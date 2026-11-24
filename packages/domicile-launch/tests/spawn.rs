//! The command lines and environments the launcher starts each component with.

use std::path::{Path, PathBuf};

use domicile_launch::shell_path::{Shell, ShellFiles};
use domicile_launch::spawn::{
    composite_on_the_cpu, compositor, engine, let_the_engine_open_links, let_the_engine_take_input,
    send_frames_in_memory, the_engine_takes_input, Runtime,
};

/// A built shell, split as `shell_path` returns it: the directory the engine
/// serves and the module the generated document loads.
///
/// The module is `main.js` so nothing here relies on the `shell.js` build
/// convention.
fn shell() -> Shell {
    Shell {
        files: ShellFiles::Directory,
        root: PathBuf::from("/d/dist"),
        module: PathBuf::from("main.js"),
    }
}

/// The session path is passed explicitly, not derived from the chrome socket,
/// because the launcher waits for the compositor to publish it.
fn runtime() -> Runtime {
    Runtime {
        broker: PathBuf::from("/run/d/broker"),
        chrome_socket: PathBuf::from("/run/d/chrome.sock"),
        command: PathBuf::from("/run/d/command.sock"),
        electron: PathBuf::from("/run/d/electron.sock"),
        control: PathBuf::from("/run/d/domicile-ipc.4242.sock"),
        profile: PathBuf::from("/run/d/profile"),
        shims: PathBuf::from("/run/d/bin"),
        session: PathBuf::from("/run/d/session.json"),
        electron_entries: PathBuf::from("/run/d/share"),
        launches: PathBuf::from("/run/d/launches.json"),
    }
}

fn env_of(spawn: &domicile_launch::spawn::Spawn, name: &str) -> Option<String> {
    spawn
        .env
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.to_string_lossy().into_owned())
}

fn args_of(spawn: &domicile_launch::spawn::Spawn) -> Vec<String> {
    spawn
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn the_engine_is_a_desktop_rather_than_a_browser() {
    // `--app` removes the tab strip, address bar and bookmarks row, and frees
    // the browser's keyboard shortcuts for the shell.
    let spawned = engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    );
    assert_eq!(spawned.program, PathBuf::from("/l/engine/chrome"));
    let args = args_of(&spawned);
    // The whole string, with no trailing path. `CreateLoaderAndStart` serves
    // the generated document only for `/`; any other path goes to the file
    // resolver, finds nothing and leaves an empty window.
    assert!(
        args.contains(&"--app=domicile://shell/".to_string()),
        "{args:?}"
    );
    assert!(
        args.contains(&"--ozone-platform=wayland".to_string()),
        "{args:?}"
    );
    assert!(
        args.contains(&"--domicile-broker-socket=/run/d/broker".to_string()),
        "{args:?}"
    );
    assert!(
        args.contains(&"--user-data-dir=/run/d/profile".to_string()),
        "{args:?}"
    );
}

#[test]
fn the_engine_takes_commands_on_a_socket_of_this_runs_own() {
    // Without this switch `domicile load-shell` has nowhere to send
    // `load_shell`, and the shell cannot be replaced.
    //
    // The socket is in the run directory, not at `control_socket::address`,
    // because only the supervisor dials it, like the broker and chrome sockets.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        args.contains(&"--domicile-command-socket=/run/d/command.sock".to_string()),
        "{args:?}"
    );
}

#[test]
fn an_engine_restarted_under_domicile_dev_reads_the_shell_from_the_dev_server() {
    // The supervisor restarts a crashed engine with the shell it was serving;
    // without the switch it would read the socket's path as a directory.
    let dev = Shell {
        files: ShellFiles::DevServer,
        ..shell()
    };
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &dev,
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        args.contains(&"--domicile-shell-dev-server".to_string()),
        "{args:?}"
    );

    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        !args.contains(&"--domicile-shell-dev-server".to_string()),
        "{args:?}"
    );
}

#[test]
fn the_engine_takes_electron_apps_on_a_socket_of_this_runs_own() {
    // Without it an Electron app's `electron-host` has nowhere to open its
    // windows. See docs/architecture/ELECTRON-APPS.md.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        args.contains(&"--domicile-electron-socket=/run/d/electron.sock".to_string()),
        "{args:?}"
    );
}

