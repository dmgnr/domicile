//! The OAuth 2.1 authorization server that `domicile mcp --http` runs for
//! itself, so a client such as claude.ai can sign in to the desk.
//!
//! A client registers itself (RFC 7591) and sends the user to `/authorize`,
//! which waits while the desk asks the user whether it may sign in. Their
//! answer on the desk is what lets it in; what the agent may then reach, the
//! user still decides on the desk at its first tool call. Codes are bound to
//! a PKCE S256 challenge.
//! Clients and refresh tokens are kept, refresh tokens only as hashes, so a
//! client stays signed in when the server restarts. See `docs/AGENTS.md`.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::base64;

/// A request's query or form fields.
pub(super) type Params = HashMap<String, String>;

/// The file in the state directory that keeps signed-in clients.
pub const SIGNED_IN_FILE: &str = "signed-in-agents.json";

/// How long an authorization code may wait to be exchanged.
const CODE_LIFETIME_MS: u64 = 2 * 60 * 1000;
/// How long an access token lasts.
const ACCESS_LIFETIME_MS: u64 = 60 * 60 * 1000;
/// How long a refresh token lasts unused.
const REFRESH_IDLE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// How long the desk asks whether a client may sign in before the ask
/// counts as declined.
pub const ASK_MS: u64 = 2 * 60 * 1000;
/// How much longer than [`ASK_MS`] an ask is kept, so an answer the user
/// gives as the dialog closes still counts.
const ASK_SLACK_MS: u64 = 30 * 1000;
/// The longest name a client may give itself.
const MOST_NAME_CHARS: usize = 40;

/// What the server keeps between runs.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    clients: Vec<Client>,
    refresh: Vec<Refresh>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Client {
    id: String,
    name: String,
    redirect_uris: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Refresh {
    /// The token's SHA-256, in hex.
    hash: String,
    client: String,
    used_ms: u64,
}

/// A sign-in the desk is asking the user about, named by `id`, a secret only
/// the browser that started it holds. It answers only the request it was
/// made for.
struct Asked {
    id: String,
    client: String,
    redirect_uri: String,
    challenge: String,
    state: Option<String>,
    /// The number the page and the dialog both show, so the user allows
    /// the request their own browser made.
    matching: String,
    asked_ms: u64,
    answer: Answer,
}

/// What the user said when the desk asked whether a client may sign in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Said {
    Allowed,
    Declined,
    /// The desk couldn't ask, for this reason.
    Failed(String),
}

/// Where the desk puts the user's answer to a sign-in, once they give it.
#[derive(Debug, Clone, Default)]
pub struct Answer(Arc<Mutex<Option<Said>>>);

impl Answer {
    /// Answers the sign-in with what the user said.
    pub fn give(&self, said: Said) {
        *self.0.lock().unwrap() = Some(said);
    }

    fn given(&self) -> Option<Said> {
        self.0.lock().unwrap().clone()
    }
}

/// An authorization code waiting to be exchanged.
struct Code {
    code: String,
    client: String,
    redirect_uri: String,
    challenge: String,
    issued_ms: u64,
}

struct Access {
    token: String,
    client: String,
    expires_ms: u64,
}

/// A client signed in to the desk: one holding a refresh token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SignedIn {
    pub client: String,
    /// What it calls itself.
    pub name: String,
    /// When it last got tokens.
    pub last_used_ms: u64,
}

/// The clients signed in, as kept at `path`, most recently used first.
pub fn signed_in(path: &Path) -> Vec<SignedIn> {
    let saved = load(path);
    let mut signed_in: Vec<SignedIn> = saved
        .clients
        .iter()
        .filter_map(|client| {
            let last_used_ms = saved
                .refresh
                .iter()
                .filter(|refresh| refresh.client == client.id)
                .map(|refresh| refresh.used_ms)
                .max()?;
            Some(SignedIn {
                client: client.id.clone(),
                name: client.name.clone(),
                last_used_ms,
            })
        })
        .collect();
    signed_in.sort_by_key(|signed_in| std::cmp::Reverse(signed_in.last_used_ms));
    signed_in
}

