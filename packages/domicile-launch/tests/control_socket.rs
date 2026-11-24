//! Control socket naming, ownership and client errors.

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;

use domicile_launch::cli::MonitorMode;
use domicile_launch::control::{Request, Response};
use domicile_launch::control_socket::{
    address, advertised, answer_one, ask, hold, listen, serve_one, take, AskError, Lenders,
    NotInADesktop, TakeError,
};
use domicile_protocol::{HostMessage, Scale, Theme, WatchTopic};

/// Read timeout: long enough not to flake under load, short enough to keep the
/// suite fast.
const BRIEFLY: Duration = Duration::from_millis(200);

#[test]
fn the_socket_is_named_after_the_desktop_that_answers_on_it() {
    // One socket per desktop, keyed by pid like sway's
    // `sway-ipc.<uid>.<pid>.sock`.
    assert_eq!(
        address(Some("/run/user/1000"), 4242),
        PathBuf::from("/run/user/1000/domicile-ipc.4242.sock")
    );
}

#[test]
fn with_no_runtime_directory_it_goes_where_the_runs_own_files_do() {
    // Same fallback as the run directory, so a desktop's sockets and its
    // control socket stay together.
    assert_eq!(
        address(None, 4242),
        std::env::temp_dir().join("domicile-ipc.4242.sock")
    );
}

#[test]
fn a_client_is_told_which_desktop_it_is_inside() {
    // Only the variable counts. A session can hold several desktops, so
    // scanning the runtime directory would have to guess.
    assert_eq!(
        advertised(Some("/run/user/1000/domicile-ipc.4242.sock")),
        Ok(PathBuf::from("/run/user/1000/domicile-ipc.4242.sock"))
    );
}

#[test]
fn a_client_outside_every_desktop_is_told_so_rather_than_guessed_for() {
    assert_eq!(advertised(None), Err(NotInADesktop));
}

