//! Tests for `domicile mcp --http`: Streamable HTTP, signed in with OAuth.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use domicile_launch::mcp::{serve_http, Agent, Answer, Grant, Ran, Said, Web, IDLE_MS};
use domicile_protocol::AgentReach;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const VERIFIER: &str = "a-verifier-long-enough-to-be-a-real-one-0123456789";
const BACK: &str = "http://127.0.0.1:9/callback";

/// What the desk asked the user: the client, the site, the matching number
/// and where the answer goes.
type AskedUser = (String, String, String, Answer);

/// A server on a port of its own, its clock, and what it asked the user.
struct Desk {
    port: u16,
    now: Arc<AtomicU64>,
    asked: Arc<Mutex<Vec<AskedUser>>>,
    /// How many agents have been let go.
    gone: Arc<AtomicU8>,
    /// How many times the user was asked to let an agent in.
    admitted: Arc<AtomicU8>,
}

/// What one request got back.
struct Got {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

impl Got {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap()
    }
}

/// Lets an agent in to the whole desk and counts it out when it goes.
struct Counted(Arc<AtomicU8>);

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn desk() -> Desk {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let now = Arc::new(AtomicU64::new(1_000));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let gone = Arc::new(AtomicU8::new(0));
    let admitted = Arc::new(AtomicU8::new(0));
    let counter = AtomicU8::new(0);
    let web = Web {
        listener,
        base: format!("http://127.0.0.1:{port}"),
        state: None,
        ask: Box::new({
            let asked = Arc::clone(&asked);
            move |client: &str, site: &str, matching: &str, answer: Answer| {
                asked.lock().unwrap().push((
                    client.to_string(),
                    site.to_string(),
                    matching.to_string(),
                    answer,
                ));
            }
        }),
        clock: Arc::new({
            let now = Arc::clone(&now);
            move || now.load(Ordering::SeqCst)
        }),
        random: Box::new(move || [counter.fetch_add(1, Ordering::SeqCst); 32]),
        sweep_every: Duration::from_millis(10),
    };
    let gone_too = Arc::clone(&gone);
    let admitted_too = Arc::clone(&admitted);
    thread::spawn(move || {
        serve_http(web, move || {
            let counted = Counted(Arc::clone(&gone_too));
            let admitted = Arc::clone(&admitted_too);
            Agent::new(
                |_args: &[String]| -> io::Result<Ran> {
                    Ok(Ran {
                        success: true,
                        stdout: "[]".to_string(),
                        stderr: String::new(),
                    })
                },
                move |_name: &str| {
                    admitted.fetch_add(1, Ordering::SeqCst);
                    let held = Counted(Arc::clone(&counted.0));
                    Ok(Grant {
                        reach: Box::new(|| AgentReach::Desk),
                        stopped: Box::new(move || {
                            let _ = &held;
                            false
                        }),
                        did: Box::new(|_: &str| {}),
                    })
                },
            )
        })
        .unwrap();
    });
    Desk {
        port,
        now,
        asked,
        gone,
        admitted,
    }
}