/// Signs `client` out, as kept at `path`: its refresh tokens are dropped, and
/// a running server drops its access tokens when it sees the file change. It
/// signs in again only once the user allows it on the desk.
pub fn sign_out(path: &Path, client: &str) -> io::Result<()> {
    let mut saved = load(path);
    saved.refresh.retain(|refresh| refresh.client != client);
    write(path, &saved)
}

/// What `/authorize` answers.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Authorized {
    /// Send the browser here: the client, with a code or an error.
    Redirect(String),
    /// The desk is asking the user about the client named, showing
    /// `matching`: come back with `ask` to see what they said.
    Wait {
        client: String,
        ask: String,
        matching: String,
    },
    /// The user declined the client named, didn't answer in time, or the
    /// request names no ask the desk knows.
    Declined { client: String },
    /// The desk couldn't ask the user, for this reason.
    Failed(String),
    /// The request can't go back to the client, which is unknown or named a
    /// redirect it didn't register.
    Refused(String),
}

/// Asks the user on the desk whether the client named may sign in, going
/// back to the site named, showing the matching number its page shows, and
/// gives `Answer` what they say. Returns at once.
pub type Asks = dyn Fn(&str, &str, &str, Answer) + Send;

/// The authorization server.
pub(super) struct Auth {
    issuer: String,
    path: Option<PathBuf>,
    saved: Saved,
    codes: Vec<Code>,
    access: Vec<Access>,
    asked: Vec<Asked>,
    /// When the kept file was last read or written, to see another process
    /// change it.
    seen: Option<(SystemTime, u64)>,
    clock: Box<dyn Fn() -> u64 + Send>,
    random: Box<dyn FnMut() -> [u8; 32] + Send>,
    ask: Box<Asks>,
}

impl Auth {
    /// The server at `issuer`, its base URL, keeping what it must at `path`.
    /// `clock` is the time in milliseconds and `random` makes secrets.
    /// `ask` asks the user on the desk whether a client may sign in.
    pub(super) fn new(
        issuer: String,
        path: Option<PathBuf>,
        clock: impl Fn() -> u64 + Send + 'static,
        random: impl FnMut() -> [u8; 32] + Send + 'static,
        ask: impl Fn(&str, &str, &str, Answer) + Send + 'static,
    ) -> Auth {
        let saved = path.as_deref().map(load).unwrap_or_default();
        let seen = path.as_deref().and_then(modified);
        Auth {
            issuer,
            path,
            saved,
            codes: Vec::new(),
            access: Vec::new(),
            asked: Vec::new(),
            seen,
            clock: Box::new(clock),
            random: Box::new(random),
            ask: Box::new(ask),
        }
    }

    /// The MCP endpoint, which tokens are for.
    pub(super) fn resource(&self) -> String {
        format!("{}/mcp", self.issuer)
    }

    /// RFC 9728's protected resource metadata.
    pub(super) fn resource_metadata(&self) -> Value {
        json!({
            "resource": self.resource(),
            "authorization_servers": [self.issuer],
            "bearer_methods_supported": ["header"],
        })
    }

