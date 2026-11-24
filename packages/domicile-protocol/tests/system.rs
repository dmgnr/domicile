//! Wire shapes for the shell's system access: files, processes and watches.
//!
//! Pinned as JSON because the SDK hard-codes them. See
//! `docs/SHELL-SYSTEM-ACCESS.md`.

use std::collections::BTreeMap;

use domicile_protocol::{
    Bus, ChromeMessage, DirEntry, FileType, HostMessage, InhibitorAction, KeymapChoice,
    ListedKeymap, PreviewedWindow, ResizeEdges, Scale, ShellBinding, ShellCommandHelp, Signal,
    Stream, SystemEnd, SystemError, SystemErrorKind, SystemEvent, SystemReply, SystemRequest,
    UnlockRefusal, WindowRequest, WindowState,
};

fn chrome(json: &str) -> ChromeMessage {
    serde_json::from_str(json).expect("a chrome message")
}

fn host(message: &HostMessage) -> String {
    serde_json::to_string(message).expect("it serializes")
}

#[test]
fn file_calls_name_a_path() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":1,"request":{"call":"read_file","path":"/sys/x"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 1,
            request: SystemRequest::ReadFile {
                path: "/sys/x".into(),
                offset: 0,
                length: None,
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":1,"request":{"call":"read_file","path":"a","offset":10,"length":4}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 1,
            request: SystemRequest::ReadFile {
                path: "a".into(),
                offset: 10,
                length: Some(4),
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":2,"request":{"call":"write_file","path":"a","data":"aGk=","atomic":true}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 2,
            request: SystemRequest::WriteFile {
                path: "a".into(),
                data: "aGk=".into(),
                atomic: true,
            },
        }
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":3,"request":{"call":"read_dir","path":"/"}}"#),
        ChromeMessage::SystemRequest {
            id: 3,
            request: SystemRequest::ReadDir { path: "/".into() },
        }
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":4,"request":{"call":"stat","path":"/"}}"#),
        ChromeMessage::SystemRequest {
            id: 4,
            request: SystemRequest::Stat { path: "/".into() },
        }
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":5,"request":{"call":"create_dir","path":"new"}}"#),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::CreateDir { path: "new".into() },
        }
    );
}

#[test]
fn a_watch_is_started_and_stopped_by_its_id() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":5,"request":{"call":"watch","path":"/tmp"}}"#),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::Watch {
                path: "/tmp".into()
            },
        }
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":5,"request":{"call":"unwatch"}}"#),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::Unwatch,
        }
    );
}

#[test]
fn a_process_is_an_argv_and_is_driven_by_its_id() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":6,"request":{"call":"spawn","argv":["pactl","subscribe"],"cwd":"/tmp","env":{"LANG":"C"},"stdin":true}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 6,
            request: SystemRequest::Spawn {
                argv: vec!["pactl".into(), "subscribe".into()],
                cwd: Some("/tmp".into()),
                env: BTreeMap::from([("LANG".into(), "C".into())]),
                stdin: true,
            },
        }
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":6,"request":{"call":"stdin","data":"aGk="}}"#),
        ChromeMessage::SystemRequest {
            id: 6,
            request: SystemRequest::Stdin {
                data: "aGk=".into()
            },
        }
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":6,"request":{"call":"close_stdin"}}"#),
        ChromeMessage::SystemRequest {
            id: 6,
            request: SystemRequest::CloseStdin,
        }
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":6,"request":{"call":"kill","signal":"term"}}"#),
        ChromeMessage::SystemRequest {
            id: 6,
            request: SystemRequest::Kill {
                signal: Signal::Term
            },
        }
    );
}

/// `cwd` and `env` may be left out; the process then runs in the home with the
/// compositor's environment.
#[test]
fn a_spawn_needs_only_its_argv() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":7,"request":{"call":"spawn","argv":["true"]}}"#),
        ChromeMessage::SystemRequest {
            id: 7,
            request: SystemRequest::Spawn {
                argv: vec!["true".into()],
                cwd: None,
                env: BTreeMap::new(),
                stdin: false,
            },
        }
    );
}