impl Desk {
    fn ask(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Got {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        let mut request = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
        if !headers.iter().any(|(name, _)| *name == "Host") {
            request.push_str(&format!("Host: 127.0.0.1:{}\r\n", self.port));
        }
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
        stream.write_all(request.as_bytes()).unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        let (head, body) = answer.split_once("\r\n\r\n").unwrap();
        let mut lines = head.lines();
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .filter_map(|line| line.split_once(": "))
            .map(|(name, value)| (name.to_ascii_lowercase(), value.to_string()))
            .collect();
        Got {
            status,
            headers,
            body: body.to_string(),
        }
    }

    /// Registers and opens the authorization page: the client's id, the
    /// request's query, and the page.
    fn authorizing(&self) -> (String, String, Got) {
        let client = self.ask(
            "POST",
            "/register",
            &[("Content-Type", "application/json")],
            &json!({"client_name": "Claude", "redirect_uris": [BACK]}).to_string(),
        );
        assert_eq!(client.status, 201);
        let client_id = client.json()["client_id"].as_str().unwrap().to_string();
        let challenge = base64url(&Sha256::digest(VERIFIER.as_bytes()));
        let query = format!(
            "response_type=code&client_id={client_id}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&state=xyz",
            escaped(BACK)
        );
        let page = self.ask("GET", &format!("/authorize?{query}"), &[], "");
        (client_id, query, page)
    }

    /// Where the waiting page `page` loads next.
    fn again(page: &Got) -> String {
        let (_, after) = page.body.split_once(";url=").unwrap();
        let (to, _) = after.split_once('"').unwrap();
        to.replace("&amp;", "&")
    }

    /// Registers, is allowed on the desk, and exchanges the code: an access
    /// token.
    fn signed_in(&self) -> String {
        let (client_id, query, page) = self.authorizing();
        assert_eq!(page.status, 200);
        assert!(
            page.body.contains("Connect Claude to your desktop"),
            "{}",
            page.body
        );
        let again = Desk::again(&page);
        assert!(
            again.starts_with(&format!("/authorize?{query}&ask=")),
            "{again}"
        );
        let waiting = self.ask("GET", &again, &[], "");
        assert_eq!(Desk::again(&waiting), again, "it waits on the same ask");
        let (client_name, site, matching, answer) =
            self.asked.lock().unwrap().last().unwrap().clone();
        assert_eq!(
            (client_name.as_str(), site.as_str()),
            ("Claude", "127.0.0.1:9")
        );
        assert!(
            page.body
                .contains(&format!("<p class=\"matching\">{matching}</p>")),
            "the page shows the dialog's number: {}",
            page.body
        );
        answer.give(Said::Allowed);
        let sent = self.ask("GET", &again, &[], "");
        assert_eq!(sent.status, 302, "{}", sent.body);
        let location = &sent.headers["location"];
        assert!(location.starts_with(BACK), "{location}");
        assert!(location.ends_with("&state=xyz"));
        let code = location
            .split(['?', '&'])
            .find_map(|field| field.strip_prefix("code="))
            .unwrap();
        let tokens = self.ask(
            "POST",
            "/token",
            &[("Content-Type", "application/x-www-form-urlencoded")],
            &format!(
                "grant_type=authorization_code&client_id={client_id}&code={code}&redirect_uri={}&code_verifier={VERIFIER}",
                escaped(BACK)
            ),
        );
        assert_eq!(tokens.status, 200, "{}", tokens.body);
        tokens.json()["access_token"].as_str().unwrap().to_string()
    }

    fn mcp(&self, token: &str, session: Option<&str>, message: &Value) -> Got {
        let bearer = format!("Bearer {token}");
        let mut headers = vec![
            ("Authorization", bearer.as_str()),
            ("Content-Type", "application/json"),
            ("Accept", "application/json, text/event-stream"),
        ];
        if let Some(session) = session {
            headers.push(("Mcp-Session-Id", session));
        }
        self.ask("POST", "/mcp", &headers, &message.to_string())
    }
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let word = chunk.iter().enumerate().fold(0u32, |word, (at, byte)| {
            word | u32::from(*byte) << (16 - 8 * at)
        });
        for at in 0..=chunk.len() {
            out.push(char::from(ALPHABET[(word >> (18 - 6 * at) & 63) as usize]));
        }
    }
    out
}

fn escaped(text: &str) -> String {
    text.replace(':', "%3A").replace('/', "%2F")
}

fn initialize() -> Value {
    json!({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "claude-ai"}}
    })
}

#[test]
fn mcp_asks_a_client_to_sign_in_and_says_where() {
    let desk = desk();
    let refused = desk.ask("POST", "/mcp", &[], &initialize().to_string());
    assert_eq!(refused.status, 401);
    let metadata_at = format!(
        "Bearer resource_metadata=\"http://127.0.0.1:{}/.well-known/oauth-protected-resource\"",
        desk.port
    );
    assert_eq!(refused.headers["www-authenticate"], metadata_at);
    let resource = desk.ask("GET", "/.well-known/oauth-protected-resource", &[], "");
    assert_eq!(
        resource.json()["authorization_servers"],
        json!([format!("http://127.0.0.1:{}", desk.port)])
    );
    let server = desk.ask("GET", "/.well-known/oauth-authorization-server", &[], "");
    assert_eq!(
        server.json()["code_challenge_methods_supported"],
        json!(["S256"])
    );
    assert_eq!(desk.mcp("made-up", None, &initialize()).status, 401);
}

