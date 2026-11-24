//! The compositor's side of `domicile set-log-level`: which modules each
//! [`Subsystem`] covers, and the filter the levels make.
//!
//! The filter is reloaded in place ([`LogFilter`]), so the levels change
//! without a restart. See `docs/LOGGING.md`.

use domicile_protocol::{LogLevels, Subsystem};
use tracing_subscriber::{reload, EnvFilter, Registry};

/// The modules under `src/` each subsystem covers. Every module is in exactly
/// one; a test checks this, so a new module has to pick one.
const MODULES: [(Subsystem, &[&str]); 13] = [
    (
        Subsystem::Input,
        &[
            "seat",
            "keymap",
            "modifiers",
            "touch",
            "pinch",
            "swipe",
            "emulated_input",
            "eis",
            "pointer_constraints",
            "relative_pointer",
            "shortcuts_inhibit",
            "text_input",
            "cursor_surface",
            "input_trace",
        ],
    ),
    (
        Subsystem::Displays,
        &[
            "outputs",
            "configured_displays",
            "screens",
            "scale",
            "gamma",
            "gamma_control",
            "night_light",
            "color_management",
            "display_sleep",
            "blanking",
            "pnp_ids",
            "virtual_monitors",
            "primary_node",
        ],
    ),
    (
        Subsystem::Windows,
        &[
            "windows",
            "xdg_shell",
            "xdg_foreign",
            "decorations",
            "popups",
            "window_geometry",
            "foreign_toplevels",
            "configure_answers",
            "once_per_window",
            "clients",
            "client_requests",
            "activation",
            "anchors",
            "app_scope",
            "spawning",
            "launches",
            "peer_process",
            "subsurfaces",
            "synced_moves",
        ],
    ),
    (
        Subsystem::Rendering,
        &[
            "frame_callbacks",
            "frame_descriptor",
            "frame_pacing",
            "frame_publishing",
            "frame_report",
            "engine",
            "engine_buffers",
            "engine_damage",
            "engine_imports",
            "engine_lingering",
            "engine_pump",
            "engine_retired",
            "engine_session",
            "engine_surfaces",
            "engine_waiting",
            "dmabuf_descriptor",
            "dmabuf_import",
            "gbm",
            "shm_upload",
            "uploads",
            "held_frames",
            "presentations",
            "latency",
            "latency_run",
            "timing_window",
            "memory_frames",
            "buffer_transform",
            "client_damage",
            "surface_commit",
            "viewport",
            "thread_priority",
            "spike_probes",
            "which_engine",
        ],
    ),
    (
        Subsystem::Cast,
        &["casting", "compositor_casts", "screencopy"],
    ),
    (Subsystem::Portals, &["portals", "bus_names"]),
    (
        Subsystem::Idle,
        &[
            "idle",
            "screen_saver",
            "lock",
            "locking",
            "unlock_backoff",
            "pam",
        ],
    ),
    (Subsystem::Clipboard, &["clipboard", "selections"]),
    (Subsystem::Notifications, &["notifications", "bell", "tray"]),
    (Subsystem::Electron, &["electron_apps"]),
    (Subsystem::Agents, &["web_agents"]),
    (
        Subsystem::Shell,
        &[
            "chrome_connection",
            "chrome_hub",
            "protocol_trace",
            "chrome_editor",
            "outbound",
            "reply",
            "restatement",
            "shell_config",
            "config_adoption",
            "theme_turnover",
            "watchers",
            "file_indexing",
            "log_levels",
        ],
    ),
    (Subsystem::Session, &["main", "logind"]),
];

/// Targets outside `domicile_compositor::` and the subsystem they belong to.
///
/// `engine_pump` hears every engine event; its lines about other subsystems
/// take these targets, so they follow those subsystems' levels.
const TARGETS: [(Subsystem, &str); 6] = [
    (Subsystem::Rendering, "domicile::engine::spike"),
    (Subsystem::Displays, "domicile::engine::displays"),
    (Subsystem::Windows, "domicile::engine::windows"),
    (Subsystem::Input, "domicile::engine::input"),
    (Subsystem::Cast, "domicile::engine::cast"),
    (Subsystem::Clipboard, "domicile::engine::clipboard"),
];

