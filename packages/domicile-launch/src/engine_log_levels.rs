//! The engine's side of `domicile set-log-level`: Chromium's minimum severity
//! and the `--vmodule` patterns that turn on its VLOGs, from the levels asked
//! for.
//!
//! Chromium has one minimum severity per process, so the most verbose level
//! asked for sets it. VLOGs are per file, so `debug` and `trace` turn on only
//! the files of the subsystems asked for. The engine applies both in every
//! process; see the engine's `set_log_levels` command.

use domicile_protocol::{LogLevel, LogLevels, Subsystem};

use crate::journal::Priority;

/// What the engine's `set_log_levels` takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineLevels {
    /// Chromium's minimum severity: -1 `VERBOSE` to 3 `FATAL`.
    pub min_level: i32,
    /// Chromium's `--vmodule`.
    pub vmodule: String,
}

/// The minimum severity `spawn::engine` starts the engine at.
const STARTING: i32 = 2;

/// Every file of Domicile's own, wherever in Chromium's tree it is.
const DOMICILE: &str = "*/domicile/*";

/// The source files each subsystem covers, as `--vmodule` patterns: a module
/// name, or a path pattern when it holds a slash. Domicile's files outside a
/// `domicile/` directory, in Chromium's own files, are listed too.
const FILES: [(Subsystem, &[&str]); 13] = [
    (
        Subsystem::Input,
        &[
            "*/evdev/domicile/*",
            "absolute_mouse_event_converter_evdev",
            "libinput*",
            "drm_input_*",
            "drm_logind_input",
            "drm_pointer_targets",
            "keyboard_layout",
            "domicile_pointer_*",
            "pointer_hiding",
            "engine_event_queue",
            "input_device_factory_evdev",
        ],
    ),
    (
        Subsystem::Displays,
        &[
            "drm_modeset",
            "drm_screen",
            "drm_canvas",
            "drm_sleep",
            "drm_thread",
            "drm_window_host",
            "drm_cursor_factory",
            "domicile_cursor_display",
            "desk_cursor_theme",
            "domicile_desk_presenters",
            "gbm_wrapper",
            "display_list",
        ],
    ),
    (
        Subsystem::Windows,
        &[
            "domicile_shell_windows",
            "domicile_browser_windows",
            "domicile_browser_profiles",
            "domicile_external_apps",
            "web_view_guest",
            "html_web_view_element",
            "html_app_element",
            "profile_route_throttle",
            "will_navigate_throttle",
            "browser_page_throttle",
        ],
    ),
    (
        Subsystem::Rendering,
        &[
            "brokered_frame_sink",
            "domicile_frame_sink_broker",
            "frame_sink_broker",
            "external_surface_embedder",
            "surface_producer",
            "solid_color_submitter",
            "layer_tree_host*",
            "tiling_set_raster_queue_all",
            "begin_frame_source",
            "shared_image_interface",
            "render_widget_host_impl",
            "gpu_data_manager_impl_private",
        ],
    ),
    (
        Subsystem::Cast,
        &[
            "display_capture*",
            "domicile_media_devices",
            "domicile_device_chooser",
        ],
    ),
    (
        Subsystem::Portals,
        &[
            "domicile_file_dialogs",
            "domicile_printing",
            "domicile_prompts",
            "domicile_permissions",
            "*identity_dialog",
        ],
    ),
    (Subsystem::Idle, &["desk_lock"]),
    (Subsystem::Clipboard, &["*clipboard*"]),
    (Subsystem::Notifications, &["*notification*"]),
    (Subsystem::Electron, &["electron_*", "domicile_electron_*"]),
    (
        Subsystem::Agents,
        &["domicile_devtools", "domicile_agent_*"],
    ),
    (
        Subsystem::Shell,
        &[
            "app_channel",
            "control_channel",
            "domicile_host",
            "shell_*",
            "domicile_command_socket",
            "domicile_extension_*",
            "domicile_window_controller",
            "desk_downloads",
        ],
    ),
    (
        Subsystem::Session,
        &[
            "domicile_engine",
            "domicile_desk",
            "drm_logind_session",
            "drm_vt_switcher",
            "rtkit",
            "desk_faults",
            "sandbox_linux",
            "gpu_pre_sandbox_hook_linux",
        ],
    ),
];