#[test]
fn a_signed_in_client_talks_in_a_session_until_it_ends_it() {
    let desk = desk();
    let token = desk.signed_in();
    let started = desk.mcp(&token, None, &initialize());
    assert_eq!(started.status, 200, "{}", started.body);
    assert_eq!(started.json()["result"]["serverInfo"]["name"], "domicile");
    let session = started.headers["mcp-session-id"].clone();

    let notified = desk.mcp(
        &token,
        Some(&session),
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    );
    assert_eq!(notified.status, 202);
    let listed = desk.mcp(
        &token,
        Some(&session),
        &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_windows"}}),
    );
    assert_eq!(listed.json()["result"]["isError"], false, "{}", listed.body);
    assert_eq!(
        desk.mcp(
            &token,
            None,
            &json!({"jsonrpc": "2.0", "id": 2, "method": "ping"})
        )
        .status,
        400
    );

    let bearer = format!("Bearer {token}");
    let ended = desk.ask(
        "DELETE",
        "/mcp",
        &[("Authorization", &bearer), ("Mcp-Session-Id", &session)],
        "",
    );
    assert_eq!(ended.status, 204);
    let after = desk.mcp(
        &token,
        Some(&session),
        &json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}),
    );
    assert_eq!(after.status, 404);
    wait_until(|| desk.gone.load(Ordering::SeqCst) >= 1);
}

#[test]
fn an_idle_session_ends_and_lets_its_agent_go() {
    let desk = desk();
    let token = desk.signed_in();
    let session = desk.mcp(&token, None, &initialize()).headers["mcp-session-id"].clone();
    desk.mcp(
        &token,
        Some(&session),
        &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_windows"}}),
    );
    desk.now.fetch_add(IDLE_MS, Ordering::SeqCst);
    // Between requests, too.
    wait_until(|| desk.gone.load(Ordering::SeqCst) >= 1);
    // Access tokens last an hour, longer than a session idles.
    let after = desk.mcp(
        &token,
        Some(&session),
        &json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
    );
    assert_eq!(after.status, 404);
}

/// A tool call in the conversation ChatGPT names `chat`.
fn called_in(chat: &str, tool: &str) -> Value {
    json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool, "_meta": {"openai/session": chat}}
    })
}

impl Desk {
    /// Starts an MCP session and makes one call in it, as ChatGPT does for
    /// each tool call.
    fn called_once(&self, token: &str, call: &Value) -> Got {
        let session = self.mcp(token, None, &initialize()).headers["mcp-session-id"].clone();
        self.mcp(token, Some(&session), call)
    }
}

#[test]
fn sessions_in_one_conversation_share_one_grant() {
    let desk = desk();
    let token = desk.signed_in();
    for tool in ["list_windows", "status", "list_windows"] {
        let called = desk.called_once(&token, &called_in("chat-1", tool));
        assert_eq!(called.json()["result"]["isError"], false, "{}", called.body);
    }
    assert_eq!(desk.admitted.load(Ordering::SeqCst), 1);

    desk.called_once(&token, &called_in("chat-2", "list_windows"));
    assert_eq!(desk.admitted.load(Ordering::SeqCst), 2, "another chat asks");
    let other = desk.signed_in();
    desk.called_once(&other, &called_in("chat-1", "list_windows"));
    assert_eq!(
        desk.admitted.load(Ordering::SeqCst),
        3,
        "another client's chat asks, though its id is the same"
    );

    let stopped = desk.called_once(&token, &called_in("chat-1", "stop_using_desktop"));
    assert_eq!(
        stopped.json()["result"]["isError"],
        false,
        "{}",
        stopped.body
    );
    wait_until(|| desk.gone.load(Ordering::SeqCst) >= 1);
    desk.called_once(&token, &called_in("chat-1", "list_windows"));
    assert_eq!(
        desk.admitted.load(Ordering::SeqCst),
        4,
        "it asks again once"
    );
    desk.called_once(&token, &called_in("chat-1", "list_windows"));
    assert_eq!(desk.admitted.load(Ordering::SeqCst), 4);
}