/// The filter for `levels`, over the `starting` one (`RUST_LOG`, or `info`).
///
/// `all` applies to Domicile's own targets, not to Smithay or other crates,
/// which keep their starting levels.
pub fn directives(starting: &str, levels: &LogLevels) -> String {
    let all = levels.all.into_iter().flat_map(|level| {
        ["domicile_compositor", "domicile"].map(|target| format!("{target}={}", level.name()))
    });
    let subsystems = levels.subsystems.iter().flat_map(|(subsystem, level)| {
        targets(*subsystem).map(move |target| format!("{target}={}", level.name()))
    });
    std::iter::once(starting.to_string())
        .chain(all)
        .chain(subsystems)
        .collect::<Vec<_>>()
        .join(",")
}

/// Every target `subsystem` covers.
fn targets(subsystem: Subsystem) -> impl Iterator<Item = String> {
    MODULES
        .iter()
        .filter(move |(covered, _)| *covered == subsystem)
        .flat_map(|(_, modules)| modules.iter())
        .map(|module| format!("domicile_compositor::{module}"))
        .chain(
            TARGETS
                .iter()
                .filter(move |(covered, _)| *covered == subsystem)
                .map(|(_, target)| target.to_string()),
        )
}

/// The running filter, and the starting directives it was built from.
pub struct LogFilter {
    starting: String,
    handle: reload::Handle<EnvFilter, Registry>,
}

impl LogFilter {
    pub fn new(starting: String, handle: reload::Handle<EnvFilter, Registry>) -> Self {
        LogFilter { starting, handle }
    }

    /// Logs at `levels` from now on.
    pub fn set(&self, levels: &LogLevels) -> Result<(), String> {
        let filter = EnvFilter::try_new(directives(&self.starting, levels))
            .map_err(|why| format!("the levels make no filter: {why}"))?;
        self.handle
            .reload(filter)
            .map_err(|why| format!("the filter did not reload: {why}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domicile_protocol::LogLevel;

    #[test]
    fn no_levels_leaves_the_starting_filter() {
        assert_eq!(directives("warn", &LogLevels::default()), "warn");
    }

    #[test]
    fn a_level_for_everything_covers_domicile_and_not_smithay() {
        // Smithay at `debug` logs every request; nobody turning the desktop's
        // logs up wants that.
        let levels = LogLevels {
            all: Some(LogLevel::Debug),
            ..LogLevels::default()
        };
        assert_eq!(
            directives("warn", &levels),
            "warn,domicile_compositor=debug,domicile=debug"
        );
    }

    #[test]
    fn a_subsystems_level_covers_its_modules() {
        let levels = LogLevels {
            all: None,
            subsystems: [(Subsystem::Clipboard, LogLevel::Trace)].into(),
        };
        assert_eq!(
            directives("warn", &levels),
            "warn,domicile_compositor::clipboard=trace,domicile_compositor::selections=trace,domicile::engine::clipboard=trace"
        );
    }

    #[test]
    fn a_subsystem_covers_targets_outside_the_crate() {
        assert!(targets(Subsystem::Rendering).any(|target| target == "domicile::engine::spike"));
    }

    #[test]
    fn every_directive_parses() {
        let levels = LogLevels {
            all: Some(LogLevel::Info),
            subsystems: Subsystem::ALL.map(|s| (s, LogLevel::Trace)).into(),
        };
        EnvFilter::try_new(directives("warn", &levels)).expect("a filter");
    }

    #[test]
    fn every_module_is_in_exactly_one_subsystem() {
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut modules: Vec<String> = std::fs::read_dir(&source)
            .expect("the source directory")
            .map(|entry| entry.expect("an entry").path())
            .filter(|path| !path.ends_with("bin"))
            .map(|path| {
                path.file_stem()
                    .expect("a name")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        modules.sort();
        modules.dedup();
        let mut covered: Vec<String> = MODULES
            .iter()
            .flat_map(|(_, modules)| modules.iter().map(|m| m.to_string()))
            .collect();
        covered.sort();
        assert_eq!(covered, modules);
    }
}
