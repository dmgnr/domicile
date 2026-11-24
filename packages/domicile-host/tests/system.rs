//! Behavior tests for `domicile_host::system`, against a real disk and real
//! processes.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use domicile_host::priority;
use domicile_host::system::{locked_out, reach, refused_to_an_app, Handled, Reach, System};
use domicile_protocol::{
    Bus, FileType, HostMessage, PreviewedWindow, Signal, Stream, SystemEnd, SystemErrorKind,
    SystemEvent, SystemReply, SystemRequest,
};

/// How long a test waits for the next message before failing.
const PATIENCE: Duration = Duration::from_secs(10);

/// A [`System`] in `home`, and what it sends.
fn system_in(home: &Path) -> (System, Receiver<HostMessage>) {
    system_starting_at(home, ours())
}

/// As [`system_in`], starting processes at nice `nice`.
fn system_starting_at(home: &Path, nice: i32) -> (System, Receiver<HostMessage>) {
    let (told, heard) = channel();
    let system = System::new(home.to_path_buf(), Vec::new(), nice, move |message| {
        // A test that has finished stops listening; the process may still talk.
        let _ = told.send(message);
    });
    (system, heard)
}

/// This thread's nice value, which a process may always start at.
fn ours() -> i32 {
    priority::nice(priority::this_thread()).unwrap()
}

fn next(heard: &Receiver<HostMessage>) -> HostMessage {
    heard.recv_timeout(PATIENCE).expect("a message in time")
}

fn reply(heard: &Receiver<HostMessage>, id: u32) -> SystemReply {
    match next(heard) {
        HostMessage::SystemReply { id: replied, reply } if replied == id => reply,
        other => panic!("expected a reply to {id}, heard {other:?}"),
    }
}

fn failure(reply: SystemReply) -> SystemErrorKind {
    match reply {
        SystemReply::Failed { error } => error.kind,
        other => panic!("expected a failure, got {other:?}"),
    }
}

/// Everything a process sends until it ends: its stdout, its stderr and how it
/// ended.
fn run_out(heard: &Receiver<HostMessage>, id: u32) -> (String, String, SystemEnd) {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    loop {
        match next(heard) {
            HostMessage::SystemEvent {
                id: from,
                event: SystemEvent::Output { stream, data },
            } if from == id => {
                let bytes = domicile_host::base64::decoded(&data).expect("base64");
                match stream {
                    Stream::Stdout => out.extend(bytes),
                    Stream::Stderr => err.extend(bytes),
                }
            }
            HostMessage::SystemEnd { id: from, end } if from == id => {
                return (
                    String::from_utf8(out).expect("utf-8"),
                    String::from_utf8(err).expect("utf-8"),
                    end,
                );
            }
            other => panic!("expected output from {id}, heard {other:?}"),
        }
    }
}

fn spawn(argv: &[&str]) -> SystemRequest {
    SystemRequest::Spawn {
        argv: argv.iter().map(|arg| arg.to_string()).collect(),
        cwd: None,
        env: BTreeMap::new(),
        stdin: false,
    }
}

fn exited(code: i32) -> SystemEnd {
    SystemEnd::Exited {
        code: Some(code),
        signal: None,
    }
}

mod files {
    use super::*;

    #[test]
    fn a_relative_path_is_read_from_the_home() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("note"), "hi").unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::ReadFile {
                path: "note".into(),
                offset: 0,
                length: None,
            },
        );

        assert_eq!(
            reply(&heard, 1),
            SystemReply::Read {
                data: "aGk=".into()
            }
        );
    }

    #[test]
    fn a_range_reads_only_its_bytes() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("note"), "a big hi").unwrap();
        let (system, heard) = system_in(home.path());

        // "hi", whether the range ends at the file's end or past it. One at a
        // time: each read answers from its own thread.
        for (id, length) in [(1, Some(2)), (2, Some(100)), (3, None)] {
            system.handle(
                id,
                SystemRequest::ReadFile {
                    path: "note".into(),
                    offset: 6,
                    length,
                },
            );
            assert_eq!(
                reply(&heard, id),
                SystemReply::Read {
                    data: "aGk=".into()
                },
                "{id}"
            );
        }
    }

    #[test]
    fn a_missing_file_is_not_found() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::ReadFile {
                path: "/no/such/file".into(),
                offset: 0,
                length: None,
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::NotFound);
    }

    #[test]
    fn a_file_is_written_whole_either_way() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        for (id, atomic) in [(1, true), (2, false)] {
            let name = format!("written-{id}");
            system.handle(
                id,
                SystemRequest::WriteFile {
                    path: name.clone(),
                    data: "aGk=".into(),
                    atomic,
                },
            );

            assert_eq!(reply(&heard, id), SystemReply::Written);
            assert_eq!(std::fs::read(home.path().join(name)).unwrap(), b"hi");
        }
        // An atomic write leaves no temporary file behind.
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 2);
    }

    #[test]
    fn a_directory_is_created_once() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        // One at a time: each call answers from its own thread, so the second
        // could otherwise create the directory first.
        system.handle(1, SystemRequest::CreateDir { path: "new".into() });
        assert_eq!(reply(&heard, 1), SystemReply::Created);
        assert!(home.path().join("new").is_dir());

        system.handle(2, SystemRequest::CreateDir { path: "new".into() });
        assert_eq!(failure(reply(&heard, 2)), SystemErrorKind::AlreadyExists);
    }

    #[test]
    fn data_that_is_not_base64_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::WriteFile {
                path: "f".into(),
                data: "not base64!".into(),
                atomic: false,
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::InvalidInput);
        assert!(!home.path().join("f").exists());
    }

    #[test]
    fn a_directory_lists_each_entry_with_its_own_type() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("file"), "").unwrap();
        std::fs::create_dir(home.path().join("dir")).unwrap();
        std::os::unix::fs::symlink("dir", home.path().join("link")).unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, SystemRequest::ReadDir { path: "".into() });

        let SystemReply::Entries { mut entries } = reply(&heard, 1) else {
            panic!("expected entries");
        };
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let listed: Vec<_> = entries
            .into_iter()
            .map(|entry| (entry.name, entry.file_type))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("dir".to_string(), FileType::Directory),
                ("file".to_string(), FileType::File),
                ("link".to_string(), FileType::Symlink),
            ]
        );
    }

    #[test]
    fn a_stat_follows_symlinks() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("file"), "four").unwrap();
        std::os::unix::fs::symlink("file", home.path().join("link")).unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::Stat {
                path: "link".into(),
            },
        );

        let SystemReply::Stat {
            file_type,
            size,
            modified_ms,
            real_path,
        } = reply(&heard, 1)
        else {
            panic!("expected a stat");
        };
        assert_eq!((file_type, size), (FileType::File, 4));
        assert!(modified_ms.is_some());
        let file = std::fs::canonicalize(home.path().join("file")).unwrap();
        assert_eq!(real_path, Some(file.to_string_lossy().into_owned()));
    }
}

mod processes {
    use super::*;

