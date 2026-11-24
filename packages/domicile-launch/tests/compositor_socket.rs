//! Tests for asking the compositor for a screenshot, to send the shell a
//! command, or for its theme, over its chrome socket.

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use domicile_host::system::DisplayPower;
use domicile_launch::cli::MonitorMode;
use domicile_launch::compositor_socket::{
    act_on_window, agent, agents, displays, forget_agent, inputs, launch, lock, monitors,
    power_displays, screen_record, screenshot, send_shell, set_log_levels, shell_bindings,
    shell_commands, status, stop_agent, theme, virtual_monitor, windows, CompositorError,
};
use domicile_launch::control::Shot;
use domicile_protocol::{
    AgentReach, ConnectedAgent, DisplayHdr, KnownAgents, LogLevel, LogLevels, MonitorInfo,
    RememberedAgent, Scale, Theme, WindowAct,
};

/// Reply timeout: long enough for a loaded machine, short enough for a fast
/// suite.
const BRIEFLY: Duration = Duration::from_millis(200);

const PANE: MonitorMode = MonitorMode {
    size: (1280, 720),
    refresh_mhz: 60_000,
    scale: Scale::ONE,
};

#[test]
fn the_compositor_is_asked_for_the_whole_desk_in_the_file_and_says_it_saved_it() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        Duration::ZERO,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"saved\",\
             \"path\":\"/home/me/shot.png\"}}\n",
        ),
    );

    assert_eq!(
        screenshot(&path, Some(Path::new("/home/me/shot.png")), Some(BRIEFLY)),
        Ok(Shot::Saved(PathBuf::from("/home/me/shot.png")))
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        "{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\"screenshot\",\
         \"file\":\"/home/me/shot.png\"}}\n"
    );
}

#[test]
fn a_compositor_that_could_not_save_it_is_carried_back_in_its_own_words() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        Duration::ZERO,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"failed\",\
             \"error\":{\"kind\":\"locked\",\"message\":\"the desktop is locked\"}}}\n",
        ),
    );

    let why = screenshot(&path, Some(Path::new("/home/me/shot.png")), Some(BRIEFLY))
        .expect_err("the compositor refused");

    assert_eq!(
        why,
        CompositorError::Refused {
            why: "the desktop is locked".to_string()
        }
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn a_compositor_that_is_not_there_is_said_rather_than_waited_for() {
    let (_scratch, path) = scratch();

    let why = screenshot(&path, Some(Path::new("/home/me/shot.png")), Some(BRIEFLY))
        .expect_err("nothing is bound there");

    assert_eq!(
        why,
        CompositorError::NoCompositor {
            path: path.display().to_string()
        }
    );
}

#[test]
fn a_compositor_that_says_nothing_did_not_save_it() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(&path, Duration::ZERO, None);

    let why = screenshot(&path, Some(Path::new("/home/me/shot.png")), Some(BRIEFLY))
        .expect_err("the compositor never answered");

    assert_eq!(
        why,
        CompositorError::NoAnswer {
            path: path.display().to_string()
        }
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn a_compositor_that_stays_silent_past_the_patience_did_not_save_it() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(&path, BRIEFLY * 4, None);
    let asked = std::time::Instant::now();

    let why = screenshot(&path, Some(Path::new("/home/me/shot.png")), Some(BRIEFLY))
        .expect_err("the compositor never answered");

    assert_eq!(
        why,
        CompositorError::NoAnswer {
            path: path.display().to_string()
        }
    );
    assert!(
        asked.elapsed() < BRIEFLY * 3,
        "it waited for the hang-up rather than its patience: {:?}",
        asked.elapsed()
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn an_answer_that_is_not_a_reply_is_unreadable() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(&path, Duration::ZERO, Some("{\"type\":\"welcome\"}\n"));

    let why = screenshot(&path, Some(Path::new("/home/me/shot.png")), Some(BRIEFLY))
        .expect_err("not a reply");

    assert_eq!(
        why,
        CompositorError::Unreadable {
            path: path.display().to_string(),
            said: "{\"type\":\"welcome\"}".to_string(),
        }
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn a_screenshot_with_no_file_is_the_shells_and_waits_for_the_user_to_pick() {
    // The user takes as long as they take, so the supervisor gives no
    // patience.
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        BRIEFLY * 2,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"saved\",\
             \"path\":\"/home/me/Pictures/Screenshots/picked.png\"}}\n",
        ),
    );

    assert_eq!(
        screenshot(&path, None, None),
        Ok(Shot::Saved(PathBuf::from(
            "/home/me/Pictures/Screenshots/picked.png"
        )))
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        "{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\"screenshot\",\
         \"file\":null}}\n"
    );
}

#[test]
fn a_screen_recording_waits_until_it_stops_and_answers_with_its_file() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        BRIEFLY * 2,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"saved\",\
             \"path\":\"/home/me/Videos/rec.webm\"}}\n",
        ),
    );

    assert_eq!(
        screen_record(&path),
        Ok(Some(PathBuf::from("/home/me/Videos/rec.webm")))
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        "{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\"screen_record\"}}\n"
    );
}

