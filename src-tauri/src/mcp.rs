//! jterm as an MCP server: the app, offered as tools to the agent running in it.
//!
//! An agent in the sidebar is an agent *inside a terminal app*, and the most
//! useful things it can be told about are the app's — which tabs are open, what
//! the build in the pane on the right just printed, a file opened where the user
//! will see it. None of that is reachable from a shell, so it is offered over
//! the Model Context Protocol, which is the one interface Claude Code, Codex and
//! Gemini CLI all speak.
//!
//! **Transport.** Streamable HTTP on `127.0.0.1`, on a port the OS picks, with a
//! random bearer token made fresh on every launch. HTTP rather than stdio
//! because stdio would mean a second process per agent whose only job is to
//! relay to this one, and all three CLIs can be pointed at an HTTP server with a
//! header. Every response is a single JSON body — the spec allows a server to
//! answer a POST that way rather than with an event stream — and this server
//! sends no requests of its own, so there is no stream to open and GET is
//! refused.
//!
//! **Who may call.** The token is the gate. The listener is on loopback only,
//! but loopback is every local user and every web page's `fetch` too: the
//! token is never on a command line (where `ps` shows it) — it reaches an agent
//! through its environment or a file only its user can read, see
//! `crate::agent_cli` — and a request carrying a browser `Origin` that is not
//! local is refused before the token is even looked at.
//!
//! **Where tools run.** The workspace is the frontend's, per window, so the
//! protocol is spoken here and the tools are run there. A `tools/*` request is
//! handed to the window named in the URL as an event, and the thread serving
//! the HTTP request waits for that window to call `mcp_respond`. The tool list
//! is the frontend's too (`src/lib/mcp.ts`), so a tool is defined in exactly the
//! one place that implements it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::valid_window_label;

/// Raised on a window when an agent calls one of its tools.
pub const REQUEST_EVENT: &str = "mcp://request";

/// Newest first. A client asking for one of these gets it back; anything else
/// is offered the newest, which is what the spec says a server should do.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// How long a tool may take in the window. Generous, because opening a
/// terminal and waiting for its prompt is a tool, and a window busy restoring a
/// session answers slowly.
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);
/// A client that connects and then says nothing is not worth a thread forever.
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Given to the agent at `initialize`, for it to know what these tools are for.
const INSTRUCTIONS: &str = "jterm is the terminal app you are running inside. These tools reach \
the app itself: list the user's tabs and panes, read what a terminal pane is showing, type into \
one, and open terminals, files and web pages where the user will see them. Anything typed into a \
pane the user is working in happens in front of them — for your own long-running commands, open \
a new terminal rather than borrowing theirs.";

type Reply = Result<Value, String>;

pub struct McpServer {
    /// Taken by `serve`; `None` afterwards, or from the start if binding failed.
    listener: Mutex<Option<TcpListener>>,
    port: Option<u16>,
    token: String,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    app: OnceLock<AppHandle>,
}

#[derive(Serialize, Clone)]
struct RequestPayload {
    id: u64,
    /// Which window the call is for. The event is aimed at that window, and the
    /// frontend checks this too: a listener that hears every target would
    /// otherwise have every window run every agent's tools.
    window: String,
    method: String,
    params: Value,
}