    #[test]
    fn a_process_sends_its_output_then_how_it_exited() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, spawn(&["sh", "-c", "echo out; echo err >&2; exit 3"]));

        assert_eq!(reply(&heard, 1), SystemReply::Started);
        assert_eq!(
            run_out(&heard, 1),
            ("out\n".into(), "err\n".into(), exited(3))
        );
    }

    #[test]
    fn a_process_runs_in_the_home_with_the_environment_it_was_given() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::Spawn {
                argv: vec!["sh".into(), "-c".into(), "echo $GREETING; pwd".into()],
                cwd: None,
                env: BTreeMap::from([("GREETING".into(), "hello".into())]),
                stdin: false,
            },
        );

        assert_eq!(reply(&heard, 1), SystemReply::Started);
        let (out, _, end) = run_out(&heard, 1);
        let home = home.path().canonicalize().unwrap();
        assert_eq!(out, format!("hello\n{}\n", home.display()));
        assert_eq!(end, exited(0));
    }

    /// The compositor raises its own threads; a page's processes start at the
    /// nice value they are given instead.
    #[test]
    fn a_process_starts_at_the_nice_value_the_system_was_given() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_starting_at(home.path(), ours() + 3);

        system.handle(1, spawn(&["nice"]));

        assert_eq!(reply(&heard, 1), SystemReply::Started);
        let (out, _, end) = run_out(&heard, 1);
        assert_eq!((out, end), (format!("{}\n", ours() + 3), exited(0)));
    }

    /// The desktop's own variables, such as its `WAYLAND_DISPLAY`, are set or
    /// removed before the page's.
    #[test]
    fn a_process_runs_in_the_desktops_environment() {
        let home = tempfile::tempdir().unwrap();
        let (told, heard) = channel();
        let system = System::new(
            home.path().to_path_buf(),
            vec![
                ("DESKTOP_SET".into(), Some("desk".into())),
                ("HOME".into(), None),
                ("PAGE_WINS".into(), Some("desk".into())),
            ],
            ours(),
            move |message| {
                let _ = told.send(message);
            },
        );

        system.handle(
            1,
            SystemRequest::Spawn {
                argv: vec![
                    "sh".into(),
                    "-c".into(),
                    "echo $DESKTOP_SET ${HOME-unset} $PAGE_WINS".into(),
                ],
                cwd: None,
                env: BTreeMap::from([("PAGE_WINS".into(), "page".into())]),
                stdin: false,
            },
        );

        assert_eq!(reply(&heard, 1), SystemReply::Started);
        assert_eq!(run_out(&heard, 1).0, "desk unset page\n");
    }

    #[test]
    fn a_process_reads_what_it_is_written() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::Spawn {
                argv: vec!["cat".into()],
                cwd: None,
                env: BTreeMap::new(),
                stdin: true,
            },
        );
        assert_eq!(reply(&heard, 1), SystemReply::Started);
        system.handle(
            1,
            SystemRequest::Stdin {
                data: "aGk=".into(),
            },
        );
        system.handle(1, SystemRequest::CloseStdin);

        assert_eq!(run_out(&heard, 1), ("hi".into(), "".into(), exited(0)));
    }

    #[test]
    fn a_killed_process_reports_the_signal() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, spawn(&["sleep", "100"]));
        assert_eq!(reply(&heard, 1), SystemReply::Started);
        system.handle(
            1,
            SystemRequest::Kill {
                signal: Signal::Term,
            },
        );

        assert_eq!(
            run_out(&heard, 1).2,
            SystemEnd::Exited {
                code: None,
                signal: Some(libc::SIGTERM),
            }
        );
    }

    #[test]
    fn a_program_that_is_not_installed_is_not_found() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, spawn(&["domicile-no-such-program"]));

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::NotFound);
    }

    #[test]
    fn an_empty_argv_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, spawn(&[]));

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::InvalidInput);
    }

    #[test]
    fn an_id_that_is_running_cannot_start_another() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, spawn(&["sleep", "100"]));
        assert_eq!(reply(&heard, 1), SystemReply::Started);
        system.handle(1, spawn(&["true"]));

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::InvalidInput);
    }

    #[test]
    fn driving_an_id_that_is_not_running_says_so() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        assert_eq!(
            system.handle(
                9,
                SystemRequest::Kill {
                    signal: Signal::Term
                }
            ),
            Handled::NothingRunning
        );
        assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
    }

    /// A page that goes away takes its processes with it.
    #[test]
    fn dropping_the_system_ends_its_processes() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, spawn(&["sh", "-c", "echo $$; exec sleep 100"]));
        assert_eq!(reply(&heard, 1), SystemReply::Started);
        let HostMessage::SystemEvent {
            event: SystemEvent::Output { data, .. },
            ..
        } = next(&heard)
        else {
            panic!("expected the pid");
        };
        let pid = String::from_utf8(domicile_host::base64::decoded(&data).unwrap()).unwrap();
        let proc = Path::new("/proc").join(pid.trim());
        drop(system);

        let deadline = Instant::now() + PATIENCE;
        while proc.exists() {
            assert!(Instant::now() < deadline, "{} is still running", pid.trim());
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

mod watches {
    use super::*;

    #[test]
    fn a_watch_reports_changes_until_it_is_stopped() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, SystemRequest::Watch { path: "".into() });
        assert_eq!(reply(&heard, 1), SystemReply::Started);
        let file = home.path().join("new");
        std::fs::write(&file, "").unwrap();

        let HostMessage::SystemEvent {
            id: 1,
            event: SystemEvent::Changed { path },
        } = next(&heard)
        else {
            panic!("expected a change");
        };
        assert_eq!(path, file.display().to_string());

        assert_eq!(system.handle(1, SystemRequest::Unwatch), Handled::Done);
        // Changes may still be queued ahead of the end; the end comes last.
        loop {
            match next(&heard) {
                HostMessage::SystemEvent { id: 1, .. } => continue,
                end => {
                    assert_eq!(
                        end,
                        HostMessage::SystemEnd {
                            id: 1,
                            end: SystemEnd::Stopped
                        }
                    );
                    break;
                }
            }
        }
    }

    #[test]
    fn watching_a_missing_path_fails() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::Watch {
                path: "missing".into(),
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::NotFound);
    }
}

/// What the lock needs to know about a request.
mod reaches {
    use super::*;

    #[test]
    fn reading_the_kernel_is_told_apart_from_reading_anything_else() {
        let read = |path: &str| SystemRequest::ReadFile {
            path: path.into(),
            offset: 0,
            length: None,
        };

        assert_eq!(reach(&read("/sys/class")), Reach::ReadsTheKernel);
        assert_eq!(
            reach(&SystemRequest::Stat {
                path: "/sys/kernel".into()
            }),
            Reach::ReadsTheKernel
        );
        assert_eq!(reach(&read("/sys/../etc/passwd")), Reach::Acts);
        assert_eq!(reach(&read("/sysfs")), Reach::Acts);
        assert_eq!(reach(&read("/proc/self/status")), Reach::Acts);
        // Relative paths start in the home, where a symlink into `/sys` could
        // be swapped for one out of it after the lock has judged it.
        assert_eq!(reach(&read("sys/class")), Reach::Acts);
    }

    #[test]
    fn stopping_something_is_its_own_reach() {
        for stops in [
            SystemRequest::Unwatch,
            SystemRequest::CloseStdin,
            SystemRequest::Kill {
                signal: Signal::Kill,
            },
        ] {
            assert_eq!(reach(&stops), Reach::Stops);
        }
        for acts in [
            spawn(&["true"]),
            SystemRequest::Stdin { data: "".into() },
            SystemRequest::WriteFile {
                path: "/sys/power/state".into(),
                data: "".into(),
                atomic: false,
            },
            SystemRequest::Screenshot { file: None },
            SystemRequest::PreviewWindow {
                window: PreviewedWindow::App { id: "app-1".into() },
            },
        ] {
            assert_eq!(reach(&acts), Reach::Acts);
        }
    }
}

/// Screenshots, taken by whatever the compositor hands the system.
mod screenshots {
    use std::path::PathBuf;

    use domicile_host::system::Kept;
    use domicile_protocol::SystemError;

    use super::*;

    #[test]
    fn a_screenshot_is_saved_where_the_compositor_says() {
        let home = tempfile::tempdir().unwrap();
        let (told, asked) = channel();
        let (system, heard) = system_in(home.path());
        let system = system.screenshotting_with(move |file| {
            told.send(file).unwrap();
            Ok(Kept::Saved(PathBuf::from("/pictures/a.png")))
        });

        system.handle(
            1,
            SystemRequest::Screenshot {
                file: Some("shot.png".into()),
            },
        );

        assert_eq!(
            reply(&heard, 1),
            SystemReply::Saved {
                path: "/pictures/a.png".into()
            }
        );
        assert_eq!(asked.recv().unwrap(), Some(home.path().join("shot.png")));
    }

    #[test]
    fn a_screenshot_copied_from_the_dialog_says_so() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());
        let system = system.screenshotting_with(|_| Ok(Kept::Copied));

        system.handle(1, SystemRequest::Screenshot { file: None });

        assert_eq!(reply(&heard, 1), SystemReply::Copied);
    }

    #[test]
    fn a_screenshot_the_compositor_did_not_take_says_why() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());
        let system = system.screenshotting_with(|_| {
            Err(SystemError {
                kind: SystemErrorKind::Canceled,
                message: "dismissed".into(),
            })
        });

        system.handle(1, SystemRequest::Screenshot { file: None });

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Canceled);
    }

    #[test]
    fn a_system_that_takes_no_screenshots_says_so() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, SystemRequest::Screenshot { file: None });

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }
}

/// Screen recordings, run by whatever the compositor hands the system.
mod screen_recordings {
    use std::path::PathBuf;

    use domicile_protocol::SystemError;

    use super::*;

    #[test]
    fn a_recording_is_answered_with_its_file_once_it_stops() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());
        let system =
            system.recording_with(|| Ok(PathBuf::from("/videos/Screen recordings/a.webm")));

        system.handle(1, SystemRequest::ScreenRecord);

        assert_eq!(
            reply(&heard, 1),
            SystemReply::Saved {
                path: "/videos/Screen recordings/a.webm".into()
            }
        );
    }

    #[test]
    fn a_recording_the_user_called_off_says_so() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());
        let system = system.recording_with(|| {
            Err(SystemError {
                kind: SystemErrorKind::Canceled,
                message: "discarded".into(),
            })
        });

        system.handle(1, SystemRequest::ScreenRecord);

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Canceled);
    }

    #[test]
    fn a_system_that_records_nothing_says_so() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(1, SystemRequest::ScreenRecord);

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }
}

/// Window previews, drawn by whatever the compositor hands the system.
mod previews {
    use domicile_protocol::SystemError;

    use super::*;

    #[test]
    fn a_preview_is_the_frame_the_compositor_draws() {
        let home = tempfile::tempdir().unwrap();
        let (told, asked) = channel();
        let (system, heard) = system_in(home.path());
        let system = system.previewing_with(move |window| {
            told.send(window).unwrap();
            Ok("data:image/png;base64,AA==".into())
        });

        system.handle(
            1,
            SystemRequest::PreviewWindow {
                window: PreviewedWindow::Browser { id: "7".into() },
            },
        );

        assert_eq!(
            reply(&heard, 1),
            SystemReply::Preview {
                frame: "data:image/png;base64,AA==".into()
            }
        );
        assert_eq!(
            asked.recv().unwrap(),
            PreviewedWindow::Browser { id: "7".into() }
        );
    }

    #[test]
    fn a_preview_the_compositor_did_not_draw_says_why() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());
        let system = system.previewing_with(|_| {
            Err(SystemError {
                kind: SystemErrorKind::NotFound,
                message: "no window app-1".into(),
            })
        });

        system.handle(
            1,
            SystemRequest::PreviewWindow {
                window: PreviewedWindow::App { id: "app-1".into() },
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::NotFound);
    }

    #[test]
    fn a_system_that_draws_no_previews_says_so() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard) = system_in(home.path());

        system.handle(
            1,
            SystemRequest::PreviewWindow {
                window: PreviewedWindow::App { id: "app-1".into() },
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }
}

