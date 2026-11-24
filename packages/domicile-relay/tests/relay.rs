//! Tests for the relay: desks dial in and prove their key, and clients are
//! passed to them whole.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use std::time::Duration;

use domicile_relay::{hex, label, DeskSays, Relay, RelaySays, PROOF_CONTEXT};
use ed25519_dalek::{Signer, SigningKey};

const ZONE: &str = "relay.example";

/// A relay on ports of its own: (public, desks).
fn relay() -> (u16, u16) {
    let public = TcpListener::bind("127.0.0.1:0").unwrap();
    let desks = TcpListener::bind("127.0.0.1:0").unwrap();
    let ports = (
        public.local_addr().unwrap().port(),
        desks.local_addr().unwrap().port(),
    );
    let counter = AtomicU8::new(0);
    let relay = Relay::new(ZONE, move || [counter.fetch_add(1, Ordering::SeqCst); 32]);
    thread::spawn(move || relay.serve(public, desks));
    ports
}

/// A desk's line-speaking connection to the relay.
struct Line {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
}

impl Line {
    fn to(port: u16) -> Line {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let reader = BufReader::new(stream.try_clone().unwrap());
        Line { stream, reader }
    }

    fn say(&mut self, message: &DeskSays) {
        let mut line = serde_json::to_vec(message).unwrap();
        line.push(b'\n');
        self.stream.write_all(&line).unwrap();
    }

    fn hear(&mut self) -> Option<RelaySays> {
        let mut line = String::new();
        self.reader.read_line(&mut line).ok()?;
        serde_json::from_str(line.trim()).ok()
    }
}

