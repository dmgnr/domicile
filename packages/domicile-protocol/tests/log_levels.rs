//! The log levels `domicile set-log-level` sets, on the wire.
//!
//! Names are pinned: the CLI, the Settings app and shells use them.

use domicile_protocol::{ChromeMessage, HostMessage, LogLevel, LogLevels, Subsystem};

#[test]
fn levels_for_everything_and_for_a_subsystem_cross_the_wire() {
    let wire = serde_json::json!({
        "type": "set_log_levels",
        "levels": {"all": "debug", "subsystems": {"input": "trace"}},
    });
    let message = ChromeMessage::SetLogLevels {
        levels: LogLevels {
            all: Some(LogLevel::Debug),
            subsystems: [(Subsystem::Input, LogLevel::Trace)].into(),
        },
    };
    assert_eq!(serde_json::to_value(&message).unwrap(), wire);
    assert_eq!(
        serde_json::from_value::<ChromeMessage>(wire).unwrap(),
        message
    );
}

#[test]
fn the_starting_levels_are_an_empty_object() {
    // What `--reset` sends: no level for everything, none for any subsystem.
    let wire = serde_json::json!({"type": "set_log_levels", "levels": {}});
    assert_eq!(
        serde_json::from_value::<ChromeMessage>(wire.clone()).unwrap(),
        ChromeMessage::SetLogLevels {
            levels: LogLevels::default()
        }
    );
    assert_eq!(
        serde_json::to_value(ChromeMessage::SetLogLevels {
            levels: LogLevels::default()
        })
        .unwrap(),
        wire
    );
}

#[test]
fn the_answer_says_why_not() {
    let wire = serde_json::json!({"type": "log_levels_set", "refused": "no"});
    assert_eq!(
        serde_json::from_value::<HostMessage>(wire).unwrap(),
        HostMessage::LogLevelsSet {
            refused: Some("no".to_string())
        }
    );
}

#[test]
fn every_subsystem_has_a_name_and_a_description() {
    // The CLI's help and the Settings app list them from here.
    let names: Vec<&str> = Subsystem::ALL.iter().map(|s| s.name()).collect();
    assert_eq!(
        names,
        [
            "input",
            "displays",
            "windows",
            "rendering",
            "cast",
            "portals",
            "idle",
            "clipboard",
            "notifications",
            "electron",
            "agents",
            "shell",
            "session",
        ]
    );
    for subsystem in Subsystem::ALL {
        assert!(!subsystem.description().is_empty(), "{}", subsystem.name());
        assert_eq!(
            serde_json::to_value(subsystem).unwrap(),
            serde_json::json!(subsystem.name())
        );
    }
}