    /// RFC 8414's authorization server metadata.
    pub(super) fn metadata(&self) -> Value {
        let issuer = &self.issuer;
        json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/authorize"),
            "token_endpoint": format!("{issuer}/token"),
            "registration_endpoint": format!("{issuer}/register"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
        })
    }

    /// Registers a client from its metadata, answering RFC 7591's response
    /// or error.
    pub(super) fn register(&mut self, metadata: &Value) -> Result<Value, Value> {
        let redirect_uris: Vec<String> = match metadata["redirect_uris"].as_array() {
            Some(uris) if !uris.is_empty() => uris
                .iter()
                .map(|uri| uri.as_str().map(str::to_string))
                .collect::<Option<_>>()
                .ok_or_else(|| refusal("invalid_redirect_uri", "redirect_uris are strings"))?,
            _ => return Err(refusal("invalid_redirect_uri", "redirect_uris is required")),
        };
        if let Some(uri) = redirect_uris.iter().find(|uri| !redirectable(uri)) {
            return Err(refusal(
                "invalid_redirect_uri",
                &format!("{uri} is neither https nor on this computer"),
            ));
        }
        let name = metadata["client_name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("An agent")
            .to_string();
        // The desk's dialog names it in its title.
        if name.chars().count() > MOST_NAME_CHARS || name.chars().any(char::is_control) {
            return Err(refusal(
                "invalid_client_metadata",
                &format!(
                    "client_name is over {MOST_NAME_CHARS} characters or holds a control character"
                ),
            ));
        }
        let client = Client {
            id: self.secret(),
            name,
            redirect_uris,
        };
        let answer = json!({
            "client_id": client.id,
            "client_name": client.name,
            "redirect_uris": client.redirect_uris,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        });
        self.saved.clients.push(client);
        self.save();
        Ok(answer)
    }

    /// Answers `/authorize` with `query`. Without an `ask` field, it has the
    /// desk ask the user; with one, it answers with what they said.
    pub(super) fn authorize(&mut self, query: &Params) -> Authorized {
        let field = |name: &str| query.get(name).map(String::as_str).unwrap_or("");
        let Some(client) = self.client(field("client_id")).cloned() else {
            return Authorized::Refused("This app isn't registered with your desktop.".into());
        };
        let redirect_uri = field("redirect_uri");
        // Kept clients are checked too, not only new registrations.
        if !redirectable(redirect_uri)
            || !client.redirect_uris.iter().any(|uri| uri == redirect_uri)
        {
            return Authorized::Refused(format!(
                "{} asked to go back to an address it didn't register.",
                client.name
            ));
        }
        let back = |error: &str| {
            let mut fields = vec![("error", error)];
            if let Some(state) = query.get("state") {
                fields.push(("state", state));
            }
            Authorized::Redirect(with_query(redirect_uri, &fields))
        };
        if field("response_type") != "code" {
            return back("unsupported_response_type");
        }
        if field("code_challenge_method") != "S256" || field("code_challenge").is_empty() {
            return back("invalid_request");
        }
        if query
            .get("resource")
            .is_some_and(|resource| *resource != self.resource())
        {
            return back("invalid_target");
        }
        let now = (self.clock)();
        self.asked
            .retain(|asked| now.saturating_sub(asked.asked_ms) < ASK_MS + ASK_SLACK_MS);
        let Some(id) = query.get("ask") else {
            if self
                .asked
                .iter()
                .any(|asked| asked.answer.given().is_none())
            {
                return Authorized::Failed(
                    "Your desktop is already asking about another sign-in. Answer it there, then try again."
                        .into(),
                );
            }
            let id = self.secret();
            let matching = self.matching();
            let answer = Answer::default();
            self.asked.push(Asked {
                id: id.clone(),
                client: client.id.clone(),
                redirect_uri: redirect_uri.to_string(),
                challenge: field("code_challenge").to_string(),
                state: query.get("state").cloned(),
                matching: matching.clone(),
                asked_ms: now,
                answer: answer.clone(),
            });
            (self.ask)(&client.name, authority(redirect_uri), &matching, answer);
            return Authorized::Wait {
                client: client.name,
                ask: id,
                matching,
            };
        };
        let Some(at) = self.asked.iter().position(|asked| {
            asked.id == *id
                && asked.client == client.id
                && asked.redirect_uri == redirect_uri
                && asked.challenge == field("code_challenge")
                && asked.state.as_ref() == query.get("state")
        }) else {
            return Authorized::Declined {
                client: client.name,
            };
        };
        let Some(said) = self.asked[at].answer.given() else {
            return Authorized::Wait {
                client: client.name,
                ask: id.clone(),
                matching: self.asked[at].matching.clone(),
            };
        };
        // An answer is read once.
        self.asked.remove(at);
        match said {
            Said::Declined => Authorized::Declined {
                client: client.name,
            },
            Said::Failed(why) => Authorized::Failed(why),
            Said::Allowed => {
                let code = self.code(&client.id, redirect_uri, field("code_challenge"));
                let mut fields = vec![("code", code.as_str())];
                if let Some(state) = query.get("state") {
                    fields.push(("state", state));
                }
                Authorized::Redirect(with_query(redirect_uri, &fields))
            }
        }
    }

    /// A new authorization code for `client`, going back to `redirect_uri`,
    /// bound to `challenge`.
    fn code(&mut self, client: &str, redirect_uri: &str, challenge: &str) -> String {
        let code = self.secret();
        self.codes.push(Code {
            code: code.clone(),
            client: client.to_string(),
            redirect_uri: redirect_uri.to_string(),
            challenge: challenge.to_string(),
            issued_ms: (self.clock)(),
        });
        code
    }

    /// Answers `/token` with `form`: tokens, or RFC 6749's error.
    pub(super) fn token(&mut self, form: &Params) -> Result<Value, Value> {
        let field = |name: &str| form.get(name).map(String::as_str).unwrap_or("");
        if form
            .get("resource")
            .is_some_and(|resource| *resource != self.resource())
        {
            return Err(refusal(
                "invalid_target",
                "tokens are only for this desktop",
            ));
        }
        let client = field("client_id").to_string();
        let now = (self.clock)();
        self.reread();
        match field("grant_type") {
            "authorization_code" => {
                let at = self
                    .codes
                    .iter()
                    .position(|code| code.code == field("code"))
                    .ok_or_else(|| refusal("invalid_grant", "the code is unknown or used"))?;
                // Used or not, a code is tried once.
                let code = self.codes.remove(at);
                if now.saturating_sub(code.issued_ms) > CODE_LIFETIME_MS {
                    return Err(refusal("invalid_grant", "the code expired"));
                }
                if code.client != client || code.redirect_uri != field("redirect_uri") {
                    return Err(refusal("invalid_grant", "the code was for another client"));
                }
                if challenge(field("code_verifier")) != code.challenge {
                    return Err(refusal("invalid_grant", "the code verifier does not match"));
                }
                Ok(self.tokens(client, now))
            }
            "refresh_token" => {
                let hash = hashed(field("refresh_token"));
                self.saved
                    .refresh
                    .retain(|refresh| now.saturating_sub(refresh.used_ms) <= REFRESH_IDLE_MS);
                let at = self
                    .saved
                    .refresh
                    .iter()
                    .position(|refresh| refresh.hash == hash && refresh.client == client)
                    .ok_or_else(|| refusal("invalid_grant", "the refresh token is unknown"))?;
                // Each refresh token is used once.
                self.saved.refresh.remove(at);
                Ok(self.tokens(client, now))
            }
            _ => Err(refusal(
                "unsupported_grant_type",
                "authorization_code or refresh_token",
            )),
        }
    }

    /// The client `token` signs in, if it is an access token this server
    /// issued that is still good.
    pub(super) fn client_of(&mut self, token: &str) -> Option<String> {
        self.reread();
        let now = (self.clock)();
        self.access.retain(|access| access.expires_ms > now);
        self.access
            .iter()
            .find(|access| access.token == token)
            .map(|access| access.client.clone())
    }

    fn tokens(&mut self, client: String, now: u64) -> Value {
        let access = self.secret();
        let refresh = self.secret();
        self.access.push(Access {
            token: access.clone(),
            client: client.clone(),
            expires_ms: now + ACCESS_LIFETIME_MS,
        });
        self.saved.refresh.push(Refresh {
            hash: hashed(&refresh),
            client,
            used_ms: now,
        });
        self.save();
        json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_LIFETIME_MS / 1000,
            "refresh_token": refresh,
        })
    }

    fn client(&self, id: &str) -> Option<&Client> {
        self.saved.clients.iter().find(|client| client.id == id)
    }

    /// Four digits for the user to match between page and dialog.
    fn matching(&mut self) -> String {
        let bytes = (self.random)();
        format!(
            "{:04}",
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 10_000
        )
    }

    fn secret(&mut self) -> String {
        base64url(&(self.random)())
    }

    /// Takes up what another process, such as Settings signing a client
    /// out, wrote to the kept file: a client with no refresh token left loses
    /// its access tokens too.
    fn reread(&mut self) {
        let Some(path) = &self.path else { return };
        let modified = modified(path);
        if modified == self.seen {
            return;
        }
        self.seen = modified;
        self.saved = load(path);
        let saved = &self.saved;
        self.access.retain(|access| {
            saved
                .refresh
                .iter()
                .any(|refresh| refresh.client == access.client)
        });
    }

    fn save(&mut self) {
        let Some(path) = &self.path else { return };
        let written = write(path, &self.saved);
        self.seen = modified(path);
        if let Err(why) = written {
            eprintln!(
                "domicile: could not save signed-in agents to {}: {why}",
                path.display()
            );
        }
    }
}

