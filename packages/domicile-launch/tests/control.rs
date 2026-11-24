//! Tests for the control socket protocol.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use domicile_host::system::DisplayPower;
use domicile_launch::control::{
    answer, parse_response, AppReuse, Desktop, LoadShell, OpenUrl, Response, Screenshot, SendShell,
    SettingsFiles, Shot,
};
use domicile_launch::extensions::{
    ExtensionSettings, InstalledExtension, SiteAccess, SiteAccessMode,
};
use domicile_launch::history::{BrowsingData, HistoryItem, HistoryQuery};
use domicile_launch::journal::Priority;
use domicile_launch::media_devices::{MediaDevice, MediaDevices, MediaKind};
use domicile_launch::recent_log::Said;
use domicile_launch::shell_path::{Shell, ShellFiles};
use domicile_launch::site_data::SiteData;
use domicile_launch::site_permissions::{Permission, Setting, SitePermission, SiteSettings};
use domicile_protocol::{
    AdaptiveSync, DeskRect, DeskShot, DesktopStatus, DisplayChange, DisplayHdr, DisplayInfo,
    DisplayTransform, EmulatedInput, InputConnection, InputKind, ListedDisplay, ListedInput,
    ListedView, ListedWindow, LogLevel, LogLevels, MonitorInfo, ShellBinding, ShellCommandHelp,
    Subsystem, Theme, WindowAct, WindowKind,
};

#[test]
fn a_desktop_says_which_shell_it_is_running() {
    // Written out rather than serialized from `Request::WhichShell`, so the
    // test checks the wire format rather than `serde` against itself.
    assert_eq!(
        answered(
            "{\"type\":\"which_shell\"}",
            Path::new("/desktops/mine/shell.js"),
            &|_| panic!("a question is answered where it lands, not dialed on"),
        ),
        Response::Shell {
            module: PathBuf::from("/desktops/mine/shell.js"),
            root: PathBuf::from("/desktops/mine"),
            dev_server: false,
        }
    );
}

#[test]
fn a_desktop_says_when_its_shell_comes_from_a_dev_server() {
    // `domicile dev` loads the shell it replaced again from this answer, so
    // it must say where that shell's files come from.
    assert_eq!(
        reply_to(
            "{\"type\":\"which_shell\"}",
            &Desktop {
                shell: &Shell {
                    files: ShellFiles::DevServer,
                    module: PathBuf::from("domicile-dev-shell.js"),
                    root: PathBuf::from("/run/dev.sock"),
                },
                ..nothing_dialed()
            },
        ),
        Response::Shell {
            module: PathBuf::from("/run/dev.sock/domicile-dev-shell.js"),
            root: PathBuf::from("/run/dev.sock"),
            dev_server: true,
        }
    );
}

#[test]
fn a_desktop_told_to_load_a_shell_tells_the_engine_and_says_what_it_serves() {
    // The supervisor forwards this to the engine. The dial is injected so no
    // engine is needed.
    let told = Cell::new(None);
    let answered = answered(
        "{\"type\":\"load_shell\",\"root\":\"/desktops/other\",\"module\":\"shell.js\"}",
        Path::new("/desktops/mine/shell.js"),
        &|shell| {
            told.set(Some(shell.clone()));
            Ok(())
        },
    );

    assert_eq!(
        told.take(),
        Some(Shell {
            root: PathBuf::from("/desktops/other"),
            module: PathBuf::from("shell.js"),
            files: ShellFiles::Directory,
        })
    );
    // Replies with the new shell, as `which-shell` would.
    assert_eq!(
        answered,
        Response::Shell {
            module: PathBuf::from("/desktops/other/shell.js"),
            root: PathBuf::from("/desktops/other"),
            dev_server: false,
        }
    );
}

#[test]
fn a_desktop_told_to_load_a_shell_from_a_dev_server_tells_the_engine_so() {
    // `domicile dev` sends this: the root is the dev server's socket.
    let told = Cell::new(None);
    answered(
        "{\"type\":\"load_shell\",\"root\":\"/run/user/1000/domicile-dev.7.sock\",\
         \"module\":\"domicile-dev-shell.js\",\"dev_server\":true}",
        Path::new("/desktops/mine/shell.js"),
        &|shell| {
            told.set(Some(shell.clone()));
            Ok(())
        },
    );

    assert_eq!(
        told.take(),
        Some(Shell {
            root: PathBuf::from("/run/user/1000/domicile-dev.7.sock"),
            module: PathBuf::from("domicile-dev-shell.js"),
            files: ShellFiles::DevServer,
        })
    );
}

#[test]
fn an_engine_that_refused_the_shell_is_quoted_to_whoever_typed_the_command() {
    // Pass the engine's reason through verbatim; the user cannot see the
    // engine's log.
    let Response::Refused { why } = answered(
        "{\"type\":\"load_shell\",\"root\":\"/desktops/other\",\"module\":\"shell.js\"}",
        Path::new("/desktops/mine/shell.js"),
        &|_| Err("this engine has no shell window to load a shell into".to_string()),
    ) else {
        panic!("an engine that refused the shell is not a desktop that loaded it");
    };
    assert!(
        why.contains("no shell window"),
        "the refusal did not carry the engine's own words: {why}"
    );
}

#[test]
fn a_line_that_is_not_a_request_is_refused_and_quoted_back() {
    // The refusal quotes the line so the client sees what was rejected.
    let Response::Refused { why } =
        answered("{\"type\":\"reboot\"}", Path::new("/shell.js"), &|_| {
            panic!("a line that is not a request reaches no engine")
        })
    else {
        panic!("a request this desktop has never heard of is not a request");
    };
    assert!(
        why.contains("reboot"),
        "the refusal did not quote the line: {why}"
    );
}

#[test]
fn a_desktop_told_to_open_an_address_tells_the_engine() {
    // Forwarded to the engine, like `load_shell`.
    let told = Cell::new(None);
    let answered = answered_opening(
        "{\"type\":\"open_url\",\"url\":\"https://example.com/\"}",
        &|url, profile| {
            told.set(Some((url.to_string(), profile.map(str::to_string))));
            Ok(())
        },
    );

    assert_eq!(
        told.take(),
        Some(("https://example.com/".to_string(), None))
    );
    assert_eq!(answered, Response::Opened);
}

#[test]
fn a_desktop_hands_the_engine_the_profile_an_address_opens_in() {
    let told = Cell::new(None);
    answered_opening(
        "{\"type\":\"open_url\",\"url\":\"https://example.com/\",\"profile\":\"work\"}",
        &|_, profile| {
            told.set(profile.map(str::to_string));
            Ok(())
        },
    );

    assert_eq!(told.take(), Some("work".to_string()));
}

