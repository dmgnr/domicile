//! The lines a desktop said lately, kept for `domicile logs` and
//! `domicile export-logs` when they did not go to the journal.

use domicile_launch::journal::{Entry, Priority};
use domicile_launch::recent_log::{compositor_line, from_journal, Recent, Said};

fn said(message: &str) -> Said {
    Said {
        at: 0,
        identifier: "domicile-engine".to_string(),
        priority: Priority::Error,
        message: message.to_string(),
    }
}

#[test]
fn a_line_says_when_who_and_how_bad() {
    // 2026-11-27 17:12:03.123456 UTC, said in UTC-8.
    let said = Said {
        at: 1_795_799_523_123_456,
        identifier: "domicile-shell".to_string(),
        priority: Priority::Warning,
        message: "no layout".to_string(),
    };
    assert_eq!(
        said.line(-8 * 3600),
        "2026-11-27 09:12:03.123 domicile-shell warning: no layout"
    );
}

#[test]
fn it_keeps_the_newest_lines_it_has_room_for() {
    let mut recent = Recent::holding(2);
    for message in ["one", "two", "three"] {
        recent.keep(said(message));
    }
    let kept: Vec<_> = recent.lines().map(|said| said.message.as_str()).collect();
    assert_eq!(kept, ["two", "three"]);
}

#[test]
fn an_entry_is_kept_as_it_was_sent() {
    let entry = Entry {
        identifier: "domicile-engine",
        priority: Priority::Critical,
        message: "gone".to_string(),
        fields: vec![("CODE_FILE", "a.cc".to_string())],
    };
    let said = Said::of(&entry, 7);
    assert_eq!(said.identifier, "domicile-engine");
    assert_eq!(said.priority, Priority::Critical);
    assert_eq!(said.message, "gone");
    assert_eq!(said.at, 7);
}

#[test]
fn the_compositors_tracing_keeps_its_level() {
    // Off the journal the compositor formats its tracing to stdout.
    let said = compositor_line(
        "2026-11-21T17:12:03.123456Z  WARN domicile_compositor::input: no seat",
        9,
    );
    assert_eq!(said.identifier, "domicile-compositor");
    assert_eq!(said.priority, Priority::Warning);
    assert_eq!(said.message, "domicile_compositor::input: no seat");
    for (level, priority) in [
        ("ERROR", Priority::Error),
        ("INFO", Priority::Info),
        ("DEBUG", Priority::Debug),
        ("TRACE", Priority::Debug),
    ] {
        assert_eq!(
            compositor_line(&format!("2026-11-21T17:12:03Z {level} x: y"), 0).priority,
            priority
        );
    }
}

#[test]
fn a_compositor_line_without_a_level_is_an_error() {
    // Such as a panic's message, which is worth seeing.
    let said = compositor_line("thread 'main' panicked at src/main.rs:3:5", 0);
    assert_eq!(said.priority, Priority::Error);
    assert_eq!(said.message, "thread 'main' panicked at src/main.rs:3:5");
}

#[test]
fn a_journal_entry_reads_as_the_same_line() {
    let said = from_journal(
        r#"{"__REALTIME_TIMESTAMP":"1795799523123456","SYSLOG_IDENTIFIER":"domicile-engine","PRIORITY":"3","MESSAGE":"the bus is gone"}"#,
    )
    .unwrap();
    assert_eq!(
        said,
        Said {
            at: 1_795_799_523_123_456,
            identifier: "domicile-engine".to_string(),
            priority: Priority::Error,
            message: "the bus is gone".to_string(),
        }
    );
}

#[test]
fn a_journal_message_that_is_not_utf8_is_read_lossily() {
    // journalctl writes such a message as an array of bytes.
    let said = from_journal(
        r#"{"__REALTIME_TIMESTAMP":"1","SYSLOG_IDENTIFIER":"domicile","PRIORITY":"6","MESSAGE":[104,105,255]}"#,
    )
    .unwrap();
    assert_eq!(said.message, "hi\u{fffd}");
    assert_eq!(said.priority, Priority::Info);
}

#[test]
fn a_journal_entry_without_a_message_is_refused() {
    assert!(from_journal(r#"{"__REALTIME_TIMESTAMP":"1"}"#).is_err());
}

#[test]
fn the_journal_is_read_for_every_part_this_boot() {
    assert_eq!(
        domicile_launch::recent_log::journal_args(),
        [
            "--user",
            "--boot",
            "--identifier=domicile",
            "--identifier=domicile-compositor",
            "--identifier=domicile-engine",
            "--identifier=domicile-shell",
            "--identifier=domicile-relay",
        ]
    );
}
