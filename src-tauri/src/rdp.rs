//! A Remote Desktop pane's session: IronRDP on one thread, the screen streamed
//! to the page as the rectangles that changed.
//!
//! Unlike VNC there is no mature RDP client that runs in a page, so the
//! protocol lives here — IronRDP negotiates, upgrades to TLS, signs in with
//! CredSSP, and decodes every kind of bitmap update into one RGBA image. What
//! crosses to the page is only what moved: each change is the rectangle's
//! position and its pixels, as raw binary down a `Channel`, and the page puts
//! it on a canvas. Input goes the other way as small JSON messages, and is
//! turned into RDP's fast-path input events here.
//!
//! **One thread, no runtime.** A session is a socket and a loop. The socket
//! reads with a short timeout so the same loop can also drain the input queue;
//! IronRDP's `Framed` keeps a partly-read PDU across a timed-out read, which is
//! what makes that safe.
//!
//! **The certificate is checked by its fingerprint, before the password goes
//! anywhere.** RDP servers almost always present a self-signed certificate, so
//! the usual chain-of-trust check would refuse every one of them — which is why
//! most clients, IronRDP's own example included, check nothing at all. That
//! sends the password to whoever answers. Here the TLS handshake accepts the
//! certificate provisionally, its SHA-256 fingerprint is compared with the one
//! the pane trusted last time, and CredSSP — the step that carries the
//! credentials — only starts if they match. A first connection, or a changed
//! certificate, stops there and hands the fingerprint to the pane to show.

use std::collections::HashMap;
use std::io::Write as _;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ironrdp::connector::{self, ConnectionResult, Credentials, ServerName};
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use parking_lot::Mutex;
use rustls::pki_types::{CertificateDer, ServerName as TlsName, UnixTime};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a read waits before the loop looks at the input queue. Short
/// enough that a key press is not noticeably late, long enough that an idle
/// session is not spinning.
const POLL: Duration = Duration::from_millis(8);
/// The longest the screen goes between updates while the server is sending a
/// burst — about one frame.
const FLUSH_EVERY: Duration = Duration::from_millis(16);

type Tls = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

/// What the page sends: the pointer and the keyboard, in the remote desktop's
/// own coordinates and scancodes, and the end of the session.
#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Input {
    Move {
        x: u16,
        y: u16,
    },
    Button {
        button: u8,
        down: bool,
    },
    Wheel {
        vertical: bool,
        units: i16,
    },
    /// A set-1 scancode; `0xE0xx` for the extended keys.
    Key {
        scancode: u16,
        down: bool,
    },
    /// Text that has no key of its own — what an input method produces.
    Text {
        text: String,
    },
    /// Let go of everything held, for when the pane loses focus mid-chord.
    ReleaseAll,
    Disconnect,
}

#[derive(Default)]
pub struct RdpRegistry {
    /// Each pane's input queue, and the generation that opened it — so a
    /// session ending late does not remove the one that replaced it.
    sessions: Mutex<HashMap<String, (u64, Sender<Input>)>>,
    next: AtomicU64,
}

pub struct SessionRequest {
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    trusted: Option<String>,
    width: u16,
    height: u16,
}

fn json(value: serde_json::Value) -> InvokeResponseBody {
    InvokeResponseBody::Json(value.to_string())
}