#[test]
fn a_desktop_told_to_run_an_app_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"run_app\",\"root\":\"/opt/notes\",\"module\":\"notes.js\"}",
        &Desktop {
            run_app: &|root, module| {
                *told.borrow_mut() = Some((root.to_path_buf(), module.to_path_buf()));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some((PathBuf::from("/opt/notes"), PathBuf::from("notes.js")))
    );
    assert_eq!(answered, Response::Opened);
}

#[test]
fn a_desktop_told_to_launch_a_program_has_the_compositor_start_it() {
    // Started as the launcher starts an app, whoever asked: an engine's
    // `xdg-open` has none of an app's environment.
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"launch\",\"command\":[\"slack\",\"slack://T1\"]}",
        &Desktop {
            launch: &|command| {
                *told.borrow_mut() = Some(command.to_vec());
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some(vec!["slack".to_string(), "slack://T1".to_string()])
    );
    assert_eq!(answered, Response::Opened);
}

#[test]
fn a_desktop_hands_a_link_to_the_shell_that_claims_it() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"open_link\",\"url\":\"mailto:a@example.com\"}",
        &Desktop {
            open_link: &|url| {
                *told.borrow_mut() = Some(url.to_string());
                Ok(true)
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(told.take(), Some("mailto:a@example.com".to_string()));
    assert_eq!(answered, Response::Opened);
}

#[test]
fn a_link_no_shell_claims_is_unclaimed() {
    let answered = reply_to(
        "{\"type\":\"open_link\",\"url\":\"zoommtg://zoom.us/join\"}",
        &Desktop {
            open_link: &|_| Ok(false),
            ..nothing_dialed()
        },
    );

    assert_eq!(answered, Response::Unclaimed);
}

#[test]
fn a_desktop_told_to_open_an_app_tells_the_engine() {
    let told = Cell::new(None);
    let answered = reply_to(
        "{\"type\":\"open_app\",\"url\":\"https://example.com/\"}",
        &Desktop {
            open_app: &|url, id, reuse, _| {
                told.set(Some((url.to_string(), id.map(str::to_string), reuse)));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some(("https://example.com/".to_string(), None, AppReuse::New))
    );
    assert_eq!(answered, Response::Opened);
}

#[test]
fn a_desktop_told_to_reuse_an_app_window_tells_the_engine_which() {
    let told = Cell::new(None);
    let answered = reply_to(
        "{\"type\":\"open_app\",\"url\":\"https://example.com/\",\"id\":\"mail\",\
         \"reuse\":\"navigate\"}",
        &Desktop {
            open_app: &|url, id, reuse, _| {
                told.set(Some((url.to_string(), id.map(str::to_string), reuse)));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some((
            "https://example.com/".to_string(),
            Some("mail".to_string()),
            AppReuse::Navigate
        ))
    );
    assert_eq!(answered, Response::Opened);
}

#[test]
fn an_engine_that_would_not_open_the_address_is_quoted() {
    let Response::Refused { why } = answered_opening(
        "{\"type\":\"open_url\",\"url\":\"https://example.com/\"}",
        &|_, _| Err("this engine has no shell page to open it in".to_string()),
    ) else {
        panic!("an engine that refused the address is not one that opened it");
    };
    assert!(
        why.contains("no shell page"),
        "the refusal did not carry the engine's own words: {why}"
    );
}

#[test]
fn a_desktop_told_to_take_a_screenshot_tells_the_compositor_and_says_where_it_is() {
    let told = Cell::new(None);
    let answered = answered_capturing(
        "{\"type\":\"screenshot\",\"file\":\"/home/me/shot.png\"}",
        &|file| {
            told.set(Some(file.map(Path::to_path_buf)));
            Ok(Shot::Saved(PathBuf::from("/home/me/shot.png")))
        },
    );

    assert_eq!(told.take(), Some(Some(PathBuf::from("/home/me/shot.png"))));
    assert_eq!(
        answered,
        Response::Captured {
            file: PathBuf::from("/home/me/shot.png")
        }
    );
}

#[test]
fn a_screenshot_with_no_file_is_the_shells_and_the_answer_is_where_it_saved_it() {
    let told = Cell::new(None);
    let answered = answered_capturing("{\"type\":\"screenshot\"}", &|file| {
        told.set(Some(file.map(Path::to_path_buf)));
        Ok(Shot::Saved(PathBuf::from(
            "/home/me/Pictures/Screenshots/Screenshot.png",
        )))
    });

    assert_eq!(told.take(), Some(None));
    assert_eq!(
        answered,
        Response::Captured {
            file: PathBuf::from("/home/me/Pictures/Screenshots/Screenshot.png")
        }
    );
}

#[test]
fn a_screenshot_the_user_copied_says_so() {
    assert_eq!(
        answered_capturing("{\"type\":\"screenshot\"}", &|_| Ok(Shot::Copied)),
        Response::Copied
    );
}

#[test]
fn a_screenshot_the_user_dismissed_is_canceled() {
    assert_eq!(
        answered_capturing("{\"type\":\"screenshot\"}", &|_| Ok(Shot::Canceled)),
        Response::Canceled
    );
}

#[test]
fn a_compositor_that_could_not_take_the_screenshot_is_quoted() {
    let Response::Refused { why } = answered_capturing(
        "{\"type\":\"screenshot\",\"file\":\"/home/me/shot.png\"}",
        &|_| Err("could not write /home/me/shot.png".to_string()),
    ) else {
        panic!("a compositor that refused the screenshot is not one that took it");
    };
    assert!(
        why.contains("could not write"),
        "the refusal did not carry the compositor's own words: {why}"
    );
}

#[test]
fn a_screen_recording_answers_with_its_file_once_it_stops() {
    assert_eq!(
        reply_to(
            "{\"type\":\"screen_record\"}",
            &Desktop {
                record: &|| Ok(Some(PathBuf::from("/home/me/Videos/rec.webm"))),
                ..nothing_dialed()
            },
        ),
        Response::Captured {
            file: PathBuf::from("/home/me/Videos/rec.webm")
        }
    );
}

#[test]
fn a_screen_recording_dismissed_or_discarded_is_canceled() {
    assert_eq!(
        reply_to(
            "{\"type\":\"screen_record\"}",
            &Desktop {
                record: &|| Ok(None),
                ..nothing_dialed()
            },
        ),
        Response::Canceled
    );
}

#[test]
fn a_desktop_told_to_send_the_shell_a_command_tells_the_compositor() {
    let told = Cell::new(None);
    let answered = answered_sending(
        "{\"type\":\"send_shell\",\"command\":[\"focus\",\"right\"]}",
        &|command| {
            told.set(Some(command.to_vec()));
            Ok(Some("[]".to_string()))
        },
    );

    assert_eq!(
        told.take(),
        Some(vec!["focus".to_string(), "right".to_string()])
    );
    // What the shell printed reaches the terminal.
    assert_eq!(
        answered,
        Response::Sent {
            output: Some("[]".to_string())
        }
    );
}

#[test]
fn a_desktop_told_to_sleep_or_wake_the_displays_tells_the_compositor() {
    for (line, power, display) in [
        ("{\"type\":\"sleep_displays\"}", DisplayPower::Asleep, None),
        (
            "{\"type\":\"wake_displays\",\"display\":\"DP-1\"}",
            DisplayPower::Awake,
            Some("DP-1".to_string()),
        ),
    ] {
        let told = RefCell::new(None);
        let answered = reply_to(
            line,
            &Desktop {
                power_displays: &|power, display| {
                    told.replace(Some((power, display.map(str::to_string))));
                    Ok(())
                },
                ..nothing_dialed()
            },
        );

        assert_eq!(told.take(), Some((power, display)));
        assert_eq!(answered, Response::Powered);
    }
}

#[test]
fn a_desktop_asked_its_displays_or_windows_asks_the_compositor() {
    let display = ListedDisplay {
        display: DisplayInfo {
            name: "drm-1".to_string(),
            position: [0, 0],
            size: [1920, 1080],
            scale: 1,
            mode: [1920, 1080],
            refresh_mhz: 60_000,
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: DisplayHdr::Unsupported,
            peak_luminance: 0,
            sdr_white: 0,
            transform: DisplayTransform::Normal,
        },
        names: vec!["drm-1".to_string(), "DP-1".to_string()],
        lit: true,
    };
    let window = ListedWindow {
        id: "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA".to_string(),
        kind: WindowKind::Browser,
        title: "Inbox".to_string(),
        app: None,
        pid: None,
        size: None,
        focused: false,
        urgent: false,
        url: None,
        private: false,
        engine_id: Some("3".to_string()),
        views: Vec::new(),
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"displays\"}",
            &Desktop {
                displays: &|| Ok(vec![display.clone()]),
                ..nothing_dialed()
            },
        ),
        Response::Displays {
            displays: vec![display.clone()]
        }
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"windows\"}",
            &Desktop {
                windows: &|| Ok(vec![window.clone()]),
                ..nothing_dialed()
            },
        ),
        Response::Windows {
            windows: vec![window.clone()]
        }
    );
    let lock = ShellCommandHelp {
        usage: "lock".to_string(),
        description: "Lock the desktop.".to_string(),
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"shell_commands\"}",
            &Desktop {
                shell_commands: &|| Ok(vec![lock.clone()]),
                ..nothing_dialed()
            },
        ),
        Response::ShellCommands {
            commands: vec![lock]
        }
    );
    let binding = ShellBinding {
        mode: "default".to_string(),
        chord: "Meta+l".to_string(),
        action: "send-shell lock".to_string(),
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"shell_bindings\"}",
            &Desktop {
                shell_bindings: &|| Ok(vec![binding.clone()]),
                ..nothing_dialed()
            },
        ),
        Response::ShellBindings {
            bindings: vec![binding]
        }
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"configure_display\",\"display\":\"DP-1\",\"change\":{\"scale\":1.5}}",
            &Desktop {
                configure_display: &|display, change| {
                    assert_eq!(display, "DP-1");
                    assert_eq!(
                        change,
                        &DisplayChange {
                            scale: Some(1.5),
                            ..DisplayChange::default()
                        }
                    );
                    Err("no monitor DP-1 is plugged in".to_string())
                },
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "no monitor DP-1 is plugged in".to_string()
        }
    );
    let set = std::cell::RefCell::new(LogLevels::default());
    let current = || set.borrow().clone();
    let apply = |levels: &LogLevels| {
        *set.borrow_mut() = levels.clone();
        Ok(())
    };
    let desktop = Desktop {
        log_levels: &current,
        set_log_levels: &apply,
        ..nothing_dialed()
    };
    let input_at_trace = LogLevels {
        all: None,
        subsystems: [(Subsystem::Input, LogLevel::Trace)].into(),
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"set_log_level\",\"level\":\"trace\",\"subsystems\":[\"input\"]}",
            &desktop,
        ),
        Response::LogLevels {
            levels: input_at_trace.clone()
        }
    );
    assert_eq!(
        reply_to("{\"type\":\"log_levels\"}", &desktop),
        Response::LogLevels {
            levels: input_at_trace
        }
    );
    assert_eq!(
        reply_to("{\"type\":\"reset_log_levels\"}", &desktop),
        Response::LogLevels {
            levels: LogLevels::default()
        }
    );
    assert_eq!(*set.borrow(), LogLevels::default());
    assert_eq!(
        reply_to(
            "{\"type\":\"lock\"}",
            &Desktop {
                lock: &|| Ok(()),
                ..nothing_dialed()
            },
        ),
        Response::Done
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"act_on_window\",\"id\":\"kD3m\",\"act\":\"close\"}",
            &Desktop {
                act_on_window: &|id, act| {
                    assert_eq!((id, act), ("kD3m", WindowAct::Close));
                    Err("the desktop is locked".to_string())
                },
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "the desktop is locked".to_string()
        }
    );
    let keyboard = ListedInput {
        id: 4,
        name: "AT Translated Set 2 keyboard".to_string(),
        kind: InputKind::Keyboard,
        connection: InputConnection::Internal,
        sys_path: String::new(),
        vendor: 1,
        product: 1,
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"inputs\"}",
            &Desktop {
                inputs: &|| Ok(vec![keyboard.clone()]),
                ..nothing_dialed()
            },
        ),
        Response::Inputs {
            inputs: vec![keyboard]
        }
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"idle_time\"}",
            &Desktop {
                idle_time: &|| Ok(42),
                ..nothing_dialed()
            },
        ),
        Response::IdleTime { seconds: 42 }
    );
    let status = DesktopStatus {
        theme: Theme::Light,
        locked: false,
        keymap: None,
        screens_off: false,
        held_awake_by: Vec::new(),
        capturing: Vec::new(),
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"status\"}",
            &Desktop {
                status: &|| Ok(status.clone()),
                ..nothing_dialed()
            },
        ),
        Response::Status {
            shell: PathBuf::from("/shell.js"),
            status
        }
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"windows\"}",
            &Desktop {
                windows: &|| Err("no compositor".to_string()),
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "no compositor".to_string()
        }
    );
}

