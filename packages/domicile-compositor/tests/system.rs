//! A page's system calls, end to end through the chrome socket.
//!
//! `domicile_host::system`'s tests cover the calls themselves. These check what
//! the compositor adds: the page's home, the desktop's environment, the lock,
//! and that a page's processes end with its connection.

mod running;

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use domicile_protocol::{
    ChromeMessage, HostMessage, Stream, SystemErrorKind, SystemEvent, SystemReply, SystemRequest,
};

use crate::running::Compositor;

const A_DESK: &str = r#"{ "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] } }"#;

/// The same desktop, locking after a second idle.
const A_DESK_THAT_LOCKS_IN_A_SECOND: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] },
  "idle": { "lock_after_seconds": 1 }
}
"#;

fn call(chrome: &mut domicile_test_chrome::Chrome, id: u32, request: SystemRequest) {
    chrome
        .say(&ChromeMessage::SystemRequest { id, request })
        .expect("the chrome socket takes a system call");
}

fn reply(chrome: &mut domicile_test_chrome::Chrome, id: u32) -> SystemReply {
    let replied = chrome
        .wait_for(|message| matches!(message, HostMessage::SystemReply { id: of, .. } if *of == id))
        .expect("a system call is answered");
    let HostMessage::SystemReply { reply, .. } = replied else {
        unreachable!("the wait matched on this variant")
    };
    reply
}

/// The first line a process prints on stdout.
fn first_line(chrome: &mut domicile_test_chrome::Chrome, id: u32) -> String {
    let printed = chrome
        .wait_for(|message| {
            matches!(
                message,
                HostMessage::SystemEvent {
                    id: of,
                    event: SystemEvent::Output {
                        stream: Stream::Stdout,
                        ..
                    },
                } if *of == id
            )
        })
        .expect("the process prints");
    let HostMessage::SystemEvent {
        event: SystemEvent::Output { data, .. },
        ..
    } = printed
    else {
        unreachable!("the wait matched on this variant")
    };
    let text =
        String::from_utf8(domicile_host::base64::decoded(&data).expect("base64")).expect("utf-8");
    text.lines().next().expect("a line").to_string()
}

fn shell(script: &str) -> SystemRequest {
    SystemRequest::Spawn {
        argv: vec!["sh".into(), "-c".into(), script.into()],
        cwd: None,
        env: Default::default(),
        stdin: false,
    }
}

#[test]
fn a_page_reads_its_home() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("note"), "hi").unwrap();
    let compositor = Compositor::started_in_a_home(A_DESK, Some(home.path()));
    let mut chrome = compositor.chrome();

    call(
        &mut chrome,
        1,
        SystemRequest::ReadFile {
            path: "note".into(),
            offset: 0,
            length: None,
        },
    );

    assert_eq!(
        reply(&mut chrome, 1),
        SystemReply::Read {
            data: "aGk=".into()
        }
    );
}

/// A tool the shell runs, like `wl-paste`, reaches this desktop rather than
/// the session the compositor was started from.
#[test]
fn a_page_s_process_runs_in_this_desktop() {
    let compositor = Compositor::started_with(A_DESK);
    let mut chrome = compositor.chrome();

    call(&mut chrome, 1, shell("echo $WAYLAND_DISPLAY"));

    assert_eq!(reply(&mut chrome, 1), SystemReply::Started);
    assert_eq!(first_line(&mut chrome, 1), compositor.wayland_display());
}