#[test]
fn a_desktop_takes_the_socket_and_keeps_it_to_itself() {
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");

    assert!(
        UnixStream::connect(&path).is_ok(),
        "a desktop that took the socket is answering on it"
    );
    // 0600 because the /tmp fallback is shared with every user on the machine.
    assert_eq!(
        std::fs::metadata(&path)
            .expect("the socket is on disk")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    drop(control);
    assert!(
        !path.exists(),
        "a run that ended took its socket with it: a file left behind is the \
         next run's stale socket"
    );
}

#[test]
fn two_desktops_on_one_session_each_answer_a_socket_of_their_own() {
    // Keying the name on the pid lets several desktops run at once, as Wayland
    // counts up from `wayland-0`.
    let scratch = tempfile::tempdir().expect("a scratch directory");
    let session = scratch.path().to_str().expect("a utf-8 scratch directory");
    let mine = address(Some(session), 4242);
    let theirs = address(Some(session), 4243);

    let _first = take(&mine).expect("nothing was there");
    let _second = take(&theirs).expect("and the first desktop is not in the way");

    assert!(UnixStream::connect(&mine).is_ok(), "both are answering");
    assert!(UnixStream::connect(&theirs).is_ok(), "both are answering");
}

#[test]
fn a_socket_that_is_already_answering_is_not_taken_from_whoever_has_it() {
    // The pid in the name keeps desktops apart. The check stays so a run never
    // deletes a socket another process is serving.
    let (_scratch, path) = scratch();
    let _first = take(&path).expect("nothing was there");

    assert_eq!(
        take(&path).unwrap_err(),
        TakeError::AlreadyRunning {
            path: path.display().to_string()
        }
    );
}

#[test]
fn the_socket_a_dead_desktop_left_behind_is_replaced() {
    // A desktop killed with SIGKILL leaves its socket file behind. That file
    // must not block the next start.
    let (_scratch, path) = scratch();
    drop(UnixListener::bind(&path).expect("a desktop that is no longer running"));
    assert!(path.exists(), "the file outlives the listener");

    take(&path).expect("nothing is answering there");
}

#[test]
fn something_that_is_not_a_socket_in_the_way_is_not_deleted() {
    // Connecting to a plain file fails the same way as connecting to a dead
    // socket, so a failed connect alone does not justify unlinking.
    let (_scratch, path) = scratch();
    std::fs::write(&path, "not a socket").expect("scratch is writable");

    assert_eq!(
        take(&path).unwrap_err(),
        TakeError::InTheWay {
            path: path.display().to_string()
        }
    );
    assert!(path.exists(), "and it is still there");
}

#[test]
fn a_command_reaches_the_desktop_and_the_answer_comes_back() {
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let serving = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("the client connected");
        answer_one(stream, BRIEFLY, &|line| {
            domicile_launch::control::answer(
                line,
                &domicile_launch::control::Desktop {
                    capture: &|_| panic!("a question about this desktop reaches no engine"),
                    record: &|| panic!("a question about this desktop records nothing"),
                    files: &domicile_launch::control::SettingsFiles::default(),
                    load: &|_| panic!("a question about this desktop reaches no engine"),
                    shell: &domicile_launch::shell_path::Shell {
                        files: domicile_launch::shell_path::ShellFiles::Directory,
                        module: PathBuf::from("shell.js"),
                        root: PathBuf::from("/desktops/mine"),
                    },
                    open: &|_, _| panic!("a question about this desktop reaches no engine"),
                    open_app: &|_, _, _, _| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    run_app: &|_, _| panic!("a question about this desktop reaches no engine"),
                    launch: &|_| panic!("a question about this desktop reaches no compositor"),
                    open_link: &|_| panic!("a question about this desktop reaches no compositor"),
                    send: &|_| panic!("a question about this desktop reaches no compositor"),
                    power_displays: &|_, _| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    monitors: &|| panic!("a question about this desktop reaches no compositor"),
                    displays: &|| panic!("a question about this desktop reaches no compositor"),
                    windows: &|| panic!("a question about this desktop reaches no compositor"),
                    status: &|| panic!("a question about this desktop reaches no compositor"),
                    shell_commands: &|| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    shell_bindings: &|| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    inputs: &|| panic!("a question about this desktop reaches no compositor"),
                    idle_time: &|| panic!("a question about this desktop reaches no compositor"),
                    agents: &|| panic!("a question about this desktop reaches no compositor"),
                    stop_agent: &|_| panic!("a question about this desktop reaches no compositor"),
                    forget_agent: &|_| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    lock: &|| panic!("a question about this desktop reaches no compositor"),
                    act_on_window: &|_, _| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    shoot_desk: &|_, _, _| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    emulate: &|_| panic!("a question about this desktop reaches no compositor"),
                    devtools: &|_, _, _| panic!("a question about this desktop reaches no engine"),
                    configure_display: &|_, _| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    log_levels: &|| panic!("a question about this desktop reads no log levels"),
                    set_log_levels: &|_| {
                        panic!("a question about this desktop reaches no compositor")
                    },
                    up: "domicile is up.",
                    logs_in_the_journal: false,
                    logs: &|| panic!("a question about this desktop reads no logs"),
                    permissions: &|| panic!("a question about this desktop reaches no engine"),
                    set_permission: &|_| panic!("a question about this desktop reaches no engine"),
                    load_unpacked: &|_| panic!("a question about this desktop reaches no engine"),
                    uninstall_extension: &|_| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    config_extensions: &|| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    media_devices: &|| panic!("a question about this desktop reaches no engine"),
                    set_media_device: &|_, _| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    extensions: &|| panic!("a question about this desktop reaches no engine"),
                    set_extension_enabled: &|_, _, _| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    browser_profiles: &|| panic!("a question about this desktop reaches no engine"),
                    pin_browser_site: &|_, _| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    configure_extension: &|_, _| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    history: &|_| panic!("a question about this desktop reaches no engine"),
                    visits: &|_| panic!("a question about this desktop reaches no engine"),
                    delete_history: &|_| panic!("a question about this desktop reaches no engine"),
                    disable_while_typing: &|_| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    theme: &|_| panic!("a question about this desktop reaches no compositor"),
                    clear_browsing_data: &|_| {
                        panic!("a question about this desktop reaches no engine")
                    },
                    site_data: &|| panic!("a question about this desktop reaches no engine"),
                    clear_site_data: &|_| panic!("a question about this desktop reaches no engine"),
                },
            )
        })
        .expect("the client asked and read the answer");
    });

    assert_eq!(
        ask(&path, &Request::WhichShell, Some(BRIEFLY)).expect("a desktop is running"),
        Response::Shell {
            module: PathBuf::from("/desktops/mine/shell.js"),
            root: PathBuf::from("/desktops/mine"),
            dev_server: false,
        }
    );
    serving.join().expect("the desktop answered");
}

