//! The desk's side of the relay (`domicile-relay`): `domicile mcp --relay`
//! dials it, is given an address named for the desk's key, and takes each
//! connection agents make to that address. TLS ends here, with a certificate
//! only the desk holds ([`super::acme`]); what's inside goes to the HTTP
//! server ([`super::http`]) on this computer. See `docs/AGENTS.md`.

use std::fmt;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use domicile_relay::{hex, unhex, DeskSays, RelaySays, PROOF_CONTEXT};
use ed25519_dalek::{Signer, SigningKey};
use rustls::crypto::ring::sign::any_supported_type;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{ServerConfig, ServerConnection};

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use super::acme::{self, AccountKey, Answer, Challenge, Http};

/// The relay Domicile runs, at `<label>.mcp.domicile-desktop.com`.
pub const RELAY: &str = "mcp.domicile-desktop.com:7444";

/// Let's Encrypt's ACME directory.
pub const LETS_ENCRYPT: &str = "https://acme-v02.api.letsencrypt.org/directory";

/// How old a certificate gets before it is renewed: Let's Encrypt's last 90
/// days, so this leaves a month to retry in.
pub const RENEW_AFTER_MS: u64 = 60 * 24 * 60 * 60 * 1000;

/// How often the desk tells the relay it's still there, so nothing between
/// them drops a quiet connection; and how long the relay has to acknowledge
/// it before the desk gives up on the connection and dials again.
const HEARTBEAT: Duration = Duration::from_secs(30);

/// The longest the desk waits before dialing a relay that hung up again.
const MOST_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// How long the desk first waits to ask for a certificate again after
/// failing; it doubles each time, up to [`MOST_RETRY_ISSUE`]. Kept well
/// inside Let's Encrypt's limit of five failed validations an hour.
const RETRY_ISSUE: Duration = Duration::from_secs(2 * 60);
const MOST_RETRY_ISSUE: Duration = Duration::from_secs(60 * 60);

/// The ALPN protocol an ACME authority checks a TLS-ALPN-01 challenge with.
const ACME_TLS: &[u8] = b"acme-tls/1";

/// The certificates the desk answers with: its own, and while an authority
/// checks it, the challenge's.
#[derive(Default)]
pub struct Certificates {
    current: RwLock<Option<Arc<CertifiedKey>>>,
    challenge: RwLock<Option<Arc<CertifiedKey>>>,
}

impl fmt::Debug for Certificates {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Certificates")
    }
}

impl Certificates {
    /// Answers with `chain_pem`, signed by `key_pem`, from now on.
    pub fn set(&self, chain_pem: &str, key_pem: &str) -> Result<(), String> {
        let chain = CertificateDer::pem_slice_iter(chain_pem.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|why| format!("the certificate is unreadable: {why}"))?;
        if chain.is_empty() {
            return Err("the certificate is empty".into());
        }
        let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
            .map_err(|why| format!("the key is unreadable: {why}"))?;
        let key = any_supported_type(&key).map_err(|why| why.to_string())?;
        *self.current.write().unwrap() = Some(Arc::new(CertifiedKey::new(chain, key)));
        Ok(())
    }

    /// Whether there is a certificate to answer with yet.
    pub fn ready(&self) -> bool {
        self.current.read().unwrap().is_some()
    }

    /// Answers `acme-tls/1` with `challenge`'s certificate, or with none.
    pub(super) fn challenge(&self, challenge: Option<&Challenge>) -> Result<(), String> {
        let certified = match challenge {
            None => None,
            Some(challenge) => {
                let key = rcgen::KeyPair::generate().map_err(|why| why.to_string())?;
                let mut params = rcgen::CertificateParams::new(vec![challenge.host.clone()])
                    .map_err(|why| why.to_string())?;
                params.custom_extensions = vec![rcgen::CustomExtension::new_acme_identifier(
                    &challenge.digest,
                )];
                let cert = params.self_signed(&key).map_err(|why| why.to_string())?;
                let der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
                let signing = any_supported_type(&der).map_err(|why| why.to_string())?;
                Some(Arc::new(CertifiedKey::new(
                    vec![cert.der().clone()],
                    signing,
                )))
            }
        };
        *self.challenge.write().unwrap() = certified;
        Ok(())
    }
}

