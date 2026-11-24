//! Turning the engine's stderr into journal entries.
//!
//! Chromium writes `[pid:tid:time:LEVEL:file:line] message`. Each line becomes
//! an entry at the matching priority, so `journalctl -p err` finds the
//! engine's errors and not its chatter.

use domicile_launch::engine_log::EngineLog;
use domicile_launch::journal::{Entry, Priority};

fn one(line: &str) -> Entry {
    EngineLog::new().entry(line)
}

#[test]
fn a_line_keeps_its_message_and_says_where_it_came_from() {
    assert_eq!(
        one("[875919:875919:0907/043334.201180:ERROR:dbus/bus.cc:405] the bus is gone"),
        Entry {
            identifier: "domicile-engine",
            priority: Priority::Error,
            message: "the bus is gone".to_string(),
            fields: vec![
                ("CODE_FILE", "dbus/bus.cc".to_string()),
                ("CODE_LINE", "405".to_string()),
                ("DOMICILE_PID", "875919".to_string()),
            ],
        }
    );
}

#[test]
fn each_level_maps_to_its_syslog_priority() {
    for (level, priority) in [
        ("VERBOSE1", Priority::Debug),
        ("INFO", Priority::Info),
        ("WARNING", Priority::Warning),
        ("ERROR", Priority::Error),
        ("FATAL", Priority::Critical),
    ] {
        assert_eq!(
            one(&format!("[1:1:1013/000000.000000:{level}:a.cc:1] said")).priority,
            priority,
            "{level}"
        );
    }
}

#[test]
fn the_older_file_and_line_form_is_read_too() {
    // Upstream code paths that format their own prefix still write `file(line)`.
    let entry = one("[1:1:1005/094108.1:FATAL:content/x.cc(12)] gone");
    assert_eq!(
        entry.fields[..2],
        [
            ("CODE_FILE", "content/x.cc".to_string()),
            ("CODE_LINE", "12".to_string()),
        ]
    );
}

#[test]
fn the_shells_console_is_the_shells_log() {
    // A shell author reads `journalctl -t domicile-shell`, not the engine's.
    let entry = one(
        "[1:1:1013/000000.000000:ERROR:CONSOLE:30] \"no layout\", source: domicile://shell/main.js (30)",
    );
    assert_eq!(entry.identifier, "domicile-shell");
    assert_eq!(entry.priority, Priority::Error);
    assert_eq!(
        entry.message,
        "\"no layout\", source: domicile://shell/main.js (30)"
    );
}

#[test]
fn a_shell_loggers_subsystem_is_a_field() {
    // `logger("notifications").error(...)` from the SDK starts its message
    // with the name, so `journalctl DOMICILE_SUBSYSTEM=notifications` finds it.
    let entry = one(
        "[1:1:1013/000000.000000:VERBOSE1:CONSOLE:12] \"[notifications] shown 3\", source: domicile://shell/main.js (12)",
    );
    assert_eq!(entry.priority, Priority::Debug);
    assert!(
        entry
            .fields
            .contains(&("DOMICILE_SUBSYSTEM", "notifications".to_string())),
        "{:?}",
        entry.fields
    );
    let plain = one(
        "[1:1:1013/000000.000000:ERROR:CONSOLE:30] \"no layout\", source: domicile://shell/main.js (30)",
    );
    assert!(
        !plain
            .fields
            .iter()
            .any(|(name, _)| *name == "DOMICILE_SUBSYSTEM"),
        "{:?}",
        plain.fields
    );
}

#[test]
fn a_pages_console_stays_the_engines() {
    let entry =
        one("[1:1:1013/000000.000000:INFO:CONSOLE:3] \"hi\", source: https://example.com/a.js (3)");
    assert_eq!(entry.identifier, "domicile-engine");
}

#[test]
fn a_line_without_a_prefix_continues_the_one_before() {
    // A multi-line message, such as a stack, keeps its priority.
    let mut log = EngineLog::new();
    log.entry(
        "[1:1:1013/000000.000000:ERROR:CONSOLE:30] \"boom\", source: domicile://shell/main.js (30)",
    );
    let next = log.entry("    at main (domicile://shell/main.js:30:5)");
    assert_eq!(next.identifier, "domicile-shell");
    assert_eq!(next.priority, Priority::Error);
    assert_eq!(next.message, "    at main (domicile://shell/main.js:30:5)");
}

#[test]
fn a_line_without_a_prefix_before_any_other_is_a_warning() {
    // A library writing to stderr directly, such as Mesa or Fontconfig. It
    // has no level, and is rare enough to be worth seeing.
    let entry = one("Fontconfig error: no such file");
    assert_eq!(entry.identifier, "domicile-engine");
    assert_eq!(entry.priority, Priority::Warning);
    assert_eq!(entry.fields, []);
}

#[test]
fn a_library_line_after_an_error_is_a_warning_not_an_error() {
    // V8 says a flag it rejects on stderr itself, between Chromium's lines.
    let mut log = EngineLog::new();
    log.entry("[1:1:1121/090510.773:ERROR:dbus/bus.cc:405] the bus is gone");
    let v8 = log.entry("Error: unrecognized flag --scavenger_direct_old_allocation");
    assert_eq!(v8.identifier, "domicile-engine");
    assert_eq!(v8.priority, Priority::Warning);
}