#[test]
fn a_screen_recording_canceled_has_no_file() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        Duration::ZERO,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"failed\",\
             \"error\":{\"kind\":\"canceled\",\"message\":\"discarded\"}}}\n",
        ),
    );

    assert_eq!(screen_record(&path), Ok(None));
    heard.join().expect("the compositor was listening");
}

#[test]
fn a_screenshot_the_user_copied_is_copied_rather_than_saved() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        Duration::ZERO,
        Some("{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"copied\"}}\n"),
    );

    assert_eq!(screenshot(&path, None, None), Ok(Shot::Copied));
    heard.join().expect("the compositor was listening");
}

#[test]
fn a_screenshot_the_user_dismissed_is_canceled_rather_than_refused() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        Duration::ZERO,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"failed\",\
             \"error\":{\"kind\":\"canceled\",\"message\":\"the screenshot dialog was dismissed\"}}}\n",
        ),
    );

    assert_eq!(screenshot(&path, None, None), Ok(Shot::Canceled));
    heard.join().expect("the compositor was listening");
}

#[test]
fn the_compositor_is_told_to_send_the_command_and_says_it_did() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        Duration::ZERO,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"sent\",\
             \"output\":\"done\"}}\n",
        ),
    );

    // What the shell printed comes back, for `domicile send-shell` to print.
    assert_eq!(
        send_shell(
            &path,
            &["focus".to_string(), "right".to_string()],
            Some(BRIEFLY)
        ),
        Ok(Some("done".to_string()))
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        "{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\"send_shell\",\
         \"command\":[\"focus\",\"right\"]}}\n"
    );
}

#[test]
fn the_compositor_is_told_to_sleep_or_wake_the_displays_and_says_it_did() {
    for (power, display, request) in [
        (DisplayPower::Asleep, None, "{\"call\":\"sleep_displays\"}"),
        (
            DisplayPower::Awake,
            Some("DP-1"),
            "{\"call\":\"wake_displays\",\"display\":\"DP-1\"}",
        ),
    ] {
        let (_scratch, path) = scratch();
        let heard = a_compositor(
            &path,
            Duration::ZERO,
            Some("{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"set\"}}\n"),
        );

        assert_eq!(power_displays(&path, power, display, Some(BRIEFLY)), Ok(()));
        assert_eq!(
            heard.join().expect("the compositor was listening"),
            format!("{{\"type\":\"system_request\",\"id\":1,\"request\":{request}}}\n")
        );
    }
}