impl ResolvesServerCert for Certificates {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let checking = hello
            .alpn()
            .is_some_and(|mut offered| offered.any(|protocol| protocol == ACME_TLS));
        if checking {
            self.challenge.read().unwrap().clone()
        } else {
            self.current.read().unwrap().clone()
        }
    }
}

/// TLS for agents' connections, answered from `certificates`.
pub fn server_config(certificates: Arc<Certificates>) -> Arc<ServerConfig> {
    let mut config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default versions")
            .with_no_client_auth()
            .with_cert_resolver(certificates);
    config.alpn_protocols = vec![b"http/1.1".to_vec(), ACME_TLS.to_vec()];
    Arc::new(config)
}

/// The desk dialed in to a relay.
pub struct Dialed {
    /// The address agents reach it at.
    pub host: String,
    control: BufReader<TcpStream>,
}

/// Dials the relay's desk port at `relay` as the desk whose Ed25519 key is
/// `seed`.
pub fn dial(relay: &str, seed: &[u8; 32]) -> io::Result<Dialed> {
    let key = SigningKey::from_bytes(seed);
    let mut stream = TcpStream::connect(relay)?;
    given_up_unacknowledged(&stream, HEARTBEAT)?;
    let mut control = BufReader::new(stream.try_clone()?);
    said(
        &mut stream,
        &DeskSays::Hello {
            key: hex(key.verifying_key().as_bytes()),
        },
    )?;
    let RelaySays::Challenge { challenge } = heard(&mut control)? else {
        return Err(io::Error::other("the relay sent no challenge"));
    };
    let mut signed = PROOF_CONTEXT.to_vec();
    signed.extend(challenge.as_bytes());
    said(
        &mut stream,
        &DeskSays::Signature {
            signature: hex(&key.sign(&signed).to_bytes()),
        },
    )?;
    match heard(&mut control)? {
        RelaySays::Welcome { host } => Ok(Dialed { host, control }),
        RelaySays::Refused { why } => Err(io::Error::other(format!("the relay refused: {why}"))),
        other => Err(io::Error::other(format!("the relay said {other:?}"))),
    }
}

/// Takes each connection the relay asks the desk to open, ending TLS with
/// `config` and passing what's inside to `local`, until the relay hangs up.
pub fn serve(
    mut dialed: Dialed,
    relay: &str,
    config: &Arc<ServerConfig>,
    local: SocketAddr,
) -> io::Result<()> {
    let mut beating = dialed.control.get_ref().try_clone()?;
    thread::spawn(move || {
        // The relay reads past a blank line; one that fails is a hangup,
        // which the reading side sees too.
        while beating.write_all(b"\n").is_ok() {
            thread::sleep(HEARTBEAT);
        }
    });
    loop {
        let token = match heard(&mut dialed.control) {
            Ok(RelaySays::Open { token }) => token,
            Ok(_) => continue,
            Err(why) if why.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(why) => return Err(why),
        };
        let relay = relay.to_string();
        let config = Arc::clone(config);
        thread::spawn(move || {
            let opened = TcpStream::connect(&relay).and_then(|mut stream| {
                // Each write goes out at once. Nagle's algorithm would hold
                // one back until the last is acknowledged, which a peer
                // delays ~40 ms, on every exchange.
                stream.set_nodelay(true)?;
                said(&mut stream, &DeskSays::Accept { token })?;
                Ok(stream)
            });
            if let Ok(stream) = opened {
                let _ = bridged(stream, &config, local);
            }
        });
    }
}

