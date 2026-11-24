//! The relay that lets an agent on the web, such as claude.ai, reach a desk
//! behind a router, without seeing what they say.
//!
//! A desk dials the relay's desk port and proves it holds an Ed25519 key;
//! its address is `<label>.<zone>`, the label named for that key
//! ([`label`]). A client connecting to that address on the public port is
//! passed to the desk whole: the relay reads only the server name in its TLS
//! ClientHello ([`sni`]), asks the desk to open a connection back, and
//! splices the two. TLS ends on the desk, with a certificate the desk holds,
//! so the relay never has a key that decrypts the traffic. See
//! `docs/AGENTS.md`.

pub mod options;
pub mod sni;

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use sni::{server_name, Hello};

/// What a desk signs, before the relay's challenge, to prove its key.
pub const PROOF_CONTEXT: &[u8] = b"domicile-relay v1 desk ";

/// How long the relay waits for a client's hello or a desk's next line, and
/// for a desk to open a connection it asked for.
pub const PATIENCE: Duration = Duration::from_secs(10);

/// The longest line a desk may send.
const LONGEST_LINE: u64 = 4096;

/// What a desk sends the relay, one JSON object a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeskSays {
    /// Starts a desk's connection: its public key, in hex.
    Hello { key: String },
    /// Its signature, in hex, of [`PROOF_CONTEXT`] and the challenge.
    Signature { signature: String },
    /// Starts a connection the relay asked it to open; after this line, the
    /// client's bytes.
    Accept { token: String },
}

/// What the relay sends a desk, one JSON object a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelaySays {
    /// Bytes for the desk to sign, in hex.
    Challenge {
        challenge: String,
    },
    /// The desk is reachable at `host`.
    Welcome {
        host: String,
    },
    /// A client is waiting: open a connection and accept `token`.
    Open {
        token: String,
    },
    Refused {
        why: String,
    },
}

