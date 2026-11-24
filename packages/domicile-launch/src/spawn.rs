//! Builds the engine and compositor command lines as data, so tests can
//! inspect them.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::control_socket::VARIABLE;
use crate::shell_path::{Shell, ShellFiles};
use crate::trace::{producer_socket, PRODUCER_VARIABLE};

/// The URL of the shell page the engine generates.
///
/// It must be the bare root. `ShellURLLoaderFactory` generates the page only
/// for `/` and serves any other path from the shell root on disk.
const SHELL_DOCUMENT: &str = "domicile://shell/";

/// A child process to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(String, OsString)>,
}

/// The variable that names the engine's Electron socket to the apps a desktop
/// starts.
pub const ELECTRON_VARIABLE: &str = "DOMICILE_ELECTRON_SOCK";

/// The socket and file paths for one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    /// The engine's broker socket, which the compositor submits frames
    /// through.
    pub broker: PathBuf,
    /// The host protocol socket. The compositor listens and the engine dials
    /// it for the page's control channel.
    pub chrome_socket: PathBuf,
    /// The engine's command socket, which the supervisor dials for
    /// `domicile load-shell`.
    ///
    /// Lives in the run directory, since only the supervisor dials it.
    pub command: PathBuf,
    /// The engine's Electron socket, which each `electron-host` dials for its
    /// app's windows. Apps find it in [`ELECTRON_VARIABLE`].
    ///
    /// Lives in the run directory, as [`Runtime::command`] does.
    pub electron: PathBuf,
    /// The control socket for `domicile which-shell` and
    /// `domicile load-shell`.
    ///
    /// Users' commands dial it, so it lives at
    /// [`crate::control_socket::address`] rather than in the run directory.
    pub control: PathBuf,
    /// The engine profile, kept between runs. See [`crate::profile_path`].
    pub profile: PathBuf,
    /// A per-run directory put first on every app's `PATH`. Its `xdg-open` and
    /// `xdg-email` are `domicile-xdg-open` and `domicile-xdg-email`, which run
    /// `domicile open`; see [`crate::open`] and [`crate::email`].
    pub shims: PathBuf,
    /// The session file the compositor writes once it is serving.
    ///
    /// Set here rather than derived in [`compositor`] because the launcher
    /// waits on it.
    pub session: PathBuf,
    /// A data directory first on every app's `XDG_DATA_DIRS`, where the
    /// compositor writes the desktop entries that run the config's
    /// `electron.apps` on the engine. See
    /// `domicile_host::electron_entries`.
    pub electron_entries: PathBuf,
    /// The clients the compositor launched, kept across a compositor restart
    /// so the next one launches again those the crash took. See
    /// `domicile_compositor::launches`.
    pub launches: PathBuf,
}

/// The ozone platform that drives the display directly.
const SCANOUT_PLATFORM: &str = "drm";

/// The ozone platform that runs as a client of another compositor.
const NESTED_PLATFORM: &str = "wayland";

/// The ozone platform with no display at all. Its monitors are the
/// compositor's virtual ones; see `docs/architecture/A-HEADLESS-DESKTOP.md`.
pub const HEADLESS_PLATFORM: &str = "headless";