/// The engine's levels for `levels`.
pub fn engine_levels(levels: &LogLevels) -> EngineLevels {
    // Each level asked for, and whether it covers the shell.
    let asked = levels.all.map(|level| (level, true)).into_iter().chain(
        levels
            .subsystems
            .iter()
            .map(|(subsystem, level)| (*level, *subsystem == Subsystem::Shell)),
    );
    let min_level = asked
        .map(|(level, shell)| severity(level, shell))
        .fold(STARTING, i32::min);
    let all = levels.all.and_then(vlog).map(|vlog| {
        std::iter::once(DOMICILE)
            .chain(FILES.iter().flat_map(|(_, files)| files.iter().copied()))
            .map(|file| format!("{file}={vlog}"))
            .collect::<Vec<_>>()
    });
    let subsystems = levels.subsystems.iter().filter_map(|(subsystem, level)| {
        vlog(*level).map(|vlog| {
            files(*subsystem)
                .map(|file| format!("{file}={vlog}"))
                .collect::<Vec<_>>()
        })
    });
    EngineLevels {
        min_level,
        // Chromium takes the first pattern a file matches, so a subsystem's
        // own level comes before `all`'s.
        vmodule: subsystems
            .chain(all)
            .flatten()
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// Chromium's minimum severity for `level`, over the shell when `shell`.
/// `debug` and `trace` are `INFO` plus VLOGs, and VERBOSE for the shell.
fn severity(level: LogLevel, shell: bool) -> i32 {
    match (level, shell) {
        (LogLevel::Error, _) => 2,
        (LogLevel::Warn, _) => 1,
        // The shell's `console.debug` is VERBOSE. VLOGs are not held back by
        // the minimum severity, so nothing else needs it.
        (LogLevel::Debug | LogLevel::Trace, true) => -1,
        (LogLevel::Info | LogLevel::Debug | LogLevel::Trace, _) => 0,
    }
}

/// The VLOG level for `level`, if it has one. Domicile's VLOGs run from 1
/// (each change) to 4 (each event).
fn vlog(level: LogLevel) -> Option<u8> {
    match level {
        LogLevel::Error | LogLevel::Warn | LogLevel::Info => None,
        LogLevel::Debug => Some(1),
        LogLevel::Trace => Some(4),
    }
}

/// The file patterns `subsystem` covers.
fn files(subsystem: Subsystem) -> impl Iterator<Item = &'static str> {
    FILES
        .iter()
        .filter(move |(covered, _)| *covered == subsystem)
        .flat_map(|(_, files)| files.iter().copied())
}

/// The switches that start an engine at `levels`, so one that restarts keeps
/// the levels set for the one before. None for the starting levels, which
/// `spawn::engine` sets. Chromium hands them to every process it starts.
pub fn starting_switches(levels: &LogLevels) -> Vec<String> {
    if *levels == LogLevels::default() {
        return Vec::new();
    }
    let EngineLevels { min_level, vmodule } = engine_levels(levels);
    vec![
        format!("--log-level={min_level}"),
        format!("--vmodule={vmodule}"),
    ]
}

/// Which of the engine's lines show at the levels set.
///
/// Chromium has one minimum severity per process, so a subsystem turned up to
/// `info` or more makes every file in the engine log at `INFO`, and the shell
/// at `debug` makes every page's console log at `VERBOSE`. The gate keeps a
/// line below the level everything is at only when it comes from a file of a
/// subsystem turned up that far.
///
/// A page's or an extension's console is the page's business, not the
/// desktop's: its lines show only when everything is at `info` or more,
/// whatever severity the page gave them. The shell's console is the `shell`
/// subsystem's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gate {
    /// The least severe priority every line shows at.
    all: Priority,
    /// Each subsystem turned up past `all`, with the least severe priority
    /// its lines show at.
    subsystems: Vec<(Subsystem, Priority)>,
}

/// Where Chromium says a `console` line came from.
const CONSOLE: &str = "CONSOLE";

impl Gate {
    /// The gate for `levels`.
    pub fn new(levels: &LogLevels) -> Gate {
        let all = levels.all.map_or(Priority::Error, priority);
        Gate {
            all,
            subsystems: levels
                .subsystems
                .iter()
                .map(|(subsystem, level)| (*subsystem, priority(*level)))
                .filter(|(_, shown)| less_severe(*shown, all))
                .collect(),
        }
    }

    /// Whether a line at `at` from `file` shows. `shell` says whether it is
    /// the shell's console.
    pub fn shows(&self, at: Priority, file: &str, shell: bool) -> bool {
        if file == CONSOLE && !shell {
            return !less_severe(at, self.all) && !less_severe(Priority::Info, self.all);
        }
        if !less_severe(at, self.all) {
            return true;
        }
        self.subsystems.iter().any(|(subsystem, shown)| {
            !less_severe(at, *shown)
                && match file == CONSOLE {
                    true => *subsystem == Subsystem::Shell,
                    false => files(*subsystem).any(|pattern| covers(pattern, file)),
                }
        })
    }
}

impl Default for Gate {
    fn default() -> Self {
        Gate::new(&LogLevels::default())
    }
}

/// The journal priority `level` shows down to.
fn priority(level: LogLevel) -> Priority {
    match level {
        LogLevel::Error => Priority::Error,
        LogLevel::Warn => Priority::Warning,
        LogLevel::Info => Priority::Info,
        LogLevel::Debug | LogLevel::Trace => Priority::Debug,
    }
}

/// Whether `a` is less severe than `b`.
fn less_severe(a: Priority, b: Priority) -> bool {
    a as u8 > b as u8
}

/// Whether the `--vmodule` pattern `pattern` covers `file`, a path as
/// Chromium's log prefix gives it. As in Chromium, a pattern with a slash
/// matches the whole path, and one without matches the file's name without
/// its extension or `-inl`.
fn covers(pattern: &str, file: &str) -> bool {
    match pattern.contains('/') {
        true => glob(pattern.as_bytes(), file.as_bytes()),
        false => {
            let name = file.rsplit('/').next().unwrap_or(file);
            let name = name.split_once('.').map_or(name, |(stem, _)| stem);
            let name = name.strip_suffix("-inl").unwrap_or(name);
            glob(pattern.as_bytes(), name.as_bytes())
        }
    }
}

/// Whether `text` matches `pattern`, where `*` is any run and `?` any one.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.first(), text.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            glob(&pattern[1..], text) || (!text.is_empty() && glob(pattern, &text[1..]))
        }
        (Some(b'?'), Some(_)) => glob(&pattern[1..], &text[1..]),
        (Some(p), Some(t)) if p == t => glob(&pattern[1..], &text[1..]),
        _ => false,
    }
}
