//! A VNC pane's connection: a TCP socket, carried to the page byte for byte.
//!
//! The VNC protocol itself — the handshake, the authentication, decoding the
//! screen — is done in the page by noVNC, which is the mature implementation of
//! it and happens to be written for a browser. A browser cannot open a TCP
//! socket, so noVNC normally talks to a WebSocket proxy (`websockify`) that
//! does. This is that proxy, without the WebSocket: the page hands noVNC an
//! object that behaves like a socket and is backed by these three commands.
//!
//! Bytes go down a Tauri `Channel` as raw binary rather than through the event
//! bus the terminals use. The terminal path carries text as JSON, which is fine
//! for a shell and hopeless for a framebuffer: a screen update is often a
//! megabyte, and turning that into a JSON array of numbers and back again is
//! most of a frame's budget. Bytes come up the same way, as a raw request body.
//!
//! Nothing here is VNC-specific except the name, and that is deliberate: the
//! moment this knew about the protocol it would be a second implementation of
//! it, and the one in the page is the one that is tested.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

/// Long enough for a machine across the internet, short enough that a typo'd
/// address says so before anyone wonders whether it is still trying.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// One read's worth. A framebuffer update arrives in several of these, and
/// noVNC reassembles them; a bigger buffer would mostly sit empty.
const READ_BUF: usize = 64 * 1024;
/// The header that names the pane on a `vnc_send`, whose body is the bytes.
const ID_HEADER: &str = "x-jterm-vnc";

#[derive(Default)]
pub struct VncRegistry {
    /// Each pane's socket, and the generation that opened it — so a reader
    /// thread from a connection that has since been replaced does not remove
    /// its replacement on the way out.
    sockets: Mutex<HashMap<String, (u64, TcpStream)>>,
    next: AtomicU64,
}

/// What the page may name as a host. Anything a resolver would take, within
/// reason; the point is only that a hand-edited snapshot cannot hand this a
/// megabyte or a newline.
pub(crate) fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':' | '[' | ']' | '_'))
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    // Brackets are how an IPv6 address is written next to a port; the
    // resolver wants it bare.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addresses = (bare, port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not find {host}: {error}"))?;
    let mut last = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(match last {
        Some(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            format!("{host}:{port} did not answer.")
        }
        Some(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            format!("{host}:{port} refused the connection — is screen sharing on there?")
        }
        Some(error) => format!("Could not connect to {host}:{port}: {error}"),
        None => format!("{host} has no address to connect to."),
    })
}

/// Open the socket and start streaming what arrives to `on_data`.
///
/// Resolves once connected, or with the reason it could not be. The end of the
/// connection, whenever it comes, is one JSON message, `{"closed": reason}`,
/// after which the channel says nothing more.
#[tauri::command]
pub async fn vnc_connect(
    registry: State<'_, Arc<VncRegistry>>,
    id: String,
    host: String,
    port: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    if !valid_host(&host) || port == 0 {
        return Err("That is not an address jterm can connect to.".into());
    }
    let target = host.clone();
    let stream = tauri::async_runtime::spawn_blocking(move || connect(&target, port))
        .await
        .map_err(|error| error.to_string())??;
    // Key presses and pointer moves are a few bytes each and want to leave now,
    // not when the kernel has enough of them to fill a packet.
    let _ = stream.set_nodelay(true);
    let mut reader = stream.try_clone().map_err(|error| error.to_string())?;

    let registry = Arc::clone(&registry);
    let generation = registry.next.fetch_add(1, Ordering::Relaxed);
    if let Some((_, old)) = registry
        .sockets
        .lock()
        .insert(id.clone(), (generation, stream))
    {
        let _ = old.shutdown(Shutdown::Both);
    }

    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUF];
        let reason = loop {
            match reader.read(&mut buf) {
                Ok(0) => break "The other end closed the connection.".to_string(),
                Ok(n) => {
                    if on_data
                        .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                        .is_err()
                    {
                        // The page is gone; nobody is left to tell.
                        break String::new();
                    }
                }
                Err(error) => break format!("The connection dropped: {error}"),
            }
        };
        {
            let mut sockets = registry.sockets.lock();
            if sockets
                .get(&id)
                .is_some_and(|(owner, _)| *owner == generation)
            {
                sockets.remove(&id);
            }
        }
        let message = serde_json::json!({ "closed": reason }).to_string();
        let _ = on_data.send(InvokeResponseBody::Json(message));
    });
    Ok(())
}

/// Write the request body to a pane's socket. The pane is named in a header,
/// because the body is the bytes and nothing else.
#[tauri::command]
pub fn vnc_send(registry: State<'_, Arc<VncRegistry>>, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get(ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("no pane named")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    // Cloned out from under the lock: a write to a stalled peer can block, and
    // it must not hold up every other pane's sends while it does.
    let stream = registry
        .sockets
        .lock()
        .get(id)
        .and_then(|(_, stream)| stream.try_clone().ok());
    let Some(mut stream) = stream else {
        return Err("not connected".into());
    };
    stream.write_all(bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn vnc_close(registry: State<'_, Arc<VncRegistry>>, id: String) {
    if let Some((_, stream)) = registry.sockets.lock().remove(&id) {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_addresses_people_type() {
        for host in [
            "mac-mini.local",
            "10.0.0.7",
            "[fe80::1]",
            "fe80::1",
            "build_box",
        ] {
            assert!(valid_host(host), "{host}");
        }
    }

    #[test]
    fn refuses_what_a_snapshot_should_not_carry() {
        for host in ["", "a b", "host\nname", "x;rm", &"a".repeat(254)] {
            assert!(!valid_host(host), "{host:?}");
        }
    }

    #[test]
    fn a_refused_port_says_what_to_check() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = connect("127.0.0.1", port).unwrap_err();
        assert!(error.contains("refused"), "{error}");
    }
}