/// Ends TLS on `tls` and passes its plaintext to and from `local`.
fn bridged(mut tls: TcpStream, config: &Arc<ServerConfig>, local: SocketAddr) -> io::Result<()> {
    let mut connection = ServerConnection::new(Arc::clone(config)).map_err(io::Error::other)?;
    while connection.is_handshaking() {
        connection.complete_io(&mut tls)?;
    }
    // The authority checks the certificate, and says nothing.
    if connection.alpn_protocol() == Some(ACME_TLS) {
        connection.send_close_notify();
        let _ = connection.complete_io(&mut tls);
        return Ok(());
    }
    let mut plain = TcpStream::connect(local)?;
    plain.set_nodelay(true)?;
    // The handshake's last read may have brought the agent's first request.
    let mut early = Vec::new();
    match connection.reader().read_to_end(&mut early) {
        Err(why) if why.kind() == io::ErrorKind::WouldBlock => {}
        Err(why) => return Err(why),
        Ok(_) => {}
    }
    plain.write_all(&early)?;
    let connection = Arc::new(Mutex::new(connection));
    let up = {
        let (connection, mut from) = (Arc::clone(&connection), tls.try_clone()?);
        let (mut to, mut answer) = (plain.try_clone()?, tls.try_clone()?);
        thread::spawn(move || -> io::Result<()> {
            let mut read = [0; 16 * 1024];
            loop {
                let count = from.read(&mut read)?;
                if count == 0 {
                    break;
                }
                let mut unread = &read[..count];
                let mut plaintext = Vec::new();
                let closed = {
                    let mut connection = connection.lock().unwrap();
                    let mut closed = false;
                    while !unread.is_empty() {
                        connection.read_tls(&mut unread)?;
                        let state = connection.process_new_packets().map_err(io::Error::other)?;
                        let mut more = vec![0; state.plaintext_bytes_to_read()];
                        connection.reader().read_exact(&mut more)?;
                        plaintext.extend(more);
                        closed |= state.peer_has_closed();
                    }
                    // Records go out in the order they were made, so they
                    // are written under the lock.
                    while connection.wants_write() {
                        connection.write_tls(&mut answer)?;
                    }
                    closed
                };
                to.write_all(&plaintext)?;
                if closed {
                    break;
                }
            }
            to.shutdown(Shutdown::Write)
        })
    };
    let mut from = plain;
    let mut read = [0; 16 * 1024];
    loop {
        let count = from.read(&mut read)?;
        let mut connection = connection.lock().unwrap();
        if count == 0 {
            connection.send_close_notify();
        } else {
            connection.writer().write_all(&read[..count])?;
        }
        while connection.wants_write() {
            connection.write_tls(&mut tls)?;
        }
        if count == 0 {
            break;
        }
    }
    let _ = tls.shutdown(Shutdown::Write);
    let _ = up.join();
    Ok(())
}

/// Sets `TCP_USER_TIMEOUT` on `stream`: data unacknowledged for `after`
/// fails it. A connection made on a network the computer has left gets no
/// acknowledgment, and without this the kernel probes it for good, so the
/// desk never hears that it is gone and never dials again. The heartbeat
/// keeps data in flight, so a dead relay is noticed within two of them.
fn given_up_unacknowledged(stream: &TcpStream, after: Duration) -> io::Result<()> {
    let after = libc::c_uint::try_from(after.as_millis()).map_err(io::Error::other)?;
    // SAFETY: the descriptor is the stream's, open for this call, and the
    // option is the size it says.
    let set = unsafe {
        libc::setsockopt(
            std::os::fd::AsRawFd::as_raw_fd(stream),
            libc::IPPROTO_TCP,
            libc::TCP_USER_TIMEOUT,
            std::ptr::from_ref(&after).cast(),
            std::mem::size_of_val(&after) as libc::socklen_t,
        )
    };
    match set {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

fn said(stream: &mut TcpStream, message: &DeskSays) -> io::Result<()> {
    let mut line = serde_json::to_vec(message).expect("it serializes");
    line.push(b'\n');
    stream.write_all(&line)
}

fn heard(reader: &mut BufReader<TcpStream>) -> io::Result<RelaySays> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    serde_json::from_str(line.trim()).map_err(io::Error::other)
}

/// What the desk keeps of its relay address, in the state directory: its
/// key, its ACME account and its certificate. Only its user may read it.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Kept {
    /// The Ed25519 seed the address is named for, in hex.
    seed: String,
    /// The ACME account's PKCS#8 key, in hex.
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    certificate: Option<KeptCertificate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KeptCertificate {
    host: String,
    chain_pem: String,
    key_pem: String,
    issued_ms: u64,
}

impl Kept {
    /// What `path` keeps, or a new key when it keeps nothing readable.
    pub fn load(path: Option<&Path>) -> Kept {
        let read = path.and_then(|path| fs::read(path).ok());
        let kept: Option<Kept> = read.and_then(|bytes| match serde_json::from_slice(&bytes) {
            Ok(kept) => Some(kept),
            Err(why) => {
                eprintln!("domicile: the relay's keys are unreadable, so the desk gets a new address: {why}");
                None
            }
        });
        match kept {
            Some(kept) if kept.seed().is_some() => kept,
            _ => Kept {
                seed: hex(&secret()),
                ..Kept::default()
            },
        }
    }

    pub fn seed(&self) -> Option<[u8; 32]> {
        unhex(&self.seed).and_then(|seed| seed.try_into().ok())
    }

    /// Writes this to `path`, readable only by its user.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let fresh = path.with_extension("json.new");
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&fresh)?
            .write_all(&serde_json::to_vec_pretty(self).expect("it serializes"))?;
        fs::rename(&fresh, path)
    }

    /// The certificate kept for `host`, if it is younger than
    /// [`RENEW_AFTER_MS`] at `now`.
    fn current(&self, host: &str, now: u64) -> Option<&KeptCertificate> {
        self.certificate
            .as_ref()
            .filter(|kept| kept.host == host && now.saturating_sub(kept.issued_ms) < RENEW_AFTER_MS)
    }
}