#[test]
fn a_desktop_asked_its_monitors_asks_the_compositor() {
    let lit = MonitorInfo {
        names: vec!["drm-1".to_string()],
        hdr: DisplayHdr::On,
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"monitors\"}",
            &Desktop {
                monitors: &|| Ok(vec![lit.clone()]),
                ..nothing_dialed()
            },
        ),
        Response::Monitors {
            monitors: vec![lit.clone()]
        }
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"monitors\"}",
            &Desktop {
                monitors: &|| Err("no compositor".to_string()),
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "no compositor".to_string()
        }
    );
}

#[test]
fn a_compositor_that_did_not_sleep_the_displays_is_quoted() {
    assert_eq!(
        reply_to(
            "{\"type\":\"sleep_displays\"}",
            &Desktop {
                power_displays: &|_, _| Err("no compositor".to_string()),
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "no compositor".to_string()
        }
    );
}

#[test]
fn a_compositor_that_did_not_send_the_command_is_quoted() {
    let Response::Refused { why } = answered_sending(
        "{\"type\":\"send_shell\",\"command\":[\"focus\",\"right\"]}",
        &|_| Err("no page of this desktop listens for commands".to_string()),
    ) else {
        panic!("a compositor that refused the command is not one that sent it");
    };
    assert!(
        why.contains("no page"),
        "the refusal did not carry the compositor's own words: {why}"
    );
}

#[test]
fn a_desktop_says_which_files_the_settings_app_edits() {
    // The shell's declared options are beside the module it serves now, which
    // `load-shell` can change.
    let files = SettingsFiles {
        config: Some(PathBuf::from("/home/me/.config/domicile/domicile.json")),
        evaluated: None,
        shell: Some(PathBuf::from("/home/me/.config/domicile/shell.ts")),
        options: None,
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"settings_files\"}",
            &Desktop {
                files: &files,
                shell: &served_from("/home/me/.cache/domicile/abc/shell.js"),
                ..nothing_dialed()
            }
        ),
        Response::SettingsFiles {
            files: SettingsFiles {
                options: Some(PathBuf::from("/home/me/.cache/domicile/abc/options.json")),
                ..files.clone()
            }
        }
    );
}