#[test]
fn asking_where_no_desktop_is_running_says_so() {
    let (_scratch, path) = scratch();

    assert_eq!(
        ask(&path, &Request::WhichShell, Some(BRIEFLY)).unwrap_err(),
        AskError::NoDesktop {
            path: path.display().to_string()
        }
    );
}

#[test]
fn the_socket_a_dead_desktop_left_behind_is_a_failure_rather_than_a_wait() {
    // Terminals that outlived a SIGKILLed desktop still have its path in
    // `DOMICILE_SOCK`. The kernel refuses the connect, so the client fails at
    // once instead of waiting out the timeout.
    let (_scratch, path) = scratch();
    drop(UnixListener::bind(&path).expect("a desktop that is no longer running"));

    assert_eq!(
        ask(&path, &Request::WhichShell, Some(BRIEFLY)).unwrap_err(),
        AskError::NoDesktop {
            path: path.display().to_string()
        }
    );
}

#[test]
fn a_connection_that_says_nothing_is_given_up_on() {
    // A silent client would hold one of the desktop's threads indefinitely.
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let _silent = UnixStream::connect(&path).expect("a client that connects and says nothing");
    let (stream, _) = listener.accept().expect("the desktop took the connection");

    assert!(answer_one(stream, BRIEFLY, &|_| unreachable!(
        "nothing was said, so there is nothing to answer"
    ))
    .is_err());
}

#[test]
fn a_line_with_no_newline_on_it_is_still_answered() {
    // A client that writes and closes its end has finished, with or without a
    // trailing newline. Waiting for one would hang.
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let mut client = UnixStream::connect(&path).expect("a client");
    client
        .write_all(b"{\"type\":\"which_shell\"}")
        .expect("it asked");
    client
        .shutdown(std::net::Shutdown::Write)
        .expect("and stopped talking");
    let (stream, _) = listener.accept().expect("the desktop took the connection");

    answer_one(stream, BRIEFLY, &|line| {
        assert_eq!(line.trim(), "{\"type\":\"which_shell\"}");
        String::from("answered\n")
    })
    .expect("the desktop answered");
}

#[test]
fn a_desktop_that_takes_the_connection_and_says_nothing_is_not_a_transport_fault() {
    // The read returns WouldBlock, but the socket is fine: the desktop stopped
    // answering. The error says so.
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let wedged = std::thread::spawn(move || {
        let taken = listener.accept().expect("the client connected");
        std::thread::sleep(BRIEFLY * 4);
        drop(taken);
    });

    assert_eq!(
        ask(&path, &Request::WhichShell, Some(BRIEFLY)).unwrap_err(),
        AskError::NoAnswer {
            path: path.display().to_string()
        }
    );
    wedged.join().expect("the desktop that never answered");
}