#[test]
fn a_page_s_processes_end_with_its_connection() {
    let compositor = Compositor::started_with(A_DESK);
    let mut chrome = compositor.chrome();
    call(&mut chrome, 1, shell("echo $$; exec sleep 100"));
    assert_eq!(reply(&mut chrome, 1), SystemReply::Started);
    let process = std::path::Path::new("/proc").join(first_line(&mut chrome, 1));

    drop(chrome);

    let deadline = Instant::now() + Duration::from_secs(10);
    while process.exists() {
        assert!(
            Instant::now() < deadline,
            "{} outlived its page",
            process.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A locked desktop runs nothing for the page, but its lock screen can still
/// read the kernel, for the battery, and warm the monitors.
#[test]
fn a_locked_desk_runs_nothing_but_reads_the_kernel() {
    let compositor = Compositor::started_with(A_DESK);
    let mut chrome = compositor.chrome();
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: false }))
        .expect("a desk that can lock says it is open");
    compositor.reconfigure(A_DESK_THAT_LOCKS_IN_A_SECOND);
    chrome
        .wait_for(|message| matches!(message, HostMessage::Locked { locked: true }))
        .expect("a desk nobody is at locks itself");
    compositor.reconfigure(A_DESK);

    call(&mut chrome, 1, shell("true"));
    let SystemReply::Failed { error } = reply(&mut chrome, 1) else {
        panic!("a process started while locked");
    };
    assert_eq!(error.kind, SystemErrorKind::Locked);

    call(
        &mut chrome,
        2,
        SystemRequest::Stat {
            path: "/sys".into(),
        },
    );
    assert!(matches!(reply(&mut chrome, 2), SystemReply::Stat { .. }));

    // A page reloaded while locked still hears commands after unlock.
    call(
        &mut chrome,
        3,
        SystemRequest::ShellCommands {
            commands: Vec::new(),
            bindings: Vec::new(),
        },
    );
    assert_eq!(reply(&mut chrome, 3), SystemReply::Started);
    call(
        &mut chrome,
        4,
        SystemRequest::SendShell {
            command: vec!["focus".into(), "right".into()],
        },
    );
    let SystemReply::Failed { error } = reply(&mut chrome, 4) else {
        panic!("a command was sent while locked");
    };
    assert_eq!(error.kind, SystemErrorKind::Locked);

    // A night light follows the clock whether or not anybody is at the desk.
    call(
        &mut chrome,
        5,
        SystemRequest::SetColorTemperature {
            kelvin: 3400,
            display: None,
        },
    );
    assert_eq!(reply(&mut chrome, 5), SystemReply::Set);
}

/// `domicile send-shell` writes one line on the chrome socket without saying
/// `hello`. Every page listening hears the command, and it is sent once one
/// ran it.
#[test]
fn a_command_sent_on_the_socket_reaches_every_page_listening() {
    let compositor = Compositor::started_with(A_DESK);
    let mut pages = [compositor.chrome(), compositor.chrome()];
    for page in &mut pages {
        call(
            page,
            7,
            SystemRequest::ShellCommands {
                commands: Vec::new(),
                bindings: Vec::new(),
            },
        );
        assert_eq!(reply(page, 7), SystemReply::Started);
    }

    let mut sender = UnixStream::connect(compositor.socket()).expect("the chrome socket is up");
    sender
        .write_all(
            b"{\"type\":\"system_request\",\"id\":1,\"request\":{\"call\":\"send_shell\",\
              \"command\":[\"focus\",\"right\"]}}\n",
        )
        .expect("the compositor reads the command");
    let mut sent = Vec::new();
    for page in &mut pages {
        let heard = page
            .wait_for(|message| {
                matches!(
                    message,
                    HostMessage::SystemEvent {
                        id: 7,
                        event: SystemEvent::ShellCommand { command, .. },
                    } if *command == ["focus", "right"]
                )
            })
            .expect("every page listening hears the command");
        let HostMessage::SystemEvent {
            event: SystemEvent::ShellCommand { sent: number, .. },
            ..
        } = heard
        else {
            unreachable!("the wait matched on this variant")
        };
        sent.push(number);
    }
    assert_eq!(sent[0], sent[1], "one command, one number");
    let sent = sent[0];
    call(
        &mut pages[0],
        8,
        SystemRequest::AnswerShellCommand {
            sent,
            refused: None,
            output: None,
        },
    );
    let mut answer = String::new();
    BufReader::new(sender)
        .read_line(&mut answer)
        .expect("the compositor answers");

    assert_eq!(
        answer,
        "{\"type\":\"system_reply\",\"id\":1,\"reply\":{\"kind\":\"sent\"}}\n"
    );
}
