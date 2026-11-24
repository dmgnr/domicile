//! Writing entries to the journal over its native protocol.
//!
//! The tests check the bytes journald reads, since a malformed entry is
//! dropped by journald without a word.

use std::os::unix::net::UnixDatagram;

use domicile_launch::journal::{self, Entry, Journal, Priority};

fn entry(message: &str) -> Entry {
    Entry {
        identifier: "domicile-engine",
        priority: Priority::Error,
        message: message.to_string(),
        fields: vec![("CODE_FILE", "dbus/bus.cc".to_string())],
    }
}

#[test]
fn an_entry_is_one_field_per_line() {
    assert_eq!(
        journal::encoded(&entry("the bus is gone")),
        b"PRIORITY=3\n\
          SYSLOG_IDENTIFIER=domicile-engine\n\
          MESSAGE=the bus is gone\n\
          CODE_FILE=dbus/bus.cc\n"
    );
}

#[test]
fn a_value_with_a_newline_is_sent_with_its_length() {
    // A bare newline would end the field and start a malformed one.
    let encoded = journal::encoded(&entry("two\nlines"));
    let mut expected = b"PRIORITY=3\nSYSLOG_IDENTIFIER=domicile-engine\nMESSAGE\n".to_vec();
    expected.extend_from_slice(&9u64.to_le_bytes());
    expected.extend_from_slice(b"two\nlines\n");
    expected.extend_from_slice(b"CODE_FILE=dbus/bus.cc\n");
    assert_eq!(encoded, expected);
}

#[test]
fn a_stream_is_the_journal_when_journal_stream_names_it() {
    // systemd sets `JOURNAL_STREAM` to the device and inode of the stream it
    // connected stdout and stderr to. A child whose stderr was redirected
    // inherits the variable, so the numbers must match.
    assert!(journal::names(Some("8:1234"), 8, 1234));
    assert!(!journal::names(Some("8:1234"), 8, 99));
    assert!(!journal::names(Some("8:1234"), 9, 1234));
    assert!(!journal::names(None, 8, 1234));
}

#[test]
fn a_sent_entry_reaches_the_socket_as_encoded() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let path = dir.path().join("socket");
    let listening = UnixDatagram::bind(&path).expect("the socket binds");

    Journal::at(&path)
        .expect("it connects")
        .send(&entry("the bus is gone"))
        .expect("it sends");

    let mut received = vec![0; 4096];
    let length = listening.recv(&mut received).expect("it arrives");
    assert_eq!(
        &received[..length],
        journal::encoded(&entry("the bus is gone"))
    );
}

#[test]
fn a_stream_names_its_lines_and_lets_them_say_their_own_priority() {
    // As `systemd-cat -t emacs -p info --level-prefix=true` opens one.
    assert_eq!(
        domicile_launch::journal::stream_header("emacs", Priority::Info),
        "emacs\n\n6\n1\n0\n0\n0\n"
    );
}

#[test]
fn a_stream_sends_its_header_then_the_childs_lines() {
    let directory = std::env::temp_dir().join(format!("journal-stream-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&directory);
    let path = directory.join("stdout");
    let _ = std::fs::remove_file(&path);
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let mut stream = domicile_launch::journal::stream(&path, "emacs", Priority::Info).unwrap();
    std::io::Write::write_all(&mut stream, b"Starting Emacs daemon.\n").unwrap();
    drop(stream);
    let (mut heard, _) = listener.accept().unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut heard, &mut text).unwrap();
    assert_eq!(text, "emacs\n\n6\n1\n0\n0\n0\nStarting Emacs daemon.\n");
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn a_child_given_a_stream_writes_to_it_and_is_told_it_is_the_journal() {
    // As systemd does for a service, so the child can tell its stderr is the
    // journal and prefix its lines with their priority.
    let directory = tempfile::tempdir().expect("a temporary directory");
    let path = directory.path().join("stdout");
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let mut child = std::process::Command::new("sh");
    child.args([
        "-c",
        r#"stat -L -c '%d:%i' /proc/self/fd/1; echo "$JOURNAL_STREAM" >&2"#,
    ]);
    journal::give_stream(&mut child, &path, "element-desktop").unwrap();
    let status = child.status().unwrap();
    drop(child);
    assert!(status.success());
    let (mut heard, _) = listener.accept().unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut heard, &mut text).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "element-desktop");
    assert_eq!(
        lines[7], lines[8],
        "JOURNAL_STREAM names the child's stream"
    );
}
