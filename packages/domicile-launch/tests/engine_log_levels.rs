//! The engine's side of `domicile set-log-level`: Chromium's minimum severity
//! and `--vmodule` patterns for the levels asked for.

use domicile_launch::engine_log_levels::{engine_levels, starting_switches, EngineLevels};
use domicile_protocol::{LogLevel, LogLevels, Subsystem};

fn all(level: LogLevel) -> LogLevels {
    LogLevels {
        all: Some(level),
        ..LogLevels::default()
    }
}

#[test]
fn no_levels_are_the_engines_starting_ones() {
    // `spawn::engine` starts it at ERROR with no patterns.
    assert_eq!(
        engine_levels(&LogLevels::default()),
        EngineLevels {
            min_level: 2,
            vmodule: String::new()
        }
    );
}

#[test]
fn error_warn_and_info_are_chromiums_severities() {
    assert_eq!(engine_levels(&all(LogLevel::Error)).min_level, 2);
    assert_eq!(engine_levels(&all(LogLevel::Warn)).min_level, 1);
    assert_eq!(engine_levels(&all(LogLevel::Info)).min_level, 0);
    assert_eq!(engine_levels(&all(LogLevel::Info)).vmodule, "");
}

#[test]
fn debug_and_trace_turn_on_domiciles_vlogs_and_no_one_elses() {
    // `--v` would turn on every VLOG in Chromium.
    let debug = engine_levels(&all(LogLevel::Debug));
    // VERBOSE, so the shell's `console.debug` shows too.
    assert_eq!(debug.min_level, -1);
    assert!(
        debug.vmodule.starts_with("*/domicile/*=1,"),
        "{}",
        debug.vmodule
    );
    let trace = engine_levels(&all(LogLevel::Trace));
    assert!(
        trace.vmodule.starts_with("*/domicile/*=4,"),
        "{}",
        trace.vmodule
    );
}

#[test]
fn a_subsystem_turns_on_only_its_files() {
    let levels = LogLevels {
        all: None,
        subsystems: [(Subsystem::Input, LogLevel::Debug)].into(),
    };
    let engine = engine_levels(&levels);
    // INFO, so the subsystem's `LOG(INFO)` lines show.
    assert_eq!(engine.min_level, 0);
    assert!(engine.vmodule.contains("libinput*=1"), "{}", engine.vmodule);
    assert!(
        !engine.vmodule.contains("drm_modeset"),
        "{}",
        engine.vmodule
    );
    assert!(
        !engine.vmodule.contains("*/domicile/*"),
        "{}",
        engine.vmodule
    );
}

#[test]
fn the_most_verbose_level_sets_the_minimum_severity() {
    let levels = LogLevels {
        all: Some(LogLevel::Warn),
        subsystems: [(Subsystem::Displays, LogLevel::Info)].into(),
    };
    assert_eq!(engine_levels(&levels).min_level, 0);
}

#[test]
fn a_subsystem_below_info_adds_no_patterns() {
    // A VLOG is below INFO, so `warn` for a subsystem has nothing to turn on.
    let levels = LogLevels {
        all: None,
        subsystems: [(Subsystem::Displays, LogLevel::Warn)].into(),
    };
    assert_eq!(
        engine_levels(&levels),
        EngineLevels {
            min_level: 1,
            vmodule: String::new()
        }
    );
}

#[test]
fn a_restarted_engine_starts_at_the_levels_set_before() {
    assert!(starting_switches(&LogLevels::default()).is_empty());
    let levels = LogLevels {
        all: None,
        subsystems: [(Subsystem::Clipboard, LogLevel::Debug)].into(),
    };
    let set = engine_levels(&levels);
    assert_eq!(
        starting_switches(&levels),
        [
            format!("--log-level={}", set.min_level),
            format!("--vmodule={}", set.vmodule)
        ]
    );
}

#[test]
fn the_shell_at_debug_shows_its_console_debug_and_no_other_subsystem_does() {
    // The shell's `console.debug` is Chromium's VERBOSE, -1. VLOGs are not
    // held back by the minimum severity, so other subsystems need only INFO.
    let shell = LogLevels {
        all: None,
        subsystems: [(Subsystem::Shell, LogLevel::Debug)].into(),
    };
    assert_eq!(engine_levels(&shell).min_level, -1);
    let input = LogLevels {
        all: None,
        subsystems: [(Subsystem::Input, LogLevel::Trace)].into(),
    };
    assert_eq!(engine_levels(&input).min_level, 0);
}
