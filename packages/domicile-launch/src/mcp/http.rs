//! `domicile mcp --http`: the Model Context Protocol over Streamable HTTP,
//! signed in with OAuth, so a client that can't run `domicile mcp` itself,
//! such as claude.ai, can drive the desk.
//!
//! `/mcp` takes one JSON-RPC message per POST and answers it as JSON; it
//! opens no event stream. `initialize` starts a session, named by the
//! `Mcp-Session-Id` header, and each session is one [`Agent`] on a thread of
//! its own, asking the user to let it in at its first tool call as `domicile
//! mcp` on stdio does. A tool call that names its conversation in `_meta`
//! ([`CONVERSATION`]) goes instead to that conversation's agent, shared by
//! every session of the same client in it, since some clients start a session
//! for each call. A session or conversation unused for [`IDLE_MS`] ends, which
//! lets its agent go. Every other path is the authorization server
//! ([`super::oauth`]). See `docs/AGENTS.md`.

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::TcpListener;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

use super::oauth::{base64url, Asks, Auth, Authorized, Params};
use super::Agent;

/// How long a session may go unused before it ends.
pub const IDLE_MS: u64 = 30 * 60 * 1000;

/// The `_meta` key on a tool call that names the conversation it is in.
/// ChatGPT sends it.
const CONVERSATION: &str = "openai/session";

/// The largest request body read.
const MOST_BYTES: u64 = 1 << 20;

/// Where and how `domicile mcp --http` serves.
pub struct Web {
    pub listener: TcpListener,
    /// The address clients reach it at, such as `http://127.0.0.1:7465`,
    /// with no trailing slash. Tokens are for this address.
    pub base: String,
    /// Where signed-in clients are kept; `None` forgets them on exit.
    pub state: Option<PathBuf>,
    /// Asks the user on the desk whether a client may sign in.
    pub ask: Box<Asks>,
    /// The time, in milliseconds.
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// Makes secrets.
    pub random: Box<dyn FnMut() -> [u8; 32] + Send>,
    /// How often idle sessions are ended between requests.
    pub sweep_every: Duration,
}

/// Makes each session's agent, on that session's thread.
type Maker = Arc<dyn Fn() -> Agent<'static> + Send + Sync>;

/// Makes secrets, shared by the authorization server and session ids.
type Random = Arc<Mutex<Box<dyn FnMut() -> [u8; 32] + Send>>>;

/// A message for a session's thread, and where its answer goes.
type Asked = (Value, Sender<io::Result<Option<Value>>>);

struct Session {
    asks: Sender<Asked>,
    used_ms: u64,
    /// The client that signed it in.
    client: String,
    /// Its `initialize`, which starts each conversation's agent it reaches.
    initialize: Value,
    /// Whether what its first tool call carried has been logged.
    logged: bool,
}

/// The agent of a conversation, shared by its client's sessions in it.
struct Conversation {
    asks: Sender<Asked>,
    used_ms: u64,
}

struct Shared {
    auth: Mutex<Auth>,
    sessions: Mutex<HashMap<String, Session>>,
    /// By client and conversation.
    conversations: Mutex<HashMap<(String, String), Conversation>>,
    random: Random,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    base: String,
    port: u16,
}

/// Serves until the server fails. `agent` makes each session's agent, on
/// that session's thread, so it need not be `Send`.
pub fn serve_http(
    web: Web,
    agent: impl Fn() -> Agent<'static> + Send + Sync + 'static,
) -> io::Result<()> {
    let port = web.listener.local_addr()?.port();
    answered_at_once(&web.listener)?;
    let server = Server::from_listener(web.listener, None).map_err(io::Error::other)?;
    let random: Random = Arc::new(Mutex::new(web.random));
    let shared = Arc::new(Shared {
        auth: Mutex::new(Auth::new(
            web.base.clone(),
            web.state,
            {
                let clock = Arc::clone(&web.clock);
                move || clock()
            },
            {
                let random = Arc::clone(&random);
                move || (random.lock().unwrap())()
            },
            web.ask,
        )),
        sessions: Mutex::new(HashMap::new()),
        conversations: Mutex::new(HashMap::new()),
        random,
        clock: web.clock,
        base: web.base,
        port,
    });
    let agent: Maker = Arc::new(agent);
    loop {
        match server.recv_timeout(web.sweep_every)? {
            Some(request) => {
                let shared = Arc::clone(&shared);
                let agent = Arc::clone(&agent);
                thread::spawn(move || {
                    let _ = answered(request, &shared, &agent);
                });
            }
            None => swept(&shared),
        }
    }
}