/// The engine command line for `shell`.
///
/// `--app` hides the browser's tab strip, address bar and shortcuts.
/// `--no-sandbox` is not passed by default because it shows an "unsupported
/// flag" bar. A machine that needs it adds it through `extra`.
///
/// `extra` is split on whitespace. Its `--enable-features` and
/// `--disable-features` values are merged into one switch each, since the
/// last copy of a switch wins and would drop the built-in features.
pub fn engine(
    engine: &Path,
    shell: &Shell,
    platform: &str,
    runtime: &Runtime,
    extra: Option<&str>,
) -> Spawn {
    let extra = Extra::parse(extra.unwrap_or_default());
    let mut args: Vec<OsString> = vec![
        format!("--ozone-platform={platform}").into(),
        format!("--app={SHELL_DOCUMENT}").into(),
        format!("--domicile-shell-root={}", shell.root.display()).into(),
        // Relative: the generated page uses it as a `<script src>` resolved
        // against `domicile://shell/`.
        format!("--domicile-shell-module={}", shell.module.display()).into(),
        format!(
            "--domicile-control-socket={}",
            runtime.chrome_socket.display()
        )
        .into(),
        // Lets `domicile load-shell` swap the shell without a restart. Passed
        // on every run, not only in development.
        format!("--domicile-command-socket={}", runtime.command.display()).into(),
        // Lets Electron apps open their windows on the desk. See
        // docs/architecture/ELECTRON-APPS.md.
        format!("--domicile-electron-socket={}", runtime.electron.display()).into(),
        // Log ERROR and above to stderr. The fork reports problems at ERROR.
        // WARNING adds a dozen routine upstream lines on every nested start.
        // `--enable-logging` lets `--log-level=0` or `1`, or `--v=1`, in
        // `extra` show more, since the last copy of a switch wins.
        "--enable-logging=stderr".into(),
        "--log-level=2".into(),
        // Route touchpads and mice through libinput. Without it, a non-ChromeOS
        // build handles them with `EventConverterEvdevImpl`, which ignores
        // touchpad motion and the mouse wheel, and has no pointer
        // acceleration. Both features are off by default.
        //
        // `EnablePerfettoSystemTracing` reports trace events to
        // `domicile trace`; see `crate::trace`.
        ["--enable-features=LibinputHandleTouchpad,LibinputHandleMouse,EnablePerfettoSystemTracing"]
            .into_iter()
            .chain(extra.enabled)
            .collect::<Vec<_>>()
            .join(",")
            .into(),
        "--password-store=basic".into(),
        "--no-first-run".into(),
        format!("--user-data-dir={}", runtime.profile.display()).into(),
        format!("--domicile-broker-socket={}", runtime.broker.display()).into(),
    ];
    // The root is `domicile dev`'s socket, so an engine restarted during
    // development keeps asking the dev server.
    if shell.files == ShellFiles::DevServer {
        args.push("--domicile-shell-dev-server".into());
    }
    // On drm, a window drives a CRTC only if its bounds match the CRTC's
    // exactly (`ScreenManager::FindWindowAt`). Otherwise its page flips are
    // dropped and the screen stays black. Fullscreen takes the display's own
    // bounds, which `--window-size` cannot know in advance. Nested runs skip
    // this so the window stays a normal window.
    //
    // Chromium's GPU process crash limit stays on: after three crashes it
    // falls back to the CPU, which the compositor follows, and when that
    // fails too the engine exits as a renderer unavailable
    // (`crate::restart::renderer_unavailable`).
    if platform == SCANOUT_PLATFORM {
        args.push("--start-fullscreen".into());
    }
    // A headless desk lays its windows out over the compositor's virtual
    // monitors, as drm does over CRTCs. Until one comes, the screen is a
    // placeholder, and headless's own is 1x1.
    if platform == HEADLESS_PLATFORM {
        args.push("--domicile-headless-desk".into());
        args.push("--ozone-override-screen-size=1024,768".into());
        args.push("--start-fullscreen".into());
    }
    // When nested, ask the host compositor to pass its shortcuts through
    // (`zwp_keyboard_shortcuts_inhibit_unstable_v1`). Otherwise the host
    // takes the shell's Meta chords. This is a switch, not engine default,
    // because the engine's own test scripts also run nested and should not
    // capture the developer's keymap. Host bindings that must still work use
    // sway's `bindsym --inhibited`; see `docs/RUNNING-A-DESKTOP.md`.
    if platform == NESTED_PLATFORM {
        args.push("--domicile-inhibit-host-shortcuts".into());
    }
    args.push(
        format!(
            "{DISABLE_FEATURES}{}",
            DISABLED
                .iter()
                .copied()
                .chain(extra.disabled)
                .collect::<Vec<_>>()
                .join(",")
        )
        .into(),
    );
    args.extend(extra.rest.into_iter().map(OsString::from));
    Spawn {
        args,
        env: vec![
            // For the programs the engine starts, such as an app's
            // `domicile-app-host`, so they reach this desktop.
            (VARIABLE.to_string(), runtime.control.clone().into()),
            // Where the engine reports trace events; see `crate::trace`.
            (
                PRODUCER_VARIABLE.to_string(),
                producer_socket(&runtime.control).into(),
            ),
        ],
        program: engine.join("chrome"),
    }
}