/// Dials in as the desk holding `key`, signing with `signer`: the host it is
/// welcomed at, and its connection.
fn dialed_in(port: u16, key: &SigningKey, signer: &SigningKey) -> (Option<RelaySays>, Line) {
    let mut line = Line::to(port);
    line.say(&DeskSays::Hello {
        key: hex(key.verifying_key().as_bytes()),
    });
    let Some(RelaySays::Challenge { challenge }) = line.hear() else {
        panic!("no challenge");
    };
    let mut signed = PROOF_CONTEXT.to_vec();
    signed.extend(challenge.as_bytes());
    line.say(&DeskSays::Signature {
        signature: hex(&signer.sign(&signed).to_bytes()),
    });
    (line.hear(), line)
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn client_hello(name: &str) -> Vec<u8> {
    let mut list = vec![0];
    list.extend((name.len() as u16).to_be_bytes());
    list.extend(name.as_bytes());
    let mut extension = vec![0, 0];
    extension.extend(((list.len() + 2) as u16).to_be_bytes());
    extension.extend((list.len() as u16).to_be_bytes());
    extension.extend(list);
    let mut body = vec![3, 3];
    body.extend([7; 32]);
    body.extend([0, 0, 2, 0x13, 0x01, 1, 0]);
    body.extend((extension.len() as u16).to_be_bytes());
    body.extend(extension);
    let mut handshake = vec![1];
    handshake.extend(&(body.len() as u32).to_be_bytes()[1..]);
    handshake.extend(body);
    let mut record = vec![22, 3, 1];
    record.extend((handshake.len() as u16).to_be_bytes());
    record.extend(handshake);
    record
}

#[test]
fn a_desk_proving_its_key_is_welcomed_at_its_label() {
    let (_, desks) = relay();
    let (welcome, _line) = dialed_in(desks, &key(1), &key(1));
    assert_eq!(
        welcome,
        Some(RelaySays::Welcome {
            host: format!("{}.{ZONE}", label(key(1).verifying_key().as_bytes()))
        })
    );
    assert_eq!(label(key(1).verifying_key().as_bytes()).len(), 16);
    assert_ne!(
        label(key(1).verifying_key().as_bytes()),
        label(key(2).verifying_key().as_bytes())
    );
}

#[test]
fn a_desk_signing_with_another_key_is_refused() {
    let (_, desks) = relay();
    let (refused, _line) = dialed_in(desks, &key(1), &key(2));
    assert!(
        matches!(refused, Some(RelaySays::Refused { .. })),
        "{refused:?}"
    );
}

#[test]
fn a_client_for_a_desk_is_passed_to_it_whole_both_ways() {
    let (public, desks) = relay();
    let (_, mut control) = dialed_in(desks, &key(1), &key(1));
    let host = format!("{}.{ZONE}", label(key(1).verifying_key().as_bytes()));

    let mut client = TcpStream::connect(("127.0.0.1", public)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let hello = client_hello(&host.to_uppercase());
    client.write_all(&hello).unwrap();
    client.write_all(b"after the hello").unwrap();

    let Some(RelaySays::Open { token }) = control.hear() else {
        panic!("not asked to open");
    };
    let mut opened = Line::to(desks);
    opened.say(&DeskSays::Accept { token });
    let mut got = vec![0; hello.len() + "after the hello".len()];
    opened.reader.read_exact(&mut got).unwrap();
    assert_eq!(&got[..hello.len()], &hello[..]);
    assert_eq!(&got[hello.len()..], b"after the hello");

    opened.stream.write_all(b"from the desk").unwrap();
    opened.stream.shutdown(Shutdown::Write).unwrap();
    let mut answer = String::new();
    client.read_to_string(&mut answer).unwrap();
    assert_eq!(answer, "from the desk");
}

#[test]
fn a_client_for_no_desk_or_another_zone_is_hung_up_on() {
    let (public, desks) = relay();
    let (_, _control) = dialed_in(desks, &key(1), &key(1));
    for host in [
        format!("nobodyhere000000.{ZONE}"),
        format!(
            "{}.elsewhere.example",
            label(key(1).verifying_key().as_bytes())
        ),
        format!("a.{}.{ZONE}", label(key(1).verifying_key().as_bytes())),
    ] {
        let mut client = TcpStream::connect(("127.0.0.1", public)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(&client_hello(&host)).unwrap();
        let mut rest = Vec::new();
        assert_eq!(client.read_to_end(&mut rest).unwrap(), 0, "{host}");
    }
}

#[test]
fn accepting_a_token_nobody_waits_on_gets_nothing() {
    let (_, desks) = relay();
    let mut opened = Line::to(desks);
    opened.say(&DeskSays::Accept {
        token: "00".repeat(32),
    });
    let mut rest = Vec::new();
    assert_eq!(opened.reader.read_to_end(&mut rest).unwrap(), 0);
}

#[test]
fn a_desk_dialing_in_again_replaces_its_old_connection() {
    let (_, desks) = relay();
    let (_, mut old) = dialed_in(desks, &key(1), &key(1));
    let (welcome, _new) = dialed_in(desks, &key(1), &key(1));
    assert!(matches!(welcome, Some(RelaySays::Welcome { .. })));
    assert_eq!(old.hear(), None, "the old connection is hung up");
}

#[test]
fn an_answer_in_pieces_is_not_held_back_for_an_acknowledgment() {
    let (public, desks) = relay();
    let (_, mut control) = dialed_in(desks, &key(1), &key(1));
    let host = format!("{}.{ZONE}", label(key(1).verifying_key().as_bytes()));
    let mut client = TcpStream::connect(("127.0.0.1", public)).unwrap();
    client.set_nodelay(true).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let hello = client_hello(&host);
    client.write_all(&hello).unwrap();
    let Some(RelaySays::Open { token }) = control.hear() else {
        panic!("not asked to open");
    };
    let mut opened = Line::to(desks);
    opened.stream.set_nodelay(true).unwrap();
    opened.say(&DeskSays::Accept { token });
    let mut got = vec![0; hello.len()];
    opened.reader.read_exact(&mut got).unwrap();

    // Each asks and answers in two pieces, as TLS records go, apart enough
    // for the relay to pass each on alone.
    let quickest = quickest(|| {
        client.write_all(b"as").unwrap();
        thread::sleep(Duration::from_millis(5));
        client.write_all(b"ks").unwrap();
        let mut asked = [0; 4];
        opened.reader.read_exact(&mut asked).unwrap();
        assert_eq!(&asked, b"asks");
        opened.stream.write_all(b"head").unwrap();
        thread::sleep(Duration::from_millis(5));
        opened.stream.write_all(b"body").unwrap();
        let mut answer = [0; 8];
        client.read_exact(&mut answer).unwrap();
        assert_eq!(&answer, b"headbody");
    });
    assert!(
        quickest < Duration::from_millis(30),
        "the quickest answer took {quickest:?}"
    );
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