#[test]
fn apps_find_the_electron_socket_in_their_environment() {
    // The compositor starts apps, so an Electron app's `electron-host`
    // inherits it from there.
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    assert_eq!(
        env_of(&spawned, "DOMICILE_ELECTRON_SOCK").unwrap(),
        "/run/d/electron.sock"
    );
}

#[test]
fn a_tty_desktop_asks_for_the_whole_screen() {
    // Without this the screen stays black with no error. ozone/drm binds a
    // window to a CRTC only when their rects match exactly
    // (`ScreenManager::FindWindowAt`). Chromium's default window is inset and
    // narrower, so no controller is bound and every page flip is dropped.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "drm",
        &runtime(),
        None,
    ));
    assert!(args.contains(&"--start-fullscreen".to_string()), "{args:?}");
}

#[test]
fn a_tty_desktop_gives_up_on_a_gpu_process_that_keeps_crashing() {
    // After three crashes Chromium falls back to the CPU, which the
    // compositor follows. When that fails too, the engine exits as a renderer
    // unavailable (patch 0178). A card that cannot draw would otherwise
    // restart the GPU process forever on a black screen.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "drm",
        &runtime(),
        None,
    ));
    assert!(
        !args.contains(&"--disable-gpu-process-crash-limit".to_string()),
        "{args:?}"
    );
}

#[test]
fn the_engine_sizes_its_own_tile_memory() {
    // NO FIXED BUDGET. The engine sizes the desk page's tile memory from the
    // monitors it spans (patch 0088, `DomicileTileBytesFor`), and an explicit
    // `--force-gpu-mem-available-mb` would override that with one number for
    // every desk -- and for every other page, which needs far less.
    for platform in ["drm", "wayland"] {
        let args = args_of(&engine(
            Path::new("/l/engine"),
            &shell(),
            platform,
            &runtime(),
            None,
        ));
        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("--force-gpu-mem-available-mb")),
            "{platform}: {args:?}"
        );
    }
}

#[test]
fn a_nested_desktop_does_not_take_over_the_screen() {
    // A nested run is a window in someone else's session, so it must not go
    // fullscreen.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        !args.contains(&"--start-fullscreen".to_string()),
        "{args:?}"
    );
    assert!(
        !args.contains(&"--domicile-headless-desk".to_string()),
        "{args:?}"
    );
}

#[test]
fn a_headless_desktop_is_a_desk_of_virtual_monitors() {
    // Its monitors are the compositor's virtual ones, and until one comes the
    // screen is a 1024x768 placeholder: headless's own default is 1x1. See
    // docs/architecture/A-HEADLESS-DESKTOP.md.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "headless",
        &runtime(),
        None,
    ));
    for wanted in [
        "--domicile-headless-desk",
        "--ozone-override-screen-size=1024,768",
        "--start-fullscreen",
    ] {
        assert!(args.contains(&wanted.to_string()), "{wanted}: {args:?}");
    }
}

#[test]
fn a_nested_desktop_asks_the_host_compositor_to_stop_reading_the_keyboard() {
    // Without this a nested desktop gets no Meta chords, because the host
    // compositor takes them first. sway stops when a client asks
    // (`shortcuts_inhibitor enable`), so the engine asks. Otherwise
    // `grabShortcut` bindings cannot be tested nested.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        args.contains(&"--domicile-inhibit-host-shortcuts".to_string()),
        "{args:?}"
    );
}

#[test]
fn a_desktop_with_no_host_compositor_has_nothing_to_inhibit() {
    // On `drm` the desktop is the compositor, and on `headless` there is no
    // host session, so there is nobody to ask.
    for platform in ["drm", "headless"] {
        let args = args_of(&engine(
            Path::new("/l/engine"),
            &shell(),
            platform,
            &runtime(),
            None,
        ));
        assert!(
            !args.contains(&"--domicile-inhibit-host-shortcuts".to_string()),
            "{platform}: {args:?}"
        );
    }
}