#[test]
fn a_desktop_asked_for_site_permissions_asks_the_engine() {
    assert_eq!(
        reply_to(
            "{\"type\":\"site_permissions\"}",
            &Desktop {
                permissions: &|| Ok(stored()),
                ..nothing_dialed()
            }
        ),
        Response::SitePermissions(stored())
    );
}

#[test]
fn a_desktop_told_to_set_a_site_permission_tells_the_engine() {
    let told = Cell::new(None);
    let answered = reply_to(
        "{\"type\":\"set_site_permission\",\"site\":{\"origin\":\"https://meet.example\",\"permission\":\"camera\",\"setting\":\"block\"}}",
        &Desktop {
            set_permission: &|site| {
                told.set(Some(site.clone()));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(told.take(), Some(a_site(Setting::Block)));
    assert_eq!(answered, Response::Stored);
}

#[test]
fn a_desktop_asked_for_media_devices_asks_the_engine() {
    assert_eq!(
        reply_to(
            "{\"type\":\"media_devices\"}",
            &Desktop {
                media_devices: &|| Ok(a_camera()),
                ..nothing_dialed()
            }
        ),
        Response::MediaDevices(a_camera())
    );
}

#[test]
fn a_desktop_told_to_prefer_a_media_device_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"set_media_device\",\"kind\":\"camera\",\"id\":\"/dev/video2\"}",
        &Desktop {
            set_media_device: &|kind, id| {
                told.replace(Some((kind, id.to_string())));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some((MediaKind::Camera, "/dev/video2".to_string()))
    );
    assert_eq!(answered, Response::Stored);
}

#[test]
fn an_engine_that_would_not_set_a_site_permission_is_quoted() {
    let Response::Refused { why } = reply_to(
        "{\"type\":\"set_site_permission\",\"site\":{\"origin\":\"https://meet.example\",\"permission\":\"camera\",\"setting\":\"block\"}}",
        &Desktop {
            set_permission: &|_| Err("\"camera\" is not a permission".to_string()),
            ..nothing_dialed()
        },
    ) else {
        panic!("an engine that refused the setting is not one that stored it");
    };
    assert!(
        why.contains("not a permission"),
        "the refusal did not carry the engine's own words: {why}"
    );
}

#[test]
fn a_desktop_told_to_load_an_unpacked_extension_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"load_unpacked\",\"directory\":\"/home/me/src/my-extension\"}",
        &Desktop {
            load_unpacked: &|directory| {
                told.replace(Some(directory.to_path_buf()));
                Ok("abcdefghijklmnopabcdefghijklmnop".to_string())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some(PathBuf::from("/home/me/src/my-extension"))
    );
    assert_eq!(
        answered,
        Response::LoadedUnpacked {
            id: "abcdefghijklmnopabcdefghijklmnop".to_string()
        }
    );
}

#[test]
fn a_desktop_told_to_uninstall_an_extension_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"uninstall_extension\",\"id\":\"abcdefghijklmnopabcdefghijklmnop\"}",
        &Desktop {
            uninstall_extension: &|id| {
                told.replace(Some(id.to_string()));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take().as_deref(),
        Some("abcdefghijklmnopabcdefghijklmnop")
    );
    assert_eq!(answered, Response::Uninstalled);
}

#[test]
fn a_desktop_asked_which_extensions_the_config_installed_asks_the_engine() {
    assert_eq!(
        reply_to(
            "{\"type\":\"config_extensions\"}",
            &Desktop {
                config_extensions: &|| Ok(vec!["abcdefghijklmnopabcdefghijklmnop".to_string()]),
                ..nothing_dialed()
            }
        ),
        Response::ConfigExtensions {
            ids: vec!["abcdefghijklmnopabcdefghijklmnop".to_string()]
        }
    );
}

#[test]
fn a_desktop_asked_for_its_extensions_asks_the_engine() {
    assert_eq!(
        reply_to(
            "{\"type\":\"extensions\"}",
            &Desktop {
                extensions: &|| Ok(vec![an_extension()]),
                ..nothing_dialed()
            }
        ),
        Response::Extensions {
            extensions: vec![an_extension()]
        }
    );
}

#[test]
fn a_desktop_told_an_extension_s_settings_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"configure_extension\",\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"settings\":{\"site_access\":[\"github.com\",\"*.example.com\"]}}",
        &Desktop {
            configure_extension: &|id, settings| {
                told.replace(Some((id.to_string(), settings.clone())));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some((
            "abcdefghijklmnopabcdefghijklmnop".to_string(),
            ExtensionSettings {
                site_access: Some(SiteAccess::Sites(vec![
                    "github.com".to_string(),
                    "*.example.com".to_string()
                ])),
                ..ExtensionSettings::default()
            }
        ))
    );
    assert_eq!(answered, Response::Stored);
}

#[test]
fn a_desktop_told_to_disable_an_extension_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"set_extension_enabled\",\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"enabled\":false}",
        &Desktop {
            set_extension_enabled: &|id, enabled, profile| {
                assert_eq!(profile, None, "no profile is the shell's");
                told.replace(Some((id.to_string(), enabled)));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        told.take(),
        Some(("abcdefghijklmnopabcdefghijklmnop".to_string(), false))
    );
    assert_eq!(answered, Response::Stored);
}

#[test]
fn a_desktop_asked_to_search_history_asks_the_engine() {
    let asked = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"history\",\"text\":\"a\",\"end_time\":1700000000123.5,\"max_results\":10}",
        &Desktop {
            history: &|query| {
                asked.replace(Some(query.clone()));
                Ok(vec![a_row()])
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        asked.take(),
        Some(HistoryQuery {
            text: "a".to_string(),
            end_time: 1_700_000_000_123.5,
            max_results: 10,
        })
    );
    assert_eq!(
        answered,
        Response::History {
            items: vec![a_row()]
        }
    );
}

#[test]
fn a_desktop_asked_for_a_page_s_visits_asks_the_engine() {
    assert_eq!(
        reply_to(
            "{\"type\":\"visits\",\"url\":\"https://a.example/\"}",
            &Desktop {
                visits: &|url| {
                    assert_eq!(url, "https://a.example/");
                    Ok(vec![1_700_000_000_123.5])
                },
                ..nothing_dialed()
            }
        ),
        Response::Visits {
            times: vec![1_700_000_000_123.5]
        }
    );
}

#[test]
fn a_desktop_told_to_delete_visits_tells_the_engine() {
    let told = RefCell::new(Vec::new());
    let answered = reply_to(
        "{\"type\":\"delete_history\",\"visits\":[1700000000123.5]}",
        &Desktop {
            delete_history: &|visits| {
                told.replace(visits.to_vec());
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(told.take(), vec![1_700_000_000_123.5]);
    assert_eq!(answered, Response::Deleted);
}

#[test]
fn a_desktop_told_to_clear_browsing_data_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"clear_browsing_data\",\"since\":0,\"types\":[\"cookies\"]}",
        &Desktop {
            clear_browsing_data: &|data| {
                told.replace(Some(data.clone()));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    // No `origins` is every origin.
    assert_eq!(
        told.take(),
        Some(BrowsingData {
            since: 0.0,
            types: vec!["cookies".to_string()],
            origins: None,
        })
    );
    assert_eq!(answered, Response::Cleared);
}

#[test]
fn a_desktop_asked_for_site_data_asks_the_engine() {
    let answered = reply_to(
        "{\"type\":\"site_data\"}",
        &Desktop {
            site_data: &|| {
                Ok(vec![SiteData {
                    host: "a.example".to_string(),
                    bytes: 2048.0,
                    cookies: 1,
                }])
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(
        answered,
        Response::SiteData {
            sites: vec![SiteData {
                host: "a.example".to_string(),
                bytes: 2048.0,
                cookies: 1,
            }],
        }
    );
}

#[test]
fn a_desktop_told_to_clear_a_host_s_site_data_tells_the_engine() {
    let told = RefCell::new(None);
    let answered = reply_to(
        "{\"type\":\"clear_site_data\",\"host\":\"a.example\"}",
        &Desktop {
            clear_site_data: &|host| {
                told.replace(Some(host.to_string()));
                Ok(())
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(told.take(), Some("a.example".to_string()));
    assert_eq!(answered, Response::Cleared);
}

#[test]
fn a_desktop_asked_about_disable_while_typing_asks_the_engine() {
    let answered = reply_to(
        "{\"type\":\"disable_while_typing\"}",
        &Desktop {
            disable_while_typing: &|enabled| {
                assert_eq!(enabled, None, "a question sets nothing");
                Ok(true)
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(answered, Response::DisableWhileTyping { enabled: true });
}

#[test]
fn a_desktop_told_to_turn_disable_while_typing_off_tells_the_engine() {
    let answered = reply_to(
        "{\"type\":\"disable_while_typing\",\"to\":\"off\"}",
        &Desktop {
            disable_while_typing: &|enabled| Ok(enabled.expect("off sets it")),
            ..nothing_dialed()
        },
    );

    assert_eq!(answered, Response::DisableWhileTyping { enabled: false });
}

#[test]
fn a_desktop_told_to_toggle_disable_while_typing_sets_the_opposite() {
    let told = RefCell::new(Vec::new());
    let answered = reply_to(
        "{\"type\":\"disable_while_typing\",\"to\":\"toggle\"}",
        &Desktop {
            disable_while_typing: &|enabled| {
                told.borrow_mut().push(enabled);
                Ok(enabled.unwrap_or(true))
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(told.take(), vec![None, Some(false)]);
    assert_eq!(answered, Response::DisableWhileTyping { enabled: false });
}

#[test]
fn a_desktop_carries_back_why_the_engine_refused_disable_while_typing() {
    let answered = reply_to(
        "{\"type\":\"disable_while_typing\",\"to\":\"toggle\"}",
        &Desktop {
            disable_while_typing: &|_| Err("no touchpad".to_string()),
            ..nothing_dialed()
        },
    );

    assert_eq!(
        answered,
        Response::Refused {
            why: "no touchpad".to_string()
        }
    );
}

#[test]
fn a_desktop_asked_its_theme_asks_the_compositor() {
    let answered = reply_to(
        "{\"type\":\"theme\"}",
        &Desktop {
            theme: &|to| {
                assert_eq!(to, None, "a question sets nothing");
                Ok(Theme::Dark)
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(answered, Response::Theme { theme: Theme::Dark });
}

#[test]
fn a_desktop_told_to_go_light_tells_the_compositor() {
    let answered = reply_to(
        "{\"type\":\"theme\",\"to\":\"light\"}",
        &Desktop {
            theme: &|to| Ok(to.expect("light sets it")),
            ..nothing_dialed()
        },
    );

    assert_eq!(
        answered,
        Response::Theme {
            theme: Theme::Light
        }
    );
}

#[test]
fn a_desktop_told_to_toggle_the_theme_sets_the_other_one() {
    let told = RefCell::new(Vec::new());
    let answered = reply_to(
        "{\"type\":\"theme\",\"to\":\"toggle\"}",
        &Desktop {
            theme: &|to| {
                told.borrow_mut().push(to);
                Ok(to.unwrap_or(Theme::Dark))
            },
            ..nothing_dialed()
        },
    );

    assert_eq!(told.take(), vec![None, Some(Theme::Light)]);
    assert_eq!(
        answered,
        Response::Theme {
            theme: Theme::Light
        }
    );
}

#[test]
fn a_desktop_carries_back_why_the_compositor_did_not_answer_the_theme() {
    let answered = reply_to(
        "{\"type\":\"theme\",\"to\":\"dark\"}",
        &Desktop {
            theme: &|_| Err("no compositor".to_string()),
            ..nothing_dialed()
        },
    );

    assert_eq!(
        answered,
        Response::Refused {
            why: "no compositor".to_string()
        }
    );
}

/// A history row with a favicon.
fn a_row() -> HistoryItem {
    HistoryItem {
        url: "https://a.example/".to_string(),
        title: "A".to_string(),
        favicon: Some("data:image/png;base64,AAAA".to_string()),
    }
}

/// An installed extension with an options page.
fn an_extension() -> InstalledExtension {
    InstalledExtension {
        id: "abcdefghijklmnopabcdefghijklmnop".to_string(),
        name: "Dark Reader".to_string(),
        description: "Dark mode".to_string(),
        version: "4.9".to_string(),
        enabled: true,
        options_url: Some(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html".to_string(),
        ),
        settings: ExtensionSettings {
            file_access: Some(false),
            site_access: Some(SiteAccess::Mode(SiteAccessMode::AllSites)),
            ..ExtensionSettings::default()
        },
        icon_path: Some("/ext/dark/128.png".to_string()),
    }
}

/// What the engine stores: camera's default, and one site's camera.
fn a_camera() -> MediaDevices {
    MediaDevices {
        cameras: vec![MediaDevice {
            id: "/dev/video2".to_string(),
            name: "USB Camera".to_string(),
        }],
        microphones: vec![],
    }
}

fn stored() -> SiteSettings {
    SiteSettings {
        defaults: BTreeMap::from([(Permission::Camera, Setting::Ask)]),
        sites: vec![a_site(Setting::Allow)],
    }
}

/// `https://meet.example`'s camera, set to `setting`.
fn a_site(setting: Setting) -> SitePermission {
    SitePermission {
        origin: "https://meet.example".to_string(),
        permission: Permission::Camera,
        setting,
    }
}

/// Sends one request line to `desktop` and parses the one reply line.
fn reply_to(line: &str, desktop: &Desktop) -> Response {
    parse_response(answer(line, desktop).trim()).expect("a desktop answers with a response")
}

/// A desktop serving `/shell.js` with no settings files, whose every dial
/// panics. Tests replace the one they expect.
fn nothing_dialed() -> Desktop<'static> {
    Desktop {
        capture: &|_| panic!("only screenshot captures anything"),
        clear_browsing_data: &|_| panic!("only clear_browsing_data clears anything"),
        clear_site_data: &|_| panic!("only clear_site_data clears a site's data"),
        config_extensions: &|| panic!("only config_extensions lists the config's extensions"),
        delete_history: &|_| panic!("only delete_history deletes visits"),
        disable_while_typing: &|_| panic!("only disable_while_typing sets it"),
        extensions: &|| panic!("only extensions lists every extension"),
        files: &NO_FILES,
        history: &|_| panic!("only history searches the history"),
        load: &|_| panic!("only load_shell loads anything"),
        load_unpacked: &|_| panic!("only load_unpacked loads an extension"),
        media_devices: &|| panic!("only media_devices lists media devices"),
        shell: Box::leak(Box::new(served_from("/shell.js"))),
        open: &|_, _| panic!("only open_url opens a browser window"),
        open_app: &|_, _, _, _| panic!("only open_app opens an app window"),
        run_app: &|_, _| panic!("only run_app runs an app module"),
        launch: &|_| panic!("only launch starts a program"),
        open_link: &|_| panic!("only open_link hands over a link"),
        permissions: &|| panic!("only site_permissions lists site permissions"),
        power_displays: &|_, _| panic!("only sleep_displays and wake_displays power them"),
        lock: &|| panic!("only lock locks the desktop"),
        act_on_window: &|_, _| panic!("only act_on_window acts on a window"),
        shoot_desk: &|_, _, _| panic!("only shoot_desk shoots the desk"),
        emulate: &|_| panic!("only emulate sends input"),
        devtools: &|_, _, _| panic!("only devtools sends DevTools methods"),
        configure_display: &|_, _| panic!("only configure_display configures a display"),
        log_levels: &|| panic!("only the log level requests read the log levels"),
        set_log_levels: &|_| panic!("only the log level requests set log levels"),
        up: "domicile is up. domicile 1.3.0",
        logs_in_the_journal: false,
        logs: &|| panic!("only recent_logs and export_logs read the logs"),
        monitors: &|| panic!("only monitors lists the monitors"),
        displays: &|| panic!("only displays lists the displays"),
        windows: &|| panic!("only windows lists the windows"),
        status: &|| panic!("only status asks how the desktop is"),
        shell_commands: &|| panic!("only shell_commands lists the shell's commands"),
        shell_bindings: &|| panic!("only shell_bindings lists the shell's bindings"),
        inputs: &|| panic!("only inputs lists the input devices"),
        idle_time: &|| panic!("only idle_time asks how long nobody has been here"),
        agents: &|| panic!("only agents lists the agents"),
        stop_agent: &|_| panic!("only stop_agent stops an agent"),
        forget_agent: &|_| panic!("only forget_agent forgets an agent"),
        record: &|| panic!("only screen_record records anything"),
        send: &|_| panic!("only send_shell sends anything"),
        site_data: &|| panic!("only site_data lists site data"),
        theme: &|_| panic!("only theme reads or sets the theme"),
        set_extension_enabled: &|_, _, _| panic!("only set_extension_enabled enables one"),
        browser_profiles: &|| panic!("only browser_profiles lists the profiles"),
        pin_browser_site: &|_, _| panic!("only pin_browser_site pins a site"),
        configure_extension: &|_, _| panic!("only configure_extension configures one"),
        set_media_device: &|_, _| panic!("only set_media_device prefers one"),
        set_permission: &|_| panic!("only set_site_permission sets one"),
        uninstall_extension: &|_| panic!("only uninstall_extension uninstalls one"),
        visits: &|_| panic!("only visits lists a page's visits"),
    }
}

static NO_FILES: SettingsFiles = SettingsFiles {
    config: None,
    evaluated: None,
    shell: None,
    options: None,
};

/// Sends one request line and parses the one reply line.
fn answered(line: &str, module: &Path, load: LoadShell) -> Response {
    reply_to(
        line,
        &Desktop {
            load,
            shell: &served_from(module),
            ..nothing_dialed()
        },
    )
}

/// The shell `module` names, served from its directory.
fn served_from(module: impl AsRef<Path>) -> Shell {
    let module = module.as_ref();
    Shell {
        files: ShellFiles::Directory,
        module: PathBuf::from(module.file_name().expect("a module is a file")),
        root: module.parent().expect("a module is in a directory").into(),
    }
}

/// [`answered`], for `open_url`.
fn answered_opening(line: &str, open: OpenUrl) -> Response {
    reply_to(
        line,
        &Desktop {
            open,
            ..nothing_dialed()
        },
    )
}

/// [`answered`], for `screenshot`.
fn answered_capturing(line: &str, capture: Screenshot) -> Response {
    reply_to(
        line,
        &Desktop {
            capture,
            ..nothing_dialed()
        },
    )
}

/// [`answered`], for `send_shell`.
fn answered_sending(line: &str, send: SendShell) -> Response {
    reply_to(
        line,
        &Desktop {
            send,
            ..nothing_dialed()
        },
    )
}

#[test]
fn a_virtual_monitor_is_refused_on_a_connection_that_is_not_held() {
    // `serve_one` lends it the connection; a lone line has no monitor to keep.
    let refused = answered(
        "{\"type\":\"virtual_monitor\",\"name\":\"Pane\",\"width\":1280,\
         \"height\":720,\"refresh_mhz\":60000}",
        Path::new("/shell.js"),
        &|_| panic!("a monitor reaches no engine"),
    );
    assert!(matches!(refused, Response::Refused { .. }), "{refused:?}");
}

#[test]
fn a_resize_with_no_monitor_held_is_refused() {
    let refused = answered(
        "{\"type\":\"resize_virtual_monitor\",\"width\":1280,\"height\":720,\
         \"refresh_mhz\":60000}",
        Path::new("/shell.js"),
        &|_| panic!("a resize reaches no engine"),
    );
    assert!(matches!(refused, Response::Refused { .. }), "{refused:?}");
}

#[test]
fn a_desk_shot_says_what_it_shows() {
    let shot = DeskShot {
        place: DeskRect {
            position: (0, 0),
            size: (3840, 1080),
        },
        width: 1280,
        height: 360,
    };
    assert_eq!(
        reply_to(
            "{\"type\":\"shoot_desk\",\"file\":\"/tmp/desk.png\",\"fit\":1280,\"area\":{\"position\":[0,0],\"size\":[10,10]}}",
            &Desktop {
                shoot_desk: &|file, fit, area| {
                    assert_eq!((file, fit), (Path::new("/tmp/desk.png"), 1280));
                    assert_eq!(
                        area,
                        Some(DeskRect {
                            position: (0, 0),
                            size: (10, 10)
                        })
                    );
                    Ok(shot)
                },
                ..nothing_dialed()
            },
        ),
        Response::DeskShot { shot }
    );
}

#[test]
fn emulated_input_is_sent_or_refused_with_why() {
    assert_eq!(
        reply_to(
            "{\"type\":\"emulate\",\"input\":[{\"kind\":\"point_to\",\"x\":1.0,\"y\":2.0}]}",
            &Desktop {
                emulate: &|input| {
                    assert_eq!(input, [EmulatedInput::PointTo { x: 1.0, y: 2.0 }]);
                    Err("the desktop is locked".to_string())
                },
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "the desktop is locked".to_string()
        }
    );
}

/// The desk's windows for `devtools`: a native one, a browser window and a
/// private one.
fn three_windows() -> Result<Vec<ListedWindow>, String> {
    let native = ListedWindow {
        id: "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA".to_string(),
        kind: WindowKind::Native,
        title: "notes.org".to_string(),
        app: Some("emacs".to_string()),
        pid: Some(4242),
        size: Some([640.0, 480.0]),
        focused: true,
        urgent: false,
        url: None,
        private: false,
        engine_id: None,
        views: Vec::new(),
    };
    let mail = ListedWindow {
        id: "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".to_string(),
        kind: WindowKind::Browser,
        title: "Inbox".to_string(),
        app: None,
        pid: None,
        size: None,
        focused: false,
        url: Some("https://mail.example/".to_string()),
        engine_id: Some("3".to_string()),
        views: vec![ListedView {
            id: "9".to_string(),
            position: [0, 40],
            size: [800, 560],
        }],
        ..native.clone()
    };
    let private = ListedWindow {
        id: "aU2iO9pE4rT7yW1qZ5xC8vB3nM6lK0jH".to_string(),
        private: true,
        engine_id: Some("7".to_string()),
        ..mail.clone()
    };
    Ok(vec![native, mail, private])
}

#[test]
fn devtools_sends_to_a_browser_window_by_its_listed_id() {
    assert_eq!(
        reply_to(
            "{\"type\":\"devtools\",\"window\":\"Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE\",\"method\":\"DOM.getBoxModel\",\"params\":{\"backendNodeId\":4}}",
            &Desktop {
                windows: &three_windows,
                status: &|| status(false),
                devtools: &|window, method, params| {
                    assert_eq!(
                        (window, method, params),
                        ("3", "DOM.getBoxModel", &serde_json::json!({"backendNodeId": 4}))
                    );
                    Ok(serde_json::json!({"model": {}}))
                },
                ..nothing_dialed()
            },
        ),
        Response::DevTools {
            result: serde_json::json!({"model": {}})
        }
    );
}

#[test]
fn devtools_sends_to_a_view_the_window_holds() {
    assert_eq!(
        reply_to(
            "{\"type\":\"devtools\",\"window\":\"Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE\",\"view\":\"9\",\"method\":\"Page.reload\",\"params\":{}}",
            &Desktop {
                windows: &three_windows,
                status: &|| status(false),
                devtools: &|window, _, _| {
                    assert_eq!(window, "9");
                    Ok(serde_json::json!({}))
                },
                ..nothing_dialed()
            },
        ),
        Response::DevTools {
            result: serde_json::json!({})
        }
    );
    let refused = reply_to(
        "{\"type\":\"devtools\",\"window\":\"Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE\",\"view\":\"3\",\"method\":\"Page.reload\",\"params\":{}}",
        &Desktop {
            windows: &three_windows,
            status: &|| status(false),
            ..nothing_dialed()
        },
    );
    assert_eq!(
        refused,
        Response::Refused {
            why: "window Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE holds no view 3; list-windows lists its views".to_string()
        }
    );
}

#[test]
fn devtools_refuses_a_window_it_does_not_drive_saying_why() {
    for (window, why) in [
        ("kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA", "native"),
        ("aU2iO9pE4rT7yW1qZ5xC8vB3nM6lK0jH", "private"),
        ("nope", "no window nope"),
    ] {
        let reply = reply_to(
            &format!("{{\"type\":\"devtools\",\"window\":\"{window}\",\"method\":\"Page.reload\",\"params\":{{}}}}"),
            &Desktop {
                windows: &three_windows,
                status: &|| status(false),
                ..nothing_dialed()
            },
        );
        match reply {
            Response::Refused { why: refused } => assert!(refused.contains(why), "{refused}"),
            other => panic!("{window} was not refused: {other:?}"),
        }
    }
}

#[test]
fn devtools_sends_window_shell_to_the_shells_own_page() {
    assert_eq!(
        reply_to(
            "{\"type\":\"devtools\",\"window\":\"shell\",\"method\":\"Accessibility.getFullAXTree\",\"params\":{}}",
            &Desktop {
                windows: &three_windows,
                status: &|| status(false),
                devtools: &|window, method, _| {
                    assert_eq!((window, method), ("shell", "Accessibility.getFullAXTree"));
                    Ok(serde_json::json!({"nodes": []}))
                },
                ..nothing_dialed()
            },
        ),
        Response::DevTools {
            result: serde_json::json!({"nodes": []})
        }
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"devtools\",\"window\":\"shell\",\"view\":\"9\",\"method\":\"Page.reload\",\"params\":{}}",
            &Desktop {
                windows: &three_windows,
                status: &|| status(false),
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "the shell holds no views; list-windows lists browser windows' views".to_string()
        }
    );
    assert_eq!(
        reply_to(
            "{\"type\":\"devtools\",\"window\":\"shell\",\"method\":\"Page.reload\",\"params\":{}}",
            &Desktop {
                windows: &three_windows,
                status: &|| status(true),
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "the desktop is locked".to_string()
        }
    );
}

fn status(locked: bool) -> Result<DesktopStatus, String> {
    Ok(DesktopStatus {
        theme: Theme::Light,
        locked,
        keymap: None,
        screens_off: false,
        held_awake_by: Vec::new(),
        capturing: Vec::new(),
    })
}

#[test]
fn devtools_is_refused_while_the_desktop_is_locked() {
    assert_eq!(
        reply_to(
            "{\"type\":\"devtools\",\"window\":\"Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE\",\"method\":\"Page.reload\",\"params\":{}}",
            &Desktop {
                windows: &three_windows,
                status: &|| status(true),
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "the desktop is locked".to_string()
        }
    );
}

#[test]
fn agents_are_listed_stopped_and_forgotten_through_the_compositor() {
    use domicile_protocol::KnownAgents;
    let stopped = Cell::new(None);
    let forgot = std::cell::RefCell::new(None);
    let desktop = Desktop {
        agents: &|| Ok(KnownAgents::default()),
        stop_agent: &|session| {
            stopped.set(Some(session));
            Ok(())
        },
        forget_agent: &|agent| {
            *forgot.borrow_mut() = Some(agent.to_string());
            Ok(())
        },
        ..nothing_dialed()
    };
    assert_eq!(
        reply_to("{\"type\":\"agents\"}", &desktop),
        Response::Agents {
            agents: KnownAgents::default()
        }
    );
    assert_eq!(
        reply_to("{\"type\":\"stop_agent\",\"session\":4}", &desktop),
        Response::Done
    );
    assert_eq!(stopped.get(), Some(4));
    assert_eq!(
        reply_to("{\"type\":\"forget_agent\",\"agent\":\"Codex\"}", &desktop),
        Response::Done
    );
    assert_eq!(forgot.borrow().as_deref(), Some("Codex"));
}

fn engine_said(message: &str) -> Said {
    Said {
        at: 1_795_799_523_000_000,
        identifier: "domicile-engine".to_string(),
        priority: Priority::Error,
        message: message.to_string(),
    }
}

fn titled(title: &str) -> ListedWindow {
    ListedWindow {
        id: "kD3m".to_string(),
        kind: WindowKind::Browser,
        title: title.to_string(),
        app: None,
        pid: None,
        size: None,
        focused: false,
        urgent: false,
        url: None,
        private: false,
        engine_id: None,
        views: Vec::new(),
    }
}

#[test]
fn recent_logs_are_the_lines_kept_off_the_journal() {
    let kept = || Ok(vec![engine_said("the bus is gone")]);
    let Response::RecentLogs { journal, lines } = reply_to(
        "{\"type\":\"recent_logs\"}",
        &Desktop {
            logs_in_the_journal: false,
            logs: &kept,
            ..nothing_dialed()
        },
    ) else {
        panic!("recent_logs answers with the lines");
    };
    assert!(!journal);
    assert_eq!(lines.len(), 1);
    assert!(
        lines[0].ends_with("domicile-engine err: the bus is gone"),
        "{lines:?}"
    );
}

#[test]
fn recent_logs_on_the_journal_send_the_client_there() {
    // `domicile logs` runs journalctl, which follows and pages.
    assert_eq!(
        reply_to(
            "{\"type\":\"recent_logs\"}",
            &Desktop {
                logs_in_the_journal: true,
                ..nothing_dialed()
            },
        ),
        Response::RecentLogs {
            journal: true,
            lines: Vec::new()
        }
    );
}

#[test]
fn export_logs_writes_them_with_urls_and_titles_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("logs.txt");
    let logs = || {
        Ok(vec![engine_said(
            "Inbox - Mail failed https://mail.example/x",
        )])
    };
    let desktop = Desktop {
        logs: &logs,
        windows: &|| Ok(vec![titled("Inbox - Mail")]),
        displays: &|| Ok(Vec::new()),
        inputs: &|| Ok(Vec::new()),
        log_levels: &LogLevels::default,
        ..nothing_dialed()
    };
    assert_eq!(
        reply_to(
            &format!(
                "{{\"type\":\"export_logs\",\"file\":{:?},\"redact\":true}}",
                file.display().to_string()
            ),
            &desktop,
        ),
        Response::ExportedLogs {
            file: file.clone(),
            unhidden: None
        }
    );
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("err: <window title> failed <url>"), "{text}");
    assert!(text.contains("domicile is up."), "{text}");

    reply_to(
        &format!(
            "{{\"type\":\"export_logs\",\"file\":{:?},\"redact\":false}}",
            file.display().to_string()
        ),
        &desktop,
    );
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        text.contains("err: Inbox - Mail failed https://mail.example/x"),
        "{text}"
    );
}

#[test]
fn export_logs_without_the_compositor_still_exports_and_says_titles_may_show() {
    // A desktop whose compositor is down is when its logs are wanted most.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("logs.txt");
    let logs = || Ok(vec![engine_said("gone")]);
    let Response::ExportedLogs { unhidden, .. } = reply_to(
        &format!(
            "{{\"type\":\"export_logs\",\"file\":{:?},\"redact\":true}}",
            file.display().to_string()
        ),
        &Desktop {
            logs: &logs,
            windows: &|| Err("the compositor is not running".to_string()),
            displays: &|| Err("the compositor is not running".to_string()),
            inputs: &|| Err("the compositor is not running".to_string()),
            log_levels: &LogLevels::default,
            ..nothing_dialed()
        },
    ) else {
        panic!("the logs are exported anyway");
    };
    assert_eq!(
        unhidden.as_deref(),
        Some("the window titles were not read, so they may show: the compositor is not running")
    );
    assert!(std::fs::read_to_string(&file)
        .unwrap()
        .contains("err: gone"));
}

#[test]
fn export_logs_that_cannot_be_read_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let logs = || Err("journalctl is not installed".to_string());
    assert_eq!(
        reply_to(
            &format!(
                "{{\"type\":\"export_logs\",\"file\":{:?},\"redact\":true}}",
                dir.path().join("logs.txt").display().to_string()
            ),
            &Desktop {
                logs: &logs,
                ..nothing_dialed()
            },
        ),
        Response::Refused {
            why: "cannot read the logs: journalctl is not installed".to_string()
        }
    );
}
