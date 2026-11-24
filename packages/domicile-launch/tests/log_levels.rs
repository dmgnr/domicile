//! How `domicile set-log-level` changes the levels already set.

use domicile_launch::log_levels::changed;
use domicile_protocol::{LogLevel, LogLevels, Subsystem};

#[test]
fn a_level_without_subsystems_is_for_everything_and_keeps_theirs() {
    // Turning everything up does not forget the one subsystem turned up more.
    let input_at_trace = LogLevels {
        all: None,
        subsystems: [(Subsystem::Input, LogLevel::Trace)].into(),
    };
    assert_eq!(
        changed(&input_at_trace, LogLevel::Debug, &[]),
        LogLevels {
            all: Some(LogLevel::Debug),
            subsystems: [(Subsystem::Input, LogLevel::Trace)].into(),
        }
    );
}

#[test]
fn a_level_with_subsystems_is_for_each_of_them() {
    let everything_at_info = LogLevels {
        all: Some(LogLevel::Info),
        ..LogLevels::default()
    };
    assert_eq!(
        changed(
            &everything_at_info,
            LogLevel::Trace,
            &[Subsystem::Cast, Subsystem::Portals]
        ),
        LogLevels {
            all: Some(LogLevel::Info),
            subsystems: [
                (Subsystem::Cast, LogLevel::Trace),
                (Subsystem::Portals, LogLevel::Trace)
            ]
            .into(),
        }
    );
}