/// `domicile send-shell` commands, sent on one connection and heard on every
/// connection listening, each answered by the pages that heard it.
mod shell_commands {
    use std::time::Duration;

    use domicile_host::shell_commands::ShellCommands;
    use domicile_protocol::{ShellBinding, ShellCommandHelp};

    use super::*;

    fn focus_right() -> Vec<String> {
        vec!["focus".into(), "right".into()]
    }

    /// Commands that wait `BRIEFLY` for an answer, so a test of the wait is
    /// quick.
    fn commands() -> ShellCommands {
        ShellCommands::answered_within(Duration::from_millis(50))
    }

    fn listening(commands: Vec<ShellCommandHelp>) -> SystemRequest {
        SystemRequest::ShellCommands {
            commands,
            bindings: Vec::new(),
        }
    }

    fn send() -> SystemRequest {
        SystemRequest::SendShell {
            command: focus_right(),
        }
    }

    /// Two systems sharing `commands`, as two chrome connections do.
    fn two_pages(
        commands: &ShellCommands,
    ) -> (
        (System, Receiver<HostMessage>),
        (System, Receiver<HostMessage>),
    ) {
        let home = std::env::temp_dir();
        let (first, first_heard) = system_in(&home);
        let (second, second_heard) = system_in(&home);
        (
            (first.sharing_shell_commands(commands.clone()), first_heard),
            (
                second.sharing_shell_commands(commands.clone()),
                second_heard,
            ),
        )
    }

    /// The `sent` of the command `heard` was told next.
    fn heard_sent(heard: &Receiver<HostMessage>) -> u64 {
        match next(heard) {
            HostMessage::SystemEvent {
                event: SystemEvent::ShellCommand { command, sent },
                ..
            } if command == focus_right() => sent,
            other => panic!("expected focus right, heard {other:?}"),
        }
    }

    #[test]
    fn a_command_is_sent_once_a_page_listening_ran_it() {
        let commands = commands();
        let ((page, page_heard), (sender, sender_heard)) = two_pages(&commands);
        page.handle(7, listening(Vec::new()));
        assert_eq!(reply(&page_heard, 7), SystemReply::Started);

        sender.handle(1, send());
        let sent = heard_sent(&page_heard);
        page.handle(
            8,
            SystemRequest::AnswerShellCommand {
                sent,
                refused: None,
                output: None,
            },
        );

        assert_eq!(reply(&page_heard, 8), SystemReply::Set);
        assert_eq!(reply(&sender_heard, 1), SystemReply::Sent { output: None });
    }

    #[test]
    fn what_the_page_that_ran_a_command_printed_reaches_the_sender() {
        // A query such as Manganese's `get-tree` answers with its JSON.
        let commands = commands();
        let ((page, page_heard), (sender, sender_heard)) = two_pages(&commands);
        page.handle(7, listening(Vec::new()));
        reply(&page_heard, 7);

        sender.handle(1, send());
        let sent = heard_sent(&page_heard);
        page.handle(
            8,
            SystemRequest::AnswerShellCommand {
                sent,
                refused: None,
                output: Some("[]".into()),
            },
        );

        assert_eq!(
            reply(&sender_heard, 1),
            SystemReply::Sent {
                output: Some("[]".into())
            }
        );
    }

    #[test]
    fn each_listening_page_s_bindings_are_listed_until_it_stops() {
        let commands = commands();
        let ((page, page_heard), _) = two_pages(&commands);
        let lock = ShellBinding {
            mode: "default".into(),
            chord: "Meta+l".into(),
            action: "send-shell lock".into(),
        };
        page.handle(
            7,
            SystemRequest::ShellCommands {
                commands: Vec::new(),
                bindings: vec![lock.clone()],
            },
        );
        reply(&page_heard, 7);
        assert_eq!(commands.bindings(), vec![lock]);

        page.handle(7, SystemRequest::Unwatch);
        assert_eq!(commands.bindings(), Vec::new());
    }

    #[test]
    fn a_command_every_page_refused_fails_with_why() {
        // Loud, so a typo in a binding or a script is not silently dropped.
        let commands = commands();
        let ((page, page_heard), (sender, sender_heard)) = two_pages(&commands);
        page.handle(7, listening(Vec::new()));
        reply(&page_heard, 7);

        sender.handle(1, send());
        let sent = heard_sent(&page_heard);
        page.handle(
            8,
            SystemRequest::AnswerShellCommand {
                sent,
                refused: Some("no command `focus right`".into()),
                output: None,
            },
        );

        match reply(&sender_heard, 1) {
            SystemReply::Failed { error } => {
                assert_eq!(error.message, "no command `focus right`")
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn a_command_no_page_answers_fails_once_the_wait_is_over() {
        let commands = commands();
        let ((page, page_heard), (sender, sender_heard)) = two_pages(&commands);
        page.handle(7, listening(Vec::new()));
        reply(&page_heard, 7);

        sender.handle(1, send());

        assert_eq!(failure(reply(&sender_heard, 1)), SystemErrorKind::Other);
    }

    #[test]
    fn a_command_nobody_listens_for_says_so() {
        let commands = commands();
        let (_, (sender, sender_heard)) = two_pages(&commands);

        sender.handle(1, send());

        assert_eq!(failure(reply(&sender_heard, 1)), SystemErrorKind::Other);
    }

    #[test]
    fn a_page_that_stopped_listening_hears_no_more() {
        let commands = commands();
        let ((page, page_heard), (sender, sender_heard)) = two_pages(&commands);
        page.handle(7, listening(Vec::new()));
        reply(&page_heard, 7);

        page.handle(7, SystemRequest::Unwatch);
        sender.handle(1, send());

        assert_eq!(
            next(&page_heard),
            HostMessage::SystemEnd {
                id: 7,
                end: SystemEnd::Stopped,
            }
        );
        assert_eq!(failure(reply(&sender_heard, 1)), SystemErrorKind::Other);
    }

    #[test]
    fn a_page_that_went_away_hears_no_more() {
        let commands = commands();
        let ((page, page_heard), (sender, sender_heard)) = two_pages(&commands);
        page.handle(7, listening(Vec::new()));
        reply(&page_heard, 7);

        drop(page);
        sender.handle(1, send());

        assert_eq!(failure(reply(&sender_heard, 1)), SystemErrorKind::Other);
    }

    #[test]
    fn the_commands_pages_listen_for_are_described_once_each_while_they_listen() {
        // `domicile list-shell-commands`. Every monitor's page of one shell
        // describes the same commands.
        let commands = commands();
        let ((first, first_heard), (second, second_heard)) = two_pages(&commands);
        let focus = ShellCommandHelp {
            usage: "focus left|right|up|down".into(),
            description: "Move focus.".into(),
        };
        let lock = ShellCommandHelp {
            usage: "lock".into(),
            description: "Lock the desktop.".into(),
        };
        first.handle(7, listening(vec![focus.clone()]));
        reply(&first_heard, 7);
        second.handle(7, listening(vec![focus.clone(), lock.clone()]));
        reply(&second_heard, 7);

        assert_eq!(commands.described(), vec![focus.clone(), lock]);

        second.handle(7, SystemRequest::Unwatch);
        assert_eq!(commands.described(), vec![focus]);
    }

    /// A reloaded page listens again while the desktop is locked, so commands
    /// still reach it once it unlocks.
    #[test]
    fn listening_is_its_own_reach_answering_listens_and_sending_acts() {
        assert_eq!(reach(&listening(Vec::new())), Reach::Listens);
        assert_eq!(
            reach(&SystemRequest::AnswerShellCommand {
                sent: 1,
                refused: None,
                output: None,
            }),
            Reach::Listens
        );
        assert_eq!(reach(&send()), Reach::Acts);
    }
}

/// Pages hearing when nobody has been at the desktop for a time each chose.
/// The compositor says how long the desk has been still; these tests stand in
/// for its clock.
mod links {
    use domicile_host::links::Links;

    use super::*;

    const LINK: &str = "mailto:a@example.com";

    fn claiming(schemes: &[&str]) -> SystemRequest {
        SystemRequest::ClaimLinks {
            schemes: schemes.iter().map(|scheme| scheme.to_string()).collect(),
        }
    }

    fn open(url: &str) -> SystemRequest {
        SystemRequest::OpenLink {
            url: url.into(),
            app_id: Some("slack".into()),
        }
    }

    /// A system sharing `links`, as each chrome connection does.
    fn a_page(links: &Links) -> (System, Receiver<HostMessage>) {
        let (system, heard) = system_in(&std::env::temp_dir());
        (system.sharing_links(links.clone()), heard)
    }

    fn heard_link(heard: &Receiver<HostMessage>, id: u32) -> (String, Option<String>) {
        match next(heard) {
            HostMessage::SystemEvent {
                id: from,
                event: SystemEvent::Link { url, app_id },
            } if from == id => (url, app_id),
            other => panic!("expected a link on {id}, heard {other:?}"),
        }
    }

    #[test]
    fn a_link_goes_to_the_page_that_claims_its_scheme() {
        let links = Links::default();
        let (page, page_heard) = a_page(&links);
        let (sender, sender_heard) = a_page(&links);
        page.handle(7, claiming(&["mailto"]));
        assert_eq!(reply(&page_heard, 7), SystemReply::Started);

        sender.handle(1, open(LINK));

        assert_eq!(
            heard_link(&page_heard, 7),
            (LINK.to_string(), Some("slack".to_string()))
        );
        assert_eq!(reply(&sender_heard, 1), SystemReply::Sent { output: None });
    }

    #[test]
    fn a_scheme_matches_in_any_case() {
        let links = Links::default();
        let (page, page_heard) = a_page(&links);
        page.handle(7, claiming(&["MailTo"]));
        reply(&page_heard, 7);

        assert!(links.open("MAILTO:a@example.com", None));
        assert_eq!(heard_link(&page_heard, 7).0, "MAILTO:a@example.com");
    }

    #[test]
    fn a_link_no_page_claims_is_not_found() {
        let links = Links::default();
        let (page, page_heard) = a_page(&links);
        page.handle(7, claiming(&["mailto"]));
        reply(&page_heard, 7);

        page.handle(1, open("zoommtg://zoom.us/join"));

        assert_eq!(failure(reply(&page_heard, 1)), SystemErrorKind::NotFound);
        assert!(!links.claims("zoommtg://zoom.us/join"));
    }

    #[test]
    fn the_page_that_claimed_last_gets_the_link() {
        // A reloaded shell claims again before the old page lets go.
        let links = Links::default();
        let (old, old_heard) = a_page(&links);
        let (new, new_heard) = a_page(&links);
        old.handle(7, claiming(&["mailto"]));
        reply(&old_heard, 7);
        new.handle(8, claiming(&["mailto"]));
        reply(&new_heard, 8);

        assert!(links.open(LINK, None));

        assert_eq!(heard_link(&new_heard, 8).0, LINK);
        assert!(old_heard.try_recv().is_err());
    }

    #[test]
    fn a_page_that_stopped_claiming_gets_no_more_links() {
        let links = Links::default();
        let (page, page_heard) = a_page(&links);
        page.handle(7, claiming(&["mailto"]));
        reply(&page_heard, 7);

        page.handle(7, SystemRequest::Unwatch);

        assert!(!links.claims(LINK));
        assert!(!links.open(LINK, None));
    }
}

mod idle_watches {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use domicile_host::idle_watches::IdleWatches;

    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    /// A system sharing `watches`, as a chrome connection does.
    fn page(watches: &IdleWatches) -> (System, Receiver<HostMessage>) {
        let (system, heard) = system_in(&std::env::temp_dir());
        (system.sharing_idle_watches(watches.clone()), heard)
    }

    /// Watches that wake nothing.
    fn watches() -> IdleWatches {
        IdleWatches::new(|| {})
    }

    /// Whether `heard`'s next message says the desk is idle for `id`.
    fn idle(heard: &Receiver<HostMessage>, id: u32) -> bool {
        match next(heard) {
            HostMessage::SystemEvent {
                id: from,
                event: SystemEvent::Idle { idle },
            } if from == id => idle,
            other => panic!("expected an idle change for {id}, heard {other:?}"),
        }
    }

    #[test]
    fn each_time_a_page_chose_passes_in_order() {
        let watches = watches();
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleAfter { seconds: 120 });
        page.handle(2, SystemRequest::IdleAfter { seconds: 240 });
        reply(&heard, 1);
        reply(&heard, 2);

        assert_eq!(watches.settle(Some(MINUTE), None), Some(MINUTE));
        assert!(heard.try_recv().is_err(), "nothing is due yet");
        assert_eq!(watches.settle(Some(2 * MINUTE), None), Some(2 * MINUTE));
        assert!(idle(&heard, 1));
        assert!(heard.try_recv().is_err(), "the later one is not due");
        assert_eq!(watches.settle(Some(4 * MINUTE), None), None);
        assert!(idle(&heard, 2));
    }

    #[test]
    fn input_ends_every_idle_spell_once() {
        let watches = watches();
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleAfter { seconds: 120 });
        page.handle(2, SystemRequest::IdleAfter { seconds: 240 });
        reply(&heard, 1);
        reply(&heard, 2);
        watches.settle(Some(3 * MINUTE), None);
        assert!(idle(&heard, 1));

        assert!(
            watches.stirred(),
            "a spell ended, so the clock must start again"
        );
        assert!(!idle(&heard, 1));
        assert!(heard.try_recv().is_err(), "the 4 minute one was never idle");
        assert!(!watches.stirred(), "nothing was idle");
    }

    #[test]
    fn an_inhibitor_holds_them_as_it_holds_blanking() {
        let watches = watches();
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleAfter { seconds: 120 });
        reply(&heard, 1);

        assert_eq!(watches.settle(None, None), None, "held: nothing is due");
        watches.settle(Some(2 * MINUTE), None);
        assert!(idle(&heard, 1), "released after the time: idle at once");
        watches.settle(None, None);
        assert!(!idle(&heard, 1), "taken while idle: somebody is watching");
    }