/// When `path` changed, and its length, which tells two writes apart within
/// one tick of a coarse clock.
fn modified(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

fn write(path: &Path, saved: &Saved) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let fresh = path.with_extension("json.new");
    fs::write(
        &fresh,
        serde_json::to_vec_pretty(saved).expect("it serializes"),
    )?;
    fs::rename(&fresh, path)
}

fn load(path: &Path) -> Saved {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|why| {
            eprintln!(
                "domicile: {} is unreadable, so every agent signs in again: {why}",
                path.display()
            );
            Saved::default()
        }),
        Err(_) => Saved::default(),
    }
}

fn refusal(error: &str, description: &str) -> Value {
    json!({"error": error, "error_description": description})
}

/// Whether a client may be sent back to `uri`: over https, or to this
/// computer, and with no user in its address, which would make the site the
/// dialog names misleading.
fn redirectable(uri: &str) -> bool {
    let loopback = ["http://localhost", "http://127.0.0.1", "http://[::1]"];
    !authority(uri).contains('@')
        && (uri.starts_with("https://")
            || loopback.iter().any(|base| {
                uri.strip_prefix(base)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
            }))
}

/// `uri` with `fields` added to its query.
fn with_query(uri: &str, fields: &[(&str, &str)]) -> String {
    let joined = fields
        .iter()
        .map(|(name, value)| format!("{name}={}", escaped(value)))
        .collect::<Vec<_>>()
        .join("&");
    let separator = if uri.contains('?') { '&' } else { '?' };
    format!("{uri}{separator}{joined}")
}