impl McpServer {
    /// Bind the port now, before there is an app to serve.
    ///
    /// Done ahead of the Tauri builder so the server can be `manage`d like the
    /// rest of the state — a command asking for it must never find it missing.
    /// A machine where loopback cannot be bound, or where the OS will not give
    /// out randomness for a token, gets a server that is simply not running,
    /// and the agent tab says so rather than starting an agent without it.
    pub fn bind() -> Arc<Self> {
        let token = new_token();
        let listener = token
            .as_ref()
            .and_then(|_| TcpListener::bind(("127.0.0.1", 0)).ok());
        let port = listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok())
            .map(|addr| addr.port());
        Arc::new(Self {
            listener: Mutex::new(listener),
            port,
            token: token.unwrap_or_default(),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            app: OnceLock::new(),
        })
    }

    /// Start accepting, now that there are windows to hand tool calls to.
    pub fn serve(self: &Arc<Self>, app: AppHandle) {
        let _ = self.app.set(app);
        self.accept();
    }

    fn accept(self: &Arc<Self>) {
        let Some(listener) = self.listener.lock().take() else {
            return;
        };
        let server = self.clone();
        let _ = std::thread::Builder::new()
            .name("mcp-accept".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let server = server.clone();
                    // A thread per connection: agents make a handful, and a
                    // tool call waits on the window for as long as it takes, so
                    // one slow call must not hold up the next agent's.
                    let _ = std::thread::Builder::new()
                        .name("mcp-conn".into())
                        .spawn(move || server.connection(stream));
                }
            });
    }

    /// Where an agent in `window` should connect, or `None` when not serving.
    pub fn endpoint(&self, window: &str) -> Option<String> {
        let port = self.port?;
        valid_window_label(window).then(|| format!("http://127.0.0.1:{port}/mcp/{window}"))
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn connection(&self, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let response = match read_request(&mut reader) {
            Ok(request) => self.respond(&request),
            Err(status) => Response::empty(status),
        };
        let _ = writer.write_all(&response.into_bytes());
        let _ = writer.flush();
    }

    fn respond(&self, request: &Request) -> Response {
        let Some(label) = request
            .path
            .split('?')
            .next()
            .and_then(|path| path.strip_prefix("/mcp/"))
            .filter(|label| valid_window_label(label))
        else {
            return Response::empty(404);
        };
        if let Some(origin) = request.header("origin") {
            if !local_origin(origin) {
                return Response::empty(403);
            }
        }
        let expected = format!("Bearer {}", self.token);
        let authorised = !self.token.is_empty()
            && request
                .header("authorization")
                .is_some_and(|given| same(given.as_bytes(), expected.as_bytes()));
        if !authorised {
            return Response::empty(401);
        }
        if request.method != "POST" {
            return Response::empty(405).with_header("Allow", "POST");
        }

        let message: Value = match serde_json::from_slice(&request.body) {
            Ok(message) => message,
            Err(_) => {
                return Response::json(400, &rpc_error(Value::Null, -32700, "parse error"));
            }
        };
        if message.is_array() {
            // Batching was taken out of the protocol in 2025-06-18, and none of
            // the clients this serves send one.
            return Response::json(
                400,
                &rpc_error(Value::Null, -32600, "batched requests are not supported"),
            );
        }
        match handle_message(&message, |method, params| {
            self.forward(label, method, params)
        }) {
            Some(reply) => Response::json(200, &reply),
            None => Response::empty(202),
        }
    }

    /// Hand a request to a window and wait for its answer.
    fn forward(&self, label: &str, method: &str, params: &Value) -> Reply {
        let app = self.app.get().ok_or("jterm is still starting")?;
        if app.get_webview_window(label).is_none() {
            return Err(format!(
                "the jterm window this agent belongs to ({label}) is closed"
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().insert(id, tx);
        let payload = RequestPayload {
            id,
            window: label.to_string(),
            method: method.to_string(),
            params: params.clone(),
        };
        if let Err(err) = app.emit_to(label, REQUEST_EVENT, payload) {
            self.pending.lock().remove(&id);
            return Err(format!("could not reach the jterm window: {err}"));
        }
        let reply = rx.recv_timeout(REPLY_TIMEOUT);
        self.pending.lock().remove(&id);
        reply.unwrap_or_else(|_| Err("the jterm window did not answer in time".into()))
    }

    fn settle(&self, id: u64, reply: Reply) {
        if let Some(tx) = self.pending.lock().remove(&id) {
            let _ = tx.send(reply);
        }
    }
}

/// A window's answer to a tool call it was handed.
#[tauri::command]
pub fn mcp_respond(
    server: tauri::State<'_, Arc<McpServer>>,
    id: u64,
    result: Option<Value>,
    error: Option<String>,
) {
    server.settle(
        id,
        match error {
            Some(error) => Err(error),
            None => Ok(result.unwrap_or(Value::Null)),
        },
    );
}

/* ── JSON-RPC ────────────────────────────────────────────────────────────── */

/// One JSON-RPC message in, at most one out.
///
/// `None` for anything that expects no reply: a notification (no `id`), and a
/// client's response to a request — this server never sends one, so there is
/// nothing to match it against. Split from the HTTP side so the protocol can be
/// tested without a socket or a window.
pub fn handle_message(
    message: &Value,
    forward: impl FnOnce(&str, &Value) -> Reply,
) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    let id = message.get("id")?.clone();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": negotiate(params.get("protocolVersion").and_then(Value::as_str)),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": {
                "name": "jterm",
                "title": "jterm",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "instructions": INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" | "tools/call" => forward(method, &params),
        _ => {
            return Some(rpc_error(
                id,
                -32601,
                &format!("method not found: {method}"),
            ))
        }
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(message) => rpc_error(id, -32603, &message),
    })
}

fn negotiate(requested: Option<&str>) -> &'static str {
    requested
        .and_then(|asked| PROTOCOL_VERSIONS.iter().find(|known| **known == asked))
        .copied()
        .unwrap_or(PROTOCOL_VERSIONS[0])
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/* ── HTTP, as little of it as this needs ─────────────────────────────────── */

pub struct Request {
    pub method: String,
    pub path: String,
    /// Names lowercased.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// Read one HTTP/1.1 request, or the status to refuse it with.
///
/// Only what an MCP client sends: a request line, headers, and a body sized by
/// `Content-Length`. A chunked body is refused rather than decoded — every
/// client here knows the length of the JSON it is about to send.
pub fn read_request(reader: &mut impl BufRead) -> Result<Request, u16> {
    let mut budget = MAX_HEAD_BYTES;
    let start = read_line(reader, &mut budget)?;
    let mut parts = start.split(' ');
    let (Some(method), Some(path), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(400);
    };
    if !version.starts_with("HTTP/1.") {
        return Err(505);
    }

    let mut headers = Vec::new();
    loop {
        let line = read_line(reader, &mut budget)?;
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }

    let request = Request {
        method: method.to_string(),
        path: path.to_string(),
        headers,
        body: Vec::new(),
    };
    if request
        .header("transfer-encoding")
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(411);
    }
    let length = match request.header("content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| 400u16)?,
        None => 0,
    };
    if length > MAX_BODY_BYTES {
        return Err(413);
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|_| 400u16)?;
    Ok(Request { body, ..request })
}

fn read_line(reader: &mut impl BufRead, budget: &mut usize) -> Result<String, u16> {
    let mut buf = Vec::new();
    let read = reader
        .take(*budget as u64)
        .read_until(b'\n', &mut buf)
        .map_err(|_| 400u16)?;
    if read == 0 || !buf.ends_with(b"\n") {
        return Err(if read >= *budget { 431 } else { 400 });
    }
    *budget -= read;
    let text = String::from_utf8(buf).map_err(|_| 400u16)?;
    Ok(text.trim_end_matches(['\r', '\n']).to_string())
}

struct Response {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Response {
    fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn json(status: u16, value: &Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type", "application/json".into())],
            body: serde_json::to_vec(value).unwrap_or_default(),
        }
    }

    fn with_header(mut self, name: &'static str, value: &str) -> Self {
        self.headers.push((name, value.to_string()));
        self
    }

    fn into_bytes(self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            411 => "Length Required",
            413 => "Payload Too Large",
            431 => "Request Header Fields Too Large",
            505 => "HTTP Version Not Supported",
            _ => "Error",
        };
        // One request per connection. Clients reconnect for the next one, which
        // on loopback costs nothing and saves this from tracking idle sockets.
        let mut head = format!(
            "HTTP/1.1 {} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
            self.status,
            self.body.len()
        );
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

/// Whether a browser `Origin` is this machine. Anything else is a web page
/// trying its luck, which is the DNS-rebinding case the spec asks servers to
/// refuse.
fn local_origin(origin: &str) -> bool {
    let host = origin
        .split_once("://")
        .map_or(origin, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or("");
    let host = if host.starts_with('[') {
        host.split(']').next().map_or(host, |inner| &inner[1..])
    } else {
        host.split(':').next().unwrap_or(host)
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// Compare without stopping at the first difference, so how long a refusal
/// takes says nothing about how much of a guessed token was right.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn new_token() -> Option<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(raw: &str) -> Result<Request, u16> {
        read_request(&mut BufReader::new(raw.as_bytes()))
    }

    fn server() -> Arc<McpServer> {
        let server = McpServer::bind();
        assert!(!server.token.is_empty(), "a token");
        server
    }

    fn post(server: &McpServer, path: &str, body: &str, token: Option<&str>) -> Response {
        let auth = token.map_or(String::new(), |token| {
            format!("Authorization: Bearer {token}\r\n")
        });
        let raw = format!(
            "POST {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {}\r\n\r\n{body}",
            body.len()
        );
        server.respond(&request(&raw).expect("a request"))
    }

    #[test]
    fn reads_a_request_and_its_body() {
        let parsed = request(
            "POST /mcp/main HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        )
        .unwrap();
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/mcp/main");
        assert_eq!(parsed.header("content-type"), Some("application/json"));
        assert_eq!(parsed.body, b"{}");
    }

    #[test]
    fn refuses_what_it_does_not_speak() {
        assert_eq!(request("garbage\r\n\r\n").err(), Some(400));
        assert_eq!(
            request("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").err(),
            Some(411)
        );
        assert_eq!(
            request("POST / HTTP/1.1\r\nContent-Length: 999999999\r\n\r\n").err(),
            Some(413)
        );
        let huge = format!(
            "GET / HTTP/1.1\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEAD_BYTES)
        );
        assert_eq!(request(&huge).err(), Some(431));
    }

    #[test]
    fn negotiates_the_protocol_version() {
        let reply = handle_message(
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}),
            |_, _| unreachable!(),
        )
        .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["serverInfo"]["name"], "jterm");

        let reply = handle_message(
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}),
            |_, _| unreachable!(),
        )
        .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn forwards_tools_and_answers_everything_else_itself() {
        let reply = handle_message(
            &json!({"jsonrpc":"2.0","id":"a","method":"tools/list"}),
            |method, _| Ok(json!({ "asked": method })),
        )
        .unwrap();
        assert_eq!(reply["id"], "a");
        assert_eq!(reply["result"]["asked"], "tools/list");

        let failed = handle_message(
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}),
            |_, _| Err("window closed".into()),
        )
        .unwrap();
        assert_eq!(failed["error"]["code"], -32603);
        assert_eq!(failed["error"]["message"], "window closed");

        let unknown = handle_message(
            &json!({"jsonrpc":"2.0","id":3,"method":"resources/list"}),
            |_, _| unreachable!(),
        )
        .unwrap();
        assert_eq!(unknown["error"]["code"], -32601);

        // A notification, and a response to a request never sent: no reply.
        assert!(handle_message(
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            |_, _| unreachable!()
        )
        .is_none());
        assert!(
            handle_message(&json!({"jsonrpc":"2.0","id":9,"result":{}}), |_, _| {
                unreachable!()
            })
            .is_none()
        );
    }

    #[test]
    fn keeps_out_anyone_without_the_token() {
        let server = server();
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        assert_eq!(post(&server, "/mcp/main", init, None).status, 401);
        assert_eq!(post(&server, "/mcp/main", init, Some("wrong")).status, 401);
        assert_eq!(
            post(&server, "/mcp/main", init, Some(&server.token)).status,
            200
        );
        assert_eq!(
            post(&server, "/elsewhere", init, Some(&server.token)).status,
            404
        );
        assert_eq!(
            post(&server, "/mcp/../x", init, Some(&server.token)).status,
            404
        );

        let from_page = format!(
            "POST /mcp/main HTTP/1.1\r\nOrigin: https://evil.example\r\nAuthorization: Bearer {}\r\nContent-Length: 2\r\n\r\n{{}}",
            server.token
        );
        assert_eq!(server.respond(&request(&from_page).unwrap()).status, 403);
    }

    #[test]
    fn accepts_notifications_and_refuses_streams() {
        let server = server();
        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert_eq!(
            post(&server, "/mcp/main", note, Some(&server.token)).status,
            202
        );
        let get = format!(
            "GET /mcp/main HTTP/1.1\r\nAuthorization: Bearer {}\r\n\r\n",
            server.token
        );
        assert_eq!(server.respond(&request(&get).unwrap()).status, 405);
    }

    #[test]
    fn a_tool_call_without_a_window_fails_rather_than_hanging() {
        let server = server();
        let call = r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#;
        let response = post(&server, "/mcp/main", call, Some(&server.token));
        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(body["error"]["code"], -32603);
    }

    #[test]
    fn tells_local_origins_from_the_rest() {
        assert!(local_origin("http://127.0.0.1:1234"));
        assert!(local_origin("http://localhost"));
        assert!(local_origin("http://[::1]:80"));
        assert!(!local_origin("https://example.com"));
        assert!(!local_origin("http://localhost.evil.com"));
    }

    #[test]
    fn serves_over_a_real_socket() {
        let server = server();
        let port = server.port.expect("a port");
        server.accept();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        write!(
            stream,
            "POST /mcp/main HTTP/1.1\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{body}",
            server.token,
            body.len()
        )
        .unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        assert!(reply.starts_with("HTTP/1.1 200 OK"), "{reply}");
        assert!(
            reply.ends_with(r#"{"id":1,"jsonrpc":"2.0","result":{}}"#),
            "{reply}"
        );
    }
}
