//! Tests for the host-chrome IPC.
//!
//! Messages are newline-delimited JSON. `apply_chrome_message` performs the
//! version handshake, then passes chrome messages to the `Host`.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::thread;

use domicile_host::ipc::{apply_chrome_message, parse_chrome, to_line};
use domicile_host::{Appearances, Host};
use domicile_protocol::{
    AccessDialog, Appearance, BoundShortcut, BrowserProfile, Capturing, CapturingKind,
    ChromeMessage, Devices, ExtensionSettings, HostMessage, Notification, Owner, PortalKind,
    PortalRequest, PortalWallpaper, Theme, TrayItem, Urgency, PROTOCOL_VERSION,
};

/// A window's owner, for tests about anything else.
const OWNER: Owner = Owner {
    pid: 1,
    uid: 1000,
    gid: 1000,
    pidfd_inode: None,
    sandbox: None,
};

/// A window's identifier on `ext-foreign-toplevel-list-v1`, for tests about
/// anything else.
const LISTED: &str = "Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa";

/// One chrome connection's [`Host`] and handshake state.
#[derive(Default)]
struct Session {
    host: Host,
    ready: bool,
}

impl Session {
    fn new() -> Self {
        Session::default()
    }

    fn is_ready(&self) -> bool {
        self.ready
    }

    fn host_mut(&mut self) -> &mut Host {
        &mut self.host
    }

    /// Handles one inbound line, ignoring a malformed one, as the compositor
    /// does.
    fn ingest(&mut self, line: &str) -> Vec<HostMessage> {
        match parse_chrome(line.trim()) {
            Ok(message) => apply_chrome_message(&mut self.host, &mut self.ready, message),
            Err(_) => Vec::new(),
        }
    }
}

#[test]
fn hello_completes_the_handshake_with_a_welcome_and_the_desktop() {
    // The chrome needs the displays to lay out, and the theme to avoid a
    // first paint in the wrong one. Both follow the agreed version.
    let mut session = Session::new();
    assert!(!session.is_ready());

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));
    assert!(session.is_ready());
    assert_eq!(
        out,
        vec![
            HostMessage::Welcome {
                protocol_version: PROTOCOL_VERSION
            },
            HostMessage::Displays { displays: vec![] },
            HostMessage::Theme { theme: Theme::Dark },
            HostMessage::WindowsTheme { theme: Theme::Dark },
            HostMessage::Appearance(Appearance::default()),
            HostMessage::ForceDark { sites: vec![] },
        ]
    );
}

#[test]
fn version_mismatch_is_refused_out_loud() {
    // The session stays not ready but still sends a `Welcome` with its own
    // version. The chrome needs it to report the mismatch; without a reply
    // it would wait forever and fail silently.
    let mut session = Session::new();

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: 999,
        checked: false,
    }));

    assert!(!session.is_ready());
    assert_eq!(
        out,
        vec![HostMessage::Welcome {
            protocol_version: PROTOCOL_VERSION
        }],
        "a mismatched hello is told what this build speaks, and nothing else"
    );
}

#[test]
fn a_version_refused_after_one_was_agreed_takes_the_handshake_back() {
    // The compositor broadcasts only to ready sessions. A page that later
    // sends an unsupported version cannot read those broadcasts, so `ready`
    // must go back to false.
    let mut session = Session::new();
    session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));
    assert!(session.is_ready(), "the first hello agreed");

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: 999,
        checked: false,
    }));

    assert!(!session.is_ready(), "the second took the agreement back");
    assert_eq!(
        out,
        vec![HostMessage::Welcome {
            protocol_version: PROTOCOL_VERSION
        }],
        "and it is still answered, so the page can report the mismatch"
    );
}

#[test]
fn messages_before_the_handshake_are_ignored() {
    // No message takes effect before `Hello`.
    let mut session = Session::new();
    let id = session.host_mut().app_created(OWNER, LISTED.to_string());
    let _ = session.ingest(&to_line(&ChromeMessage::FocusApp { app_id: id.clone() }));
    assert_eq!(
        session.host_mut().keyboard_target(),
        domicile_scene::KeyboardTarget::Chrome
    );
}

#[test]
fn a_message_after_the_handshake_reaches_the_host() {
    let mut session = Session::new();
    let id = session.host_mut().app_created(OWNER, LISTED.to_string());
    session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    session.ingest(&to_line(&ChromeMessage::FocusApp { app_id: id.clone() }));
    assert_eq!(
        session.host_mut().keyboard_target(),
        domicile_scene::KeyboardTarget::App(id)
    );
}

#[test]
fn malformed_lines_are_ignored() {
    let mut session = Session::new();
    session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));
    // Should not panic.
    let out = session.ingest("{ this is not valid json");
    assert!(out.is_empty());
}