/// `value` percent-encoded for a query.
fn escaped(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// Where `uri` goes, for the user to check: `claude.ai` for
/// `https://claude.ai/api/mcp/auth_callback`.
fn authority(uri: &str) -> &str {
    let after_scheme = uri.split_once("://").map_or(uri, |(_, rest)| rest);
    after_scheme
        .split(['/', '?', '#'])
        .next()
        .expect("a split has a first piece")
}

/// PKCE's S256 challenge for `verifier`.
fn challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

fn hashed(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn base64url(bytes: &[u8]) -> String {
    base64(bytes)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;

    const ISSUER: &str = "https://desk.example";
    const VERIFIER: &str = "a-verifier-long-enough-to-be-a-real-one-0123456789";

    /// What the desk asked the user: the client, the site, the matching
    /// number and where the answer goes.
    type AskedUser = (String, String, String, Answer);

    /// A server whose clock `now` sets, whose secrets count up, and what
    /// it asked the user.
    struct Desk {
        auth: Auth,
        now: Arc<AtomicU64>,
        asked: Arc<Mutex<Vec<AskedUser>>>,
    }

    fn desk(path: Option<PathBuf>) -> Desk {
        let now = Arc::new(AtomicU64::new(1_000));
        let asked = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::new(AtomicU8::new(0));
        let auth = Auth::new(
            ISSUER.to_string(),
            path,
            {
                let now = Arc::clone(&now);
                move || now.load(Ordering::SeqCst)
            },
            move || [counter.fetch_add(1, Ordering::SeqCst); 32],
            {
                let asked = Arc::clone(&asked);
                move |client: &str, site: &str, matching: &str, answer: Answer| {
                    asked.lock().unwrap().push((
                        client.to_string(),
                        site.to_string(),
                        matching.to_string(),
                        answer,
                    ));
                }
            },
        );
        Desk { auth, now, asked }
    }

    impl Desk {
        /// Starts `query`'s sign-in: the id to come back with.
        fn started(&mut self, query: &Params) -> String {
            let Authorized::Wait { ask, .. } = self.auth.authorize(query) else {
                panic!("the desk didn't ask");
            };
            ask
        }

        /// The user's last answer goes to `said`.
        fn says(&self, said: Said) {
            self.asked.lock().unwrap().last().unwrap().3.give(said);
        }

        fn registered(&mut self) -> String {
            self.auth
                .register(&json!({
                    "client_name": "Claude",
                    "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
                }))
                .unwrap()["client_id"]
                .as_str()
                .unwrap()
                .to_string()
        }

        fn code(&mut self, client: &str) -> String {
            let ask = self.started(&asking(client));
            self.says(Said::Allowed);
            let Authorized::Redirect(to) = self.auth.authorize(&coming_back(client, &ask)) else {
                panic!("not let in");
            };
            query_of(&to)["code"].clone()
        }

        fn exchanged(&mut self, client: &str, code: &str) -> Result<Value, Value> {
            self.auth.token(&params(&[
                ("grant_type", "authorization_code"),
                ("client_id", client),
                ("code", code),
                ("redirect_uri", "https://claude.ai/api/mcp/auth_callback"),
                ("code_verifier", VERIFIER),
            ]))
        }
    }

    fn params(fields: &[(&str, &str)]) -> Params {
        fields
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    fn asking(client: &str) -> Params {
        params(&[
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", "https://claude.ai/api/mcp/auth_callback"),
            ("code_challenge", &challenge(VERIFIER)),
            ("code_challenge_method", "S256"),
            ("state", "a state&more"),
            ("resource", "https://desk.example/mcp"),
        ])
    }

    /// [`asking`], come back to see what the user said about `ask`.
    fn coming_back(client: &str, ask: &str) -> Params {
        let mut query = asking(client);
        query.insert("ask".into(), ask.into());
        query
    }

    fn query_of(uri: &str) -> HashMap<String, String> {
        let (_, query) = uri.split_once('?').unwrap();
        query
            .split('&')
            .map(|field| {
                let (name, value) = field.split_once('=').unwrap();
                let value = value.replace("%20", " ").replace("%26", "&");
                (name.to_string(), value)
            })
            .collect()
    }

    #[test]
    fn metadata_names_its_endpoints_and_only_s256() {
        let desk = desk(None);
        let metadata = desk.auth.metadata();
        assert_eq!(metadata["issuer"], ISSUER);
        assert_eq!(metadata["token_endpoint"], "https://desk.example/token");
        assert_eq!(
            metadata["registration_endpoint"],
            "https://desk.example/register"
        );
        assert_eq!(
            metadata["code_challenge_methods_supported"],
            json!(["S256"])
        );
        assert_eq!(
            desk.auth.resource_metadata()["resource"],
            "https://desk.example/mcp"
        );
    }

    #[test]
    fn a_client_registers_only_https_or_loopback_redirects() {
        let mut desk = desk(None);
        let refused = desk
            .auth
            .register(&json!({"redirect_uris": ["http://evil.example/back"]}))
            .unwrap_err();
        assert_eq!(refused["error"], "invalid_redirect_uri");
        assert!(desk
            .auth
            .register(&json!({"redirect_uris": ["http://localhost.evil.example/back"]}))
            .is_err());
        assert!(desk
            .auth
            .register(&json!({"redirect_uris": ["https://claude.ai@evil.example/back"]}))
            .is_err());
        for name in ["Claude\nAllow everything", &"Claude".repeat(10)] {
            assert_eq!(
                desk.auth
                    .register(
                        &json!({"client_name": name, "redirect_uris": ["https://claude.ai/back"]})
                    )
                    .unwrap_err()["error"],
                "invalid_client_metadata"
            );
        }
        let registered = desk
            .auth
            .register(&json!({"redirect_uris": ["http://127.0.0.1:4567/callback"]}))
            .unwrap();
        assert_eq!(registered["client_name"], "An agent");
        assert_eq!(registered["token_endpoint_auth_method"], "none");
    }

    #[test]
    fn authorize_refuses_an_unknown_client_or_redirect_without_going_back() {
        let mut desk = desk(None);
        assert!(matches!(
            desk.auth.authorize(&asking("nobody")),
            Authorized::Refused(_)
        ));
        let client = desk.registered();
        let mut elsewhere = asking(&client);
        elsewhere.insert("redirect_uri".into(), "https://evil.example/".into());
        assert!(matches!(
            desk.auth.authorize(&elsewhere),
            Authorized::Refused(_)
        ));
    }

    #[test]
    fn authorize_sends_a_bad_request_back_with_its_state() {
        let mut desk = desk(None);
        let client = desk.registered();
        let mut plain = asking(&client);
        plain.insert("code_challenge_method".into(), "plain".into());
        let Authorized::Redirect(to) = desk.auth.authorize(&plain) else {
            panic!("not sent back");
        };
        assert_eq!(query_of(&to)["error"], "invalid_request");
        assert_eq!(query_of(&to)["state"], "a state&more");
    }

    #[test]
    fn allowing_on_the_desk_lets_one_client_in_once() {
        let mut desk = desk(None);
        let client = desk.registered();
        let Authorized::Wait { ask, matching, .. } = desk.auth.authorize(&asking(&client)) else {
            panic!("the desk didn't ask");
        };
        {
            let asked = desk.asked.lock().unwrap();
            assert_eq!(asked.len(), 1);
            assert_eq!(
                (
                    asked[0].0.as_str(),
                    asked[0].1.as_str(),
                    asked[0].2.as_str()
                ),
                ("Claude", "claude.ai", matching.as_str())
            );
        }
        assert_eq!(matching.len(), 4);
        assert_eq!(
            desk.auth.authorize(&coming_back(&client, &ask)),
            Authorized::Wait {
                client: "Claude".into(),
                ask: ask.clone(),
                matching,
            },
            "it waits until the user answers"
        );
        desk.says(Said::Allowed);
        let Authorized::Redirect(to) = desk.auth.authorize(&coming_back(&client, &ask)) else {
            panic!("not let in");
        };
        assert!(to.starts_with("https://claude.ai/api/mcp/auth_callback?code="));
        assert_eq!(query_of(&to)["state"], "a state&more");
        assert_eq!(
            desk.auth.authorize(&coming_back(&client, &ask)),
            Authorized::Declined {
                client: "Claude".into()
            },
            "an answer lets in once"
        );
    }

    #[test]
    fn declining_failing_or_not_answering_lets_nothing_in() {
        let mut desk = desk(None);
        let client = desk.registered();
        let declined = desk.started(&asking(&client));
        desk.says(Said::Declined);
        assert_eq!(
            desk.auth.authorize(&coming_back(&client, &declined)),
            Authorized::Declined {
                client: "Claude".into()
            }
        );
        let failed = desk.started(&asking(&client));
        desk.says(Said::Failed("no shell".into()));
        assert_eq!(
            desk.auth.authorize(&coming_back(&client, &failed)),
            Authorized::Failed("no shell".into())
        );
        let unanswered = desk.started(&asking(&client));
        desk.now.fetch_add(ASK_MS + ASK_SLACK_MS, Ordering::SeqCst);
        desk.says(Said::Allowed);
        assert!(matches!(
            desk.auth.authorize(&coming_back(&client, &unanswered)),
            Authorized::Declined { .. }
        ));
    }

    #[test]
    fn an_answer_lets_in_only_the_request_it_was_asked_for() {
        let mut desk = desk(None);
        let client = desk.registered();
        let ask = desk.started(&asking(&client));
        desk.says(Said::Allowed);
        let mut other_state = coming_back(&client, &ask);
        other_state.insert("state".into(), "another".into());
        let mut other_challenge = coming_back(&client, &ask);
        other_challenge.insert("code_challenge".into(), challenge("another verifier"));
        for other in [other_state, other_challenge] {
            assert!(matches!(
                desk.auth.authorize(&other),
                Authorized::Declined { .. }
            ));
        }
        assert!(matches!(
            desk.auth.authorize(&coming_back(&client, "made-up")),
            Authorized::Declined { .. }
        ));
    }

    #[test]
    fn the_desk_asks_about_one_sign_in_at_a_time() {
        let mut desk = desk(None);
        let client = desk.registered();
        desk.started(&asking(&client));
        assert!(matches!(
            desk.auth.authorize(&asking(&client)),
            Authorized::Failed(_)
        ));
        assert_eq!(desk.asked.lock().unwrap().len(), 1);
        desk.says(Said::Declined);
        desk.started(&asking(&client));
    }

    #[test]
    fn a_code_and_its_verifier_get_tokens_once() {
        let mut desk = desk(None);
        let client = desk.registered();
        let code = desk.code(&client);
        let tokens = desk.exchanged(&client, &code).unwrap();
        assert_eq!(tokens["token_type"], "Bearer");
        assert!(desk
            .auth
            .client_of(tokens["access_token"].as_str().unwrap())
            .is_some());
        assert!(desk.auth.client_of("made-up").is_none());
        assert_eq!(
            desk.exchanged(&client, &code).unwrap_err()["error"],
            "invalid_grant"
        );
    }

    #[test]
    fn a_code_with_the_wrong_verifier_or_too_late_gets_nothing() {
        let mut desk = desk(None);
        let client = desk.registered();
        let code = desk.code(&client);
        let wrong = desk.auth.token(&params(&[
            ("grant_type", "authorization_code"),
            ("client_id", &client),
            ("code", &code),
            ("redirect_uri", "https://claude.ai/api/mcp/auth_callback"),
            ("code_verifier", "another verifier"),
        ]));
        assert_eq!(wrong.unwrap_err()["error"], "invalid_grant");
        let late = desk.code(&client);
        desk.now.fetch_add(CODE_LIFETIME_MS + 1, Ordering::SeqCst);
        assert_eq!(
            desk.exchanged(&client, &late).unwrap_err()["error"],
            "invalid_grant"
        );
    }

    #[test]
    fn an_access_token_lasts_an_hour() {
        let mut desk = desk(None);
        let client = desk.registered();
        let code = desk.code(&client);
        let tokens = desk.exchanged(&client, &code).unwrap();
        desk.now.fetch_add(ACCESS_LIFETIME_MS, Ordering::SeqCst);
        assert!(desk
            .auth
            .client_of(tokens["access_token"].as_str().unwrap())
            .is_none());
    }

    #[test]
    fn a_refresh_token_works_once_and_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("signed-in.json");
        let mut first = desk(Some(path.clone()));
        let client = first.registered();
        let code = first.code(&client);
        let refresh = first.exchanged(&client, &code).unwrap()["refresh_token"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!fs::read_to_string(&path).unwrap().contains(&refresh));

        let mut second = desk(Some(path));
        let refreshing = params(&[
            ("grant_type", "refresh_token"),
            ("client_id", &client),
            ("refresh_token", &refresh),
        ]);
        let tokens = second.auth.token(&refreshing).unwrap();
        assert!(second
            .auth
            .client_of(tokens["access_token"].as_str().unwrap())
            .is_some());
        assert_eq!(
            second.auth.token(&refreshing).unwrap_err()["error"],
            "invalid_grant"
        );
    }

    #[test]
    fn signing_a_client_out_ends_its_tokens_in_a_running_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("signed-in.json");
        let mut desk = desk(Some(path.clone()));
        let client = desk.registered();
        let code = desk.code(&client);
        let tokens = desk.exchanged(&client, &code).unwrap();
        let access = tokens["access_token"].as_str().unwrap().to_string();
        assert_eq!(
            signed_in(&path),
            vec![SignedIn {
                client: client.clone(),
                name: "Claude".into(),
                last_used_ms: 1_000,
            }]
        );

        sign_out(&path, &client).unwrap();
        assert_eq!(signed_in(&path), Vec::new());
        assert!(desk.auth.client_of(&access).is_none());
        let refreshing = params(&[
            ("grant_type", "refresh_token"),
            ("client_id", &client),
            ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
        ]);
        assert_eq!(
            desk.auth.token(&refreshing).unwrap_err()["error"],
            "invalid_grant"
        );
    }

    #[test]
    fn tokens_for_another_resource_are_refused() {
        let mut desk = desk(None);
        let client = desk.registered();
        let mut elsewhere = asking(&client);
        elsewhere.insert("resource".into(), "https://other.example/mcp".into());
        let Authorized::Redirect(to) = desk.auth.authorize(&elsewhere) else {
            panic!("not sent back");
        };
        assert_eq!(query_of(&to)["error"], "invalid_target");
    }
}