#[test]
fn the_engine_is_told_where_the_shell_is_and_where_the_compositor_is() {
    // The engine reads the shell's files itself and dials the compositor's
    // socket. Missing any of these three flags starts a desktop that shows
    // nothing, so each is asserted.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        args.contains(&"--domicile-shell-root=/d/dist".to_string()),
        "{args:?}"
    );
    // Relative: it becomes a `<script src>` resolved against
    // `domicile://shell/`, where an absolute path would not resolve.
    //
    // It is the module the user named, not a fixed `shell.js`.
    assert!(
        args.contains(&"--domicile-shell-module=main.js".to_string()),
        "{args:?}"
    );
    assert!(
        args.contains(&"--domicile-control-socket=/run/d/chrome.sock".to_string()),
        "{args:?}"
    );
}

#[test]
fn no_page_is_served_over_a_port() {
    // A page served on a host and port would be reachable by every process on
    // the machine.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(
        !args
            .iter()
            .any(|arg| arg.contains("http://") || arg.contains("localhost")),
        "{args:?}"
    );
}

#[test]
fn the_sandbox_stays_on() {
    // `--no-sandbox` removes the isolation between a page and the machine, and
    // Chromium shows a warning bar for it. A container that needs it adds it as
    // an extra flag.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    ));
    assert!(!args.iter().any(|arg| arg.contains("sandbox")), "{args:?}");
    assert!(
        !args
            .iter()
            .any(|arg| arg.starts_with("--enable-blink-features")),
        "the feature is stable in the pinned engine, and any value of that flag \
         draws a second unsupported-flag bar: {args:?}"
    );
}

#[test]
fn a_machine_that_needs_more_flags_adds_its_own() {
    // Extra flags come from an environment variable, split on whitespace, so a
    // machine can add what it needs without a flag per problem.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        Some("--no-sandbox  --disable-gpu"),
    ));
    assert!(args.contains(&"--no-sandbox".to_string()), "{args:?}");
    assert!(args.contains(&"--disable-gpu".to_string()), "{args:?}");
    assert!(!args.iter().any(|arg| arg.is_empty()), "{args:?}");
}

#[test]
fn the_compositor_is_a_producer_to_the_engine() {
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    let args = args_of(&spawned);
    assert_eq!(
        args,
        [
            "--chrome-socket",
            "/run/d/chrome.sock",
            "--session",
            "/run/d/session.json",
            "--engine-socket",
            "/run/d/broker",
            "--launches",
            "/run/d/launches.json",
            "--electron-entries",
            "/run/d/share",
        ]
    );
    // The engine's own directory, so `libdomicile_engine.so` is loadable.
    assert!(
        env_of(&spawned, "LD_LIBRARY_PATH")
            .unwrap()
            .starts_with("/l/engine"),
        "{spawned:?}"
    );
}

#[test]
fn the_session_puts_each_client_in_its_own_scope() {
    // Only a desk that is the login session asks the user manager for scopes.
    // A nested desk's clients belong to its host session.
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        true,
        &|_| None,
    );
    assert!(
        args_of(&spawned)
            .windows(2)
            .any(|pair| pair == ["--scope-clients", "yes"]),
        "{spawned:?}"
    );
}

#[test]
fn the_compositor_carries_this_desktops_control_socket_to_everything_it_starts() {
    // A terminal opened inside this desktop finds it through this variable,
    // since every app inherits the compositor's environment.
    //
    // It is set on the compositor, not exported by the supervisor, because a
    // supervisor started inside another desktop would pass on that desktop's
    // socket.
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    assert_eq!(
        env_of(&spawned, "DOMICILE_SOCK").unwrap(),
        "/run/d/domicile-ipc.4242.sock"
    );
}

#[test]
fn the_engine_reports_to_this_desktops_trace_socket_for_domicile_trace() {
    let spawned = engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    );
    assert_eq!(
        env_of(&spawned, "PERFETTO_PRODUCER_SOCK_NAME").unwrap(),
        "/run/d/domicile-ipc.4242.trace.sock"
    );
    let args = args_of(&spawned);
    let features = args
        .iter()
        .find_map(|arg| arg.strip_prefix("--enable-features="))
        .unwrap();
    assert!(
        features
            .split(',')
            .any(|feature| feature == "EnablePerfettoSystemTracing"),
        "{args:?}"
    );
}

#[test]
fn the_engine_carries_this_desktops_control_socket_to_what_it_starts() {
    // An app's `domicile-app-host`, started by the engine, reaches this
    // desktop with it.
    let spawned = engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    );
    assert_eq!(
        env_of(&spawned, "DOMICILE_SOCK").unwrap(),
        "/run/d/domicile-ipc.4242.sock"
    );
}