    #[test]
    fn a_page_can_act_a_time_before_the_screens_blank() {
        let watches = watches();
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleBeforeBlanking { seconds: 30 });
        reply(&heard, 1);
        let blank_after = Some(10 * MINUTE);

        assert_eq!(
            watches.settle(Some(MINUTE), blank_after),
            Some(10 * MINUTE - Duration::from_secs(30) - MINUTE)
        );
        watches.settle(Some(10 * MINUTE - Duration::from_secs(30)), blank_after);
        assert!(idle(&heard, 1));
    }

    #[test]
    fn nothing_comes_before_screens_that_never_blank_or_blank_sooner() {
        let watches = watches();
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleBeforeBlanking { seconds: 30 });
        reply(&heard, 1);

        assert_eq!(watches.settle(Some(MINUTE), None), None);
        assert_eq!(
            watches.settle(Some(MINUTE), Some(Duration::from_secs(30))),
            None
        );
        assert!(heard.try_recv().is_err());
    }

    #[test]
    fn a_new_watch_wakes_the_clock_to_settle_it() {
        // A page that starts watching on a still desk may already be due.
        let woken = Arc::new(AtomicUsize::new(0));
        let watches = IdleWatches::new({
            let woken = woken.clone();
            move || {
                woken.fetch_add(1, Ordering::SeqCst);
            }
        });
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleAfter { seconds: 120 });
        reply(&heard, 1);

        assert_eq!(woken.load(Ordering::SeqCst), 1);
        watches.settle(Some(3 * MINUTE), None);
        assert!(idle(&heard, 1));
    }

    #[test]
    fn no_time_is_refused() {
        let (page, heard) = page(&watches());
        page.handle(1, SystemRequest::IdleAfter { seconds: 0 });
        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::InvalidInput);
        page.handle(2, SystemRequest::IdleBeforeBlanking { seconds: 0 });
        assert_eq!(failure(reply(&heard, 2)), SystemErrorKind::InvalidInput);
    }

    #[test]
    fn a_page_that_stopped_watching_hears_no_more() {
        let watches = watches();
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleAfter { seconds: 120 });
        reply(&heard, 1);

        page.handle(1, SystemRequest::Unwatch);
        watches.settle(Some(3 * MINUTE), None);

        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 1,
                end: SystemEnd::Stopped,
            }
        );
        assert!(heard.try_recv().is_err());
    }

    #[test]
    fn a_page_that_is_gone_watches_nothing() {
        let watches = watches();
        let (page, heard) = page(&watches);
        page.handle(1, SystemRequest::IdleAfter { seconds: 120 });
        reply(&heard, 1);

        drop(page);

        assert_eq!(watches.settle(Some(MINUTE), None), None);
    }

    /// A lock screen may dim too.
    #[test]
    fn watching_is_its_own_reach() {
        assert_eq!(
            reach(&SystemRequest::IdleAfter { seconds: 1 }),
            Reach::Listens
        );
        assert_eq!(
            reach(&SystemRequest::IdleBeforeBlanking { seconds: 1 }),
            Reach::Listens
        );
    }
}

/// Passphrases the lock did not take, sent by the compositor and heard on
/// every connection listening.
mod unlock_refusals {
    use std::time::Duration;

    use domicile_host::unlock_refusals::{Refused, UnlockRefusals};
    use domicile_protocol::UnlockRefusal;

    use super::*;

    #[test]
    fn a_refusal_is_heard_on_every_page_listening() {
        let refusals = UnlockRefusals::default();
        let home = std::env::temp_dir();
        let pages: Vec<_> = (0..2)
            .map(|_| {
                let (page, heard) = system_in(&home);
                let page = page.sharing_unlock_refusals(refusals.clone());
                page.handle(4, SystemRequest::UnlockRefusals);
                assert_eq!(reply(&heard, 4), SystemReply::Started);
                (page, heard)
            })
            .collect();

        refusals.send(&Refused {
            refusal: UnlockRefusal::WrongPassphrase,
            failures: 3,
            retry_in: Duration::from_secs(5),
        });

        for (_, heard) in &pages {
            assert_eq!(
                next(heard),
                HostMessage::SystemEvent {
                    id: 4,
                    event: SystemEvent::UnlockRefused {
                        refusal: UnlockRefusal::WrongPassphrase,
                        failures: 3,
                        retry_in_ms: 5000,
                    },
                }
            );
        }
    }

    /// A lock screen listens while the desktop is locked; that is when it
    /// hears anything.
    #[test]
    fn listening_is_its_own_reach() {
        assert_eq!(reach(&SystemRequest::UnlockRefusals), Reach::Listens);
    }
}

/// Window states the shell sets, and the maximize and fullscreen requests it
/// hears from clients.
mod window_states {
    use domicile_host::window_requests::WindowRequests;
    use domicile_protocol::{SystemError, WindowRequest, WindowState};

    use super::*;

    fn tile_left_and_right() -> SystemRequest {
        SystemRequest::SetWindowStates {
            app_id: "app-1".into(),
            states: vec![WindowState::TiledLeft, WindowState::TiledRight],
        }
    }