fn secret() -> [u8; 32] {
    let mut bytes = [0; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system makes secrets");
    bytes
}

/// How the desk's relay address is doing, for Settings to show; see
/// [`Reach::status`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebStatus {
    /// Where agents reach it, once the relay has said.
    pub address: Option<String>,
    /// Whether it has a certificate, so agents can connect.
    pub ready: bool,
    /// What keeps agents from reaching it, if anything.
    pub problem: Option<String>,
}

impl WebStatus {
    /// What `path` says, if anything readable.
    pub fn load(path: &Path) -> Option<WebStatus> {
        serde_json::from_slice(&fs::read(path).ok()?).ok()
    }
}

/// Where `domicile mcp --relay` writes its [`WebStatus`]:
/// `$XDG_RUNTIME_DIR/domicile/web-agents.json`.
pub fn status_file(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    env("XDG_RUNTIME_DIR").map(|runtime| {
        PathBuf::from(runtime)
            .join("domicile")
            .join("web-agents.json")
    })
}

/// The file beside the status file `status` that asks the desk to try for a
/// certificate again now, rather than when it would: [`retry_now`] touches
/// it.
fn retry_file(status: &Path) -> PathBuf {
    status.with_file_name("web-agents.retry")
}

/// Asks the desk whose status is at `status` to try for its certificate
/// again now, as Settings' Try again does.
pub fn retry_now(status: &Path) -> io::Result<()> {
    let retry = retry_file(status);
    if let Some(directory) = retry.parent() {
        fs::create_dir_all(directory)?;
    }
    fs::write(&retry, format!("{:?}\n", std::time::SystemTime::now()))
}

/// When the file `retry` last changed, if it is there.
fn touched(retry: &Path) -> Option<std::time::SystemTime> {
    fs::metadata(retry)
        .and_then(|metadata| metadata.modified())
        .ok()
}

/// Waits `wait`, or until `retry` is touched after `since`.
fn waited(wait: Duration, retry: Option<&Path>, since: Option<std::time::SystemTime>) {
    let started = Instant::now();
    while started.elapsed() < wait {
        if let Some(retry) = retry {
            if touched(retry) != since {
                return;
            }
        }
        thread::sleep(Duration::from_secs(1).min(wait - started.elapsed()));
    }
}

/// `wait` as people read it: "a minute", "4 minutes", "an hour".
fn in_words(wait: Duration) -> String {
    match wait.as_secs() / 60 {
        0 | 1 => "a minute".to_string(),
        60 => "an hour".to_string(),
        minutes => format!("{minutes} minutes"),
    }
}

/// The status, and where it is written each time it changes.
struct Told {
    path: Option<PathBuf>,
    status: Mutex<WebStatus>,
}

impl Told {
    fn update(&self, change: impl FnOnce(&mut WebStatus)) {
        let mut status = self.status.lock().unwrap();
        change(&mut status);
        let Some(path) = &self.path else { return };
        let written = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| {
                let fresh = path.with_extension("json.new");
                fs::write(&fresh, serde_json::to_vec(&*status).expect("it serializes"))?;
                fs::rename(&fresh, path)
            });
        if let Err(why) = written {
            eprintln!("domicile: could not write {}: {why}", path.display());
        }
    }
}