#[test]
fn replies_carry_the_requests_id() {
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 1,
            reply: SystemReply::Read {
                data: "aGk=".into()
            },
        }),
        r#"{"type":"system_reply","id":1,"reply":{"kind":"read","data":"aGk="}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 2,
            reply: SystemReply::Written,
        }),
        r#"{"type":"system_reply","id":2,"reply":{"kind":"written"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 5,
            reply: SystemReply::Created,
        }),
        r#"{"type":"system_reply","id":5,"reply":{"kind":"created"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 3,
            reply: SystemReply::Entries {
                entries: vec![DirEntry {
                    name: "BAT0".into(),
                    file_type: FileType::Symlink,
                }],
            },
        }),
        r#"{"type":"system_reply","id":3,"reply":{"kind":"entries","entries":[{"name":"BAT0","file_type":"symlink"}]}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 4,
            reply: SystemReply::Stat {
                file_type: FileType::Directory,
                size: 4096,
                modified_ms: Some(1_700_000_000_000),
                real_path: Some("/home/me".into()),
            },
        }),
        r#"{"type":"system_reply","id":4,"reply":{"kind":"stat","file_type":"directory","size":4096,"modified_ms":1700000000000,"real_path":"/home/me"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 6,
            reply: SystemReply::Started,
        }),
        r#"{"type":"system_reply","id":6,"reply":{"kind":"started"}}"#
    );
}

#[test]
fn a_failure_says_what_kind_it_was() {
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 1,
            reply: SystemReply::Failed {
                error: SystemError {
                    kind: SystemErrorKind::NotFound,
                    message: "No such file or directory (os error 2)".into(),
                },
            },
        }),
        r#"{"type":"system_reply","id":1,"reply":{"kind":"failed","error":{"kind":"not_found","message":"No such file or directory (os error 2)"}}}"#
    );
}

#[test]
fn a_stream_sends_events_then_one_end() {
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 6,
            event: SystemEvent::Output {
                stream: Stream::Stdout,
                data: "aGk=".into(),
            },
        }),
        r#"{"type":"system_event","id":6,"event":{"kind":"output","stream":"stdout","data":"aGk="}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 5,
            event: SystemEvent::Changed {
                path: "/tmp/a".into()
            },
        }),
        r#"{"type":"system_event","id":5,"event":{"kind":"changed","path":"/tmp/a"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemEnd {
            id: 6,
            end: SystemEnd::Exited {
                code: None,
                signal: Some(15),
            },
        }),
        r#"{"type":"system_end","id":6,"end":{"kind":"exited","code":null,"signal":15}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemEnd {
            id: 5,
            end: SystemEnd::Stopped,
        }),
        r#"{"type":"system_end","id":5,"end":{"kind":"stopped"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemEnd {
            id: 5,
            end: SystemEnd::Failed {
                error: SystemError {
                    kind: SystemErrorKind::Other,
                    message: "the watch broke".into(),
                },
            },
        }),
        r#"{"type":"system_end","id":5,"end":{"kind":"failed","error":{"kind":"other","message":"the watch broke"}}}"#
    );
}