    #[test]
    fn setting_states_hands_them_to_the_compositor() {
        let (told, asked) = channel();
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.setting_window_states_with(move |app_id, states| {
            told.send((app_id, states)).unwrap();
            Ok(())
        });

        system.handle(1, tile_left_and_right());

        assert_eq!(reply(&heard, 1), SystemReply::Set);
        assert_eq!(
            asked.recv().unwrap(),
            (
                "app-1".to_string(),
                vec![WindowState::TiledLeft, WindowState::TiledRight]
            )
        );
    }

    #[test]
    fn states_the_compositor_refused_say_why() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.setting_window_states_with(|_, _| {
            Err(SystemError {
                kind: SystemErrorKind::NotFound,
                message: "no window app-1".into(),
            })
        });

        system.handle(1, tile_left_and_right());

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::NotFound);
    }

    #[test]
    fn a_system_that_sets_no_states_says_so() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(1, tile_left_and_right());

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }

    #[test]
    fn a_page_listening_hears_each_request_until_it_stops() {
        let requests = WindowRequests::default();
        let (system, heard) = system_in(&std::env::temp_dir());
        let page = system.sharing_window_requests(requests.clone());
        page.handle(7, SystemRequest::WindowRequests);
        assert_eq!(reply(&heard, 7), SystemReply::Started);

        requests.send(&("app-1".into(), WindowRequest::Maximize));
        assert_eq!(
            next(&heard),
            HostMessage::SystemEvent {
                id: 7,
                event: SystemEvent::WindowRequest {
                    app_id: "app-1".into(),
                    request: WindowRequest::Maximize,
                },
            }
        );

        page.handle(7, SystemRequest::Unwatch);
        requests.send(&("app-1".into(), WindowRequest::Unmaximize));
        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 7,
                end: SystemEnd::Stopped,
            }
        );
        assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
    }

    /// Both arrange windows or listen, as `setAppBounds` does, so a lock
    /// screen's layout stays right.
    #[test]
    fn setting_states_arranges_and_hearing_requests_listens() {
        assert_eq!(reach(&tile_left_and_right()), Reach::Arranges);
        assert_eq!(reach(&SystemRequest::WindowRequests), Reach::Listens);
    }
}

/// Clients ringing the bell, which the compositor reports.
mod bells {
    use domicile_host::bells::Bells;

    use super::*;

    #[test]
    fn a_page_listening_hears_each_ring_until_it_stops() {
        let bells = Bells::default();
        let (system, heard) = system_in(&std::env::temp_dir());
        let page = system.sharing_bells(bells.clone());
        page.handle(7, SystemRequest::Bells);
        assert_eq!(reply(&heard, 7), SystemReply::Started);

        bells.send(&Some("app-1".into()));
        bells.send(&None);
        for app_id in [Some("app-1".to_string()), None] {
            assert_eq!(
                next(&heard),
                HostMessage::SystemEvent {
                    id: 7,
                    event: SystemEvent::Bell { app_id },
                }
            );
        }

        page.handle(7, SystemRequest::Unwatch);
        bells.send(&None);
        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 7,
                end: SystemEnd::Stopped,
            }
        );
        assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(reach(&SystemRequest::Bells), Reach::Listens);
    }
}

/// What holds the desktop awake, which the compositor lists.
mod idle_holds {
    use domicile_host::idle_holds::IdleHolds;

    use super::*;

    fn heard_holders(heard: &Receiver<HostMessage>, id: u32) -> Vec<String> {
        match next(heard) {
            HostMessage::SystemEvent {
                id: from,
                event: SystemEvent::IdleHolds { holders },
            } if from == id => holders,
            other => panic!("expected idle holds for {id}, heard {other:?}"),
        }
    }

    #[test]
    fn a_page_listening_hears_the_holders_at_once_and_each_change() {
        let holds = IdleHolds::default();
        let (system, heard) = system_in(&std::env::temp_dir());
        let page = system.sharing_idle_holds(holds.clone());

        page.handle(7, SystemRequest::IdleHolds);
        assert_eq!(reply(&heard, 7), SystemReply::Started);
        assert_eq!(
            heard_holders(&heard, 7),
            Vec::<String>::new(),
            "nothing holding is said too, so a page need not wait for a change"
        );

        holds.hold(vec!["mpv".into()]);
        assert_eq!(heard_holders(&heard, 7), vec!["mpv".to_string()]);

        holds.hold(vec!["mpv".into()]);
        page.handle(7, SystemRequest::Unwatch);
        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 7,
                end: SystemEnd::Stopped,
            },
            "an unchanged list is not told again"
        );
        holds.hold(Vec::new());
        assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn hearing_the_holders_listens() {
        assert_eq!(reach(&SystemRequest::IdleHolds), Reach::Listens);
    }
}

/// The keymaps, which the compositor lists and switches between.
mod keymaps {
    use domicile_host::keymaps::{Keymaps, Listed};
    use domicile_protocol::{KeymapChoice, ListedKeymap, SystemError};

    use super::*;

    fn listed(names: &[&str], active: &str) -> Listed {
        Listed {
            keymaps: names
                .iter()
                .map(|name| ListedKeymap {
                    name: name.to_string(),
                    description: None,
                })
                .collect(),
            active: active.into(),
        }
    }

    fn heard_keymaps(heard: &Receiver<HostMessage>, id: u32) -> Listed {
        match next(heard) {
            HostMessage::SystemEvent {
                id: from,
                event: SystemEvent::Keymaps { keymaps, active },
            } if from == id => Listed { keymaps, active },
            other => panic!("expected keymaps for {id}, heard {other:?}"),
        }
    }