#[test]
fn line_codec_round_trips() {
    let line = to_line(&ChromeMessage::FocusApp {
        app_id: "term".into(),
    });
    assert!(line.ends_with('\n'), "messages are newline-delimited");
    let back = parse_chrome(line.trim()).unwrap();
    assert_eq!(
        back,
        ChromeMessage::FocusApp {
            app_id: "term".into()
        }
    );
}

#[test]
fn handshake_works_over_a_real_unix_socket() {
    let (client, server) = UnixStream::pair().unwrap();

    let server_thread = thread::spawn(move || {
        let mut writer = server.try_clone().unwrap();
        let mut reader = BufReader::new(server);
        let mut session = Session::new();

        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        for msg in session.ingest(line.trim()) {
            writer.write_all(to_line(&msg).as_bytes()).unwrap();
        }
        session.is_ready()
    });

    let mut client_writer = client.try_clone().unwrap();
    client_writer
        .write_all(
            to_line(&ChromeMessage::Hello {
                protocol_version: PROTOCOL_VERSION,
                checked: false,
            })
            .as_bytes(),
        )
        .unwrap();

    let mut client_reader = BufReader::new(client);
    let mut resp = String::new();
    client_reader.read_line(&mut resp).unwrap();
    let welcome: HostMessage = serde_json::from_str(resp.trim()).unwrap();

    assert_eq!(
        welcome,
        HostMessage::Welcome {
            protocol_version: PROTOCOL_VERSION
        }
    );
    assert!(
        server_thread.join().unwrap(),
        "server session reached ready"
    );
}

#[test]
fn a_keymap_the_compositor_compiled_rides_with_the_handshake() {
    // The browser process reads this, not the page. Outside ChromeOS its
    // `XkbKeyboardLayoutEngine` has no keymap and resolves no printable keys,
    // so on a tty typing fails until it gets the compositor's keymap. A
    // reload opens a new channel, so the handshake must resend it.
    let mut session = Session::new();
    session.host_mut().set_keymap(KEYMAP.into());

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert_eq!(
        out,
        vec![
            HostMessage::Welcome {
                protocol_version: PROTOCOL_VERSION
            },
            HostMessage::Displays { displays: vec![] },
            HostMessage::Theme { theme: Theme::Dark },
            HostMessage::WindowsTheme { theme: Theme::Dark },
            HostMessage::Appearance(Appearance::default()),
            HostMessage::ForceDark { sites: vec![] },
            HostMessage::Keymap {
                keymap: KEYMAP.into()
            },
        ],
        "after the version it is written in, and after the desktop"
    );
}

#[test]
fn the_extensions_the_config_names_ride_with_the_handshake() {
    // The browser process installs these. A reload opens a new channel, so
    // the handshake resends the list, like the keymap.
    let mut session = Session::new();
    session.host_mut().set_keymap(KEYMAP.into());
    let private = ExtensionSettings {
        file_access: Some(true),
        ..ExtensionSettings::default()
    };
    session.host_mut().set_extensions(
        vec!["ddkjiahejlhfcafbddmgiahcphecmpfh".into()],
        vec!["/home/you/src/my-extension".into()],
        [("ddkjiahejlhfcafbddmgiahcphecmpfh".into(), private.clone())].into(),
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert_eq!(
        out.last(),
        Some(&HostMessage::Extensions {
            web_store: vec!["ddkjiahejlhfcafbddmgiahcphecmpfh".into()],
            unpacked: vec!["/home/you/src/my-extension".into()],
            settings: [("ddkjiahejlhfcafbddmgiahcphecmpfh".into(), private)].into(),
        }),
        "after the keymap, the other fact only the browser process reads"
    );
}

#[test]
fn the_browser_profiles_ride_with_the_handshake() {
    // The browser process reads these, like the extensions.
    let mut session = Session::new();
    let profiles = vec![BrowserProfile {
        id: "work".into(),
        name: "Work".into(),
        color: "#d97706".into(),
        private: false,
        extensions: None,
    }];
    let sites: std::collections::BTreeMap<String, String> =
        [("github.com/acme".into(), "work".into())].into();
    session.host_mut().set_browser_profiles(
        profiles.clone(),
        "work".into(),
        "private".into(),
        sites.clone(),
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(
        out.contains(&HostMessage::BrowserProfiles {
            profiles,
            default_profile: "work".into(),
            default_private_profile: "private".into(),
            sites,
        }),
        "{out:?}"
    );
}

#[test]
fn a_host_given_no_browser_profiles_sends_none() {
    // The browser keeps its one profile and its private one.
    let out = Session::new().ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(
        !out.iter()
            .any(|message| matches!(message, HostMessage::BrowserProfiles { .. })),
        "{out:?}"
    );
}

#[test]
fn the_sites_to_force_dark_ride_with_the_handshake() {
    // The browser process reads these, so a reloaded page's new channel needs
    // them again.
    let mut session = Session::new();
    session
        .host_mut()
        .set_force_dark(vec!["mail.google.com".into()]);

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(
        out.contains(&HostMessage::ForceDark {
            sites: vec!["mail.google.com".into()],
        }),
        "{out:?}"
    );
}

#[test]
fn spell_checking_rides_with_the_handshake_once_configured() {
    // The browser process reads it, so a reloaded page's new channel needs it
    // again. A host without a config sends none, and the browser keeps its
    // own default.
    let hello = to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    });
    let unset = Session::new().ingest(&hello);
    assert!(
        !unset
            .iter()
            .any(|message| matches!(message, HostMessage::Spellcheck { .. })),
        "{unset:?}"
    );

    let mut session = Session::new();
    session
        .host_mut()
        .set_spellcheck(false, vec!["de-DE".into()]);
    let out = session.ingest(&hello);
    assert!(
        out.contains(&HostMessage::Spellcheck {
            enabled: false,
            languages: vec!["de-DE".into()],
        }),
        "{out:?}"
    );
}

