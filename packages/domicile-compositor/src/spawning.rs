//! Starting client processes on this desktop, with the environment that points
//! them at it.

use std::ffi::{OsStr, OsString};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::thread;

use std::os::fd::AsFd as _;
use tracing::{debug, warn};

use domicile_host::desk_terminal;
use domicile_host::priority;
use domicile_host::system::Environment;

use crate::grepped;
use crate::launches::Launches;
use crate::portals::CURRENT_DESKTOP;
use crate::{app_scope, engine};

/// Spawn a client process onto Domicile's display, or say why it did not
/// start.
///
/// `command[0]` is found on the compositor's `PATH` first, so a missing
/// program is this error rather than `systemd-run`'s, which only its log
/// would hear. A reaper thread waits on the child so it doesn't become a
/// zombie. `scoped` starts it in its own systemd scope; see
/// [`crate::app_scope`]. It starts at nice value `nice`; see
/// [`client_command`]. `activation_token` lets it raise its window; see
/// [`client_command`]. A client in `launches` is launched again by the next
/// compositor if a crash takes it; see [`crate::launches`].
pub fn spawn_client(
    command: &[String],
    wayland_display: &OsStr,
    scoped: bool,
    nice: i32,
    activation_token: Option<&str>,
    launches: Option<&Arc<Launches>>,
) -> Result<(), String> {
    let (program, args) = command
        .split_first()
        .ok_or("there was nothing to start: the command is empty")?;
    let found = on_the_path(program, std::env::var_os("PATH").as_deref())?;
    let mut child = client_command(
        &[vec![found], args.to_vec()].concat(),
        wayland_display,
        std::env::var_os("LD_LIBRARY_PATH").as_deref(),
        scoped.then(app_scope::random),
        nice,
        activation_token,
    )
    .expect("the command has a program");
    own_stream(&mut child, program);
    let mut child = child
        .spawn()
        .map_err(|err| format!("{program} could not be started: {err}"))?;
    // Logged after the fork for the pid, which pairs this line with
    // `app client connected`. See `peer_process`.
    debug!(
        pid = child.id(),
        ?command,
        ?wayland_display,
        "{}",
        grepped::SPAWNING
    );
    let launches = launches.cloned();
    if let Some(launches) = &launches {
        launches.launched(child.id(), command);
    }
    thread::spawn(move || {
        let _ = child.wait();
        if let Some(launches) = launches {
            launches.ended(child.id());
        }
    });
    Ok(())
}

/// Gives an app its own journal stream, named by [`stream_name`], at `info`,
/// when the desktop's logs are in the journal. Otherwise an app writes to the
/// compositor's stderr, and its chatter (an editor's startup, a toolkit's
/// warnings) would read as the compositor's errors.
///
/// An app that can't have a stream writes where the compositor does, which
/// is logged.
pub fn own_stream(child: &mut Command, program: &str) {
    if !domicile_launch::journal::is_the_journal(std::io::stdout().as_fd()) {
        return;
    }
    let name = stream_name(program);
    if let Err(why) = domicile_launch::journal::give_stream(
        child,
        Path::new(domicile_launch::journal::STREAM_SOCKET),
        &name,
    ) {
        warn!("{name} writes to the compositor's stderr: no journal stream: {why}");
    }
}