#[test]
fn a_command_the_compositor_did_not_send_is_carried_back_in_its_own_words() {
    let (_scratch, path) = scratch();
    let heard = a_compositor(
        &path,
        Duration::ZERO,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"failed\",\
             \"error\":{\"kind\":\"locked\",\"message\":\"the desktop is locked\"}}}\n",
        ),
    );

    assert_eq!(
        send_shell(&path, &["focus".to_string()], Some(BRIEFLY)),
        Err(CompositorError::Refused {
            why: "the desktop is locked".to_string()
        })
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn the_compositor_is_told_to_start_a_program_and_heard_to_start_it() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(&path, "exec", "{\"type\":\"executed\"}\n");

    assert_eq!(
        launch(
            &path,
            &["slack".to_string(), "slack://T1/magic-login/1".to_string()],
            Some(BRIEFLY)
        ),
        Ok(())
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        vec![
            "{\"type\":\"exec\",\"command\":[\"slack\",\"slack://T1/magic-login/1\"]}\n"
                .to_string(),
        ]
    );
}

#[test]
fn a_program_that_did_not_start_says_why() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "exec",
        "{\"type\":\"executed\",\"refused\":\"kitty is not on the desktop's PATH\"}\n",
    );

    assert_eq!(
        launch(&path, &["kitty".to_string()], Some(BRIEFLY)),
        Err(CompositorError::Refused {
            why: "kitty is not on the desktop's PATH".to_string()
        })
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn the_compositor_is_asked_its_theme_and_says_it() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked_its_theme(&path, "{\"type\":\"theme\",\"theme\":\"dark\"}\n");

    assert_eq!(theme(&path, None, Some(BRIEFLY)), Ok(Theme::Dark));
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        vec!["{\"type\":\"which_theme\"}\n".to_string()]
    );
}

#[test]
fn the_compositor_is_told_the_theme_then_asked_it() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked_its_theme(&path, "{\"type\":\"theme\",\"theme\":\"light\"}\n");

    assert_eq!(
        theme(&path, Some(Theme::Light), Some(BRIEFLY)),
        Ok(Theme::Light)
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        vec![
            "{\"type\":\"set_theme\",\"theme\":\"light\"}\n".to_string(),
            "{\"type\":\"which_theme\"}\n".to_string(),
        ]
    );
}

#[test]
fn a_theme_the_compositor_did_not_name_is_carried_back() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked_its_theme(&path, "{\"type\":\"locked\",\"locked\":true}\n");

    assert_eq!(
        theme(&path, None, Some(BRIEFLY)),
        Err(CompositorError::Unreadable {
            path: path.display().to_string(),
            said: "{\"type\":\"locked\",\"locked\":true}".to_string()
        })
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn the_compositor_is_asked_its_monitors_and_says_them() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_monitors",
        "{\"type\":\"monitors\",\"monitors\":[{\"names\":[\"drm-1\",\"DEL DELL U3219Q 2ZLS413\"],\
         \"hdr\":\"on\"}]}\n",
    );

    assert_eq!(
        monitors(&path, Some(BRIEFLY)),
        Ok(vec![MonitorInfo {
            names: vec!["drm-1".to_string(), "DEL DELL U3219Q 2ZLS413".to_string()],
            hdr: DisplayHdr::On,
        }])
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        vec!["{\"type\":\"which_monitors\"}\n".to_string()]
    );
}