#[test]
fn a_link_an_app_opens_opens_in_this_desktop() {
    // Programs run `BROWSER` to open a link, and every app inherits the
    // compositor's environment, so links open in this desktop.
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    assert_eq!(env_of(&spawned, "BROWSER").unwrap(), "/b/domicile-open-url");
}

#[test]
fn xdg_open_is_this_desktops_for_every_app_it_starts() {
    // The shim directory goes first on `PATH`, so `xdg-open` is `domicile
    // open`. The rest of the path still resolves.
    let inherited = |name: &str| (name == "PATH").then(|| "/usr/bin:/bin".to_string());
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &inherited,
    );
    assert_eq!(
        env_of(&spawned, "PATH").unwrap(),
        "/run/d/bin:/usr/bin:/bin"
    );
}

#[test]
fn a_link_an_app_opens_through_gio_or_a_portal_opens_in_this_desktop_too() {
    // GIO and the portal skip `xdg-open` and read `domicile-mimeapps.list` from
    // the data directories, since `XDG_CURRENT_DESKTOP` is `domicile`. The
    // desktop's `share` holds that file and its `domicile-open-url` entry, so
    // it goes first, with no file in the user's home.
    let inherited = |name: &str| (name == "XDG_DATA_DIRS").then(|| "/run/sw/share".to_string());
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &inherited,
    );
    assert_eq!(
        env_of(&spawned, "XDG_DATA_DIRS").unwrap(),
        "/run/d/share:/d/share:/run/sw/share"
    );
}

#[test]
fn a_machine_with_no_data_directories_keeps_the_defaults_behind_this_desktops() {
    // Unset means `/usr/local/share:/usr/share`, so those defaults stay after
    // this desktop's directory.
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    assert_eq!(
        env_of(&spawned, "XDG_DATA_DIRS").unwrap(),
        "/run/d/share:/d/share:/usr/local/share:/usr/share"
    );
}

#[test]
fn a_link_a_page_opens_in_an_app_runs_this_desktops_xdg_open() {
    // The engine hands `slack:` and other app links to `xdg-open`. It must be
    // `domicile open`, which the shell's "Open Slack?" prompt names the app
    // from, or the machine's `xdg-open` finds no app and nothing opens.
    let inherited = |name: &str| (name == "PATH").then(|| "/usr/bin:/bin".to_string());
    let mut spawned = engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    );
    let_the_engine_open_links(&mut spawned, Path::new("/d/share"), &runtime(), &inherited);
    assert_eq!(
        env_of(&spawned, "PATH").unwrap(),
        "/run/d/bin:/usr/bin:/bin"
    );
}

#[test]
fn a_link_a_page_opens_in_an_app_finds_the_apps_the_compositor_finds() {
    // `domicile open` reads the data directories for the entries that run
    // the config's Electron apps on the engine, as an app the compositor
    // started does.
    let inherited = |name: &str| (name == "XDG_DATA_DIRS").then(|| "/run/sw/share".to_string());
    let mut spawned = engine(
        Path::new("/l/engine"),
        &shell(),
        "wayland",
        &runtime(),
        None,
    );
    let_the_engine_open_links(&mut spawned, Path::new("/d/share"), &runtime(), &inherited);
    assert_eq!(
        env_of(&spawned, "XDG_DATA_DIRS").unwrap(),
        "/run/d/share:/d/share:/run/sw/share"
    );
}

#[test]
fn the_engines_libraries_go_in_front_of_whatever_was_there() {
    // Prepended: an existing `LD_LIBRARY_PATH` points at libraries the machine
    // needs.
    let inherited = |name: &str| (name == "LD_LIBRARY_PATH").then(|| "/opt/lib".to_string());
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &inherited,
    );
    assert_eq!(
        env_of(&spawned, "LD_LIBRARY_PATH").unwrap(),
        "/l/engine:/opt/lib"
    );
}