/// Start a session. Returns at once with the session's generation, for
/// `rdp_close` to name; everything after — connected, the screen, the
/// certificate to confirm, the end — arrives on `on_event`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn rdp_connect(
    registry: State<'_, Arc<RdpRegistry>>,
    id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    trusted: Option<String>,
    width: u16,
    height: u16,
    on_event: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    if !crate::vnc::valid_host(&host) || port == 0 {
        return Err("That is not an address jterm can connect to.".into());
    }
    let request = SessionRequest {
        host,
        port,
        username,
        password,
        domain: domain.filter(|domain| !domain.is_empty()),
        trusted,
        // RDP wants an even width, and a desktop smaller than this is not
        // one anybody can use.
        width: (width.clamp(640, 8192) / 2) * 2,
        height: height.clamp(480, 8192),
    };
    let (sender, receiver) = mpsc::channel();
    let registry = Arc::clone(&registry);
    let generation = registry.next.fetch_add(1, Ordering::Relaxed);
    if let Some((_, old)) = registry
        .sessions
        .lock()
        .insert(id.clone(), (generation, sender))
    {
        let _ = old.send(Input::Disconnect);
    }
    std::thread::spawn(move || {
        let reason = match run(request, &receiver, &on_event) {
            Ok(reason) => reason,
            Err(reason) => reason,
        };
        {
            let mut sessions = registry.sessions.lock();
            if sessions
                .get(&id)
                .is_some_and(|(owner, _)| *owner == generation)
            {
                sessions.remove(&id);
            }
        }
        let _ = on_event.send(json(serde_json::json!({ "closed": reason })));
    });
    Ok(generation)
}

#[tauri::command]
pub fn rdp_input(registry: State<'_, Arc<RdpRegistry>>, id: String, events: Vec<Input>) {
    if let Some((_, sender)) = registry.sessions.lock().get(&id) {
        for event in events {
            let _ = sender.send(event);
        }
    }
}

/// End a pane's session — only the one `generation` names, when given. See
/// `vnc_close` for the race this closes.
#[tauri::command]
pub fn rdp_close(registry: State<'_, Arc<RdpRegistry>>, id: String, generation: Option<u64>) {
    let mut sessions = registry.sessions.lock();
    let ours = sessions
        .get(&id)
        .is_some_and(|(owner, _)| generation.is_none_or(|wanted| wanted == *owner));
    if ours {
        if let Some((_, sender)) = sessions.remove(&id) {
            let _ = sender.send(Input::Disconnect);
        }
    }
}

/* ── The session ─────────────────────────────────────────────────────────── */

/// The whole of one session. `Ok` and `Err` both carry the sentence the pane
/// shows when it ends; they differ only in whether it was expected.
fn run(
    request: SessionRequest,
    input: &Receiver<Input>,
    events: &Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let address = (request.host.trim_matches(['[', ']']), request.port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not find {}: {error}", request.host))?
        .next()
        .ok_or_else(|| format!("{} has no address to connect to.", request.host))?;
    let tcp = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|error| match error
        .kind()
    {
        std::io::ErrorKind::ConnectionRefused => format!(
            "{}:{} refused the connection — is Remote Desktop on there?",
            request.host, request.port
        ),
        std::io::ErrorKind::TimedOut => {
            format!("{}:{} did not answer.", request.host, request.port)
        }
        _ => format!("Could not connect to {}: {error}", request.host),
    })?;
    let _ = tcp.set_nodelay(true);
    let client_address = tcp.local_addr().map_err(|error| error.to_string())?;

    let mut connector = connector::ClientConnector::new(config(&request), client_address);
    let mut framed = ironrdp_blocking::Framed::new(tcp);
    let should_upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector)
        .map_err(|error| format!("The server would not start a session: {error}"))?;

    let (tls, public_key, fingerprint) =
        tls_upgrade(framed.into_inner_no_leftover(), &request.host)?;

    // The check that has to come before the password leaves this machine.
    if request.trusted.as_deref() != Some(fingerprint.as_str()) {
        let _ = events.send(json(serde_json::json!({
            "untrusted": { "fingerprint": fingerprint, "changed": request.trusted.is_some() }
        })));
        return Ok(String::new());
    }

    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = ironrdp_blocking::Framed::new(tls);
    let result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut NoNetwork,
        ServerName::new(request.host.clone()),
        public_key,
        None,
    )
    .map_err(|error| sign_in_failure(&error.to_string()))?;

    active(result, framed, input, events)
}