#[test]
fn the_compositor_is_asked_its_displays_and_windows_and_says_them() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_displays",
        "{\"type\":\"display_list\",\"displays\":[{\"name\":\"drm-1\",\"position\":[0,0],\
         \"size\":[1920,1080],\"scale\":1,\"names\":[\"drm-1\",\"DP-1\"],\"lit\":false}]}\n",
    );
    let displays = displays(&path, Some(BRIEFLY)).expect("the compositor listed them");
    assert_eq!(
        (
            displays[0].display.name.as_str(),
            displays[0].names.len(),
            displays[0].lit
        ),
        ("drm-1", 2, false)
    );
    assert_eq!(
        heard.join().expect("the compositor was listening"),
        vec!["{\"type\":\"which_displays\"}\n".to_string()]
    );

    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_windows",
        "{\"type\":\"window_list\",\"windows\":[{\"id\":\"kD3m\",\"kind\":\"browser\",\
         \"title\":\"Inbox\",\"app\":null,\"pid\":null,\"size\":null,\"focused\":false,\
         \"urgent\":false,\"url\":\"https://mail.example/\",\"private\":true}]}\n",
    );
    let windows = windows(&path, Some(BRIEFLY)).expect("the compositor listed them");
    assert_eq!(windows[0].title, "Inbox");
    assert_eq!(
        (windows[0].url.as_deref(), windows[0].private),
        (Some("https://mail.example/"), true)
    );
    heard.join().expect("the compositor was listening");

    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_status",
        "{\"type\":\"status\",\"theme\":\"light\",\"locked\":true,\"keymap\":null,\
         \"screens_off\":false,\"held_awake_by\":[\"mpv\"],\"capturing\":[]}\n",
    );
    let status = status(&path, Some(BRIEFLY)).expect("the compositor said");
    assert_eq!(
        (status.locked, status.held_awake_by),
        (true, vec!["mpv".to_string()])
    );
    heard.join().expect("the compositor was listening");

    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_shell_commands",
        "{\"type\":\"shell_command_list\",\"commands\":[{\"usage\":\"lock\",\
         \"description\":\"Lock the desktop.\"}]}\n",
    );
    let commands = shell_commands(&path, Some(BRIEFLY)).expect("the compositor said");
    assert_eq!(commands[0].usage, "lock");
    heard.join().expect("the compositor was listening");

    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_shell_bindings",
        "{\"type\":\"shell_binding_list\",\"bindings\":[{\"mode\":\"default\",\
         \"chord\":\"Meta+l\",\"action\":\"send-shell lock\"}]}\n",
    );
    let bindings = shell_bindings(&path, Some(BRIEFLY)).expect("the compositor said");
    assert_eq!(bindings[0].chord, "Meta+l");
    heard.join().expect("the compositor was listening");

    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_inputs",
        "{\"type\":\"input_list\",\"inputs\":[{\"id\":4,\"name\":\"Keyboard\",\
         \"kind\":\"keyboard\",\"connection\":\"usb\",\"sys_path\":\"\",\
         \"vendor\":1133,\"product\":49948}]}\n",
    );
    let inputs = inputs(&path, Some(BRIEFLY)).expect("the compositor said");
    assert_eq!(inputs[0].vendor, 0x046d);
    heard.join().expect("the compositor was listening");
}

#[test]
fn monitors_the_compositor_did_not_describe_are_carried_back() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_monitors",
        "{\"type\":\"locked\",\"locked\":true}\n",
    );

    assert_eq!(
        monitors(&path, Some(BRIEFLY)),
        Err(CompositorError::Unreadable {
            path: path.display().to_string(),
            said: "{\"type\":\"locked\",\"locked\":true}".to_string()
        })
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn a_virtual_monitor_is_added_resized_and_given_back() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_lending(
        &path,
        "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"virtual_monitor\",\
         \"output\":\"virtual-1\"}}\n",
    );

    let held =
        virtual_monitor(&path, "Pane", PANE, Some(BRIEFLY)).expect("the compositor added it");
    assert_eq!(held.output(), "virtual-1");
    held.resize(MonitorMode {
        size: (800, 600),
        refresh_mhz: 30_000,
        scale: Scale::try_from(2.0).expect("a scale"),
    })
    .expect("the compositor took it");
    held.give_back();

    assert_eq!(
        heard.join().expect("the compositor was listening"),
        vec![
            "{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\"virtual_monitor\",\
             \"name\":\"Pane\",\"width\":1280,\"height\":720,\"refresh_mhz\":60000,\"scale\":1.0}}\n",
            "{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\
             \"resize_virtual_monitor\",\"width\":800,\"height\":600,\"refresh_mhz\":30000,\"scale\":2.0}}\n",
        ]
    );
}