#[test]
fn the_compositor_is_quiet_unless_asked_otherwise() {
    // The default shows errors alone; `domicile set-log-level` turns it up.
    // An explicit `RUST_LOG` wins.
    let quiet = compositor(
        Path::new("/b/c"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    assert_eq!(env_of(&quiet, "RUST_LOG").unwrap(), "error");

    let asked = |name: &str| (name == "RUST_LOG").then(|| "warn".to_string());
    let spawned = compositor(
        Path::new("/b/c"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &asked,
    );
    assert_eq!(env_of(&spawned, "RUST_LOG").unwrap(), "warn");
}

#[test]
fn the_engine_is_asked_to_say_what_it_did_about_input() {
    // A release build without `--enable-logging` prints only ERROR and above to
    // stderr (`base/logging.cc`). The fork logs input failures, such as a
    // revoked device or a console taken back, at ERROR, so these flags make
    // them visible. The level stays at ERROR because upstream logs a dozen
    // routine WARNINGs on a nested run. Nested runs use the same engine, so
    // they get the same flags.
    for platform in ["drm", "wayland", "headless"] {
        let args = args_of(&engine(
            Path::new("/l/engine"),
            &shell(),
            platform,
            &runtime(),
            None,
        ));
        assert!(
            args.contains(&"--enable-logging=stderr".to_string()),
            "{platform}: {args:?}"
        );
        assert!(
            args.contains(&"--log-level=2".to_string()),
            "{platform}: {args:?}"
        );
    }
}

#[test]
fn a_run_that_wants_more_than_errors_can_ask_for_them() {
    // The default is a floor. `extra` comes after the built list, and
    // `CommandLine::AppendSwitchNative` keeps the last value of a switch, so a
    // run can ask for INFO through `extra`.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "drm",
        &runtime(),
        Some("--log-level=0"),
    ));
    let levels: Vec<&String> = args
        .iter()
        .filter(|arg| arg.starts_with("--log-level="))
        .collect();
    assert_eq!(levels, vec!["--log-level=2", "--log-level=0"], "{args:?}");
}

#[test]
fn the_engine_is_told_a_touchpad_is_libinputs() {
    // Without this the pointer draws but a touchpad never moves it.
    // `CreateConverter` has a touchpad branch only under `USE_EVDEV_GESTURES`
    // (ChromeOS devices). Other pads fall through to `EventConverterEvdevImpl`,
    // which ignores `EV_ABS`, so every finger position is dropped silently.
    //
    // `EventDeviceInfo::UseLibinput` honors an overridden
    // `kLibinputHandleTouchpad`, which is disabled by default, so the override
    // is required. Patch 0027 lets libinput read a descriptor it cannot open
    // itself.
    //
    // Set on every platform so a developer's touchpad behaves the same nested.
    for platform in ["drm", "wayland", "headless"] {
        let args = args_of(&engine(
            Path::new("/l/engine"),
            &shell(),
            platform,
            &runtime(),
            None,
        ));
        assert!(
            features_of(&args).contains(&"LibinputHandleTouchpad"),
            "{platform}: {args:?}"
        );
    }
}

#[test]
fn the_engine_is_told_a_mouse_is_libinputs() {
    // `EventConverterEvdevImpl` reads mouse motion raw, with no acceleration,
    // and ignores `REL_WHEEL`. `kLibinputHandleMouse` (patch 0059) is off
    // unless overridden.
    for platform in ["drm", "wayland", "headless"] {
        let args = args_of(&engine(
            Path::new("/l/engine"),
            &shell(),
            platform,
            &runtime(),
            None,
        ));
        assert!(
            features_of(&args).contains(&"LibinputHandleMouse"),
            "{platform}: {args:?}"
        );
    }
}

#[test]
fn a_machine_that_enables_features_keeps_libinput() {
    // The last `--enable-features` wins, so the extra features join the
    // built-in ones in one flag.
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "drm",
        &runtime(),
        Some("--enable-features=Vulkan --v=1 --enable-features=DefaultANGLEVulkan"),
    ));
    assert_eq!(
        features_of(&args),
        [
            "LibinputHandleTouchpad",
            "LibinputHandleMouse",
            "EnablePerfettoSystemTracing",
            "Vulkan",
            "DefaultANGLEVulkan",
        ]
    );
    assert!(args.contains(&"--v=1".to_string()), "{args:?}");
}

#[test]
fn a_machine_that_disables_features_gets_one_flag_for_them() {
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "drm",
        &runtime(),
        Some("--disable-features=Vulkan --disable-features=LibinputHandleMouse"),
    ));
    let lists: Vec<&String> = args
        .iter()
        .filter(|arg| arg.starts_with("--disable-features="))
        .collect();
    assert_eq!(
        lists,
        ["--disable-features=V8Flag_scavenger_direct_old_allocation,Vulkan,LibinputHandleMouse"],
        "{args:?}"
    );
}