    #[test]
    fn a_page_listening_hears_the_keymaps_at_once_and_each_change() {
        let keymaps = Keymaps::default();
        keymaps.list(listed(&["dvp", "us"], "dvp"));
        let (system, heard) = system_in(&std::env::temp_dir());
        let page = system.sharing_keymaps(keymaps.clone());

        page.handle(7, SystemRequest::Keymaps);
        assert_eq!(reply(&heard, 7), SystemReply::Started);
        assert_eq!(heard_keymaps(&heard, 7), listed(&["dvp", "us"], "dvp"));

        keymaps.list(listed(&["dvp", "us"], "us"));
        assert_eq!(heard_keymaps(&heard, 7), listed(&["dvp", "us"], "us"));

        keymaps.list(listed(&["dvp", "us"], "us"));
        page.handle(7, SystemRequest::Unwatch);
        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 7,
                end: SystemEnd::Stopped,
            },
            "an unchanged list is not told again"
        );
        keymaps.list(listed(&["dvp", "us"], "dvp"));
        assert!(heard.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn selecting_a_keymap_hands_the_choice_to_the_compositor() {
        let (told, asked) = channel();
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.selecting_keymaps_with(move |choice| {
            told.send(choice).unwrap();
            Ok(())
        });

        system.handle(
            1,
            SystemRequest::SelectKeymap {
                keymap: KeymapChoice::Next,
            },
        );

        assert_eq!(reply(&heard, 1), SystemReply::Set);
        assert_eq!(asked.recv().unwrap(), KeymapChoice::Next);
    }

    #[test]
    fn a_keymap_the_compositor_refused_says_why() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.selecting_keymaps_with(|_| {
            Err(SystemError {
                kind: SystemErrorKind::NotFound,
                message: "no keymap de".into(),
            })
        });

        system.handle(
            1,
            SystemRequest::SelectKeymap {
                keymap: KeymapChoice::Named { name: "de".into() },
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::NotFound);
    }

    #[test]
    fn a_system_that_selects_no_keymaps_says_so() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(
            1,
            SystemRequest::SelectKeymap {
                keymap: KeymapChoice::Next,
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }
}

/// The way back to the desktop from a window holding a shortcuts inhibitor.
mod shortcuts_inhibitors {
    use domicile_protocol::InhibitorAction;

    use super::*;

    #[test]
    fn switching_the_inhibitor_hands_the_action_to_the_compositor() {
        let (told, asked) = channel();
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.switching_shortcuts_inhibitors_with(move |action| {
            told.send(action).unwrap();
            Ok(())
        });

        for (id, action) in [
            (1, InhibitorAction::Deactivate),
            (2, InhibitorAction::Activate),
            (3, InhibitorAction::Toggle),
        ] {
            system.handle(id, SystemRequest::ShortcutsInhibitor { action });
            assert_eq!(reply(&heard, id), SystemReply::Set);
            assert_eq!(asked.recv().unwrap(), action);
        }
    }

    #[test]
    fn a_system_with_no_inhibitors_says_so() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(
            1,
            SystemRequest::ShortcutsInhibitor {
                action: InhibitorAction::Toggle,
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }

    /// It moves where keys go, as a focus change does.
    #[test]
    fn switching_the_inhibitor_arranges() {
        assert_eq!(
            reach(&SystemRequest::ShortcutsInhibitor {
                action: InhibitorAction::Toggle
            }),
            Reach::Arranges
        );
    }
}

/// The color temperature the shell sets every monitor to, as a night light
/// does.
mod color_temperature {
    use domicile_host::white_point::{white_point, WhitePoint};

    use super::*;

    #[test]
    fn setting_a_temperature_hands_its_white_point_to_the_compositor() {
        let (told, asked) = channel();
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.setting_white_points_with(move |display, point| {
            told.send((display, point)).unwrap();
            Ok(())
        });

        system.handle(
            1,
            SystemRequest::SetColorTemperature {
                kelvin: 3400,
                display: None,
            },
        );

        assert_eq!(reply(&heard, 1), SystemReply::Set);
        assert_eq!(asked.recv().unwrap(), (None, white_point(3400)));
    }

    #[test]
    fn setting_one_displays_temperature_names_it_to_the_compositor() {
        let (told, asked) = channel();
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.setting_white_points_with(move |display, point| {
            told.send((display, point)).unwrap();
            Ok(())
        });

        system.handle(
            1,
            SystemRequest::SetColorTemperature {
                kelvin: 3400,
                display: Some("eDP-2".into()),
            },
        );

        assert_eq!(reply(&heard, 1), SystemReply::Set);
        assert_eq!(
            asked.recv().unwrap(),
            (Some("eDP-2".into()), white_point(3400))
        );
    }

    #[test]
    fn a_temperature_out_of_range_is_refused() {
        let (told, asked) = channel::<(Option<String>, WhitePoint)>();
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.setting_white_points_with(move |display, point| {
            told.send((display, point)).unwrap();
            Ok(())
        });

        system.handle(
            1,
            SystemRequest::SetColorTemperature {
                kelvin: 999,
                display: None,
            },
        );
        system.handle(
            2,
            SystemRequest::SetColorTemperature {
                kelvin: 6501,
                display: None,
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::InvalidInput);
        assert_eq!(failure(reply(&heard, 2)), SystemErrorKind::InvalidInput);
        assert!(asked.try_recv().is_err());
    }

    #[test]
    fn a_system_that_sets_no_white_point_says_so() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(
            1,
            SystemRequest::SetColorTemperature {
                kelvin: 3400,
                display: None,
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }

    /// A lock screen shows the keymap and switches it, so the passphrase is
    /// typed on the right one.
    #[test]
    fn listing_listens_and_selecting_retypes() {
        assert_eq!(reach(&SystemRequest::Keymaps), Reach::Listens);
        assert_eq!(
            reach(&SystemRequest::SelectKeymap {
                keymap: domicile_protocol::KeymapChoice::Next
            }),
            Reach::Retypes
        );
    }

    /// A night light turns on at sunset whether or not the desktop is locked.
    #[test]
    fn setting_a_temperature_tints() {
        assert_eq!(
            reach(&SystemRequest::SetColorTemperature {
                kelvin: 3400,
                display: None,
            }),
            Reach::Tints
        );
    }

    #[test]
    fn an_app_may_not_set_a_temperature() {
        let Some(HostMessage::SystemReply {
            id: 4,
            reply: SystemReply::Failed { error },
        }) = refused_to_an_app(
            4,
            &SystemRequest::SetColorTemperature {
                kelvin: 3400,
                display: None,
            },
        )
        else {
            panic!("expected a failure");
        };
        assert_eq!(error.kind, SystemErrorKind::PermissionDenied);
    }
}

/// Turning the monitors off and on again on demand, as
/// `domicile sleep-displays` does.
mod display_power {
    use domicile_host::system::DisplayPower;

    use super::*;

    #[test]
    fn sleeping_and_waking_ask_the_compositor() {
        let (told, asked) = channel();
        let (system, heard) = system_in(&std::env::temp_dir());
        let system = system.powering_displays_with(move |power, display| {
            told.send((power, display)).unwrap();
            Ok(())
        });

        system.handle(1, SystemRequest::SleepDisplays { display: None });
        system.handle(
            2,
            SystemRequest::WakeDisplays {
                display: Some("DP-1".into()),
            },
        );

        assert_eq!(reply(&heard, 1), SystemReply::Set);
        assert_eq!(reply(&heard, 2), SystemReply::Set);
        assert_eq!(asked.recv().unwrap(), (DisplayPower::Asleep, None));
        assert_eq!(
            asked.recv().unwrap(),
            (DisplayPower::Awake, Some("DP-1".into()))
        );
    }

    #[test]
    fn a_system_that_powers_no_displays_says_so() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(1, SystemRequest::SleepDisplays { display: None });

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }

    /// Turning the screens off is how a locked desktop is left, and lighting
    /// them shows only the lock screen.
    #[test]
    fn sleeping_and_waking_power() {
        assert_eq!(
            reach(&SystemRequest::SleepDisplays { display: None }),
            Reach::Powers
        );
        assert_eq!(
            reach(&SystemRequest::WakeDisplays { display: None }),
            Reach::Powers
        );
    }

    #[test]
    fn an_app_may_not_sleep_or_wake_the_displays() {
        for asked in [
            SystemRequest::SleepDisplays { display: None },
            SystemRequest::WakeDisplays { display: None },
        ] {
            let Some(HostMessage::SystemReply {
                id: 4,
                reply: SystemReply::Failed { error },
            }) = refused_to_an_app(4, &asked)
            else {
                panic!("expected a failure for {asked:?}");
            };
            assert_eq!(error.kind, SystemErrorKind::PermissionDenied);
        }
    }
}

/// What a refused request gets while the desktop is locked.
mod locked {
    use super::*;

    #[test]
    fn a_call_that_would_start_something_is_told_it_is_locked() {
        for starts in [
            spawn(&["true"]),
            SystemRequest::Screenshot { file: None },
            SystemRequest::ScreenRecord,
            SystemRequest::PreviewWindow {
                window: PreviewedWindow::App { id: "app-1".into() },
            },
            SystemRequest::SendShell {
                command: vec!["focus".into(), "right".into()],
            },
            SystemRequest::OpenLink {
                url: "mailto:a@example.com".into(),
                app_id: None,
            },
            SystemRequest::ShortcutsInhibitor {
                action: domicile_protocol::InhibitorAction::Toggle,
            },
        ] {
            let Some(HostMessage::SystemReply {
                id: 4,
                reply: SystemReply::Failed { error },
            }) = locked_out(4, &starts)
            else {
                panic!("expected a failure for 4");
            };
            assert_eq!(error.kind, SystemErrorKind::Locked);
        }
    }

    /// Only events and the end may follow a start, so a refused write to a
    /// running process's stdin gets nothing.
    #[test]
    fn a_call_that_drives_something_running_gets_nothing() {
        assert_eq!(
            locked_out(4, &SystemRequest::Stdin { data: "".into() }),
            None
        );
    }
}

/// What an app connection may call. See `docs/architecture/APP-MODULES.md`.
mod apps {
    use super::*;

    #[test]
    fn an_app_may_use_files_processes_and_d_bus() {
        for allowed in [
            SystemRequest::ReadFile {
                path: "notes.txt".into(),
                offset: 0,
                length: None,
            },
            SystemRequest::Watch {
                path: "notes.txt".into(),
            },
            spawn(&["true"]),
            SystemRequest::Stdin { data: "".into() },
            SystemRequest::Kill {
                signal: Signal::Term,
            },
        ] {
            assert_eq!(refused_to_an_app(4, &allowed), None, "{allowed:?}");
        }
    }

    /// These belong to the window manager, which a Wayland client cannot
    /// reach either.
    #[test]
    fn an_app_may_not_reach_the_desktop() {
        for refused in [
            SystemRequest::Screenshot { file: None },
            SystemRequest::ScreenRecord,
            SystemRequest::PreviewWindow {
                window: PreviewedWindow::App { id: "app-1".into() },
            },
            SystemRequest::ShellCommands {
                commands: Vec::new(),
                bindings: Vec::new(),
            },
            SystemRequest::SendShell {
                command: vec!["focus".into(), "right".into()],
            },
            SystemRequest::AnswerShellCommand {
                sent: 1,
                refused: None,
                output: None,
            },
            SystemRequest::ClaimLinks {
                schemes: vec!["mailto".into()],
            },
            SystemRequest::OpenLink {
                url: "mailto:a@example.com".into(),
                app_id: None,
            },
            SystemRequest::IdleAfter { seconds: 1 },
            SystemRequest::IdleBeforeBlanking { seconds: 1 },
            SystemRequest::UnlockRefusals,
            SystemRequest::WindowRequests,
            SystemRequest::Bells,
            SystemRequest::SetWindowStates {
                app_id: "app-1".into(),
                states: Vec::new(),
            },
            SystemRequest::Keymaps,
            SystemRequest::SelectKeymap {
                keymap: domicile_protocol::KeymapChoice::Next,
            },
            SystemRequest::ShortcutsInhibitor {
                action: domicile_protocol::InhibitorAction::Toggle,
            },
        ] {
            let Some(HostMessage::SystemReply {
                id: 4,
                reply: SystemReply::Failed { error },
            }) = refused_to_an_app(4, &refused)
            else {
                panic!("expected a failure for {refused:?}");
            };
            assert_eq!(error.kind, SystemErrorKind::PermissionDenied);
        }
    }
}

/// D-Bus calls and matches, against a service on a peer-to-peer connection
/// rather than a bus, so no bus daemon is needed.
mod dbus {
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex};

    use zbus::blocking::connection::Builder;
    use zbus::blocking::Connection;

    use super::*;

    /// The service the tests call.
    struct Greeter;

    #[zbus::interface(name = "org.domicile.Test")]
    impl Greeter {
        fn greet(&self, name: &str, times: u32) -> String {
            format!("hello {name}").repeat(times as usize)
        }

        fn fail(&self) -> zbus::fdo::Result<()> {
            Err(zbus::fdo::Error::Failed("on purpose".into()))
        }
    }

    /// Each connection the system opens, by the service's end of it.
    type Services = Arc<Mutex<Vec<Connection>>>;

    /// A system whose buses are each a fresh connection to a [`Greeter`].
    fn connected(home: &Path) -> (System, Receiver<HostMessage>, Services) {
        let services: Services = Arc::default();
        let (told, heard) = channel();
        let system = System::new(home.to_path_buf(), Vec::new(), ours(), move |message| {
            let _ = told.send(message);
        })
        .connecting_with({
            let services = services.clone();
            move |_bus| {
                let (ours, theirs) = UnixStream::pair()?;
                let serving = std::thread::spawn(move || {
                    Builder::async_io_unix_stream(theirs)
                        .server(zbus::Guid::generate())?
                        .p2p()
                        .serve_at("/test", Greeter)?
                        .build()
                });
                let client = Builder::async_io_unix_stream(ours).p2p().build()?;
                services
                    .lock()
                    .unwrap()
                    .push(serving.join().expect("the service starts")?);
                Ok(client)
            }
        });
        (system, heard, services)
    }

    fn call(member: &str, signature: &str, body: &str) -> SystemRequest {
        SystemRequest::DbusCall {
            bus: Bus::Session,
            destination: "org.domicile.Test".into(),
            path: "/test".into(),
            interface: "org.domicile.Test".into(),
            member: member.into(),
            signature: signature.into(),
            body: body.into(),
        }
    }

    #[test]
    fn a_call_returns_its_body_as_json() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard, _services) = connected(home.path());

        system.handle(1, call("Greet", "su", r#"["ada", 2]"#));

        assert_eq!(
            reply(&heard, 1),
            SystemReply::Returned {
                signature: "s".into(),
                body: r#"["hello adahello ada"]"#.into(),
            }
        );
    }

    #[test]
    fn a_method_error_is_named() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard, _services) = connected(home.path());

        system.handle(1, call("Fail", "", "[]"));

        let SystemReply::Failed { error } = reply(&heard, 1) else {
            panic!("expected a failure");
        };
        assert_eq!(error.kind, SystemErrorKind::Dbus);
        assert!(
            error
                .message
                .starts_with("org.freedesktop.DBus.Error.Failed"),
            "{}",
            error.message
        );
    }

    #[test]
    fn a_body_that_does_not_fit_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard, _services) = connected(home.path());

        system.handle(1, call("Greet", "su", r#"["ada"]"#));

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::InvalidInput);
    }

    #[test]
    fn a_match_reports_signals_until_it_is_stopped() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard, services) = connected(home.path());

        system.handle(
            1,
            SystemRequest::DbusMatch {
                bus: Bus::Session,
                sender: None,
                path: None,
                interface: Some("org.domicile.Test".into()),
                member: Some("Pinged".into()),
            },
        );
        assert_eq!(reply(&heard, 1), SystemReply::Started);
        let service = services.lock().unwrap().last().cloned().expect("a service");
        service
            .emit_signal(None::<&str>, "/test", "org.domicile.Test", "Ignored", &())
            .unwrap();
        service
            .emit_signal(
                None::<&str>,
                "/test",
                "org.domicile.Test",
                "Pinged",
                &(7u32,),
            )
            .unwrap();

        let HostMessage::SystemEvent {
            id: 1,
            event:
                SystemEvent::Signal {
                    path,
                    interface,
                    member,
                    signature,
                    body,
                    ..
                },
        } = next(&heard)
        else {
            panic!("expected the signal");
        };
        assert_eq!(
            (path, interface, member, signature, body),
            (
                "/test".into(),
                "org.domicile.Test".into(),
                "Pinged".into(),
                "u".into(),
                "[7]".into()
            )
        );

        assert_eq!(system.handle(1, SystemRequest::Unwatch), Handled::Done);
        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 1,
                end: SystemEnd::Stopped
            }
        );
    }

    /// A page that goes away leaves no match listening.
    #[test]
    fn dropping_the_system_closes_its_matches() {
        let home = tempfile::tempdir().unwrap();
        let (system, heard, services) = connected(home.path());
        system.handle(
            1,
            SystemRequest::DbusMatch {
                bus: Bus::Session,
                sender: None,
                path: None,
                interface: None,
                member: None,
            },
        );
        assert_eq!(reply(&heard, 1), SystemReply::Started);
        let service = services.lock().unwrap().last().cloned().expect("a service");

        drop(system);

        let (closed, heard_closed) = channel();
        std::thread::spawn(move || {
            service.closed();
            let _ = closed.send(());
        });
        heard_closed
            .recv_timeout(PATIENCE)
            .expect("the match's connection closes with the system");
    }

    #[test]
    fn calls_and_matches_are_actions_to_the_lock() {
        assert_eq!(reach(&call("Greet", "", "[]")), Reach::Acts);
        assert_eq!(
            reach(&SystemRequest::DbusMatch {
                bus: Bus::System,
                sender: None,
                path: None,
                interface: None,
                member: None,
            }),
            Reach::Acts
        );
        assert!(locked_out(1, &call("Greet", "", "[]")).is_some());
    }
}