#[test]
fn a_desktop_that_hangs_up_without_answering_is_the_same_answer() {
    // Reported as an unreadable response, the message would end in an empty
    // "not a response: " and look like a bug.
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let hanging_up = std::thread::spawn(move || {
        drop(listener.accept().expect("the client connected"));
    });

    assert_eq!(
        ask(&path, &Request::WhichShell, Some(BRIEFLY)).unwrap_err(),
        AskError::NoAnswer {
            path: path.display().to_string()
        }
    );
    hanging_up.join().expect("the desktop that hung up");
}

#[test]
fn a_client_with_no_patience_waits_for_however_long_the_answer_takes() {
    // An interactive screenshot answers when the user has picked.
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let slow = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("the client connected");
        answer_one(stream, BRIEFLY, &|_| {
            std::thread::sleep(BRIEFLY * 2);
            String::from("{\"type\":\"canceled\"}\n")
        })
        .expect("the client waited for the answer");
    });

    assert_eq!(
        ask(&path, &Request::WhichShell, None).expect("the desktop answered in the end"),
        Response::Canceled
    );
    slow.join().expect("the desktop answered");
}

/// A temporary directory and a socket path inside it.
///
/// Keep the directory alive: dropping it deletes the directory.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let scratch = tempfile::tempdir().expect("a scratch directory");
    let path = scratch.path().join("domicile-ipc.4242.sock");
    (scratch, path)
}

#[test]
fn a_virtual_monitor_is_lent_the_connection_it_came_on() {
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let mut client = UnixStream::connect(&path).expect("a client");
    client
        .write_all(
            b"{\"type\":\"virtual_monitor\",\"name\":\"Pane\",\"width\":1280,\
              \"height\":720,\"refresh_mhz\":60000,\"scale\":2.0}\n{\"type\":\"resize_virtual_monitor\",\
              \"width\":800,\"height\":600,\"refresh_mhz\":60000}\n",
        )
        .expect("it asked, then resized");
    let (stream, _) = listener.accept().expect("the desktop took the connection");

    serve_one(
        stream,
        BRIEFLY,
        &|_| unreachable!("a monitor is lent, not answered"),
        Lenders {
            monitor: &|mut lent| {
                assert_eq!(lent.name, "Pane");
                assert_eq!(
                    lent.mode,
                    MonitorMode {
                        size: (1280, 720),
                        refresh_mhz: 60_000,
                        scale: Scale::try_from(2.0).expect("a scale"),
                    }
                );
                let mut next = String::new();
                lent.lines.read_line(&mut next).expect("the client went on");
                assert!(next.contains("resize_virtual_monitor"), "{next}");
                lent.client.write_all(b"lent\n").expect("the client hears");
            },
            subscribe: &|_| unreachable!("a monitor is not a subscription"),
            agent: &|_| unreachable!("a monitor is not an agent"),
        },
    )
    .expect("the desktop lent it");

    let mut heard = String::new();
    BufReader::new(client)
        .read_line(&mut heard)
        .expect("the client heard back");
    assert_eq!(heard, "lent\n");
}

#[test]
fn an_agent_is_lent_the_connection_it_came_on() {
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let mut client = UnixStream::connect(&path).expect("a client");
    client
        .write_all(
            b"{\"type\":\"agent\",\"agent\":\"Claude Code\"}\n\
              {\"type\":\"agent_did\",\"said\":\"Clicked\"}\n",
        )
        .expect("it asked, then said what it did");
    let (stream, _) = listener.accept().expect("the desktop took the connection");

    serve_one(
        stream,
        BRIEFLY,
        &|_| unreachable!("an agent is lent, not answered"),
        Lenders {
            monitor: &|_| unreachable!("an agent is not a monitor"),
            subscribe: &|_| unreachable!("an agent is not a subscription"),
            agent: &|mut admission| {
                assert_eq!(admission.agent, "Claude Code");
                let mut next = String::new();
                admission
                    .lines
                    .read_line(&mut next)
                    .expect("the client went on");
                assert!(next.contains("agent_did"), "{next}");
                admission
                    .client
                    .write_all(b"lent\n")
                    .expect("the client hears");
            },
        },
    )
    .expect("the desktop lent it");

    let mut heard = String::new();
    BufReader::new(client)
        .read_line(&mut heard)
        .expect("the client heard back");
    assert_eq!(heard, "lent\n");
}