fn config(request: &SessionRequest) -> connector::Config {
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: request.username.clone(),
            password: request.password.clone(),
        },
        domain: request.domain.clone(),
        enable_tls: true,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        // 0 asks the server to use its own layout. Scancodes are physical
        // keys, so the layout that turns them into letters is the remote
        // machine's — which is how every RDP client behaves.
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize {
            width: request.width,
            height: request.height,
        },
        bitmap: None,
        client_build: 0,
        client_name: "jterm".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        #[cfg(windows)]
        platform: MajorPlatformType::WINDOWS,
        #[cfg(target_os = "macos")]
        platform: MajorPlatformType::MACINTOSH,
        #[cfg(not(any(windows, target_os = "macos")))]
        platform: MajorPlatformType::UNIX,
        // The server's cursor is drawn into the image, so the page shows the
        // real pointer shape without having to be sent bitmaps for it.
        enable_server_pointer: true,
        pointer_software_rendering: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: None,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

/// CredSSP's errors are written for protocol engineers. The common ones get
/// a sentence; anything else is passed on as it came.
fn sign_in_failure(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("logon") || lower.contains("credentials") || lower.contains("password") {
        "The server did not accept that user name and password.".to_string()
    } else {
        format!("Signing in failed: {error}")
    }
}

fn active(
    result: ConnectionResult,
    mut framed: ironrdp_blocking::Framed<Tls>,
    input: &Receiver<Input>,
    events: &Channel<InvokeResponseBody>,
) -> Result<String, String> {
    let width = result.desktop_size.width;
    let height = result.desktop_size.height;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, width, height);
    let mut stage: ActiveStage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();
    let mut keys = Database::new();

    // From here on, reads time out so the loop can come round to the input.
    framed
        .get_inner_mut()
        .0
        .sock
        .set_read_timeout(Some(POLL))
        .map_err(|error| error.to_string())?;

    let _ = events.send(json(
        serde_json::json!({ "connected": { "width": width, "height": height } }),
    ));

    let mut dirty: Option<InclusiveRectangle> = None;
    let mut last_flush = Instant::now();

    loop {
        // Everything the page has sent since the last time round.
        let mut operations = Vec::new();
        loop {
            match input.try_recv() {
                Ok(Input::Disconnect) | Err(TryRecvError::Disconnected) => {
                    if let Ok(outputs) = stage.graceful_shutdown() {
                        write_frames(&mut framed, outputs)?;
                    }
                    return Ok("Disconnected.".to_string());
                }
                Ok(Input::ReleaseAll) => {
                    let released = keys.release_all();
                    let outputs = stage
                        .process_fastpath_input(&mut image, &released)
                        .map_err(|error| error.to_string())?;
                    write_frames(&mut framed, outputs)?;
                }
                Ok(event) => operations.extend(operation(event)),
                Err(TryRecvError::Empty) => break,
            }
        }
        if !operations.is_empty() {
            let fast = keys.apply(operations);
            let outputs = stage
                .process_fastpath_input(&mut image, &fast)
                .map_err(|error| error.to_string())?;
            if let Some(end) = handle(outputs, &mut framed, &mut dirty)? {
                return Ok(end);
            }
        }

        match framed.read_pdu() {
            Ok((action, payload)) => {
                let outputs = stage
                    .process(&mut image, action, &payload)
                    .map_err(|error| format!("The session broke: {error}"))?;
                if let Some(end) = handle(outputs, &mut framed, &mut dirty)? {
                    return Ok(end);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                // Quiet: whatever has changed goes out now rather than waiting
                // for the next burst to finish.
                flush(&image, &mut dirty, events);
                last_flush = Instant::now();
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok("The server ended the session.".to_string());
            }
            Err(error) => return Err(format!("The connection dropped: {error}")),
        }

        if last_flush.elapsed() >= FLUSH_EVERY {
            flush(&image, &mut dirty, events);
            last_flush = Instant::now();
        }
    }
}

fn operation(event: Input) -> Option<Operation> {
    Some(match event {
        Input::Move { x, y } => Operation::MouseMove(MousePosition { x, y }),
        Input::Button { button, down } => {
            let button = match button {
                0 => MouseButton::Left,
                1 => MouseButton::Middle,
                2 => MouseButton::Right,
                3 => MouseButton::X1,
                4 => MouseButton::X2,
                _ => return None,
            };
            if down {
                Operation::MouseButtonPressed(button)
            } else {
                Operation::MouseButtonReleased(button)
            }
        }
        Input::Wheel { vertical, units } => Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: units,
        }),
        Input::Key { scancode, down } => {
            let code = Scancode::from_u16(scancode);
            if down {
                Operation::KeyPressed(code)
            } else {
                Operation::KeyReleased(code)
            }
        }
        // One character at a time, pressed and released; a longer string is
        // split by the caller into several of these.
        Input::Text { text } => Operation::UnicodeKeyPressed(text.chars().next()?),
        Input::ReleaseAll | Input::Disconnect => return None,
    })
}

