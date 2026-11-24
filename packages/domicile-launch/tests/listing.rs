//! Tests for how `domicile list-*` prints what the desktop said.

use std::path::Path;

use domicile_launch::listing::{
    agents_table, bindings_table, displays_table, inputs_table, log_levels_table,
    shell_commands_table, status_table, windows_table,
};
use domicile_launch::paint::Paint;
use domicile_protocol::{
    AdaptiveSync, Capturing, CapturingKind, DesktopStatus, Devices, DisplayHdr, DisplayInfo,
    DisplayTransform, InputConnection, InputKind, ListedDisplay, ListedInput, ListedWindow,
    LogLevel, LogLevels, ShellBinding, ShellCommandHelp, Subsystem, Theme, WindowKind,
};

#[test]
fn each_display_prints_every_name_sleep_displays_takes() {
    let laptop = ListedDisplay {
        display: DisplayInfo {
            name: "drm-1".to_string(),
            position: [0, 0],
            size: [1128, 752],
            scale: 2,
            mode: [2256, 1504],
            refresh_mhz: 59_999,
            adaptive_sync: AdaptiveSync::Off,
            hdr: DisplayHdr::Unsupported,
            peak_luminance: 0,
            sdr_white: 0,
            transform: DisplayTransform::Normal,
        },
        names: vec![
            "drm-1".to_string(),
            "eDP-1".to_string(),
            "BOE NE135A1M-NY1".to_string(),
        ],
        lit: true,
    };
    let dock = ListedDisplay {
        display: DisplayInfo {
            name: "drm-2".to_string(),
            position: [1128, 0],
            size: [1080, 1920],
            refresh_mhz: 0,
            transform: DisplayTransform::Rotate90,
            hdr: DisplayHdr::On,
            ..laptop.display.clone()
        },
        names: vec!["drm-2".to_string()],
        lit: false,
    };

    assert_eq!(
        displays_table(Paint::PLAIN, &[laptop, dock]),
        "\
drm-1  ● lit
  names   drm-1, eDP-1, BOE NE135A1M-NY1
  mode    2256x1504 @ 59.999 Hz
  layout  1128x752 at 0,0 · scale 2 · normal
  color   HDR unsupported · adaptive sync off

drm-2  ○ off
  names   drm-2
  mode    2256x1504
  layout  1080x1920 at 1128,0 · scale 2 · rotate-90
  color   HDR on · adaptive sync off
"
    );
}

#[test]
fn windows_print_as_one_table_whoever_draws_them() {
    let editor = ListedWindow {
        id: "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA".to_string(),
        kind: WindowKind::Native,
        title: "notes.org".to_string(),
        app: Some("emacs".to_string()),
        pid: Some(4242),
        size: Some([640.0, 480.5]),
        focused: true,
        urgent: false,
        url: None,
        private: false,
        engine_id: None,
        views: Vec::new(),
    };
    let terminal = ListedWindow {
        id: "nW1zT5yB8vC2xF6hJ9pL4sR0gAkD3mQ7".to_string(),
        title: String::new(),
        app: None,
        pid: Some(7),
        focused: false,
        urgent: true,
        ..editor.clone()
    };
    let mail = ListedWindow {
        id: "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".to_string(),
        kind: WindowKind::Browser,
        title: "Inbox".to_string(),
        app: Some("mail".to_string()),
        pid: None,
        size: None,
        focused: false,
        urgent: false,
        url: Some("https://mail.example/".to_string()),
        private: true,
        engine_id: Some("3".to_string()),
        views: Vec::new(),
    };

    assert_eq!(
        windows_table(Paint::PLAIN, &[editor, terminal, mail]),
        "\
ID                                KIND     APP    PID   SIZE     TITLE
kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA  native   emacs  4242  640x481  notes.org ● focused
nW1zT5yB8vC2xF6hJ9pL4sR0gAkD3mQ7  native   -      7     640x481  - ▲ urgent
Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE  browser  mail   -     -        Inbox private
"
    );
}

#[test]
fn no_windows_prints_the_header_alone() {
    assert_eq!(
        windows_table(Paint::PLAIN, &[]),
        "ID  KIND  APP  PID  SIZE  TITLE\n"
    );
}

#[test]
fn the_log_levels_print_one_line_for_everything_and_one_per_subsystem() {
    assert_eq!(
        log_levels_table(Paint::PLAIN, &LogLevels::default()),
        "everything  as it started\n"
    );
    assert_eq!(
        log_levels_table(
            Paint::PLAIN,
            &LogLevels {
                all: Some(LogLevel::Debug),
                subsystems: [
                    (Subsystem::Input, LogLevel::Trace),
                    (Subsystem::Notifications, LogLevel::Info)
                ]
                .into(),
            }
        ),
        "\
everything     debug
input          trace
notifications  info
"
    );
}