/// D-Bus bodies cross as JSON text, read against the D-Bus signature beside
/// them, so this crate stays serde-only.
#[test]
fn a_d_bus_call_names_its_method_and_carries_a_typed_body() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":8,"request":{"call":"dbus_call","bus":"system","destination":"org.freedesktop.UPower","path":"/org/freedesktop/UPower/devices/DisplayDevice","interface":"org.freedesktop.DBus.Properties","member":"GetAll","signature":"s","body":"[\"org.freedesktop.UPower.Device\"]"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 8,
            request: SystemRequest::DbusCall {
                bus: Bus::System,
                destination: "org.freedesktop.UPower".into(),
                path: "/org/freedesktop/UPower/devices/DisplayDevice".into(),
                interface: "org.freedesktop.DBus.Properties".into(),
                member: "GetAll".into(),
                signature: "s".into(),
                body: r#"["org.freedesktop.UPower.Device"]"#.into(),
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 8,
            reply: SystemReply::Returned {
                signature: "a{sv}".into(),
                body: "[{}]".into(),
            },
        }),
        r#"{"type":"system_reply","id":8,"reply":{"kind":"returned","signature":"a{sv}","body":"[{}]"}}"#
    );
}

/// A match names any of the four fields a signal is routed by; the rest are
/// left open.
#[test]
fn a_d_bus_match_streams_the_signals_it_names() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":9,"request":{"call":"dbus_match","bus":"session","interface":"org.freedesktop.DBus.Properties","member":"PropertiesChanged"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 9,
            request: SystemRequest::DbusMatch {
                bus: Bus::Session,
                sender: None,
                path: None,
                interface: Some("org.freedesktop.DBus.Properties".into()),
                member: Some("PropertiesChanged".into()),
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 9,
            event: SystemEvent::Signal {
                sender: ":1.4".into(),
                path: "/org/mpris/MediaPlayer2".into(),
                interface: "org.freedesktop.DBus.Properties".into(),
                member: "PropertiesChanged".into(),
                signature: "sa{sv}as".into(),
                body: r#"["org.mpris.MediaPlayer2.Player",{},[]]"#.into(),
            },
        }),
        r#"{"type":"system_event","id":9,"event":{"kind":"signal","sender":":1.4","path":"/org/mpris/MediaPlayer2","interface":"org.freedesktop.DBus.Properties","member":"PropertiesChanged","signature":"sa{sv}as","body":"[\"org.mpris.MediaPlayer2.Player\",{},[]]"}}"#
    );
}

/// A picker previews a window it cannot see on the frozen desk: a client's
/// window by host app id, or a browser window by the engine's id.
#[test]
fn a_window_preview_is_answered_with_its_frame() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":12,"request":{"call":"preview_window","window":{"type":"app","id":"app-3"}}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 12,
            request: SystemRequest::PreviewWindow {
                window: PreviewedWindow::App { id: "app-3".into() },
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":13,"request":{"call":"preview_window","window":{"type":"browser","id":"7"}}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 13,
            request: SystemRequest::PreviewWindow {
                window: PreviewedWindow::Browser { id: "7".into() },
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 12,
            reply: SystemReply::Preview {
                frame: "data:image/png;base64,AA==".into(),
            },
        }),
        r#"{"type":"system_reply","id":12,"reply":{"kind":"preview","frame":"data:image/png;base64,AA=="}}"#
    );
}

/// Without a file the shell's dialog picks the area; with one the whole desk
/// is written there. Either way the reply names the PNG.
#[test]
fn a_screenshot_is_answered_with_where_it_was_saved() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":10,"request":{"call":"screenshot"}}"#),
        ChromeMessage::SystemRequest {
            id: 10,
            request: SystemRequest::Screenshot { file: None },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":11,"request":{"call":"screenshot","file":"/tmp/shot.png"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 11,
            request: SystemRequest::Screenshot {
                file: Some("/tmp/shot.png".into())
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 10,
            reply: SystemReply::Saved {
                path: "/home/me/Pictures/Screenshots/a.png".into(),
            },
        }),
        r#"{"type":"system_reply","id":10,"reply":{"kind":"saved","path":"/home/me/Pictures/Screenshots/a.png"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 10,
            reply: SystemReply::Copied,
        }),
        r#"{"type":"system_reply","id":10,"reply":{"kind":"copied"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 10,
            reply: SystemReply::Failed {
                error: SystemError {
                    kind: SystemErrorKind::Canceled,
                    message: "the dialog was dismissed".into(),
                },
            },
        }),
        r#"{"type":"system_reply","id":10,"reply":{"kind":"failed","error":{"kind":"canceled","message":"the dialog was dismissed"}}}"#
    );
}