/// Write what the server is owed, note what changed on screen, and say
/// whether the session has ended.
fn handle(
    outputs: Vec<ActiveStageOutput>,
    framed: &mut ironrdp_blocking::Framed<Tls>,
    dirty: &mut Option<InclusiveRectangle>,
) -> Result<Option<String>, String> {
    for output in outputs {
        match output {
            ActiveStageOutput::ResponseFrame(frame) => {
                framed
                    .write_all(&frame)
                    .map_err(|error| error.to_string())?;
            }
            ActiveStageOutput::GraphicsUpdate(rect) => {
                *dirty = Some(match dirty.take() {
                    None => rect,
                    Some(previous) => union(&previous, &rect),
                });
            }
            ActiveStageOutput::Terminate(reason) => {
                return Ok(Some(format!("The session ended: {reason}.")));
            }
            _ => {}
        }
    }
    Ok(None)
}

fn write_frames(
    framed: &mut ironrdp_blocking::Framed<Tls>,
    outputs: Vec<ActiveStageOutput>,
) -> Result<(), String> {
    for output in outputs {
        if let ActiveStageOutput::ResponseFrame(frame) = output {
            framed
                .write_all(&frame)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn union(a: &InclusiveRectangle, b: &InclusiveRectangle) -> InclusiveRectangle {
    InclusiveRectangle {
        left: a.left.min(b.left),
        top: a.top.min(b.top),
        right: a.right.max(b.right),
        bottom: a.bottom.max(b.bottom),
    }
}

/// Send the changed rectangle: eight bytes of position and size, little-endian,
/// then its pixels as RGBA, row by row.
fn flush(
    image: &DecodedImage,
    dirty: &mut Option<InclusiveRectangle>,
    events: &Channel<InvokeResponseBody>,
) {
    let Some(rect) = dirty.take() else { return };
    if let Some(bytes) = encode_rect(image.data(), image.width(), image.height(), &rect) {
        let _ = events.send(InvokeResponseBody::Raw(bytes));
    }
}

fn encode_rect(data: &[u8], width: u16, height: u16, rect: &InclusiveRectangle) -> Option<Vec<u8>> {
    let right = rect.right.min(width.checked_sub(1)?);
    let bottom = rect.bottom.min(height.checked_sub(1)?);
    if rect.left > right || rect.top > bottom {
        return None;
    }
    let w = usize::from(right - rect.left + 1);
    let h = usize::from(bottom - rect.top + 1);
    let stride = usize::from(width) * 4;
    let mut out = Vec::with_capacity(8 + w * h * 4);
    for value in [rect.left, rect.top, (w as u16), (h as u16)] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    for row in usize::from(rect.top)..=usize::from(bottom) {
        let start = row * stride + usize::from(rect.left) * 4;
        out.extend_from_slice(data.get(start..start + w * 4)?);
    }
    // The decoder leaves alpha as the server sent it, which is often zero; a
    // canvas would draw that as transparent.
    for alpha in out[8..].iter_mut().skip(3).step_by(4) {
        *alpha = 255;
    }
    Some(out)
}

/* ── TLS ─────────────────────────────────────────────────────────────────── */

/// Upgrade to TLS, accepting whatever certificate the server presents for now,
/// and return the stream, the public key CredSSP binds to, and the
/// certificate's fingerprint for the caller to judge.
fn tls_upgrade(stream: TcpStream, host: &str) -> Result<(Tls, Vec<u8>, String), String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Deferred(provider)))
        .with_no_client_auth();
    // CredSSP does not survive TLS session resumption.
    config.resumption = rustls::client::Resumption::disabled();

    let name = TlsName::try_from(host.trim_matches(['[', ']']).to_string())
        .map_err(|error| format!("{host} is not a name TLS accepts: {error}"))?;
    let client =
        rustls::ClientConnection::new(Arc::new(config), name).map_err(|error| error.to_string())?;
    let mut tls = rustls::StreamOwned::new(client, stream);
    // Drives the handshake far enough that the certificate has arrived.
    tls.flush()
        .map_err(|error| format!("The secure connection failed: {error}"))?;
    let certificate = tls
        .conn
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .ok_or("The server sent no certificate.")?
        .clone();
    let public_key = public_key(&certificate)?;
    Ok((tls, public_key, fingerprint(&certificate)))
}