/// Where and how the desk is reached through a relay.
pub struct Reach {
    /// The relay's desk port, such as [`RELAY`].
    pub relay: String,
    /// Where [`Kept`] is kept, if anywhere.
    pub state: Option<PathBuf>,
    /// The ACME directory certificates come from, such as [`LETS_ENCRYPT`].
    pub directory: String,
    /// The HTTP server agents' requests go to.
    pub local: SocketAddr,
    /// Milliseconds since the epoch.
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// Where [`WebStatus`] is written, if anywhere.
    pub status: Option<PathBuf>,
}

/// Dials in to `reach.relay` and keeps the desk reachable there, in the
/// background: dialing again when it hangs up, and getting and renewing the
/// certificate for its address. Returns the address once the relay answers.
pub fn reach(reach: Reach) -> io::Result<String> {
    let mut kept = Kept::load(reach.state.as_deref());
    let seed = kept.seed().expect("a kept seed reads back");
    let told = Arc::new(Told {
        path: reach.status.clone(),
        status: Mutex::new(WebStatus::default()),
    });
    let dialed = first_dial(&reach.relay, &seed, &told);
    let host = dialed.host.clone();
    if kept.account.is_none() {
        kept.account = Some(hex(AccountKey::generate().pkcs8()));
    }
    if let Some(path) = &reach.state {
        kept.save(path)?;
    }
    let certificates = Arc::new(Certificates::default());
    if let Some(current) = kept.current(&host, (reach.clock)()) {
        if let Err(why) = certificates.set(&current.chain_pem, &current.key_pem) {
            eprintln!(
                "domicile: the kept certificate is unusable, so the desk gets another: {why}"
            );
        }
    }
    told.update(|status| {
        *status = WebStatus {
            address: Some(format!("https://{host}/mcp")),
            ready: certificates.ready(),
            problem: None,
        };
    });
    let config = server_config(Arc::clone(&certificates));
    {
        let (relay, local, told) = (reach.relay.clone(), reach.local, Arc::clone(&told));
        thread::spawn(move || kept_dialed(dialed, &relay, &seed, &config, local, &told));
    }
    {
        let host = host.clone();
        thread::spawn(move || kept_certified(&certificates, kept, &reach, &host, &told));
    }
    Ok(host)
}

/// Dials `relay` until it answers, waiting longer each time. At login the
/// network is often not up yet, so failing here would only start over: the
/// first failure is said once, and the rest are in the status.
fn first_dial(relay: &str, seed: &[u8; 32], told: &Told) -> Dialed {
    let mut backoff = Duration::from_secs(1);
    let mut said = false;
    loop {
        match dial(relay, seed) {
            Ok(dialed) => {
                if said {
                    eprintln!("domicile: reached the relay at {relay}");
                }
                return dialed;
            }
            Err(why) => {
                if !said {
                    eprintln!(
                        "domicile: can't reach the relay at {relay} yet ({why}); trying until it answers"
                    );
                    said = true;
                }
                told.update(|status| {
                    status.problem = Some(format!("Can't reach the relay: {why}"))
                });
            }
        }
        thread::sleep(backoff);
        backoff = (backoff * 2).min(MOST_BACKOFF);
    }
}

/// Serves `dialed`, and dials again each time the relay hangs up, waiting
/// longer each time it can't be reached.
fn kept_dialed(
    mut dialed: Dialed,
    relay: &str,
    seed: &[u8; 32],
    config: &Arc<ServerConfig>,
    local: SocketAddr,
    told: &Told,
) {
    let host = dialed.host.clone();
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        let ended = serve(dialed, relay, config, local);
        eprintln!("domicile: the relay hung up ({ended:?}), dialing again");
        told.update(|status| status.problem = Some("Lost the relay; reconnecting".into()));
        if started.elapsed() > MOST_BACKOFF {
            backoff = Duration::from_secs(1);
        }
        dialed = loop {
            thread::sleep(backoff);
            backoff = (backoff * 2).min(MOST_BACKOFF);
            match dial(relay, seed) {
                Ok(dialed) => break dialed,
                Err(why) => {
                    eprintln!("domicile: could not reach the relay at {relay}: {why}");
                    told.update(|status| {
                        status.problem = Some(format!("Can't reach the relay: {why}"));
                    });
                }
            }
        };
        if dialed.host != host {
            // Its certificate and the address agents have are for the old
            // one; starting over gets both for the new.
            eprintln!(
                "domicile: the relay moved the desk from {host} to {}; starting over",
                dialed.host
            );
            std::process::exit(1);
        }
        told.update(|status| status.problem = None);
    }
}