/// The browser ends a call whose compositor exited in these words. See
/// "A compositor restart" in docs/architecture/ENGINE-FORK.md.
#[test]
fn a_call_whose_compositor_exited_ends_with_compositor_gone() {
    assert_eq!(
        host(&HostMessage::SystemEnd {
            id: 3,
            end: SystemEnd::Failed {
                error: SystemError {
                    kind: SystemErrorKind::CompositorGone,
                    message: "the compositor exited".into(),
                },
            },
        }),
        r#"{"type":"system_end","id":3,"end":{"kind":"failed","error":{"kind":"compositor_gone","message":"the compositor exited"}}}"#
    );
}

/// `domicile send-shell` sends a command to every page listening for one.
#[test]
fn a_shell_command_goes_to_each_page_that_listens_for_one() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":12,"request":{"call":"shell_commands"}}"#),
        ChromeMessage::SystemRequest {
            id: 12,
            request: SystemRequest::ShellCommands {
                commands: Vec::new(),
                bindings: Vec::new(),
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":12,"request":{"call":"shell_commands","commands":[{"usage":"lock","description":"Lock the desktop."}]}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 12,
            request: SystemRequest::ShellCommands {
                commands: vec![ShellCommandHelp {
                    usage: "lock".into(),
                    description: "Lock the desktop.".into(),
                }],
                bindings: Vec::new(),
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":13,"request":{"call":"answer_shell_command","sent":4,"refused":"no command `x`"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 13,
            request: SystemRequest::AnswerShellCommand {
                sent: 4,
                refused: Some("no command `x`".into()),
                output: None,
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":1,"request":{"call":"send_shell","command":["focus","right"]}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 1,
            request: SystemRequest::SendShell {
                command: vec!["focus".into(), "right".into()],
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 1,
            reply: SystemReply::Sent { output: None },
        }),
        r#"{"type":"system_reply","id":1,"reply":{"kind":"sent"}}"#
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 1,
            reply: SystemReply::Sent {
                output: Some("[]".into())
            },
        }),
        r#"{"type":"system_reply","id":1,"reply":{"kind":"sent","output":"[]"}}"#
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":12,"request":{"call":"shell_commands","bindings":[{"mode":"default","chord":"Meta+l","action":"send-shell lock"}]}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 12,
            request: SystemRequest::ShellCommands {
                commands: Vec::new(),
                bindings: vec![ShellBinding {
                    mode: "default".into(),
                    chord: "Meta+l".into(),
                    action: "send-shell lock".into(),
                }],
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 12,
            event: SystemEvent::ShellCommand {
                command: vec!["focus".into(), "right".into()],
                sent: 4,
            },
        }),
        r#"{"type":"system_event","id":12,"event":{"kind":"shell_command","command":["focus","right"],"sent":4}}"#
    );
}

/// A page hears when nobody has been at the desktop for a time it chose, and
/// when somebody is again. See `docs/IDLE.md`.
#[test]
fn a_page_hears_the_desktop_go_idle_after_a_time_it_chose() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":13,"request":{"call":"idle_after","seconds":120}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 13,
            request: SystemRequest::IdleAfter { seconds: 120 },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":14,"request":{"call":"idle_before_blanking","seconds":30}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 14,
            request: SystemRequest::IdleBeforeBlanking { seconds: 30 },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 13,
            event: SystemEvent::Idle { idle: true },
        }),
        r#"{"type":"system_event","id":13,"event":{"kind":"idle","idle":true}}"#
    );
}