/// The journal name for what `program` writes: its file name. The `domicile`
/// command, which a binding may run, is `domicile-cli`, apart from the
/// launcher's own `domicile`.
fn stream_name(program: &str) -> String {
    let name = Path::new(program).file_name().map_or_else(
        || program.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    match name.as_str() {
        "domicile" => "domicile-cli".to_string(),
        _ => name,
    }
}

/// [`spawn_client`] for a start nobody waits on, such as the config's startup
/// commands: a failure is logged as an error.
pub fn start_client(
    command: &[String],
    wayland_display: &OsStr,
    scoped: bool,
    nice: i32,
    activation_token: Option<&str>,
    launches: Option<&Arc<Launches>>,
) {
    if let Err(why) = spawn_client(
        command,
        wayland_display,
        scoped,
        nice,
        activation_token,
        launches,
    ) {
        tracing::error!(why, ?command, "failed to spawn client");
    }
}

/// The program `program` runs: itself when it names a path, or the first
/// executable of that name in `path`, the `PATH` variable. Errs saying it is
/// not there.
fn on_the_path(program: &str, path: Option<&OsStr>) -> Result<String, String> {
    if program.contains('/') {
        return match is_executable(Path::new(program)) {
            true => Ok(program.to_string()),
            false => Err(format!("{program} is not a program that can be run")),
        };
    }
    path.into_iter()
        .flat_map(std::env::split_paths)
        .map(|directory| directory.join(program))
        .find(|candidate| is_executable(candidate))
        .map(|found| {
            found
                .into_os_string()
                .into_string()
                .expect("a UTF-8 directory of PATH joined to a UTF-8 name")
        })
        .ok_or_else(|| format!("{program} is not on the desktop's PATH; give its full path"))
}

/// Whether `file` is a file someone may execute.
fn is_executable(file: &Path) -> bool {
    file.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// Build the command for a spawned client.
///
/// - `WAYLAND_DISPLAY` is set to ours. Our own may be the host session's, and a
///   client inheriting it would open there.
/// - `DISPLAY` is removed so dual-backend toolkits choose Wayland.
/// - There is no Xwayland, so X11-only defaults would fail;
///   [`WAYLAND_PREFERENCE`] overrides them.
/// - `LD_LIBRARY_PATH` loses the engine's directory; see
///   [`without_the_engine`].
/// - It starts at nice value `nice`, not the raised Wayland thread's; see
///   [`thread_priority`].
///
/// `DOMICILE_SOCK` is inherited unchanged: the launcher sets it to this
/// desktop's control socket.
///
/// With a `scope`, the client starts in its own systemd scope; see
/// [`app_scope::scoped`].
///
/// An `activation_token` is set as `XDG_ACTIVATION_TOKEN`, and as
/// `DESKTOP_STARTUP_ID` for toolkits that read only that. A singleton app
/// launched again hands it to its running instance, which raises its window.
/// See [`crate::activation`].
pub fn client_command(
    command: &[String],
    wayland_display: &OsStr,
    library_path: Option<&OsStr>,
    scope: Option<u64>,
    nice: i32,
    activation_token: Option<&str>,
) -> Option<Command> {
    let (program, args) = command.split_first()?;
    let words = match scope {
        Some(random) => app_scope::scoped(program, args, random),
        None => command.to_vec(),
    };
    let (program, args) = words.split_first().expect("both start with a program");
    let mut child = Command::new(program);
    child.args(args);
    for (name, value) in desktop_environment(wayland_display, library_path)
        .into_iter()
        .chain([terminal_variable()])
    {
        match value {
            Some(value) => child.env(name, value),
            None => child.env_remove(name),
        };
    }
    if let Some(token) = activation_token {
        child.env("XDG_ACTIVATION_TOKEN", token);
        child.env("DESKTOP_STARTUP_ID", token);
    }
    priority::starting_at(&mut child, nice);
    Some(child)
}

/// [`desk_terminal::VARIABLE`] for the terminal the live config names, or to
/// remove it. Read at each start rather than kept in
/// [`desktop_environment`], so a reload reaches the next process.
pub fn terminal_variable() -> (OsString, Option<OsString>) {
    (
        desk_terminal::VARIABLE.into(),
        desk_terminal::variable(desk_terminal::current().as_deref()),
    )
}

/// The variables [`client_command`] sets, or with `None` removes, so a process
/// runs in this desktop rather than the one the compositor was started from.
///
/// Also what the shell's processes run with; see `domicile_host::system`.
pub fn desktop_environment(wayland_display: &OsStr, library_path: Option<&OsStr>) -> Environment {
    [
        ("WAYLAND_DISPLAY", Some(wayland_display.to_os_string())),
        // For `OnlyShowIn` in `.desktop` files and for toolkits. Portal routing
        // uses the frontend's environment instead; see
        // `portals::say_which_desktop`.
        ("XDG_CURRENT_DESKTOP", Some(CURRENT_DESKTOP.into())),
        ("DISPLAY", None),
        ("LD_LIBRARY_PATH", library_path.and_then(without_the_engine)),
        // Qt 6.6 and later reconnect to the next compositor after a crash,
        // keeping their windows. See `crate::launches`.
        ("QT_WAYLAND_RECONNECT", Some("1".into())),
    ]
    .into_iter()
    .chain(
        WAYLAND_PREFERENCE
            .iter()
            .map(|&(name, value)| (name, Some(value.into()))),
    )
    .map(|(name, value)| (name.into(), value))
    .collect()
}

/// What each toolkit reads to choose Wayland over X11; see [`client_command`].
///
/// - `XDG_SESSION_TYPE`: what `--ozone-platform=auto` (Electron 38 and later,
///   and Chromium), Qt and GLFW look at when nothing more specific is set.
/// - `ELECTRON_OZONE_PLATFORM_HINT`: Electron 28 through 37, which otherwise
///   default to X11 (`element-desktop`, VS Code, Slack).
/// - `NIXOS_OZONE_WL`: nixpkgs' Electron and Chromium wrappers, which add the
///   Wayland flags only when it is set.
/// - `QT_QPA_PLATFORM`, `SDL_VIDEODRIVER`: Qt5 and SDL2, both X11 by default.
/// - `MOZ_ENABLE_WAYLAND`: Firefox before 121.
const WAYLAND_PREFERENCE: [(&str, &str); 6] = [
    ("XDG_SESSION_TYPE", "wayland"),
    ("ELECTRON_OZONE_PLATFORM_HINT", "wayland"),
    ("NIXOS_OZONE_WL", "1"),
    ("QT_QPA_PLATFORM", "wayland"),
    ("SDL_VIDEODRIVER", "wayland"),
    ("MOZ_ENABLE_WAYLAND", "1"),
];

/// `path` without any directory containing the engine, or `None` if nothing is
/// left.
///
/// The engine's directory is Chromium's and holds its own `libvulkan.so.1`,
/// built without Xlib surfaces. A client that loads it fails, for example:
///
///   libgtk-4.so.1: undefined symbol: vkCreateXlibSurfaceKHR
///
/// Detected by contents rather than a flag, so a hand-started compositor with a
/// Chromium `out` directory on its path is covered.
fn without_the_engine(path: &OsStr) -> Option<OsString> {
    let kept: Vec<_> = std::env::split_paths(path)
        .filter(|directory| !directory.join(engine::LIBRARY).exists())
        .collect();
    (!kept.is_empty())
        .then(|| std::env::join_paths(kept).expect("split on the separator it is joined with"))
}

/// The chrome's Wayland display name, derived from ours.
///
/// A separate socket, so the compositor knows which client is the chrome rather
/// than trusting a claim.
pub fn chrome_display(socket_name: &OsStr) -> String {
    format!("{}-chrome", socket_name.to_string_lossy())
}

/// The user's home directory, which the file index covers.
///
/// Read from the environment because it is a fact about the running user, not a
/// setting; configuration arrives on the command line. Spawned clients inherit
/// the same `HOME`, and `domicile_config` uses it to expand `~`.
pub fn home_directory() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};

    use super::{client_command, stream_name};

    #[test]
    fn an_app_logs_under_its_programs_name() {
        assert_eq!(stream_name("/run/current-system/sw/bin/emacs"), "emacs");
        assert_eq!(stream_name("foot"), "foot");
    }

    #[test]
    fn the_domicile_command_logs_apart_from_the_launcher() {
        // `domicile` is the launcher's own name. A command a binding runs,
        // such as a screen recording, says its output under its own.
        assert_eq!(stream_name("domicile"), "domicile-cli");
        assert_eq!(
            stream_name("/nix/store/x-domicile/bin/domicile"),
            "domicile-cli"
        );
    }

    /// The value `client_command` sets for `name`; `None` means cleared.
    fn child_env(command: &[String], display: &str, name: &str) -> Option<OsString> {
        child_env_from(command, display, None, name)
    }

    /// [`child_env`], for a compositor with `library_path` as its
    /// `LD_LIBRARY_PATH`.
    fn child_env_from(
        command: &[String],
        display: &str,
        library_path: Option<&OsStr>,
        name: &str,
    ) -> Option<OsString> {
        client_command(command, OsStr::new(display), library_path, None, 0, None)
            .expect("a command with a program builds")
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(name))
            .map(|(_, value)| value.map(OsStr::to_os_string))
            .expect("the variable is one this sets or clears")
    }

    /// A directory holding an executable `name` and a file `plain` that is
    /// not executable.
    fn bin_directory(name: &str, plain: &str) -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().expect("a temporary directory");
        let program = directory.path().join(name);
        std::fs::write(&program, b"#!/bin/sh\n").expect("the program is written");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
            .expect("the program is made executable");
        std::fs::write(directory.path().join(plain), b"").expect("the file is written");
        directory
    }

    #[test]
    fn a_program_is_found_on_the_path_as_a_full_path() {
        let bin = bin_directory("kitty", "notes");
        let path = std::env::join_paths(["/nowhere".as_ref(), bin.path()]).expect("joinable");
        assert_eq!(
            super::on_the_path("kitty", Some(&path)),
            Ok(bin.path().join("kitty").display().to_string())
        );
    }

    #[test]
    fn a_program_not_on_the_path_is_refused_naming_it() {
        let bin = bin_directory("foot", "kitty");
        let path = bin.path().as_os_str();
        let why = super::on_the_path("kitty", Some(path)).unwrap_err();
        assert!(why.contains("kitty") && why.contains("PATH"), "{why}");
        assert!(super::on_the_path("kitty", None).is_err());
    }

    #[test]
    fn a_program_named_by_path_must_be_executable_there() {
        let bin = bin_directory("foot", "notes");
        let foot = bin.path().join("foot").display().to_string();
        let notes = bin.path().join("notes").display().to_string();
        assert_eq!(super::on_the_path(&foot, None), Ok(foot.clone()));
        assert!(super::on_the_path(&notes, None).is_err());
        assert!(super::on_the_path("/nowhere/foot", None).is_err());
    }

    fn kitty() -> Vec<String> {
        vec!["kitty".to_string()]
    }

    #[test]
    fn a_spawned_client_is_pointed_at_our_display_not_the_one_we_inherited() {
        // The compositor's own `WAYLAND_DISPLAY` may be the host's. A child
        // inheriting it would open on the host desktop.
        assert_eq!(
            child_env(&kitty(), "wayland-7", "WAYLAND_DISPLAY"),
            Some(OsString::from("wayland-7")),
        );
    }

    #[test]
    fn a_spawned_qt_client_reconnects_after_a_compositor_crash() {
        assert_eq!(
            child_env(&kitty(), "wayland-7", "QT_WAYLAND_RECONNECT"),
            Some(OsString::from("1")),
        );
    }

    #[test]
    fn a_spawned_client_gets_no_x_display() {
        assert_eq!(child_env(&kitty(), "wayland-7", "DISPLAY"), None);
    }

    #[test]
    fn a_spawned_client_is_told_to_speak_wayland() {
        // No Xwayland, so X11-default toolkits (Electron, SDL2) would fail to
        // start. Inherited X settings are overridden.
        for (name, value) in [
            ("XDG_SESSION_TYPE", "wayland"),
            ("ELECTRON_OZONE_PLATFORM_HINT", "wayland"),
            ("NIXOS_OZONE_WL", "1"),
            ("QT_QPA_PLATFORM", "wayland"),
            ("SDL_VIDEODRIVER", "wayland"),
            ("MOZ_ENABLE_WAYLAND", "1"),
        ] {
            assert_eq!(
                child_env(&kitty(), "wayland-7", name),
                Some(OsString::from(value)),
                "{name}",
            );
        }
    }

    #[test]
    fn a_spawned_client_is_told_which_desktop_it_is_on() {
        // `xdg-desktop-portal` matches this against `UseIn=` in `.portal`
        // files, routing color scheme queries to our settings backend.
        assert_eq!(
            child_env(&kitty(), "wayland-7", "XDG_CURRENT_DESKTOP"),
            Some(OsString::from("domicile")),
        );
    }

    /// A directory with a stand-in engine library, as the launcher puts on
    /// `LD_LIBRARY_PATH`.
    fn engine_directory() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("a temporary directory");
        std::fs::write(directory.path().join(crate::engine::LIBRARY), b"")
            .expect("the stand-in is written");
        directory
    }

    #[test]
    fn a_spawned_client_does_not_load_the_engines_libraries() {
        // The engine's directory holds Chromium's `libvulkan.so.1`, built
        // without Xlib surfaces. GTK 4 loaded it and failed:
        //
        //   libgtk-4.so.1: undefined symbol: vkCreateXlibSurfaceKHR
        let engine = engine_directory();
        let ours = std::env::join_paths([engine.path(), std::path::Path::new("/opt/lib")])
            .expect("joinable");
        assert_eq!(
            child_env_from(&kitty(), "wayland-7", Some(&ours), "LD_LIBRARY_PATH"),
            Some(OsString::from("/opt/lib")),
        );
    }

    #[test]
    fn a_spawned_client_of_a_compositor_that_only_had_the_engine_gets_no_library_path() {
        let engine = engine_directory();
        assert_eq!(
            child_env_from(
                &kitty(),
                "wayland-7",
                Some(engine.path().as_os_str()),
                "LD_LIBRARY_PATH"
            ),
            None,
        );
    }

    #[test]
    fn a_launched_client_is_handed_a_token_to_raise_its_window() {
        // A singleton app launched again passes it to its running instance,
        // which raises its window with it.
        let child = client_command(
            &kitty(),
            OsStr::new("wayland-7"),
            None,
            None,
            0,
            Some("t0k"),
        )
        .expect("a command with a program builds");
        for name in ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"] {
            assert!(
                child
                    .get_envs()
                    .any(|pair| pair == (OsStr::new(name), Some(OsStr::new("t0k")))),
                "{name}: {child:?}"
            );
        }
    }

    #[test]
    fn an_empty_command_spawns_nothing() {
        assert!(client_command(&[], OsStr::new("wayland-7"), None, None, 0, None).is_none());
    }

    #[test]
    fn a_scoped_client_keeps_the_desktops_environment() {
        // `systemd-run --scope` execs the client with its own environment.
        let child = client_command(&kitty(), OsStr::new("wayland-7"), None, Some(7), 0, None)
            .expect("a command with a program builds");
        assert_eq!(child.get_program(), "systemd-run");
        assert!(
            child
                .get_envs()
                .any(|pair| pair == (OsStr::new("WAYLAND_DISPLAY"), Some(OsStr::new("wayland-7")))),
            "{child:?}"
        );
    }

    #[test]
    fn an_unscoped_client_starts_itself() {
        let child = client_command(&kitty(), OsStr::new("wayland-7"), None, None, 0, None)
            .expect("a command with a program builds");
        assert_eq!(child.get_program(), "kitty");
    }

    /// The Wayland thread runs raised; a client starts at the nice value it is
    /// given instead.
    #[test]
    fn a_client_starts_at_the_nice_value_it_is_given() {
        use domicile_host::priority::{nice, this_thread};
        let given = nice(this_thread()).unwrap() + 3;

        let ran = client_command(
            &["nice".into()],
            OsStr::new("wayland-7"),
            None,
            None,
            given,
            None,
        )
        .expect("a command with a program builds")
        .output()
        .expect("`nice` runs");

        assert_eq!(String::from_utf8(ran.stdout).unwrap(), format!("{given}\n"));
    }
}