#[test]
fn the_status_prints_one_line_per_question() {
    let status = DesktopStatus {
        theme: Theme::Dark,
        locked: false,
        keymap: Some("dvorak".to_string()),
        screens_off: false,
        held_awake_by: vec!["Firefox".to_string(), "mpv".to_string()],
        capturing: vec![Capturing {
            id: 2,
            app_id: "org.example.Remote".to_string(),
            kind: CapturingKind::InputCapture {
                devices: Devices::default(),
            },
        }],
    };
    assert_eq!(
        status_table(Paint::PLAIN, Path::new("/desk/shell.js"), &status),
        "\
shell       /desk/shell.js
theme       dark
keymap      dvorak
locked      no
screens     lit
held awake  Firefox, mpv
capturing   org.example.Remote (input_capture)
"
    );
    assert_eq!(
        status_table(
            Paint::PLAIN,
            Path::new("/desk/shell.js"),
            &DesktopStatus {
                locked: true,
                keymap: None,
                screens_off: true,
                held_awake_by: Vec::new(),
                capturing: Vec::new(),
                ..status
            }
        ),
        "\
shell       /desk/shell.js
theme       dark
keymap      -
locked      yes
screens     off
held awake  -
capturing   -
"
    );
}

#[test]
fn the_shells_commands_print_with_their_usage_lined_up() {
    let help = |usage: &str, description: &str| ShellCommandHelp {
        usage: usage.to_string(),
        description: description.to_string(),
    };
    assert_eq!(
        shell_commands_table(
            Paint::PLAIN,
            &[
                help("focus left|right|up|down", "Move focus."),
                help("lock", "Lock the desktop."),
            ]
        ),
        "\
focus left|right|up|down  Move focus.
lock                      Lock the desktop.
"
    );
    assert_eq!(
        shell_commands_table(Paint::PLAIN, &[]),
        "The shell describes no commands.\n"
    );
}

#[test]
fn the_shells_bindings_print_mode_by_mode() {
    let binding = |mode: &str, chord: &str, action: &str| ShellBinding {
        mode: mode.to_string(),
        chord: chord.to_string(),
        action: action.to_string(),
    };
    assert_eq!(
        bindings_table(
            Paint::PLAIN,
            &[
                binding("default", "Meta+Left", "send-shell focus left"),
                binding("default", "Meta+r", "mode resize"),
                binding("resize", "Escape", "mode default"),
            ]
        ),
        "\
default
  Meta+Left  send-shell focus left
  Meta+r     mode resize

resize
  Escape     mode default
"
    );
    assert_eq!(
        bindings_table(Paint::PLAIN, &[]),
        "The shell binds no keys.\n"
    );
}

#[test]
fn the_inputs_print_one_row_each_with_ids_as_lsusb_prints_them() {
    let input =
        |id: i32, kind: InputKind, connection: InputConnection, ids: (u16, u16), name: &str| {
            ListedInput {
                id,
                name: name.to_string(),
                kind,
                connection,
                sys_path: String::new(),
                vendor: ids.0,
                product: ids.1,
            }
        };
    assert_eq!(
        inputs_table(
            Paint::PLAIN,
            &[
                input(
                    4,
                    InputKind::Keyboard,
                    InputConnection::Internal,
                    (1, 1),
                    "AT Translated Set 2 keyboard"
                ),
                input(
                    9,
                    InputKind::Mouse,
                    InputConnection::Bluetooth,
                    (0x046d, 0x4082),
                    "Logitech MX Master 3"
                ),
                input(
                    11,
                    InputKind::PointingStick,
                    InputConnection::Internal,
                    (0, 0),
                    "TPPS/2 IBM TrackPoint"
                ),
            ]
        ),
        "\
ID  KIND            CONNECTION  VENDOR:PRODUCT  NAME
4   keyboard        internal    0001:0001       AT Translated Set 2 keyboard
9   mouse           bluetooth   046d:4082       Logitech MX Master 3
11  pointing-stick  internal    -               TPPS/2 IBM TrackPoint
"
    );
    assert_eq!(
        inputs_table(Paint::PLAIN, &[]),
        "ID  KIND  CONNECTION  VENDOR:PRODUCT  NAME\n"
    );
}

#[test]
fn agents_print_those_in_then_those_remembered() {
    use domicile_protocol::{
        AgentReach, AgentWindow, ConnectedAgent, KnownAgents, RememberedAgent,
    };
    let printed = agents_table(
        Paint::PLAIN,
        &KnownAgents {
            connected: vec![ConnectedAgent {
                session: 12,
                agent: "Claude Code".into(),
                reach: AgentReach::Windows {
                    windows: vec![AgentWindow {
                        id: "kD3m".into(),
                        kind: WindowKind::Native,
                        title: "Notes".into(),
                        app: None,
                    }],
                },
            }],
            remembered: vec![RememberedAgent {
                agent: "Codex".into(),
                last_used_ms: 0,
            }],
        },
    );
    assert_eq!(
        printed,
        "SESSION  STATE       REACH  AGENT\n\
         12       ● in        kD3m   Claude Code\n\
         -        remembered  desk   Codex\n"
    );
}

#[test]
fn on_a_terminal_states_are_colored_and_detail_dimmed() {
    let window = ListedWindow {
        id: "kD3m".to_string(),
        kind: WindowKind::Native,
        title: "notes.org".to_string(),
        app: None,
        pid: None,
        size: None,
        focused: true,
        urgent: false,
        private: false,
        url: None,
        engine_id: None,
        views: Vec::new(),
    };
    let table = windows_table(Paint::COLOR, &[window]);
    assert_eq!(
        table.lines().nth(1).expect("a row"),
        "\x1b[2mkD3m\x1b[0m  native  \x1b[2m-\x1b[0m    \x1b[2m-\x1b[0m    \x1b[2m-\x1b[0m     notes.org \x1b[32m● focused\x1b[0m"
    );
    assert!(table.starts_with("\x1b[1mID\x1b[0m"), "{table:?}");
}