/// A lock screen hears why each passphrase did not open the desktop.
#[test]
fn a_refused_unlock_goes_to_each_page_that_listens_for_one() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":13,"request":{"call":"unlock_refusals"}}"#),
        ChromeMessage::SystemRequest {
            id: 13,
            request: SystemRequest::UnlockRefusals,
        }
    );
    for (refusal, wire) in [
        (UnlockRefusal::WrongPassphrase, "wrong_passphrase"),
        (UnlockRefusal::Unverifiable, "unverifiable"),
        (UnlockRefusal::TooSoon, "too_soon"),
    ] {
        assert_eq!(
            host(&HostMessage::SystemEvent {
                id: 13,
                event: SystemEvent::UnlockRefused {
                    refusal,
                    failures: 3,
                    retry_in_ms: 5000,
                },
            }),
            format!(
                r#"{{"type":"system_event","id":13,"event":{{"kind":"unlock_refused","refusal":"{wire}","failures":3,"retry_in_ms":5000}}}}"#
            )
        );
    }
}
/// The shell sets a window's `xdg_toplevel` states and hears what its client
/// asks for.
#[test]
fn a_link_goes_to_the_page_that_claims_its_scheme() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":3,"request":{"call":"claim_links","schemes":["mailto"]}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 3,
            request: SystemRequest::ClaimLinks {
                schemes: vec!["mailto".into()],
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":4,"request":{"call":"open_link","url":"mailto:a@example.com"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 4,
            request: SystemRequest::OpenLink {
                url: "mailto:a@example.com".into(),
                app_id: None,
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 3,
            event: SystemEvent::Link {
                url: "mailto:a@example.com".into(),
                app_id: Some("org.gnome.Evince".into()),
            },
        }),
        r#"{"type":"system_event","id":3,"event":{"kind":"link","url":"mailto:a@example.com","app_id":"org.gnome.Evince"}}"#
    );
}

#[test]
fn the_shell_sets_window_states_and_hears_what_clients_ask_for() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":3,"request":{"call":"set_window_states","app_id":"app-1","states":["tiled_left","tiled_right","tiled_top","tiled_bottom","maximized","fullscreen","resizing"]}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 3,
            request: SystemRequest::SetWindowStates {
                app_id: "app-1".into(),
                states: vec![
                    WindowState::TiledLeft,
                    WindowState::TiledRight,
                    WindowState::TiledTop,
                    WindowState::TiledBottom,
                    WindowState::Maximized,
                    WindowState::Fullscreen,
                    WindowState::Resizing,
                ],
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 3,
            reply: SystemReply::Set,
        }),
        r#"{"type":"system_reply","id":3,"reply":{"kind":"set"}}"#
    );
    assert_eq!(
        chrome(r#"{"type":"system_request","id":4,"request":{"call":"window_requests"}}"#),
        ChromeMessage::SystemRequest {
            id: 4,
            request: SystemRequest::WindowRequests,
        }
    );
    for (request, json) in [
        (WindowRequest::Maximize, r#"{"kind":"maximize"}"#),
        (WindowRequest::Unmaximize, r#"{"kind":"unmaximize"}"#),
        (
            WindowRequest::Fullscreen { display: None },
            r#"{"kind":"fullscreen","display":null}"#,
        ),
        (
            WindowRequest::Fullscreen {
                display: Some("left".into()),
            },
            r#"{"kind":"fullscreen","display":"left"}"#,
        ),
        (WindowRequest::Unfullscreen, r#"{"kind":"unfullscreen"}"#),
        (WindowRequest::Minimize, r#"{"kind":"minimize"}"#),
        (WindowRequest::Move, r#"{"kind":"move"}"#),
        (
            WindowRequest::Resize {
                edges: ResizeEdges::BottomRight,
            },
            r#"{"kind":"resize","edges":"bottom_right"}"#,
        ),
    ] {
        assert_eq!(
            host(&HostMessage::SystemEvent {
                id: 4,
                event: SystemEvent::WindowRequest {
                    app_id: "app-1".into(),
                    request,
                },
            }),
            format!(
                r#"{{"type":"system_event","id":4,"event":{{"kind":"window_request","app_id":"app-1","request":{json}}}}}"#
            )
        );
    }
}

/// The shell adds a monitor with no connector to cast the desk to a TV.
#[test]
fn the_shell_adds_a_virtual_monitor() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"virtual_monitor","name":"Living Room TV","width":1920,"height":1080,"refresh_mhz":60000}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::VirtualMonitor {
                name: "Living Room TV".into(),
                width: 1920,
                height: 1080,
                refresh_mhz: 60_000,
                // Left out, so one device pixel a logical one.
                scale: Scale::ONE,
            },
        }
    );
    assert_eq!(
        host(&HostMessage::SystemReply {
            id: 5,
            reply: SystemReply::VirtualMonitor {
                output: "virtual-1".into(),
            },
        }),
        r#"{"type":"system_reply","id":5,"reply":{"kind":"virtual_monitor","output":"virtual-1"}}"#
    );
}

/// The shell resizes a virtual monitor it added, under the id that added it.
#[test]
fn the_shell_resizes_a_virtual_monitor() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"resize_virtual_monitor","width":1280,"height":720,"refresh_mhz":30000}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::ResizeVirtualMonitor {
                width: 1280,
                height: 720,
                refresh_mhz: 30_000,
                scale: Scale::ONE,
            },
        }
    );
}