/// Virtual monitors a page adds to cast the desk to a TV.
mod virtual_monitors {
    use std::sync::mpsc::Sender;

    use domicile_host::system::{AddedMonitor, MonitorLease, VirtualMonitor};
    use domicile_protocol::{Scale, SystemEnd};

    use super::*;

    fn one_and_a_half() -> Scale {
        Scale::try_from(1.5).unwrap()
    }

    fn a_tv() -> SystemRequest {
        SystemRequest::VirtualMonitor {
            name: "Living Room TV".into(),
            width: 1920,
            height: 1080,
            refresh_mhz: 60_000,
            scale: Scale::ONE,
        }
    }

    /// Says on `gone` when it drops, as the compositor removes the monitor,
    /// and on `resized` each size it is given.
    struct Lease {
        gone: Sender<()>,
        resized: Sender<((u32, u32), u32, Scale)>,
    }

    impl MonitorLease for Lease {
        fn resize(&self, size: (u32, u32), refresh_mhz: u32, scale: Scale) {
            self.resized.send((size, refresh_mhz, scale)).unwrap();
        }
    }

    impl Drop for Lease {
        fn drop(&mut self) {
            // A test that ends with the monitor up has stopped listening.
            let _ = self.gone.send(());
        }
    }

    /// What a system that adds monitors was asked to do.
    struct Asked {
        added: Receiver<VirtualMonitor>,
        gone: Receiver<()>,
        resized: Receiver<((u32, u32), u32, Scale)>,
    }

    /// A system that adds each monitor as `virtual-1`, and what it was asked.
    fn adding(system: System) -> (System, Asked) {
        let (added_one, added) = channel();
        let (removed, gone) = channel();
        let (resized_one, resized) = channel();
        let system = system.adding_virtual_monitors_with(move |wanted| {
            added_one.send(wanted).unwrap();
            Ok(AddedMonitor {
                output: "virtual-1".into(),
                lease: Box::new(Lease {
                    gone: removed.clone(),
                    resized: resized_one.clone(),
                }),
            })
        });
        (
            system,
            Asked {
                added,
                gone,
                resized,
            },
        )
    }

    #[test]
    fn a_page_adds_a_monitor_until_it_stops() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = adding(system);

        system.handle(1, a_tv());

        assert_eq!(
            reply(&heard, 1),
            SystemReply::VirtualMonitor {
                output: "virtual-1".into()
            }
        );
        assert_eq!(
            asked.added.recv().unwrap(),
            VirtualMonitor {
                name: "Living Room TV".into(),
                size: (1920, 1080),
                refresh_mhz: 60_000,
                scale: Scale::ONE,
            }
        );
        assert!(
            asked.gone.try_recv().is_err(),
            "the monitor stays while it runs"
        );

        system.handle(1, SystemRequest::Unwatch);

        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 1,
                end: SystemEnd::Stopped,
            }
        );
        asked.gone.recv().unwrap();
    }

    #[test]
    fn a_page_adds_a_monitor_at_its_scale() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = adding(system);

        system.handle(
            1,
            SystemRequest::VirtualMonitor {
                name: "Pane".into(),
                width: 806,
                height: 539,
                refresh_mhz: 60_000,
                scale: one_and_a_half(),
            },
        );
        reply(&heard, 1);

        assert_eq!(asked.added.recv().unwrap().scale, one_and_a_half());
    }

    #[test]
    fn a_page_resizes_its_monitor_in_place() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = adding(system);
        system.handle(1, a_tv());
        reply(&heard, 1);

        assert_eq!(
            system.handle(
                1,
                SystemRequest::ResizeVirtualMonitor {
                    width: 1280,
                    height: 720,
                    refresh_mhz: 30_000,
                    scale: one_and_a_half(),
                },
            ),
            Handled::Done
        );

        assert_eq!(
            asked.resized.recv().unwrap(),
            ((1280, 720), 30_000, one_and_a_half())
        );
        assert!(asked.gone.try_recv().is_err(), "the same monitor stays");
    }

    /// A resize arranges the desk, as `setAppBounds` does, so a monitor
    /// keeps following its pane while the desk is locked.
    #[test]
    fn a_resize_arranges_and_drives_what_is_running() {
        let resize = SystemRequest::ResizeVirtualMonitor {
            width: 1280,
            height: 720,
            refresh_mhz: 30_000,
            scale: Scale::ONE,
        };
        assert_eq!(reach(&resize), Reach::Arranges);
        assert_eq!(locked_out(1, &resize), None);
        assert!(refused_to_an_app(1, &resize).is_some());
    }

    #[test]
    fn a_resize_with_no_monitor_reaches_nothing() {
        let (system, _heard) = system_in(&std::env::temp_dir());
        let (system, asked) = adding(system);

        assert_eq!(
            system.handle(
                1,
                SystemRequest::ResizeVirtualMonitor {
                    width: 1280,
                    height: 720,
                    refresh_mhz: 30_000,
                    scale: Scale::ONE,
                },
            ),
            Handled::NothingRunning
        );
        assert!(asked.resized.try_recv().is_err());
    }

    #[test]
    fn a_page_that_goes_away_takes_its_monitor_with_it() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = adding(system);
        system.handle(1, a_tv());
        reply(&heard, 1);

        drop(system);

        asked.gone.recv().unwrap();
    }

    #[test]
    fn a_name_with_a_nul_is_refused() {
        // The engine takes the name as a C string.
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = adding(system);

        system.handle(
            1,
            SystemRequest::VirtualMonitor {
                name: "TV\0".into(),
                width: 1920,
                height: 1080,
                refresh_mhz: 60_000,
                scale: Scale::ONE,
            },
        );

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::InvalidInput);
        assert!(asked.added.try_recv().is_err());
    }

    #[test]
    fn a_system_that_adds_no_monitors_says_so() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(1, a_tv());

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }
}