#[test]
fn a_compositor_that_will_not_add_a_monitor_is_quoted() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_lending(
        &path,
        "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"failed\",\
         \"error\":{\"kind\":\"other\",\"message\":\"nested\"}}}\n",
    );

    let refused = virtual_monitor(&path, "Pane", PANE, Some(BRIEFLY))
        .err()
        .expect("the compositor refused");

    assert_eq!(
        refused,
        CompositorError::Refused {
            why: "nested".to_string()
        }
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn a_held_monitor_hears_its_compositor_go() {
    let (_scratch, path) = scratch();
    let compositor = a_compositor(
        &path,
        Duration::ZERO,
        Some(
            "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"virtual_monitor\",\
             \"output\":\"virtual-1\"}}\n",
        ),
    );
    let held =
        virtual_monitor(&path, "Pane", PANE, Some(BRIEFLY)).expect("the compositor added it");
    compositor
        .join()
        .expect("the compositor answered, then exited");

    // Returns: the compositor hung up, taking the monitor with it.
    held.until_it_ends();
}

/// A fake compositor at `path` that reads the request, replies `with`, then
/// reads until the supervisor gives the monitor back, and returns the lines.
fn a_compositor_lending(path: &Path, with: &'static str) -> std::thread::JoinHandle<Vec<String>> {
    let listener = UnixListener::bind(path).expect("the compositor binds its chrome socket");
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("a supervisor dialed");
        let mut reader = BufReader::new(stream.try_clone().expect("the connection is readable"));
        let mut first = String::new();
        reader.read_line(&mut first).expect("the supervisor asked");
        let mut answering = stream;
        answering
            .write_all(with.as_bytes())
            .expect("the compositor answers");
        std::iter::once(first)
            .chain(reader.lines().map(|line| line.expect("a line") + "\n"))
            .collect()
    })
}

/// A fake compositor at `path` that reads lines up to `which_theme`, replies
/// `with`, and returns the lines.
fn a_compositor_asked_its_theme(
    path: &Path,
    with: &'static str,
) -> std::thread::JoinHandle<Vec<String>> {
    a_compositor_asked(path, "which_theme", with)
}

/// A fake compositor at `path` that reads lines until one names `last`, then
/// replies `with`. Returns the lines it read.
fn a_compositor_asked(
    path: &Path,
    last: &'static str,
    with: &'static str,
) -> std::thread::JoinHandle<Vec<String>> {
    let listener = UnixListener::bind(path).expect("the compositor binds its chrome socket");
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("a supervisor dialed");
        let mut reader = BufReader::new(stream.try_clone().expect("the connection is readable"));
        let mut lines = Vec::new();
        while lines
            .last()
            .is_none_or(|line: &String| !line.contains(last))
        {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("the supervisor wrote a line");
            lines.push(line);
        }
        let mut answering = stream;
        answering
            .write_all(with.as_bytes())
            .expect("the compositor answers");
        lines
    })
}

/// A fake compositor at `path` that reads one line and, `after` that long,
/// replies `with`, or hangs up if `with` is `None`.
fn a_compositor(
    path: &Path,
    after: Duration,
    with: Option<&'static str>,
) -> std::thread::JoinHandle<String> {
    let listener = UnixListener::bind(path).expect("the compositor binds its chrome socket");
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("a supervisor dialed");
        let mut line = String::new();
        BufReader::new(stream.try_clone().expect("the connection is readable"))
            .read_line(&mut line)
            .expect("the supervisor wrote a line");
        std::thread::sleep(after);
        if let Some(answer) = with {
            let mut answering = stream;
            answering
                .write_all(answer.as_bytes())
                .expect("the compositor answers");
        }
        line
    })
}

/// A temporary directory and an unused socket path in it.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("a temp directory");
    let path = directory.path().join("chrome.sock");
    (directory, path)
}

#[test]
fn log_levels_are_answered_with_why_not() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "set_log_levels",
        "{\"type\":\"log_levels_set\",\"refused\":\"no filter\"}\n",
    );
    let levels = LogLevels {
        all: Some(LogLevel::Debug),
        ..LogLevels::default()
    };

    assert_eq!(
        set_log_levels(&path, &levels, Some(BRIEFLY)),
        Ok(Err("no filter".to_string()))
    );
    let asked = heard.join().expect("the compositor was listening");
    assert!(asked[0].contains("\"all\":\"debug\""), "{asked:?}");
}