fn public_key(certificate: &CertificateDer<'_>) -> Result<Vec<u8>, String> {
    use x509_cert::der::Decode as _;
    let parsed = x509_cert::Certificate::from_der(certificate)
        .map_err(|error| format!("The server's certificate could not be read: {error}"))?;
    parsed
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .map(<[u8]>::to_vec)
        .ok_or_else(|| "The server's certificate has no usable key.".to_string())
}

/// SHA-256 of the certificate, as colon-separated hex — the form Windows shows
/// in its own certificate dialog, so the two can be compared by eye.
pub fn fingerprint(certificate: &[u8]) -> String {
    Sha256::digest(certificate)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Accepts any certificate *during the handshake*, so that it can be judged by
/// fingerprint after it — see the module comment. The handshake's signature is
/// still verified, so the server must hold the key the certificate names.
#[derive(Debug)]
struct Deferred(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for Deferred {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &TlsName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// CredSSP can reach out to a Kerberos KDC, which jterm does not configure;
/// with no KDC it signs in with NTLM, which needs no network of its own.
struct NoNetwork;

impl connector::sspi::network_client::NetworkClient for NoNetwork {
    fn send(
        &self,
        _: &connector::sspi::generator::NetworkRequest,
    ) -> connector::sspi::Result<Vec<u8>> {
        Err(connector::sspi::Error::new(
            connector::sspi::ErrorKind::NoAuthenticatingAuthority,
            "jterm does not contact a Kerberos server",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rectangle_is_its_position_then_opaque_pixels() {
        // A 3x2 image, every pixel's bytes its own index, alpha zero.
        let mut data = Vec::new();
        for i in 0..6u8 {
            data.extend_from_slice(&[i, i, i, 0]);
        }
        let rect = InclusiveRectangle {
            left: 1,
            top: 0,
            right: 2,
            bottom: 1,
        };
        let out = encode_rect(&data, 3, 2, &rect).unwrap();
        assert_eq!(&out[..8], &[1, 0, 0, 0, 2, 0, 2, 0]);
        assert_eq!(
            &out[8..],
            &[1, 1, 1, 255, 2, 2, 2, 255, 4, 4, 4, 255, 5, 5, 5, 255]
        );
    }

    #[test]
    fn a_rectangle_off_the_edge_is_clipped_to_the_image() {
        let data = vec![0u8; 2 * 2 * 4];
        let rect = InclusiveRectangle {
            left: 1,
            top: 1,
            right: 9,
            bottom: 9,
        };
        let out = encode_rect(&data, 2, 2, &rect).unwrap();
        assert_eq!(&out[..8], &[1, 0, 1, 0, 1, 0, 1, 0]);
        assert_eq!(out.len(), 8 + 4);
    }

    #[test]
    fn fingerprints_read_like_windows_shows_them() {
        let print = fingerprint(b"jterm");
        assert_eq!(print.len(), 32 * 3 - 1);
        assert!(print.chars().all(|ch| ch.is_ascii_hexdigit() || ch == ':'));
        assert_eq!(print, print.to_uppercase());
    }

    #[test]
    fn keys_and_buttons_become_operations() {
        assert!(matches!(
            operation(Input::Key {
                scancode: 0xE04B,
                down: true
            }),
            Some(Operation::KeyPressed(_))
        ));
        assert!(operation(Input::Button {
            button: 9,
            down: true
        })
        .is_none());
    }
}