/// Makes an [`engine`] on drm composite on the CPU, for a card with no 3D.
/// See [`crate::software_compositing`].
pub fn composite_on_the_cpu(engine: &mut Spawn) {
    engine.args.push("--disable-gpu".into());
}

/// Makes a [`compositor`] hand the engine windows in shared memory, for an
/// engine that composites on the CPU. See [`crate::software_compositing`].
pub fn send_frames_in_memory(compositor: &mut Spawn) {
    compositor.args.push("--software-compositing".into());
    compositor.args.push("yes".into());
}

/// Makes an [`engine`] open links for apps, such as `slack:`, as the
/// [`compositor`]'s apps do: its `xdg-open` is `domicile open`, which finds
/// the entries that run the config's Electron apps on the engine. The shell
/// names the app it asks about with `domicile open --which`, so the two agree,
/// except on `Terminal=true` handlers: the engine has no `DOMICILE_TERMINAL`,
/// which the compositor sets from the live config, so it skips them.
pub fn let_the_engine_open_links(
    engine: &mut Spawn,
    data: &Path,
    runtime: &Runtime,
    inherited: &dyn Fn(&str) -> Option<String>,
) {
    engine
        .env
        .push(("PATH".to_string(), shims_first(runtime, inherited)));
    engine.env.push((
        "XDG_DATA_DIRS".to_string(),
        data_dirs(data, runtime, inherited),
    ));
}

/// Whether the engine on `platform` takes emulated input (EIS) through its
/// own input path, so the shell and its lock screen hear it as a real hand's.
/// A desk the engine drives does; a nested one's host session delivers it.
/// See `docs/architecture/A-HEADLESS-DESKTOP.md`.
pub fn the_engine_takes_input(platform: &str) -> bool {
    platform != NESTED_PLATFORM
}

/// Makes a [`compositor`] hand emulated input to the engine, for a desk where
/// [`the_engine_takes_input`].
pub fn let_the_engine_take_input(compositor: &mut Spawn) {
    compositor.args.push("--engine-takes-input".into());
    compositor.args.push("yes".into());
}

/// The compositor command line.
///
/// The compositor starts apps, so its environment is what apps inherit:
///
/// - `DOMICILE_SOCK`: `domicile` commands in a terminal reach this desktop.
/// - `DOMICILE_ELECTRON_SOCK`: an Electron app's `electron-host` reaches the
///   engine.
/// - `BROWSER`: `domicile-open-url`, a single program because many readers
///   don't split the value.
/// - `PATH`: [`Runtime::shims`] first, so `xdg-open` is `domicile open`.
/// - `XDG_DATA_DIRS`: [`Runtime::electron_entries`] first, so starting an
///   app the config lists runs it on the engine; then `data`, so GIO finds
///   `domicile-mimeapps.list`. A user's own `mimeapps.list` still wins. The
///   portal does not see this.
/// - `LD_LIBRARY_PATH`: the engine directory first, for the
///   `libdomicile_engine.so` the compositor `dlopen`s. The compositor removes
///   it again for its clients.
///
/// `scope_clients` passes `--scope-clients yes`, for a desk that is the login
/// session.
#[allow(clippy::too_many_arguments)] // Each from a different part of the run.
pub fn compositor(
    compositor: &Path,
    engine: &Path,
    browser: &Path,
    data: &Path,
    runtime: &Runtime,
    config: Option<&Path>,
    scope_clients: bool,
    inherited: &dyn Fn(&str) -> Option<String>,
) -> Spawn {
    let mut libraries = OsString::from(engine);
    if let Some(theirs) = inherited("LD_LIBRARY_PATH") {
        libraries.push(":");
        libraries.push(theirs);
    }
    let mut args: Vec<OsString> = vec![
        "--chrome-socket".into(),
        runtime.chrome_socket.clone().into(),
        "--session".into(),
        runtime.session.clone().into(),
        "--engine-socket".into(),
        runtime.broker.clone().into(),
        "--launches".into(),
        runtime.launches.clone().into(),
        "--electron-entries".into(),
        runtime.electron_entries.clone().into(),
    ];
    // Omit `--config` when there is none. The compositor uses defaults for a
    // missing flag but fails on a path it cannot load.
    if let Some(path) = config {
        args.push("--config".into());
        args.push(path.into());
    }
    if scope_clients {
        args.push("--scope-clients".into());
        args.push("yes".into());
    }
    Spawn {
        args,
        env: vec![
            (VARIABLE.to_string(), runtime.control.clone().into()),
            (
                ELECTRON_VARIABLE.to_string(),
                runtime.electron.clone().into(),
            ),
            ("BROWSER".to_string(), browser.into()),
            ("PATH".to_string(), shims_first(runtime, inherited)),
            (
                "XDG_DATA_DIRS".to_string(),
                data_dirs(data, runtime, inherited),
            ),
            ("LD_LIBRARY_PATH".to_string(), libraries),
            (
                "RUST_LOG".to_string(),
                // Errors alone; `domicile set-log-level` turns it up while
                // the desktop runs. An inherited value wins.
                inherited("RUST_LOG")
                    .unwrap_or_else(|| "error".to_string())
                    .into(),
            ),
        ],
        program: compositor.to_path_buf(),
    }
}