#[test]
fn the_engine_starts_without_the_v8_flag_its_v8_rejects() {
    let args = args_of(&engine(
        Path::new("/l/engine"),
        &shell(),
        "drm",
        &runtime(),
        None,
    ));
    assert!(
        args.contains(&"--disable-features=V8Flag_scavenger_direct_old_allocation".to_string()),
        "{args:?}"
    );
}

/// The features in the single `--enable-features` flag. A second flag would
/// replace the first.
fn features_of(args: &[String]) -> Vec<&str> {
    let lists: Vec<&str> = args
        .iter()
        .filter_map(|arg| arg.strip_prefix("--enable-features="))
        .collect();
    assert_eq!(lists.len(), 1, "{args:?}");
    lists[0].split(',').collect()
}

#[test]
fn the_compositor_is_given_the_config_it_was_started_with() {
    // The monitors, their scales and rotations are in this file, and the
    // compositor is the process that reads it.
    let spawned = compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        Some(Path::new("/etc/domicile/desk.json")),
        false,
        &|_| None,
    );
    let args = args_of(&spawned);
    assert_eq!(
        args,
        [
            "--chrome-socket",
            "/run/d/chrome.sock",
            "--session",
            "/run/d/session.json",
            "--engine-socket",
            "/run/d/broker",
            "--launches",
            "/run/d/launches.json",
            "--electron-entries",
            "/run/d/share",
            "--config",
            "/etc/domicile/desk.json",
        ]
    );
}

#[test]
fn a_desktop_with_no_config_is_given_no_flag_rather_than_an_empty_one() {
    // `Config::load` fails on a path it cannot open, so an empty `--config`
    // would stop the compositor from starting.
    let args = args_of(&compositor(
        Path::new("/b/domicile-compositor"),
        Path::new("/l/engine"),
        Path::new("/b/domicile-open-url"),
        Path::new("/d/share"),
        &runtime(),
        None,
        false,
        &|_| None,
    ));
    assert!(
        !args.iter().any(|arg| arg == "--config"),
        "no config was asked for, so none should be named: {args:?}"
    );
}

#[test]
fn an_engine_on_the_cpu_has_no_gpu() {
    // Software compositing over dumb buffers. With a GL that only half works
    // (Mesa's software rasterizer behind a 2D card), Chromium would otherwise
    // composite on it, and the compositor's shared-memory windows would be
    // dropped.
    let mut spawned = engine(Path::new("/l/engine"), &shell(), "drm", &runtime(), None);
    composite_on_the_cpu(&mut spawned);

    assert!(args_of(&spawned).contains(&"--disable-gpu".to_string()));
}

#[test]
fn a_compositor_for_an_engine_on_the_cpu_sends_frames_in_memory() {
    let mut spawned = compositor(
        Path::new("/l/compositor"),
        Path::new("/l/engine"),
        Path::new("/l/open-url"),
        Path::new("/l/data"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    send_frames_in_memory(&mut spawned);

    let args = args_of(&spawned);
    let at = args
        .iter()
        .position(|arg| arg == "--software-compositing")
        .expect("the flag is passed");
    assert_eq!(args[at + 1], "yes");
}

#[test]
fn a_compositor_for_a_headless_desk_lets_the_engine_take_input() {
    let mut spawned = compositor(
        Path::new("/l/compositor"),
        Path::new("/l/engine"),
        Path::new("/l/open-url"),
        Path::new("/l/data"),
        &runtime(),
        None,
        false,
        &|_| None,
    );
    let_the_engine_take_input(&mut spawned);

    let args = args_of(&spawned);
    let at = args
        .iter()
        .position(|arg| arg == "--engine-takes-input")
        .expect("the flag is passed");
    assert_eq!(args[at + 1], "yes");
}

#[test]
fn the_engine_takes_emulated_input_on_a_desk_it_drives() {
    assert!(the_engine_takes_input("headless"), "its only input");
    assert!(the_engine_takes_input("drm"), "so the lock screen hears it");
    assert!(
        !the_engine_takes_input("wayland"),
        "nested, the host session's seat delivers it"
    );
}
