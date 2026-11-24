//! Tests for how the launcher's own messages are leveled and written.

use domicile_launch::launcher_log::{line, shown, threshold};
use domicile_protocol::{LogLevel, LogLevels, Subsystem};

#[test]
fn on_the_journal_a_line_carries_its_priority() {
    assert_eq!(
        line(LogLevel::Error, "the engine died", true),
        "<3>domicile: the engine died"
    );
    assert_eq!(line(LogLevel::Warn, "x", true), "<4>domicile: x");
    assert_eq!(line(LogLevel::Info, "x", true), "<6>domicile: x");
    assert_eq!(line(LogLevel::Debug, "x", true), "<7>domicile: x");
    assert_eq!(line(LogLevel::Trace, "x", true), "<7>domicile: x");
}

#[test]
fn elsewhere_a_line_is_as_said() {
    assert_eq!(
        line(LogLevel::Error, "the engine died", false),
        "domicile: the engine died"
    );
}

#[test]
fn errors_alone_show_until_the_session_or_everything_is_turned_up() {
    let quiet = threshold(&LogLevels::default());
    assert!(shown(LogLevel::Error, quiet));
    assert!(!shown(LogLevel::Warn, quiet));

    let everything = threshold(&LogLevels {
        all: Some(LogLevel::Info),
        ..LogLevels::default()
    });
    assert!(shown(LogLevel::Info, everything));
    assert!(!shown(LogLevel::Debug, everything));

    let session = threshold(&LogLevels {
        all: Some(LogLevel::Info),
        subsystems: [(Subsystem::Session, LogLevel::Debug)].into(),
    });
    assert!(shown(LogLevel::Debug, session));

    let elsewhere = threshold(&LogLevels {
        all: None,
        subsystems: [(Subsystem::Input, LogLevel::Trace)].into(),
    });
    assert!(!shown(LogLevel::Warn, elsewhere));
}