#[test]
fn the_rest_of_a_console_message_continues_it_until_its_source() {
    let mut log = EngineLog::new();
    log.entry("[1:1:1121/090510.773:ERROR:CONSOLE:88] \"[Background] channel: stable");
    let middle = log.entry("os: Linux ()");
    let end = log.entry("build: 8.11 (81100)\", source: chrome-extension://a/background.js (88)");
    let after = log.entry("Fontconfig error: no such file");
    assert_eq!(
        [middle.priority, end.priority, after.priority],
        [Priority::Error, Priority::Error, Priority::Warning]
    );
}

mod gate {
    use domicile_launch::engine_log::EngineLog;
    use domicile_launch::engine_log_levels::Gate;
    use domicile_protocol::{LogLevel, LogLevels, Subsystem};

    fn levels(all: Option<LogLevel>, subsystems: &[(Subsystem, LogLevel)]) -> Gate {
        Gate::new(&LogLevels {
            all,
            subsystems: subsystems.iter().copied().collect(),
        })
    }

    /// The messages of `lines` that show through `gate`.
    fn shown(gate: &Gate, lines: &[&str]) -> Vec<String> {
        let mut log = EngineLog::new();
        lines
            .iter()
            .filter_map(|line| log.through(line, gate))
            .map(|entry| entry.message)
            .collect()
    }

    const POINTER: &str =
        "[1:1:1121/093029.359:INFO:ui/ozone/platform/drm/domicile/pointer_hiding.cc:88] domicile: hiding the pointer";
    const WEBVIEW: &str =
        "[1:1:1121/093041.923:INFO:extensions/browser/guest_view/web_view/web_view_guest.cc:12] domicile: <webview> SetFocused received=1";
    const EVDEV: &str =
        "[1:1:1121/093041.923:INFO:ui/events/ozone/evdev/domicile/fling_tracker.cc:40] domicile: a fling";
    const PAGE: &str = "[1:1:1121/093043.697:INFO:CONSOLE:1] \"FetchHttpApi: --> GET https://example.com/sync\", source: vector://vector/webapp/init.js (1)";
    const EXTENSION_ERROR: &str = "[1:1:1121/093039.296:ERROR:CONSOLE:88] \"[AppIntegration] Desktop app port disconnected.\", source: chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/background/background.js (88)";
    const SHELL_DEBUG: &str =
        "[1:1:1121/093043.697:VERBOSE1:CONSOLE:4] \"[bar] drew\", source: domicile://shell/main.js (4)";
    const PAGE_DEBUG: &str =
        "[1:1:1121/093043.697:VERBOSE1:CONSOLE:4] \"drew\", source: https://example.com/a.js (4)";
    const ENGINE_ERROR: &str = "[1:1:1121/093029.359:ERROR:dbus/bus.cc:405] the bus is gone";
    const VLOG: &str =
        "[1:1:1121/093029.359:VERBOSE1:ui/ozone/platform/drm/gpu/drm_thread.cc:9] Got display event";

    #[test]
    fn a_subsystem_turned_up_shows_its_files_and_no_others() {
        let input = levels(None, &[(Subsystem::Input, LogLevel::Debug)]);
        assert_eq!(
            shown(&input, &[POINTER, WEBVIEW, EVDEV, PAGE, ENGINE_ERROR]),
            [
                "domicile: hiding the pointer",
                "domicile: a fling",
                "the bus is gone"
            ]
        );
    }

    #[test]
    fn everything_turned_up_shows_every_file_and_the_pages_consoles() {
        let all = levels(Some(LogLevel::Info), &[]);
        assert_eq!(shown(&all, &[POINTER, WEBVIEW, PAGE]).len(), 3);
    }

    #[test]
    fn a_pages_or_extensions_console_stays_out_by_default_even_its_errors() {
        let starting = Gate::default();
        assert_eq!(
            shown(&starting, &[PAGE, EXTENSION_ERROR, ENGINE_ERROR]),
            ["the bus is gone"]
        );
        let warn = levels(Some(LogLevel::Warn), &[]);
        assert_eq!(shown(&warn, &[EXTENSION_ERROR]), Vec::<String>::new());
    }

    #[test]
    fn the_shell_at_debug_shows_its_console_and_no_pages() {
        let shell = levels(None, &[(Subsystem::Shell, LogLevel::Debug)]);
        assert_eq!(
            shown(&shell, &[SHELL_DEBUG, PAGE_DEBUG, PAGE]),
            ["\"[bar] drew\", source: domicile://shell/main.js (4)"]
        );
    }

    #[test]
    fn a_vlog_shows_when_its_subsystem_asked_for_it() {
        let displays = levels(None, &[(Subsystem::Displays, LogLevel::Debug)]);
        assert_eq!(shown(&displays, &[VLOG]), ["Got display event"]);
        assert_eq!(shown(&Gate::default(), &[VLOG]), Vec::<String>::new());
    }

    #[test]
    fn a_line_without_a_prefix_follows_the_line_it_continues() {
        let starting = Gate::default();
        assert_eq!(
            shown(
                &starting,
                &[PAGE, "    at f (a.js:1)", ENGINE_ERROR, "    at g (b.js:2)"]
            ),
            ["the bus is gone", "    at g (b.js:2)"]
        );
    }
}

#[test]
fn an_engine_started_at_its_own_levels_shows_every_line() {
    // A guard or a developer passing `--log-level=0` reads the engine's INFO.
    use domicile_launch::engine_log::raises_logging;
    assert!(raises_logging(Some("--no-sandbox --log-level=0")));
    assert!(raises_logging(Some("--vmodule=drm_modeset=1")));
    assert!(raises_logging(Some("--v=1")));
    assert!(!raises_logging(Some(
        "--no-sandbox --disable-features=Vulkan"
    )));
    assert!(!raises_logging(None));
}