/// Gets a certificate for `host` when there is none or it is due renewal,
/// and keeps it, forever.
fn kept_certified(
    certificates: &Certificates,
    mut kept: Kept,
    reach: &Reach,
    host: &str,
    told: &Told,
) {
    let account = kept
        .account
        .as_deref()
        .and_then(unhex)
        .and_then(|pkcs8| AccountKey::from_pkcs8(&pkcs8))
        .unwrap_or_else(AccountKey::generate);
    let mut http = Ureq::new();
    let retry = told.path.as_deref().map(retry_file);
    let mut wait = RETRY_ISSUE;
    loop {
        let now = (reach.clock)();
        if let Some(current) = kept.current(host, now) {
            let due = current.issued_ms.saturating_add(RENEW_AFTER_MS) - now;
            // Checked at least daily, so a clock that jumps is caught.
            thread::sleep(Duration::from_millis(due).min(Duration::from_secs(24 * 60 * 60)));
            continue;
        }
        let issued = acme::issue(
            &mut http,
            &reach.directory,
            &account,
            host,
            &mut |challenge| {
                if let Err(why) = certificates.challenge(challenge.as_ref()) {
                    eprintln!("domicile: could not answer the certificate's challenge: {why}");
                }
            },
            &mut || thread::sleep(Duration::from_secs(2)),
        )
        .and_then(|issued| {
            certificates.set(&issued.chain_pem, &issued.key_pem)?;
            Ok(issued)
        });
        match issued {
            Ok(issued) => {
                eprintln!("domicile: got a certificate for {host}");
                wait = RETRY_ISSUE;
                told.update(|status| {
                    status.ready = true;
                    status.problem = None;
                });
                kept.certificate = Some(KeptCertificate {
                    host: host.to_string(),
                    chain_pem: issued.chain_pem,
                    key_pem: issued.key_pem,
                    issued_ms: now,
                });
                if let Some(path) = &reach.state {
                    if let Err(why) = kept.save(path) {
                        eprintln!(
                            "domicile: could not keep the certificate in {}: {why}",
                            path.display()
                        );
                    }
                }
            }
            Err(why) => {
                let when = in_words(wait);
                eprintln!(
                    "domicile: could not get a certificate for {host}, trying again in {when}: {why}"
                );
                // A renewal that fails leaves the current one working.
                if !certificates.ready() {
                    told.update(|status| {
                        status.problem = Some(format!(
                            "Couldn't get a certificate, trying again in {when}: {why}"
                        ));
                    });
                }
                let since = retry.as_deref().and_then(touched);
                waited(wait, retry.as_deref(), since);
                wait = (wait * 2).min(MOST_RETRY_ISSUE);
                if !certificates.ready() {
                    told.update(|status| status.problem = None);
                }
            }
        }
    }
}

/// HTTPS to the ACME authority, with `ureq`.
struct Ureq(ureq::Agent);

/// The most of an authority's answer read.
const LONGEST_ANSWER: u64 = 1024 * 1024;

impl Ureq {
    fn new() -> Ureq {
        Ureq(
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(30)))
                .build()
                .into(),
        )
    }
}