/// Agents a caller asks the user to let in, such as `domicile agent`'s.
mod agents {
    use std::sync::mpsc::Sender;
    use std::sync::{Arc, Mutex};

    use domicile_host::system::{AgentChanged, AgentLease, AgentStopped, AgentTold, Agents, LetIn};
    use domicile_protocol::{
        AgentReach, ConnectedAgent, KnownAgents, RememberedAgent, SystemError, SystemEvent,
    };

    use super::*;

    fn claude() -> SystemRequest {
        SystemRequest::Agent {
            agent: "Claude Code".into(),
        }
    }

    /// Says on `did` what the agent did, and on `gone` when it drops, as the
    /// compositor takes it off the shell's list.
    struct Lease {
        did: Sender<String>,
        gone: Sender<()>,
    }

    impl AgentLease for Lease {
        fn did(&self, said: String) {
            self.did.send(said).unwrap();
        }
    }

    impl Drop for Lease {
        fn drop(&mut self) {
            let _ = self.gone.send(());
        }
    }

    type Answer = Box<dyn Fn() -> Result<AgentReach, SystemError> + Send + Sync>;

    /// Agents whose user answers each with `answer`, telling the test what
    /// it hears.
    struct Door {
        answer: Answer,
        named: Sender<String>,
        did: Sender<String>,
        gone: Sender<()>,
        stop: Arc<Mutex<Option<AgentStopped>>>,
        change: Arc<Mutex<Option<AgentChanged>>>,
        stopped: Sender<u32>,
        forgot: Sender<String>,
    }

    impl Agents for Door {
        fn let_in(&self, agent: String, told: AgentTold) -> Result<LetIn, SystemError> {
            self.named.send(agent).unwrap();
            *self.stop.lock().unwrap() = Some(told.stopped);
            *self.change.lock().unwrap() = Some(told.changed);
            Ok(LetIn {
                reach: (self.answer)()?,
                lease: Box::new(Lease {
                    did: self.did.clone(),
                    gone: self.gone.clone(),
                }),
            })
        }

        fn known(&self) -> KnownAgents {
            KnownAgents {
                connected: vec![ConnectedAgent {
                    session: 4,
                    agent: "Claude Code".into(),
                    reach: AgentReach::Desk,
                }],
                remembered: vec![RememberedAgent {
                    agent: "Codex".into(),
                    last_used_ms: 9,
                }],
            }
        }

        fn stop(&self, session: u32) -> Result<(), SystemError> {
            self.stopped.send(session).unwrap();
            Ok(())
        }

        fn forget(&self, agent: &str) -> Result<(), SystemError> {
            self.forgot.send(agent.into()).unwrap();
            Ok(())
        }
    }

    /// What a system that lets agents in heard, and the user's stop and
    /// change.
    struct Asked {
        named: Receiver<String>,
        did: Receiver<String>,
        gone: Receiver<()>,
        stop: Arc<Mutex<Option<AgentStopped>>>,
        change: Arc<Mutex<Option<AgentChanged>>>,
        stopped: Receiver<u32>,
        forgot: Receiver<String>,
    }

    /// A system whose user answers each agent with `answer`.
    fn letting(
        system: System,
        answer: impl Fn() -> Result<AgentReach, SystemError> + Send + Sync + 'static,
    ) -> (System, Asked) {
        let (named_one, named) = channel();
        let (did_one, did) = channel();
        let (gone_one, gone) = channel();
        let (stopped_one, stopped) = channel();
        let (forgot_one, forgot) = channel();
        let stop = Arc::new(Mutex::new(None));
        let change = Arc::new(Mutex::new(None));
        let system = system.letting_agents_in(Door {
            answer: Box::new(answer),
            named: named_one,
            did: did_one,
            gone: gone_one,
            stop: stop.clone(),
            change: change.clone(),
            stopped: stopped_one,
            forgot: forgot_one,
        });
        (
            system,
            Asked {
                named,
                did,
                gone,
                stop,
                change,
                stopped,
                forgot,
            },
        )
    }

    #[test]
    fn an_agent_let_in_lists_what_it_did_until_its_caller_lets_go() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = letting(system, || Ok(AgentReach::Desk));

        system.handle(1, claude());

        assert_eq!(
            reply(&heard, 1),
            SystemReply::Agent {
                reach: AgentReach::Desk
            }
        );
        assert_eq!(asked.named.recv().unwrap(), "Claude Code");
        assert_eq!(
            system.handle(
                1,
                SystemRequest::AgentDid {
                    said: "Clicked".into()
                }
            ),
            Handled::Done
        );
        assert_eq!(asked.did.recv().unwrap(), "Clicked");

        system.handle(1, SystemRequest::Unwatch);

        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 1,
                end: SystemEnd::Stopped,
            }
        );
        asked.gone.recv().unwrap();
    }

    #[test]
    fn the_shell_stopping_an_agent_ends_its_call() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = letting(system, || Ok(AgentReach::Desk));
        system.handle(1, claude());
        reply(&heard, 1);

        let stop = asked.stop.lock().unwrap().take().unwrap();
        stop();

        assert_eq!(
            next(&heard),
            HostMessage::SystemEnd {
                id: 1,
                end: SystemEnd::Stopped,
            }
        );
        asked.gone.recv().unwrap();
        assert_eq!(
            system.handle(
                1,
                SystemRequest::AgentDid {
                    said: "late".into()
                }
            ),
            Handled::NothingRunning
        );
    }

    #[test]
    fn an_agent_the_user_cancels_fails_its_call() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, _asked) = letting(system, || {
            Err(SystemError {
                kind: SystemErrorKind::Canceled,
                message: "canceled".into(),
            })
        });

        system.handle(1, claude());

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Canceled);
    }

    #[test]
    fn a_system_that_lets_no_agents_in_says_so() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(1, claude());

        assert_eq!(failure(reply(&heard, 1)), SystemErrorKind::Other);
    }

    #[test]
    fn an_agent_acts_and_is_refused_to_apps_and_while_locked() {
        assert_eq!(reach(&claude()), Reach::Acts);
        assert!(locked_out(1, &claude()).is_some());
        assert!(refused_to_an_app(1, &claude()).is_some());
        let did = SystemRequest::AgentDid { said: "x".into() };
        assert_eq!(locked_out(1, &did), None);
        assert!(refused_to_an_app(1, &did).is_some());
    }

    #[test]
    fn the_user_changing_an_agent_tells_its_caller() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = letting(system, || Ok(AgentReach::Desk));
        system.handle(1, claude());
        reply(&heard, 1);
        let windows = AgentReach::Windows { windows: vec![] };

        (asked.change.lock().unwrap().as_ref().unwrap())(windows.clone());

        assert_eq!(
            next(&heard),
            HostMessage::SystemEvent {
                id: 1,
                event: SystemEvent::AgentReach { reach: windows },
            }
        );
    }

    #[test]
    fn a_change_after_the_caller_let_go_tells_nobody() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = letting(system, || Ok(AgentReach::Desk));
        system.handle(1, claude());
        reply(&heard, 1);
        system.handle(1, SystemRequest::Unwatch);
        next(&heard);

        (asked.change.lock().unwrap().as_ref().unwrap())(AgentReach::Desk);

        assert!(heard.try_recv().is_err());
    }

    #[test]
    fn the_agents_are_listed_stopped_and_forgotten() {
        let (system, heard) = system_in(&std::env::temp_dir());
        let (system, asked) = letting(system, || Ok(AgentReach::Desk));

        system.handle(1, SystemRequest::Agents);
        let SystemReply::Agents(known) = reply(&heard, 1) else {
            panic!("the agents are listed");
        };
        assert_eq!(known.connected[0].session, 4);
        assert_eq!(known.remembered[0].agent, "Codex");

        system.handle(2, SystemRequest::StopAgent { session: 4 });
        assert_eq!(reply(&heard, 2), SystemReply::Set);
        assert_eq!(asked.stopped.recv().unwrap(), 4);

        system.handle(
            3,
            SystemRequest::ForgetAgent {
                agent: "Codex".into(),
            },
        );
        assert_eq!(reply(&heard, 3), SystemReply::Set);
        assert_eq!(asked.forgot.recv().unwrap(), "Codex");
    }

    #[test]
    fn a_system_that_lets_no_agents_in_knows_none() {
        let (system, heard) = system_in(&std::env::temp_dir());

        system.handle(1, SystemRequest::Agents);

        assert_eq!(
            reply(&heard, 1),
            SystemReply::Agents(KnownAgents::default())
        );
    }

    #[test]
    fn managing_agents_is_refused_to_apps_and_while_locked() {
        for request in [
            SystemRequest::Agents,
            SystemRequest::StopAgent { session: 1 },
            SystemRequest::ForgetAgent { agent: "x".into() },
        ] {
            assert!(locked_out(1, &request).is_some(), "{request:?}");
            assert!(refused_to_an_app(1, &request).is_some(), "{request:?}");
        }
        assert_eq!(
            reach(&SystemRequest::StopAgent { session: 1 }),
            Reach::Stops
        );
    }
}