/// A virtual monitor stands in for a window on another desktop, which can be
/// at any density, such as Windows at 150%.
#[test]
fn a_virtual_monitor_takes_a_fractional_scale() {
    let at = |scale: f64| Scale::try_from(scale).expect("a scale");
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"virtual_monitor","name":"Pane","width":806,"height":539,"refresh_mhz":60000,"scale":1.25}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::VirtualMonitor {
                name: "Pane".into(),
                width: 806,
                height: 539,
                refresh_mhz: 60_000,
                scale: at(1.25),
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"resize_virtual_monitor","width":1280,"height":720,"refresh_mhz":60000,"scale":1.5}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::ResizeVirtualMonitor {
                width: 1280,
                height: 720,
                refresh_mhz: 60_000,
                scale: at(1.5),
            },
        }
    );
}

/// A scale no monitor can have is no request at all.
#[test]
fn a_virtual_monitor_refuses_a_scale_of_nothing() {
    for scale in [0.0, -1.5, f64::INFINITY] {
        assert!(Scale::try_from(scale).is_err(), "{scale}");
    }
    let resize = |scale: &str| {
        serde_json::from_str::<ChromeMessage>(&format!(
            r#"{{"type":"system_request","id":5,"request":{{"call":"resize_virtual_monitor","width":1280,"height":720,"refresh_mhz":60000,"scale":{scale}}}}}"#
        ))
    };
    assert!(resize("0").is_err());
    assert!(resize("-2").is_err());
    assert!(resize("2").is_ok());
}

/// The shell hears what holds the desktop awake.
#[test]
fn the_shell_hears_what_holds_the_desktop_awake() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":5,"request":{"call":"idle_holds"}}"#),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::IdleHolds,
        }
    );
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 5,
            event: SystemEvent::IdleHolds {
                holders: vec!["mpv".into(), "slack".into()],
            },
        }),
        r#"{"type":"system_event","id":5,"event":{"kind":"idle_holds","holders":["mpv","slack"]}}"#
    );
}