#[test]
fn the_keyboard_and_the_shell_s_options_ride_with_the_handshake() {
    // A reloaded page has no resolved keys or options, so the handshake
    // resends them. The keys follow the keymap they were resolved against.
    let mut session = Session::new();
    session.host_mut().set_keymap(KEYMAP.into());
    session.host_mut().set_shell_config(
        [("Return".to_string(), 28)].into(),
        "{\"gaps\":4}".to_string(),
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    let keymap_at = out
        .iter()
        .position(|message| matches!(message, HostMessage::Keymap { .. }))
        .expect("the keymap rides with the handshake");
    assert_eq!(
        out.get(keymap_at + 1),
        Some(&HostMessage::ShellConfig {
            keys: [("Return".to_string(), 28)].into(),
            options: "{\"gaps\":4}".to_string(),
        })
    );
}

#[test]
fn the_tray_rides_with_the_handshake() {
    // A reloaded page missed earlier icons, and unchanged icons are not
    // resent.
    let mut session = Session::new();
    let icon = TrayItem {
        id: ":1.42/StatusNotifierItem".into(),
        title: "Network".into(),
        icon: None,
        bus: ":1.42".into(),
        menu: None,
        item_is_menu: false,
    };
    let told = session.host_mut().set_tray(vec![icon.clone()]);
    assert_eq!(
        told,
        Some(HostMessage::Tray {
            items: vec![icon.clone()]
        })
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert_eq!(out.last(), Some(&HostMessage::Tray { items: vec![icon] }));
}

#[test]
fn a_tray_that_did_not_change_says_nothing() {
    // Items emit signals without real changes, such as an unchanged tooltip.
    // Broadcasting each would redraw every bar for nothing.
    let mut session = Session::new();
    session.host_mut().set_tray(vec![]);

    assert_eq!(session.host_mut().set_tray(vec![]), None);
}

#[test]
fn a_host_nobody_gave_a_tray_says_nothing_about_one() {
    // The `domicile` daemon has no D-Bus connection, so it must not report
    // an empty tray.
    let mut session = Session::new();

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(!out
        .iter()
        .any(|message| matches!(message, HostMessage::Tray { .. })));
}

#[test]
fn the_notifications_ride_with_the_handshake() {
    // The compositor owns notification history, so a reloaded page gets it
    // back. Sent after the tray.
    let mut session = Session::new();
    let notification = Notification {
        id: 7,
        app_name: "Firefox".into(),
        summary: "New message".into(),
        body: String::new(),
        icon: None,
        urgency: Urgency::Normal,
        actions: Vec::new(),
        clickable: false,
        timeout_ms: None,
        time: 1,
        browser_window: None,
    };
    session.host_mut().set_tray(vec![]);
    let told = session
        .host_mut()
        .set_notifications(vec![notification.clone()]);
    assert_eq!(
        told,
        Some(HostMessage::Notifications {
            items: vec![notification.clone()]
        })
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert_eq!(
        out.last(),
        Some(&HostMessage::Notifications {
            items: vec![notification]
        })
    );
}

#[test]
fn notifications_that_did_not_change_say_nothing() {
    let mut session = Session::new();
    session.host_mut().set_notifications(vec![]);

    assert_eq!(session.host_mut().set_notifications(vec![]), None);
}

#[test]
fn a_host_nobody_gave_notifications_says_nothing_about_them() {
    // Same as the tray: the `domicile` daemon has no D-Bus connection.
    let mut session = Session::new();

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(!out
        .iter()
        .any(|message| matches!(message, HostMessage::Notifications { .. })));
}

#[test]
fn the_portal_requests_ride_with_the_handshake() {
    // A reloaded page must still see a dialog an application is waiting on,
    // and a session it can stop.
    let mut session = Session::new();
    let request = PortalRequest {
        id: 1,
        app_id: "org.example.App".into(),
        parent_app_id: None,
        kind: PortalKind::Access(AccessDialog {
            title: "Use the camera?".into(),
            subtitle: String::new(),
            body: String::new(),
            grant_label: None,
            deny_label: None,
            destructive: false,
        }),
    };
    let remote = Capturing {
        id: 2,
        app_id: "org.example.Remote".into(),
        kind: CapturingKind::InputCapture {
            devices: Devices::default(),
        },
    };
    let told = session
        .host_mut()
        .set_portal_requests(vec![request.clone()], Vec::new());
    assert_eq!(
        told,
        Some(HostMessage::PortalRequests {
            items: vec![request.clone()],
            capturing: Vec::new(),
            shortcuts: Vec::new(),
            wallpaper: PortalWallpaper::default(),
        })
    );
    assert_eq!(
        session
            .host_mut()
            .set_portal_requests(vec![request.clone()], Vec::new()),
        None,
        "an unchanged list says nothing"
    );
    assert!(
        session
            .host_mut()
            .set_portal_requests(vec![request.clone()], vec![remote.clone()])
            .is_some(),
        "a new session is a change"
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(out.contains(&HostMessage::PortalRequests {
        items: vec![request],
        capturing: vec![remote],
        shortcuts: Vec::new(),
        wallpaper: PortalWallpaper::default(),
    }));
}

#[test]
fn bound_shortcuts_ride_with_the_dialogs_and_the_handshake() {
    // A reloaded page must grab the chords applications hold again.
    let mut session = Session::new();
    session
        .host_mut()
        .set_portal_requests(Vec::new(), Vec::new());
    let bound = BoundShortcut {
        id: 1,
        app_id: "org.example.App".into(),
        chord: "Ctrl+Alt+t".into(),
    };
    let expected = HostMessage::PortalRequests {
        items: Vec::new(),
        capturing: Vec::new(),
        shortcuts: vec![bound.clone()],
        wallpaper: PortalWallpaper::default(),
    };

    assert_eq!(
        session.host_mut().set_global_shortcuts(vec![bound.clone()]),
        Some(expected.clone())
    );
    assert_eq!(
        session.host_mut().set_global_shortcuts(vec![bound]),
        None,
        "an unchanged list says nothing"
    );
    assert_eq!(
        session
            .host_mut()
            .set_portal_requests(Vec::new(), Vec::new()),
        None,
        "the dialogs did not change either"
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));
    assert!(out.contains(&expected));
}

/// A stand-in keymap. The host passes it through as text without compiling
/// it.
const KEYMAP: &str = "xkb_keymap { /* the compositor's */ };";

#[test]
fn a_portal_wallpaper_rides_with_the_requests() {
    // A reloaded page must draw the picture an application set.
    let mut session = Session::new();
    session
        .host_mut()
        .set_portal_requests(Vec::new(), Vec::new());
    let wallpaper = PortalWallpaper {
        background: Some("/state/background-1.jpg".into()),
        lockscreen: None,
    };
    let told = HostMessage::PortalRequests {
        items: Vec::new(),
        capturing: Vec::new(),
        shortcuts: Vec::new(),
        wallpaper: wallpaper.clone(),
    };

    assert_eq!(
        session.host_mut().set_portal_wallpaper(wallpaper.clone()),
        Some(told.clone())
    );
    assert_eq!(
        session.host_mut().set_portal_wallpaper(wallpaper),
        None,
        "an unchanged wallpaper says nothing"
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(out.contains(&told));
}

#[test]
fn the_configs_appearance_rides_with_the_handshake() {
    // A reloaded page must follow the config's accent, contrast and motion.
    let mut session = Session::new();
    let appearance = Appearance {
        accent_color: Some("#3584e4".into()),
        high_contrast: true,
        reduced_motion: false,
        ..Appearance::default()
    };

    let appearances = Appearances {
        dark: appearance.clone(),
        light: appearance.clone(),
    };

    assert_eq!(
        session.host_mut().set_appearance(appearances.clone()),
        Some(HostMessage::Appearance(appearance.clone()))
    );
    assert_eq!(
        session.host_mut().set_appearance(appearances),
        None,
        "an unchanged appearance says nothing"
    );

    let out = session.ingest(&to_line(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: false,
    }));

    assert!(out.contains(&HostMessage::Appearance(appearance)));
}