#[test]
fn a_window_act_is_answered_with_why_not() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "act_on_window",
        "{\"type\":\"window_acted\",\"refused\":\"no window kD3m\"}\n",
    );

    assert_eq!(
        act_on_window(&path, "kD3m", WindowAct::Focus, Some(BRIEFLY)),
        Ok(Err("no window kD3m".to_string()))
    );
    let asked = heard.join().expect("the compositor was listening");
    assert!(asked[0].contains("\"act\":\"focus\""), "{asked:?}");
}

#[test]
fn a_lock_is_taken_when_the_status_after_it_is_answered() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "which_status",
        "{\"type\":\"status\",\"theme\":\"dark\",\"locked\":true,\"keymap\":null,\
         \"screens_off\":false,\"held_awake_by\":[],\"capturing\":[]}\n",
    );

    assert_eq!(lock(&path, Some(BRIEFLY)), Ok(()));
    let asked = heard.join().expect("the compositor was listening");
    assert!(asked[0].contains("\"lock\""), "{asked:?}");
}

#[test]
fn the_compositor_is_asked_its_agents_and_says_them() {
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(
        &path,
        "\"agents\"",
        "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"agents\",\
         \"connected\":[{\"session\":4,\"agent\":\"Claude Code\",\"reach\":{\"type\":\"desk\"}}],\
         \"remembered\":[{\"agent\":\"Codex\",\"last_used_ms\":9}]}}\n",
    );

    assert_eq!(
        agents(&path, Some(BRIEFLY)),
        Ok(KnownAgents {
            connected: vec![ConnectedAgent {
                session: 4,
                agent: "Claude Code".into(),
                reach: AgentReach::Desk,
            }],
            remembered: vec![RememberedAgent {
                agent: "Codex".into(),
                last_used_ms: 9,
            }],
        })
    );
    heard.join().expect("the compositor was listening");
}

#[test]
fn the_compositor_is_told_to_stop_and_forget_agents() {
    let set = "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"set\"}}\n";
    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(&path, "stop_agent", set);
    assert_eq!(stop_agent(&path, 4, Some(BRIEFLY)), Ok(()));
    assert!(heard.join().expect("the compositor was listening")[0].contains("\"session\":4"));

    let (_scratch, path) = scratch();
    let heard = a_compositor_asked(&path, "forget_agent", set);
    assert_eq!(forget_agent(&path, "Codex", Some(BRIEFLY)), Ok(()));
    assert!(heard.join().expect("the compositor was listening")[0].contains("\"Codex\""));
}

#[test]
fn a_held_agent_hears_each_change_then_its_end() {
    let (_scratch, path) = scratch();
    let listener = UnixListener::bind(&path).expect("the compositor binds its chrome socket");
    let compositor = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("a supervisor dialed");
        let mut reader = BufReader::new(stream.try_clone().expect("the connection is readable"));
        reader
            .read_line(&mut String::new())
            .expect("the supervisor asked");
        let mut answering = stream;
        answering
            .write_all(
                b"{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"agent\",\
                  \"reach\":{\"type\":\"desk\"}}}\n\
                  {\"type\":\"system_event\",\"id\":1,\"event\":{\"kind\":\"agent_reach\",\
                  \"reach\":{\"type\":\"windows\",\"windows\":[]}}}\n\
                  {\"type\":\"system_end\",\"id\":1,\"end\":{\"kind\":\"stopped\"}}\n",
            )
            .expect("the compositor answers");
    });
    let held = agent(&path, "Claude Code", Some(BRIEFLY)).expect("the user let it in");
    compositor.join().expect("the compositor answered");

    assert_eq!(held.reach(), &AgentReach::Desk);
    assert_eq!(
        held.changed(),
        Some(AgentReach::Windows { windows: vec![] })
    );
    assert_eq!(held.changed(), None);
}