#[test]
fn a_held_request_keeps_its_connection_after_the_answer() {
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let desktop = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("the client connected");
        let mut lines = BufReader::new(stream.try_clone().expect("readable")).lines();
        lines.next().expect("a request").expect("a line");
        let mut answering = stream;
        answering
            .write_all(b"{\"type\":\"virtual_monitor\",\"output\":\"virtual-1\"}\n")
            .expect("the desktop answered");
        lines.next().expect("a second line").expect("a line")
    });

    let (answer, mut held) = hold(
        &path,
        &Request::ResizeVirtualMonitor {
            width: 1,
            height: 1,
            refresh_mhz: 1,
            scale: Scale::ONE,
        },
        Some(BRIEFLY),
    )
    .expect("the desktop answered");
    held.write_all(b"more\n")
        .expect("the connection is still open");

    assert_eq!(
        answer,
        Response::VirtualMonitor {
            output: "virtual-1".to_string()
        }
    );
    assert_eq!(desktop.join().expect("the desktop read on"), "more");
}

#[test]
fn a_subscription_is_lent_the_connection_it_came_on() {
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let mut client = UnixStream::connect(&path).expect("a client");
    client
        .write_all(b"{\"type\":\"subscribe\",\"topics\":[\"windows\",\"status\"]}\n")
        .expect("it asked");
    let (stream, _) = listener.accept().expect("the desktop took the connection");

    serve_one(
        stream,
        BRIEFLY,
        &|_| unreachable!("a subscription is lent, not answered"),
        Lenders {
            monitor: &|_| unreachable!("a subscription is not a monitor"),
            subscribe: &|mut subscription| {
                assert_eq!(
                    subscription.topics,
                    vec![WatchTopic::Windows, WatchTopic::Status]
                );
                subscription
                    .client
                    .write_all(b"lent\n")
                    .expect("the client hears");
            },
            agent: &|_| unreachable!("a subscription is not an agent"),
        },
    )
    .expect("the desktop lent it");

    let mut heard = String::new();
    BufReader::new(client)
        .read_line(&mut heard)
        .expect("the client heard back");
    assert_eq!(heard, "lent\n");
}

#[test]
fn a_listener_hears_each_response_until_it_stops() {
    let (_scratch, path) = scratch();
    let control = take(&path).expect("nothing was there");
    let listener = control.listener().expect("the run's own listener");
    let desktop = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("the client connected");
        let mut lines = BufReader::new(stream.try_clone().expect("readable")).lines();
        let asked = lines.next().expect("a request").expect("a line");
        let mut answering = stream;
        answering
            .write_all(
                b"{\"type\":\"heard\",\"message\":{\"type\":\"theme\",\"theme\":\"dark\"}}\n\
                  {\"type\":\"heard\",\"message\":{\"type\":\"theme\",\"theme\":\"light\"}}\n\
                  {\"type\":\"heard\",\"message\":{\"type\":\"theme\",\"theme\":\"dark\"}}\n",
            )
            .expect("the desktop answered");
        asked
    });

    let mut heard = Vec::new();
    listen(
        &path,
        &Request::Subscribe {
            topics: vec![WatchTopic::Status],
        },
        |response| {
            heard.push(response);
            heard.len() < 2
        },
    )
    .expect("the desktop answered");

    assert!(desktop
        .join()
        .expect("the desktop ran")
        .contains("subscribe"));
    assert_eq!(
        heard,
        vec![
            Response::Heard {
                message: HostMessage::Theme { theme: Theme::Dark }
            },
            Response::Heard {
                message: HostMessage::Theme {
                    theme: Theme::Light
                }
            },
        ]
    );
}