/// `PATH` with [`Runtime::shims`] first, so `xdg-open` is `domicile open`.
fn shims_first(runtime: &Runtime, inherited: &dyn Fn(&str) -> Option<String>) -> OsString {
    let mut path = OsString::from(&runtime.shims);
    if let Some(theirs) = inherited("PATH") {
        path.push(":");
        path.push(theirs);
    }
    path
}

/// `XDG_DATA_DIRS` with [`Runtime::electron_entries`] first, then `data`,
/// as [`compositor`] says.
fn data_dirs(
    data: &Path,
    runtime: &Runtime,
    inherited: &dyn Fn(&str) -> Option<String>,
) -> OsString {
    // Unset means `/usr/local/share:/usr/share` per the XDG spec, so keep
    // those after ours.
    let mut dirs = OsString::from(&runtime.electron_entries);
    dirs.push(":");
    dirs.push(data);
    dirs.push(":");
    dirs.push(
        inherited("XDG_DATA_DIRS")
            .filter(|theirs| !theirs.is_empty())
            .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string()),
    );
    dirs
}

const ENABLE_FEATURES: &str = "--enable-features=";

const DISABLE_FEATURES: &str = "--disable-features=";

/// Features the engine starts with off.
///
/// `V8Flag_scavenger_direct_old_allocation`: Chromium's field trial testing
/// config, which a build that isn't Chrome-branded applies, turns it on for
/// Linux, and the feature passes `--scavenger_direct_old_allocation` to V8.
/// The pinned V8 has no such flag, so every process that starts V8 wrote
/// "Error: unrecognized flag" to the logs, hundreds of times a boot. Remove
/// it once a pin's V8 has the flag (`d8 --help`).
pub const DISABLED: [&str; 1] = ["V8Flag_scavenger_direct_old_allocation"];

/// The `extra` engine switches, with the feature lists apart from the rest.
struct Extra<'a> {
    enabled: Vec<&'a str>,
    disabled: Vec<&'a str>,
    rest: Vec<&'a str>,
}

impl<'a> Extra<'a> {
    /// Splits on whitespace; runs of spaces produce no empty arguments.
    fn parse(extra: &'a str) -> Self {
        let mut parsed = Extra {
            enabled: Vec::new(),
            disabled: Vec::new(),
            rest: Vec::new(),
        };
        for arg in extra.split_whitespace() {
            match (
                arg.strip_prefix(ENABLE_FEATURES),
                arg.strip_prefix(DISABLE_FEATURES),
            ) {
                (Some(features), _) => parsed.enabled.push(features),
                (_, Some(features)) => parsed.disabled.push(features),
                (None, None) => parsed.rest.push(arg),
            }
        }
        parsed
    }
}