/// The label of the desk holding `key`: 16 letters and digits from its
/// SHA-256, so an address can't be claimed without the key.
pub fn label(key: &[u8; 32]) -> String {
    const LETTERS: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let digest = Sha256::digest(key);
    // 80 bits, five at a time.
    let bits = digest[..10]
        .iter()
        .fold(0u128, |bits, byte| bits << 8 | u128::from(*byte));
    (0..16)
        .rev()
        .map(|at| char::from(LETTERS[(bits >> (at * 5) & 31) as usize]))
        .collect()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// A desk dialed in.
struct Desk {
    /// The relay's side of its connection, to ask it to open more.
    control: TcpStream,
    /// Which connection this is, so an old one ending doesn't drop a new.
    generation: u64,
}

/// A client waiting for its desk to open a connection.
struct Waiting {
    client: TcpStream,
    /// What was read of it to find its desk, for the desk to read first.
    read: Vec<u8>,
}

/// The relay for addresses under `zone`.
pub struct Relay {
    zone: String,
    desks: Mutex<HashMap<String, Desk>>,
    waiting: Mutex<HashMap<String, Waiting>>,
    random: Mutex<Box<dyn FnMut() -> [u8; 32] + Send>>,
    generations: AtomicU64,
}

impl Relay {
    /// `random` makes challenges and tokens.
    pub fn new(zone: &str, random: impl FnMut() -> [u8; 32] + Send + 'static) -> Arc<Relay> {
        Arc::new(Relay {
            zone: zone.trim_matches('.').to_ascii_lowercase(),
            desks: Mutex::new(HashMap::new()),
            waiting: Mutex::new(HashMap::new()),
            random: Mutex::new(Box::new(random)),
            generations: AtomicU64::new(0),
        })
    }

    /// Serves clients on `public` and desks on `desks`, each connection on a
    /// thread of its own, until either listener fails.
    pub fn serve(self: &Arc<Self>, public: TcpListener, desks: TcpListener) -> io::Result<()> {
        let relay = Arc::clone(self);
        let deskside = thread::spawn(move || -> io::Result<()> {
            for desk in desks.incoming() {
                let relay = Arc::clone(&relay);
                let desk = desk?;
                thread::spawn(move || relay.desk(desk));
            }
            Ok(())
        });
        for client in public.incoming() {
            let relay = Arc::clone(self);
            let client = client?;
            thread::spawn(move || relay.client(client));
        }
        deskside.join().unwrap_or(Ok(()))
    }

    fn secret(&self) -> String {
        hex(&(self.random.lock().unwrap())())
    }

    /// A client on the public port: find its desk and ask it to connect.
    fn client(self: Arc<Self>, mut client: TcpStream) {
        // Each write goes out at once. Nagle's algorithm would hold one back
        // until the last is acknowledged, which a peer delays ~40 ms.
        if client.set_nodelay(true).is_err() {
            return;
        }
        let _ = client.set_read_timeout(Some(PATIENCE));
        let mut read = Vec::new();
        let host = loop {
            let mut chunk = [0; 2048];
            match client.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(count) => read.extend(&chunk[..count]),
            }
            match server_name(&read) {
                Hello::Named(host) => break host,
                Hello::Unnamed => return,
                Hello::Incomplete if read.len() > sni::MOST_BYTES => return,
                Hello::Incomplete => {}
            }
        };
        let Some(label) = host
            .strip_suffix(&self.zone)
            .and_then(|rest| rest.strip_suffix('.'))
            .filter(|label| !label.contains('.'))
        else {
            return;
        };
        let token = self.secret();
        let asked = {
            let mut desks = self.desks.lock().unwrap();
            let Some(desk) = desks.get_mut(label) else {
                return;
            };
            said(
                &mut desk.control,
                &RelaySays::Open {
                    token: token.clone(),
                },
            )
        };
        if asked.is_err() {
            return;
        }
        let _ = client.set_read_timeout(None);
        self.waiting
            .lock()
            .unwrap()
            .insert(token.clone(), Waiting { client, read });
        // A desk that doesn't open it in time leaves the client hung up on.
        thread::sleep(PATIENCE);
        if let Some(waiting) = self.waiting.lock().unwrap().remove(&token) {
            let _ = waiting.client.shutdown(Shutdown::Both);
        }
    }

    /// A connection on the desk port: a desk dialing in, or opening a
    /// connection it was asked to.
    fn desk(self: Arc<Self>, stream: TcpStream) {
        // As in `client`: no write waits on an acknowledgment.
        if stream.set_nodelay(true).is_err() {
            return;
        }
        let _ = stream.set_read_timeout(Some(PATIENCE));
        let Ok(mut reader) = stream.try_clone().map(BufReader::new) else {
            return;
        };
        let mut stream = stream;
        match heard(&mut reader) {
            Some(DeskSays::Hello { key }) => self.dialed_in(stream, reader, &key),
            Some(DeskSays::Accept { token }) => {
                let Some(waiting) = self.waiting.lock().unwrap().remove(&token) else {
                    return;
                };
                let _ = stream.set_read_timeout(None);
                if stream.write_all(&waiting.read).is_err() {
                    return;
                }
                // Anything the desk sent after its line is the client's.
                let early = reader.buffer().to_vec();
                spliced(waiting.client, stream, &early);
            }
            _ => {
                let _ = said(
                    &mut stream,
                    &RelaySays::Refused {
                        why: "start with hello or accept".into(),
                    },
                );
            }
        }
    }

    fn dialed_in(&self, mut stream: TcpStream, mut reader: BufReader<TcpStream>, key: &str) {
        let refuse = |stream: &mut TcpStream, why: &str| {
            let _ = said(stream, &RelaySays::Refused { why: why.into() });
        };
        let Some(key) = unhex(key)
            .and_then(|key| <[u8; 32]>::try_from(key).ok())
            .and_then(|key| VerifyingKey::from_bytes(&key).ok())
        else {
            return refuse(&mut stream, "the key is not an Ed25519 public key");
        };
        let challenge = self.secret();
        if said(
            &mut stream,
            &RelaySays::Challenge {
                challenge: challenge.clone(),
            },
        )
        .is_err()
        {
            return;
        }
        let Some(DeskSays::Signature { signature }) = heard(&mut reader) else {
            return refuse(&mut stream, "sign the challenge");
        };
        let mut signed = PROOF_CONTEXT.to_vec();
        signed.extend(challenge.as_bytes());
        let proved = unhex(&signature)
            .and_then(|bytes| Signature::from_slice(&bytes).ok())
            .is_some_and(|signature| key.verify_strict(&signed, &signature).is_ok());
        if !proved {
            return refuse(&mut stream, "the signature does not match the key");
        }
        let label = label(key.as_bytes());
        let host = format!("{label}.{}", self.zone);
        if said(&mut stream, &RelaySays::Welcome { host }).is_err() {
            return;
        }
        let Ok(control) = stream.try_clone() else {
            return;
        };
        let generation = self.generations.fetch_add(1, Ordering::SeqCst);
        // The newest connection for a key wins; the old one is hung up.
        if let Some(old) = self.desks.lock().unwrap().insert(
            label.clone(),
            Desk {
                control,
                generation,
            },
        ) {
            let _ = old.control.shutdown(Shutdown::Both);
        }
        // It says nothing more; its connection ending is it going.
        let _ = stream.set_read_timeout(None);
        let _ = io::copy(&mut reader, &mut io::sink());
        let mut desks = self.desks.lock().unwrap();
        if desks
            .get(&label)
            .is_some_and(|desk| desk.generation == generation)
        {
            desks.remove(&label);
        }
    }
}

fn said(stream: &mut TcpStream, message: &RelaySays) -> io::Result<()> {
    let mut line = serde_json::to_vec(message).expect("it serializes");
    line.push(b'\n');
    stream.write_all(&line)
}

fn heard(reader: &mut BufReader<TcpStream>) -> Option<DeskSays> {
    let mut line = String::new();
    reader
        .by_ref()
        .take(LONGEST_LINE)
        .read_line(&mut line)
        .ok()?;
    serde_json::from_str(line.trim()).ok()
}

/// Passes bytes both ways until either side ends, `early` going to the
/// client first.
fn spliced(client: TcpStream, desk: TcpStream, early: &[u8]) {
    let (Ok(mut client_reads), Ok(mut desk_writes)) = (client.try_clone(), desk.try_clone()) else {
        return;
    };
    let up = thread::spawn(move || {
        let _ = io::copy(&mut client_reads, &mut desk_writes);
        let _ = desk_writes.shutdown(Shutdown::Write);
    });
    let (mut desk_reads, mut client_writes) = (desk, client);
    if client_writes.write_all(early).is_ok() {
        // The desk's reader may have read past its line; that went first.
        let _ = io::copy(&mut desk_reads, &mut client_writes);
    }
    let _ = client_writes.shutdown(Shutdown::Write);
    let _ = up.join();
}