/// The shell hears the keymaps the desktop switches between, and switches it.
#[test]
fn the_shell_hears_the_keymaps_and_switches_between_them() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":5,"request":{"call":"keymaps"}}"#),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::Keymaps,
        }
    );
    assert_eq!(
        host(&HostMessage::SystemEvent {
            id: 5,
            event: SystemEvent::Keymaps {
                keymaps: vec![
                    ListedKeymap {
                        name: "dvp".into(),
                        description: Some("English (programmer Dvorak)".into()),
                    },
                    ListedKeymap {
                        name: "odd".into(),
                        description: None,
                    },
                ],
                active: "odd".into(),
            },
        }),
        r#"{"type":"system_event","id":5,"event":{"kind":"keymaps","keymaps":[{"name":"dvp","description":"English (programmer Dvorak)"},{"name":"odd"}],"active":"odd"}}"#
    );
    for (json, keymap) in [
        (r#"{"kind":"next"}"#, KeymapChoice::Next),
        (
            r#"{"kind":"named","name":"us"}"#,
            KeymapChoice::Named { name: "us".into() },
        ),
    ] {
        assert_eq!(
            chrome(&format!(
                r#"{{"type":"system_request","id":6,"request":{{"call":"select_keymap","keymap":{json}}}}}"#
            )),
            ChromeMessage::SystemRequest {
                id: 6,
                request: SystemRequest::SelectKeymap { keymap },
            }
        );
    }
}

/// The shell switches the keyboard window's shortcuts inhibitor, as sway's
/// `seat shortcuts_inhibitor` does.
#[test]
fn the_shell_switches_the_shortcuts_inhibitor() {
    for (wire, action) in [
        ("activate", InhibitorAction::Activate),
        ("deactivate", InhibitorAction::Deactivate),
        ("toggle", InhibitorAction::Toggle),
    ] {
        assert_eq!(
            chrome(&format!(
                r#"{{"type":"system_request","id":6,"request":{{"call":"shortcuts_inhibitor","action":"{wire}"}}}}"#
            )),
            ChromeMessage::SystemRequest {
                id: 6,
                request: SystemRequest::ShortcutsInhibitor { action },
            }
        );
    }
}

/// `domicile screen-record` asks for a recording. The shell's picker chooses
/// what to record, and the reply names the file once the user stops it.
#[test]
fn a_screen_recording_is_answered_with_where_it_was_saved() {
    assert_eq!(
        chrome(r#"{"type":"system_request","id":12,"request":{"call":"screen_record"}}"#),
        ChromeMessage::SystemRequest {
            id: 12,
            request: SystemRequest::ScreenRecord,
        }
    );
}

/// `domicile sleep-displays` turns every monitor off, and `wake-displays`
/// lights them again.
#[test]
fn the_displays_sleep_and_wake_on_demand() {
    for (call, request) in [
        (
            "sleep_displays",
            SystemRequest::SleepDisplays { display: None },
        ),
        (
            "wake_displays",
            SystemRequest::WakeDisplays { display: None },
        ),
    ] {
        assert_eq!(
            chrome(&format!(
                r#"{{"type":"system_request","id":5,"request":{{"call":"{call}"}}}}"#
            )),
            ChromeMessage::SystemRequest { id: 5, request }
        );
    }
}

/// `domicile sleep-displays DP-1` turns one monitor off, leaving the others.
#[test]
fn one_display_sleeps_and_wakes_by_name() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"sleep_displays","display":"DP-1"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::SleepDisplays {
                display: Some("DP-1".into())
            },
        }
    );
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"wake_displays","display":"DP-1"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::WakeDisplays {
                display: Some("DP-1".into())
            },
        }
    );
}

/// The shell warms every monitor, as a night light does.
#[test]
fn the_shell_sets_the_color_temperature() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"set_color_temperature","kelvin":3400}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::SetColorTemperature {
                kelvin: 3400,
                display: None,
            },
        }
    );
}

/// The shell warms one monitor, leaving the others as they are.
#[test]
fn the_shell_sets_one_displays_color_temperature() {
    assert_eq!(
        chrome(
            r#"{"type":"system_request","id":5,"request":{"call":"set_color_temperature","kelvin":3400,"display":"eDP-2"}}"#
        ),
        ChromeMessage::SystemRequest {
            id: 5,
            request: SystemRequest::SetColorTemperature {
                kelvin: 3400,
                display: Some("eDP-2".into()),
            },
        }
    );
}