fn answered(answer: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> io::Result<Answer> {
    let mut answer = answer.map_err(io::Error::other)?;
    let header = |name: &str| {
        answer
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let (location, nonce) = (header("location"), header("replay-nonce"));
    let status = answer.status().as_u16();
    let body = answer
        .body_mut()
        .with_config()
        .limit(LONGEST_ANSWER)
        .read_to_vec()
        .map_err(io::Error::other)?;
    Ok(Answer {
        status,
        location,
        nonce,
        body,
    })
}

impl Http for Ureq {
    fn head(&mut self, url: &str) -> io::Result<Answer> {
        answered(self.0.head(url).call())
    }

    fn get(&mut self, url: &str) -> io::Result<Answer> {
        answered(self.0.get(url).call())
    }

    fn post(&mut self, url: &str, body: &[u8]) -> io::Result<Answer> {
        answered(
            self.0
                .post(url)
                .header("Content-Type", "application/jose+json")
                .send(body),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_kept_reads_back_readable_only_by_its_user() {
        let directory = std::env::temp_dir().join(format!("domicile-kept-{}", std::process::id()));
        let path = directory.join("relay.json");
        let mut kept = Kept::load(Some(&path));
        assert!(kept.seed().is_some());
        kept.certificate = Some(KeptCertificate {
            host: "desk.relay.example".into(),
            chain_pem: "chain".into(),
            key_pem: "key".into(),
            issued_ms: 1000,
        });
        kept.save(&path).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions();
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777,
            0o600
        );
        let again = Kept::load(Some(&path));
        assert_eq!(again.seed(), kept.seed());
        assert!(again.current("desk.relay.example", 2000).is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_certificate_is_renewed_when_old_or_for_another_address() {
        let kept = Kept {
            seed: hex(&[1; 32]),
            account: None,
            certificate: Some(KeptCertificate {
                host: "desk.relay.example".into(),
                chain_pem: String::new(),
                key_pem: String::new(),
                issued_ms: 1000,
            }),
        };
        assert!(kept
            .current("desk.relay.example", 1000 + RENEW_AFTER_MS - 1)
            .is_some());
        assert!(kept
            .current("desk.relay.example", 1000 + RENEW_AFTER_MS)
            .is_none());
        assert!(kept.current("other.relay.example", 1000).is_none());
    }

    #[test]
    fn nothing_kept_is_a_new_key_each_time() {
        assert_ne!(Kept::load(None).seed(), Kept::load(None).seed());
    }

    #[test]
    fn the_challenge_is_answered_only_to_acme_and_only_while_set() {
        let certificates = Certificates::default();
        certificates
            .challenge(Some(&Challenge {
                host: "desk.relay.example".into(),
                digest: [7; 32],
            }))
            .unwrap();
        assert!(certificates.challenge.read().unwrap().is_some());
        assert!(!certificates.ready());
        certificates.challenge(None).unwrap();
        assert!(certificates.challenge.read().unwrap().is_none());
    }

    #[test]
    fn a_retry_ends_the_wait_at_once() {
        let state = tempfile::tempdir().expect("a temporary directory");
        let status = state.path().join("domicile/web-agents.json");
        let retry = retry_file(&status);
        retry_now(&status).expect("written");
        let since = touched(&retry);
        let started = Instant::now();
        let waiting = thread::spawn(move || waited(Duration::from_secs(60), Some(&retry), since));
        thread::sleep(Duration::from_millis(1100));
        retry_now(&status).expect("written again");
        waiting.join().expect("waiting does not panic");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_relay_that_stops_acknowledging_the_heartbeat_is_given_up_on() {
        let desks = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = desks.local_addr().unwrap().to_string();
        let public = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let relay = domicile_relay::Relay::new("relay.example", || [1; 32]);
        thread::spawn(move || relay.serve(public, desks));
        let dialed = dial(&address, &[2; 32]).unwrap();
        let mut timeout: libc::c_uint = 0;
        let mut size = std::mem::size_of_val(&timeout) as libc::socklen_t;
        // SAFETY: the descriptor is the control connection's, open for this
        // call, and the option is the size it says.
        let got = unsafe {
            libc::getsockopt(
                std::os::fd::AsRawFd::as_raw_fd(dialed.control.get_ref()),
                libc::IPPROTO_TCP,
                libc::TCP_USER_TIMEOUT,
                std::ptr::from_mut(&mut timeout).cast(),
                &mut size,
            )
        };
        assert_eq!(got, 0);
        assert_eq!(u128::from(timeout), HEARTBEAT.as_millis());
    }

    #[test]
    fn waits_read_in_words() {
        assert_eq!(in_words(RETRY_ISSUE), "2 minutes");
        assert_eq!(in_words(MOST_RETRY_ISSUE), "an hour");
    }
}