/// Sets `TCP_NODELAY` on `listener`, which each connection it accepts takes
/// from it. `tiny_http` writes an answer in pieces; Nagle's algorithm would
/// hold each piece after the first until the last is acknowledged, which the
/// client delays ~40 ms, on every answer.
fn answered_at_once(listener: &TcpListener) -> io::Result<()> {
    let on: libc::c_int = 1;
    // SAFETY: the descriptor is the listener's, open for this call, and the
    // option is the size it says.
    let set = unsafe {
        libc::setsockopt(
            listener.as_raw_fd(),
            libc::IPPROTO_TCP,
            libc::TCP_NODELAY,
            std::ptr::from_ref(&on).cast(),
            std::mem::size_of_val(&on) as libc::socklen_t,
        )
    };
    match set {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

/// Ends each session and conversation unused for [`IDLE_MS`], which lets its
/// agent go.
fn swept(shared: &Shared) {
    let now = (shared.clock)();
    shared
        .sessions
        .lock()
        .unwrap()
        .retain(|_, session| now.saturating_sub(session.used_ms) < IDLE_MS);
    shared
        .conversations
        .lock()
        .unwrap()
        .retain(|_, conversation| now.saturating_sub(conversation.used_ms) < IDLE_MS);
}

fn answered(mut request: Request, shared: &Shared, agent: &Maker) -> io::Result<()> {
    if !trusted(&request, shared) {
        return request.respond(text(403, "This address can't reach your desktop."));
    }
    let url = request.url().to_string();
    let (path, raw_query) = url.split_once('?').unwrap_or((&url, ""));
    let query = form(raw_query);
    let method = request.method().clone();
    let response = match (method, path) {
        (
            Method::Get,
            "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp",
        ) => as_json(200, &shared.auth.lock().unwrap().resource_metadata()),
        (Method::Get, "/.well-known/oauth-authorization-server") => {
            as_json(200, &shared.auth.lock().unwrap().metadata())
        }
        (Method::Post, "/register") => match serde_json::from_slice(&body(&mut request)?) {
            Ok(metadata) => match shared.auth.lock().unwrap().register(&metadata) {
                Ok(registered) => as_json(201, &registered),
                Err(refused) => as_json(400, &refused),
            },
            Err(why) => as_json(
                400,
                &json!({"error": "invalid_client_metadata", "error_description": why.to_string()}),
            ),
        },
        (Method::Get, "/authorize") => {
            authorize_page(shared.auth.lock().unwrap().authorize(&query), raw_query)
        }
        (Method::Post, "/token") => {
            let fields = form(&String::from_utf8_lossy(&body(&mut request)?));
            match shared.auth.lock().unwrap().token(&fields) {
                Ok(tokens) => {
                    as_json(200, &tokens).with_header(header("Cache-Control", "no-store"))
                }
                Err(refused) => as_json(400, &refused),
            }
        }
        (method, "/mcp") => match signed_in(&request, shared) {
            Some(client) => mcp(method, &mut request, client, shared, agent)?,
            None => {
                let metadata = format!(
                    "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource\"",
                    shared.base
                );
                text(401, "Sign in first.").with_header(header("WWW-Authenticate", &metadata))
            }
        },
        _ => text(404, "Not found."),
    };
    request.respond(response)
}

/// Whether the request is for this server, by its `Host` and `Origin`, so a
/// web page can't reach it by renaming a host it controls to this one.
fn trusted(request: &Request, shared: &Shared) -> bool {
    let loopback = |authority: &str| {
        ["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|host| authority == format!("{host}:{}", shared.port))
    };
    let ours = shared
        .base
        .split_once("://")
        .map_or("", |(_, authority)| authority);
    let host = header_value(request, "Host").unwrap_or_default();
    let host_ok = host == ours || loopback(&host);
    let origin_ok = header_value(request, "Origin").is_none_or(|origin| {
        origin == shared.base || origin.strip_prefix("http://").is_some_and(loopback)
    });
    host_ok && origin_ok
}

/// The client the request's token signs in, if it does.
fn signed_in(request: &Request, shared: &Shared) -> Option<String> {
    header_value(request, "Authorization")
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
        .and_then(|token| shared.auth.lock().unwrap().client_of(token.trim()))
}

/// `/mcp`, signed in.
fn mcp(
    method: Method,
    request: &mut Request,
    client: String,
    shared: &Shared,
    agent: &Maker,
) -> io::Result<Response<io::Cursor<Vec<u8>>>> {
    swept(shared);
    let now = (shared.clock)();
    let id = header_value(request, "Mcp-Session-Id");
    match method {
        Method::Post => {}
        Method::Delete => {
            let ended = id.and_then(|id| shared.sessions.lock().unwrap().remove(&id));
            return Ok(match ended {
                Some(_) => text(204, ""),
                None => text(404, "No such session."),
            });
        }
        // No event stream: every answer comes back on its POST.
        _ => return Ok(text(405, "POST a message.").with_header(header("Allow", "POST, DELETE"))),
    }
    let message: Value = match serde_json::from_slice(&body(request)?) {
        Ok(message @ Value::Object(_)) => message,
        Ok(_) => return Ok(text(400, "Send one JSON-RPC message.")),
        Err(why) => {
            return Ok(as_json(
                400,
                &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": why.to_string()}}),
            ))
        }
    };
    let starting = message["method"] == "initialize";
    let (id, asks) = match (id, starting) {
        (_, true) => {
            let id = base64url(&(shared.random.lock().unwrap())());
            let asks = started(agent);
            shared.sessions.lock().unwrap().insert(
                id.clone(),
                Session {
                    asks: asks.clone(),
                    used_ms: now,
                    client,
                    initialize: message.clone(),
                    logged: false,
                },
            );
            (id, asks)
        }
        (Some(id), false) => {
            let mut sessions = shared.sessions.lock().unwrap();
            match sessions.get_mut(&id) {
                Some(session) => {
                    session.used_ms = now;
                    let asks = joined(&message, session, shared, agent, now);
                    (id, asks)
                }
                None => return Ok(text(404, "No such session. Initialize again.")),
            }
        }
        (None, false) => return Ok(text(400, "Name the session with Mcp-Session-Id.")),
    };
    let (reply, answer) = mpsc::channel();
    if asks.send((message, reply)).is_err() {
        return Ok(text(404, "The session ended. Initialize again."));
    }
    let answered = answer
        .recv()
        .map_err(|_| io::Error::other("the session ended mid-call"))??;
    let response = match answered {
        Some(answer) => as_json(200, &answer),
        None => text(202, ""),
    };
    Ok(response.with_header(header("Mcp-Session-Id", &id)))
}

/// Starts a thread for a session or conversation, with an agent made on it.
fn started(agent: &Maker) -> Sender<Asked> {
    let (asks, asked) = mpsc::channel::<Asked>();
    let agent = Arc::clone(agent);
    thread::spawn(move || {
        let mut agent = agent();
        // Ends when its session or conversation does, which drops the agent
        // and lets it go.
        for (message, reply) in asked {
            let _ = reply.send(agent.answer(&message));
        }
    });
    asks
}

/// Where `session`'s `message` goes: the agent of the conversation a tool
/// call names, started with the session's `initialize` if it is new, or else
/// the session's own.
fn joined(
    message: &Value,
    session: &mut Session,
    shared: &Shared,
    agent: &Maker,
    now: u64,
) -> Sender<Asked> {
    let calling = message["method"] == "tools/call";
    let meta = &message["params"]["_meta"];
    let named = meta[CONVERSATION]
        .as_str()
        .filter(|conversation| calling && !conversation.is_empty());
    if calling && !session.logged {
        session.logged = true;
        let keys = meta
            .as_object()
            .map(|meta| meta.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        eprintln!(
            "domicile: {} ({}) called a tool; _meta keys: {keys:?}; {}",
            session.initialize["params"]["clientInfo"]["name"],
            session.initialize["params"]["clientInfo"]["version"],
            match named {
                Some(_) => "it names its conversation",
                None => "it names no conversation, so the session is its own",
            }
        );
    }
    let Some(named) = named else {
        return session.asks.clone();
    };
    let mut conversations = shared.conversations.lock().unwrap();
    let conversation = conversations
        .entry((session.client.clone(), named.to_string()))
        .or_insert_with(|| {
            let asks = started(agent);
            // Its answer was the session's, long since sent.
            let (unheard, _) = mpsc::channel();
            let _ = asks.send((session.initialize.clone(), unheard));
            Conversation { asks, used_ms: now }
        });
    conversation.used_ms = now;
    conversation.asks.clone()
}

/// How often the waiting page looks again for the user's answer.
const LOOK_AGAIN_S: u8 = 2;

/// The `/authorize` page for the request `query`, still encoded, or the
/// redirect it answers with.
fn authorize_page(authorized: Authorized, query: &str) -> Response<io::Cursor<Vec<u8>>> {
    match authorized {
        Authorized::Redirect(to) => text(302, "").with_header(header("Location", &to)),
        Authorized::Refused(why) | Authorized::Failed(why) => {
            page(400, "Can't connect", "", &format!("<p>{}</p>", html(&why)))
        }
        Authorized::Wait {
            client,
            ask,
            matching,
        } => {
            // Without script, which the page's policy forbids, the page
            // loads itself again, holding the ask, until the user answers.
            let again = if form(query).contains_key("ask") {
                format!("/authorize?{query}")
            } else {
                format!("/authorize?{query}&ask={ask}")
            };
            page(
                200,
                &format!("Connect {} to your desktop", html(&client)),
                &format!(
                    "<meta http-equiv=\"refresh\" content=\"{LOOK_AGAIN_S};url={}\">",
                    html(&again)
                ),
                &format!(
                    "<p>Your desktop is asking whether to let {client} sign in. Allow it there \
                     if it shows this number:</p>\
                     <p class=\"matching\">{matching}</p>\
                     <p class=\"wait\"><span class=\"spin\"></span>Waiting for your desktop…</p>\
                     <p class=\"hint\">{client} still asks on your desktop before it uses anything.</p>",
                    client = html(&client),
                    matching = html(&matching),
                ),
            )
        }
        Authorized::Declined { client } => page(
            200,
            &format!("{} wasn't connected", html(&client)),
            "",
            &format!(
                "<p>Your desktop didn't allow it. Start again from {} if you meant to connect.</p>",
                html(&client)
            ),
        ),
    }
}

/// A page titled `title` showing `body`, with `head` in its head.
fn page(status: u16, title: &str, head: &str, body: &str) -> Response<io::Cursor<Vec<u8>>> {
    let document = format!(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">{head}\
         <title>{title}</title><style>\
         :root{{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1c1c1a;--muted:#6b6b66;--line:#d9d9d4;--accent:#3b5bdb}}\
         @media (prefers-color-scheme:dark){{:root{{--bg:#151514;--card:#1f1f1d;--fg:#ececea;--muted:#a0a09a;--line:#3a3a36;--accent:#7c93f2}}}}\
         body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}}\
         main{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;margin:16px;max-width:380px}}\
         h1{{font-size:18px;margin:0 0 12px}}p{{margin:0 0 16px}}.hint{{color:var(--muted);font-size:13px;margin:16px 0 0}}\
         .matching{{font-size:28px;font-weight:600;letter-spacing:.15em;font-variant-numeric:tabular-nums}}\
         .wait{{display:flex;align-items:center;gap:10px;color:var(--muted);margin:0}}\
         .spin{{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--line);border-top-color:var(--accent);animation:spin 1s linear infinite}}\
         @keyframes spin{{to{{transform:rotate(360deg)}}}}\
         @media (prefers-reduced-motion:reduce){{.spin{{animation:none}}}}\
         </style><main><h1>{title}</h1>{body}</main></html>"
    );
    Response::from_string(document)
        .with_status_code(status)
        .with_header(header("Content-Type", "text/html; charset=utf-8"))
        .with_header(header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'",
        ))
        .with_header(header("X-Frame-Options", "DENY"))
}

fn html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn as_json(status: u16, value: &Value) -> Response<io::Cursor<Vec<u8>>> {
    Response::from_string(value.to_string())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
}

fn text(status: u16, said: &str) -> Response<io::Cursor<Vec<u8>>> {
    Response::from_string(said)
        .with_status_code(status)
        .with_header(header("Content-Type", "text/plain; charset=utf-8"))
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a valid header")
}

fn header_value(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().to_string())
}

fn body(request: &mut Request) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take(MOST_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// The fields of a query or form, decoded.
fn form(encoded: &str) -> Params {
    encoded
        .split('&')
        .filter(|field| !field.is_empty())
        .map(|field| {
            let (name, value) = field.split_once('=').unwrap_or((field, ""));
            (decoded(name), decoded(value))
        })
        .collect()
}

fn decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let escaped = bytes
            .get(at + 1..at + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[at], escaped) {
            (b'+', _) => out.push(b' '),
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 2;
            }
            (byte, _) => out.push(byte),
        }
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
