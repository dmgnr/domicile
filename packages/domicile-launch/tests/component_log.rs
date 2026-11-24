//! Where the components' stderr goes.

use std::os::unix::net::UnixDatagram;

use domicile_launch::component_log::{self, Sink};
use domicile_launch::journal::{self, Entry, Journal, Priority};

fn listening() -> (tempfile::TempDir, UnixDatagram, Journal) {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let path = dir.path().join("socket");
    let socket = UnixDatagram::bind(&path).expect("the socket binds");
    let journal = Journal::at(&path).expect("it connects");
    (dir, socket, journal)
}

fn entry(message: String) -> Entry {
    Entry {
        identifier: "domicile-engine",
        priority: Priority::Error,
        message,
        fields: Vec::new(),
    }
}

#[test]
fn on_the_journal_a_line_is_sent_as_its_entry() {
    let (_dir, socket, journal) = listening();
    let mut fallback = Vec::new();

    Sink::Journal(journal).say(&entry("gone".to_string()), "[...] gone", &mut fallback);

    let mut received = vec![0; 4096];
    let length = socket.recv(&mut received).expect("it arrives");
    assert_eq!(
        &received[..length],
        journal::encoded(&entry("gone".to_string()))
    );
    assert_eq!(fallback, b"");
}

#[test]
fn a_line_the_journal_refuses_is_written_as_said() {
    // Larger than any datagram journald takes. Written to stderr, which is the
    // journal's stream, it still arrives, without a priority.
    let (_dir, _socket, journal) = listening();
    let huge = "x".repeat(16 * 1024 * 1024);
    let mut fallback = Vec::new();

    Sink::Journal(journal).say(&entry(huge.clone()), &huge, &mut fallback);

    assert_eq!(fallback, format!("{huge}\n").into_bytes());
}

#[test]
fn off_the_journal_a_line_is_written_as_said() {
    // A terminal, or the file a test redirected stderr to, reads Chromium's
    // own format.
    let mut out = Vec::new();
    Sink::Stderr.say(&entry("gone".to_string()), "[...] gone", &mut out);
    assert_eq!(out, b"[...] gone\n");
}

#[test]
fn the_compositors_stderr_is_its_errors() {
    // Its tracing goes to stdout. Its stderr is panics and fatal errors.
    assert_eq!(
        component_log::compositor("thread 'main' panicked"),
        Entry {
            identifier: "domicile-compositor",
            priority: Priority::Error,
            message: "thread 'main' panicked".to_string(),
            fields: Vec::new(),
        }
    );
}