#[test]
fn sessions_with_no_conversation_each_ask() {
    let desk = desk();
    let token = desk.signed_in();
    let call = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_windows"}});
    desk.called_once(&token, &call);
    desk.called_once(&token, &call);
    assert_eq!(desk.admitted.load(Ordering::SeqCst), 2);
}

#[test]
fn an_idle_conversation_lets_its_agent_go() {
    let desk = desk();
    let token = desk.signed_in();
    desk.called_once(&token, &called_in("chat-1", "list_windows"));
    desk.now.fetch_add(IDLE_MS, Ordering::SeqCst);
    wait_until(|| desk.gone.load(Ordering::SeqCst) >= 1);
    desk.called_once(&token, &called_in("chat-1", "list_windows"));
    assert_eq!(desk.admitted.load(Ordering::SeqCst), 2);
}

#[test]
fn a_request_for_another_host_or_origin_is_refused() {
    let desk = desk();
    let rebound = desk.ask(
        "GET",
        "/.well-known/oauth-authorization-server",
        &[("Host", "evil.example")],
        "",
    );
    assert_eq!(rebound.status, 403);
    let cross = desk.ask(
        "GET",
        "/.well-known/oauth-authorization-server",
        &[("Origin", "https://evil.example")],
        "",
    );
    assert_eq!(cross.status, 403);
    let local = desk.ask(
        "GET",
        "/.well-known/oauth-authorization-server",
        &[("Host", &format!("localhost:{}", desk.port))],
        "",
    );
    assert_eq!(local.status, 200);
}

#[test]
fn a_client_the_user_declines_is_told_so() {
    let desk = desk();
    let (_, _, page) = desk.authorizing();
    let again = Desk::again(&page);
    desk.asked.lock().unwrap()[0].3.give(Said::Declined);
    let declined = desk.ask("GET", &again, &[], "");
    assert_eq!(declined.status, 200);
    assert!(
        declined.body.contains("Claude wasn't connected"),
        "{}",
        declined.body
    );
    assert!(!declined.body.contains("refresh"));
}

fn wait_until(done: impl Fn() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("it never happened");
}

#[test]
fn an_answer_in_pieces_is_not_held_back_for_an_acknowledgment() {
    let desk = desk();
    // Once it answers, it serves; a connection queued before may not be
    // served the same way.
    assert_eq!(desk.ask("GET", "/authorize", &[], "").status, 400);
    let stream = TcpStream::connect(("127.0.0.1", desk.port)).unwrap();
    stream.set_nodelay(true).unwrap();
    let mut reader = io::BufReader::new(stream.try_clone().unwrap());
    let mut writer = stream;
    // The page is larger than one of the pieces `tiny_http` writes.
    let request = format!(
        "GET /authorize HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
        desk.port
    );
    let quickest = quickest(|| {
        writer.write_all(request.as_bytes()).unwrap();
        let length = answered_length(&mut reader);
        assert!(length > 1024, "the page is {length} bytes");
    });
    assert!(
        quickest < Duration::from_millis(30),
        "the quickest answer took {quickest:?}"
    );
}

/// Reads one answer off `reader` and says how long its body is.
fn answered_length(reader: &mut impl io::BufRead) -> usize {
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length: ") {
            length = value.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    length
}

/// The quickest of five runs of `exchange` on a connection already in use. A
/// piece held back for an acknowledgment holds every run for ~40 ms.
fn quickest(mut exchange: impl FnMut()) -> Duration {
    exchange();
    (0..5)
        .map(|_| {
            let started = std::time::Instant::now();
            exchange();
            started.elapsed()
        })
        .min()
        .unwrap()
}
