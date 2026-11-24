//! Behavior tests for `Host`.
//!
//! `Host` tracks Wayland apps, applies the chrome's focus requests and reports
//! changes back as `HostMessage`s. These tests need no Wayland or GPU.

use std::collections::BTreeMap;

use domicile_host::ipc::apply_chrome_message;
use domicile_host::{AppId, Appearances, BrowserWindow, Host, Mapped};
use domicile_protocol::{
    AdaptiveSync, AppFrame, Appearance, Capturing, CapturingKind, ChromeMessage, CursorTheme,
    DesktopStatus, Devices, DisplayHdr, DisplayInfo, DisplayTransform, HostMessage,
    InputConnection, InputKind, ListedDisplay, ListedInput, ListedView, ListedWindow, MonitorInfo,
    Owner, Theme, WindowKind, PROTOCOL_VERSION,
};
use domicile_scene::KeyboardTarget;

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

// ---- listings for `domicile list-*` ----------------------------------------

#[test]
fn each_display_is_listed_with_every_name_it_answers_to_and_whether_it_is_lit() {
    // `domicile list-displays` prints the names `sleep-displays` takes, so
    // they come from the monitors. A display with no monitor (a nested
    // desktop's window) answers to its own name.
    let mut host = Host::new();
    let laptop = lying_down("drm-1", [0, 0], [1280, 800], 2);
    let dock = lying_down("drm-2", [1280, 0], [1920, 1080], 1);
    let window = lying_down("domicile-0", [3200, 0], [800, 600], 1);
    host.describe_displays(vec![laptop.clone(), dock.clone(), window.clone()]);
    host.describe_monitors(vec![
        MonitorInfo {
            names: vec!["drm-1".into(), "eDP-1".into(), "BOE NE135A1M-NY1".into()],
            hdr: DisplayHdr::Unsupported,
        },
        MonitorInfo {
            names: vec!["drm-2".into(), "DP-1".into()],
            hdr: DisplayHdr::Unsupported,
        },
    ]);
    host.describe_darkness(false, vec!["DP-1".into()]);

    assert_eq!(
        host.list_displays(),
        HostMessage::DisplayList {
            displays: vec![
                ListedDisplay {
                    display: laptop,
                    names: vec!["drm-1".into(), "eDP-1".into(), "BOE NE135A1M-NY1".into()],
                    lit: true,
                },
                ListedDisplay {
                    display: dock,
                    names: vec!["drm-2".into(), "DP-1".into()],
                    lit: false,
                },
                ListedDisplay {
                    display: window.clone(),
                    names: vec!["domicile-0".into()],
                    lit: true,
                },
            ]
        }
    );

    host.describe_darkness(true, Vec::new());
    let HostMessage::DisplayList { displays } = host.list_displays() else {
        unreachable!("list_displays answers with a display list")
    };
    assert!(
        displays.iter().all(|listed| !listed.lit),
        "blanked or slept together, none is lit: {displays:?}"
    );
}

#[test]
fn every_window_is_listed_native_and_browser_alike() {
    // A script sees one list of windows, whoever draws them, each by its
    // `ext-foreign-toplevel-list-v1` identifier. Undrawn windows are not
    // listed, as the chromes have not heard of them.
    let mut host = Host::new();
    let owner = Owner { pid: 4242, ..OWNER };
    let editor = host.app_created(owner, "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA".to_string());
    host.app_mapped(&editor, mapped());
    host.app_titled(&editor, Some("notes.org".into()));
    host.app_desktop_id(&editor, "emacs".into());
    host.app_created(OWNER, "nW1zT5yB8vC2xF6hJ9pL4sR0gAkD3mQ7".to_string());
    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: editor.clone(),
    })
    .unwrap();
    host.browser_windows(vec![
        BrowserWindow {
            id: "3".into(),
            title: "Inbox".into(),
            app_id: "mail".into(),
            url: "https://mail.example/".into(),
            private: false,
            views: Vec::new(),
        },
        BrowserWindow {
            id: "7".into(),
            title: "Example".into(),
            app_id: String::new(),
            url: "https://example.com/".into(),
            private: true,
            views: Vec::new(),
        },
    ]);
    host.browser_toplevel_ids(BTreeMap::from([
        (
            "3".to_string(),
            "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".to_string(),
        ),
        (
            "7".to_string(),
            "aU2iO9pE4rT7yW1qZ5xC8vB3nM6lK0jH".to_string(),
        ),
    ]));

    assert_eq!(
        host.list_windows(),
        HostMessage::WindowList {
            windows: vec![
                ListedWindow {
                    id: "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA".into(),
                    kind: WindowKind::Native,
                    title: "notes.org".into(),
                    app: Some("emacs".into()),
                    pid: Some(4242),
                    size: Some(SIZE),
                    focused: true,
                    urgent: false,
                    url: None,
                    private: false,
                    engine_id: None,
                    views: Vec::new(),
                },
                ListedWindow {
                    id: "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".into(),
                    kind: WindowKind::Browser,
                    title: "Inbox".into(),
                    app: Some("mail".into()),
                    pid: None,
                    size: None,
                    focused: false,
                    urgent: false,
                    url: Some("https://mail.example/".into()),
                    private: false,
                    engine_id: Some("3".into()),
                    views: Vec::new(),
                },
                ListedWindow {
                    id: "aU2iO9pE4rT7yW1qZ5xC8vB3nM6lK0jH".into(),
                    kind: WindowKind::Browser,
                    title: "Example".into(),
                    app: None,
                    pid: None,
                    size: None,
                    focused: false,
                    urgent: false,
                    url: Some("https://example.com/".into()),
                    private: true,
                    engine_id: Some("7".into()),
                    views: Vec::new(),
                },
            ]
        }
    );
}

#[test]
fn a_browser_window_lists_the_views_it_holds() {
    // An Electron app such as Claude draws its whole page in views, so an
    // agent reads and drives them, not the window's empty page.
    let mut host = Host::new();
    let sidebar = ListedView {
        id: "8".into(),
        position: [0, 0],
        size: [200, 600],
    };
    let chat = ListedView {
        id: "9".into(),
        position: [200, 40],
        size: [600, 560],
    };
    host.browser_windows(vec![BrowserWindow {
        id: "5".into(),
        title: "Claude".into(),
        app_id: "claude-desktop".into(),
        url: "app://claude/".into(),
        private: false,
        views: vec![sidebar.clone(), chat.clone()],
    }]);
    host.browser_toplevel_ids(BTreeMap::from([(
        "5".to_string(),
        "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".to_string(),
    )]));

    let HostMessage::WindowList { windows } = host.list_windows() else {
        unreachable!("list_windows answers with a window list")
    };
    assert_eq!(windows[0].views, [sidebar, chat]);
}

#[test]
fn the_status_says_how_the_desktop_is_and_what_is_holding_or_watching_it() {
    // What a person checks before walking away: the theme, the lock, the
    // keymap, whether the screens are off, what keeps them on, and what is
    // recording or controlling the desktop.
    let mut host = Host::new();
    let remote = Capturing {
        id: 2,
        app_id: "org.example.Remote".into(),
        kind: CapturingKind::InputCapture {
            devices: Devices::default(),
        },
    };
    host.set_portal_requests(Vec::new(), vec![remote.clone()]);
    host.describe_darkness(true, Vec::new());

    assert_eq!(
        host.status(true, Some("dvorak".into()), vec!["Firefox".into()]),
        HostMessage::Status(DesktopStatus {
            theme: Theme::Dark,
            locked: true,
            keymap: Some("dvorak".into()),
            screens_off: true,
            held_awake_by: vec!["Firefox".into()],
            capturing: vec![remote],
        })
    );
    // Monitors slept one by one leave the rest lit.
    host.describe_darkness(false, vec!["DP-1".into()]);
    let HostMessage::Status(status) = host.status(false, None, Vec::new()) else {
        unreachable!("status answers with a status")
    };
    assert!(!status.screens_off);
    assert!(status.capturing.len() == 1);
}

// ---- app lifecycle --------------------------------------------------------

#[test]
fn a_window_names_the_process_that_owns_it() {
    // The shell needs an owner the client cannot forge. The compositor reads
    // it off the client's socket before the window exists.
    let mut host = Host::new();
    let owner = Owner {
        pid: 4242,
        uid: 1001,
        gid: 100,
        pidfd_inode: Some(5021),
        sandbox: None,
    };
    let app = host.app_created(owner.clone(), LISTED.to_string());

    let announced = host.app_mapped(&app, mapped());
    assert!(
        matches!(announced.first(), Some(HostMessage::AppAppeared { owner: told, .. }) if *told == owner),
        "{announced:?}"
    );
    // The replay for a reloading chrome includes it.
    assert_eq!(host.open_apps().first(), announced.first());
}

#[test]
fn a_window_names_its_handle_for_capture_tools() {
    // A shell hands a capture tool the window's `ext-foreign-toplevel-list-v1`
    // identifier, so the identifier the compositor listed it under is the one
    // the chromes hear, on a reload too.
    let mut host = Host::new();
    let app = host.app_created(OWNER, "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA".to_string());

    let announced = host.app_mapped(&app, mapped());

    assert!(
        matches!(
            announced.first(),
            Some(HostMessage::AppAppeared { toplevel_id, .. })
                if toplevel_id == "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA"
        ),
        "{announced:?}"
    );
    assert_eq!(host.open_apps().first(), announced.first());
}

#[test]
fn browser_windows_name_their_handles_for_capture_tools_when_they_change() {
    // Browser windows are the engine's, and the shell knows them by the
    // engine's ids. The whole map is restated on each change; latest wins.
    let mut host = Host::new();
    let listed = BTreeMap::from([
        (
            "3".to_string(),
            "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".to_string(),
        ),
        (
            "7".to_string(),
            "aU2iO9pE4rT7yW1qZ5xC8vB3nM6lK0jH".to_string(),
        ),
    ]);

    assert_eq!(
        host.browser_toplevel_ids(listed.clone()),
        Some(HostMessage::BrowserToplevelIds {
            toplevel_ids: listed.clone()
        })
    );
    assert_eq!(
        host.browser_toplevel_ids(listed),
        None,
        "an unchanged map is not restated"
    );
}

#[test]
fn a_chrome_that_arrives_late_is_told_each_browser_windows_handle() {
    // Before focus, as for the native windows. A desk with no browser windows
    // says nothing, which a chrome that just connected already knows.
    let mut host = Host::new();
    assert_eq!(
        host.open_apps(),
        vec![HostMessage::FocusChanged { app_id: None }]
    );
    let listed = BTreeMap::from([(
        "3".to_string(),
        "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".to_string(),
    )]);
    host.browser_toplevel_ids(listed.clone());

    assert_eq!(
        host.open_apps(),
        vec![
            HostMessage::BrowserToplevelIds {
                toplevel_ids: listed
            },
            HostMessage::FocusChanged { app_id: None },
        ]
    );
}

#[test]
fn a_window_says_what_it_is_called_when_the_client_says_it() {
    // A terminal retitles on every command, so title changes need their own
    // message.
    let mut host = Host::new();
    let app = drawn(&mut host);

    assert_eq!(
        host.app_titled(&app, Some("a terminal".to_string())),
        Some(HostMessage::AppTitled {
            app_id: app.clone(),
            title: Some("a terminal".to_string()),
        })
    );
    // The replay for a reloading chrome includes the title.
    assert_eq!(
        host.open_apps().first(),
        Some(&HostMessage::AppAppeared {
            app_id: app.clone(),
            title: Some("a terminal".to_string()),
            desktop_id: None,
            size: SIZE,
            dialog: false,
            client_frame: false,
            owner: OWNER,
            toplevel_id: LISTED.to_string(),
            frame: 0,
        })
    );
    // An unchanged title sends nothing.
    assert_eq!(host.app_titled(&app, Some("a terminal".to_string())), None);
    // An unknown app sends nothing.
    assert_eq!(host.app_titled("app-nowhere", None), None);
}

#[test]
fn a_window_says_which_desktop_entry_it_is_when_the_client_says_it() {
    // A client may change it after drawing, and a shell reads it to find the
    // app's icon.
    let mut host = Host::new();
    let app = drawn(&mut host);

    assert_eq!(
        host.app_desktop_id(&app, "org.gnome.Nautilus".to_string()),
        Some(HostMessage::AppDesktopId {
            app_id: app.clone(),
            desktop_id: "org.gnome.Nautilus".to_string(),
        })
    );
    // The replay for a reloading chrome includes it.
    assert_eq!(
        host.open_apps().first(),
        Some(&HostMessage::AppAppeared {
            app_id: app.clone(),
            title: None,
            desktop_id: Some("org.gnome.Nautilus".to_string()),
            size: SIZE,
            dialog: false,
            client_frame: false,
            owner: OWNER,
            toplevel_id: LISTED.to_string(),
            frame: 0,
        })
    );
    // An unchanged id sends nothing.
    assert_eq!(
        host.app_desktop_id(&app, "org.gnome.Nautilus".to_string()),
        None
    );
    // An unknown app sends nothing.
    assert_eq!(host.app_desktop_id("app-nowhere", String::new()), None);
}

#[test]
fn a_window_says_when_it_takes_and_gives_back_the_desktops_shortcuts() {
    // A remote desktop viewer or a VM takes every key while it has focus, and
    // the shell must know to let its chords through.
    let mut host = Host::new();
    let app = drawn(&mut host);

    assert_eq!(
        host.app_inhibits_shortcuts(&app, true),
        Some(HostMessage::AppInhibitsShortcuts {
            app_id: app.clone(),
            inhibits: true,
        })
    );
    // An unchanged state sends nothing.
    assert_eq!(host.app_inhibits_shortcuts(&app, true), None);
    assert_eq!(
        host.app_inhibits_shortcuts(&app, false),
        Some(HostMessage::AppInhibitsShortcuts {
            app_id: app.clone(),
            inhibits: false,
        })
    );
    // An unknown app sends nothing.
    assert_eq!(host.app_inhibits_shortcuts("app-nowhere", true), None);
}

#[test]
fn a_window_that_inhibits_before_it_draws_says_so_right_after_it_appears() {
    // A client may take its inhibitor before its first frame. The replay for a
    // reloading chrome says so too.
    let mut host = Host::new();
    let app = host.app_created(OWNER, LISTED.to_string());
    assert_eq!(host.app_inhibits_shortcuts(&app, true), None);

    let announced = host.app_mapped(&app, mapped());

    let inhibits = HostMessage::AppInhibitsShortcuts {
        app_id: app.clone(),
        inhibits: true,
    };
    assert!(
        matches!(announced.first(), Some(HostMessage::AppAppeared { .. })),
        "{announced:?}"
    );
    assert_eq!(announced.last(), Some(&inhibits));
    assert!(host.open_apps().contains(&inhibits));
}

#[test]
fn a_window_names_the_page_anchor_it_asked_for_right_after_it_appears() {
    // The shell lays an anchored window out at its anchor rather than tiling
    // it, so the anchor comes with the announcement and the replay.
    let mut host = Host::new();
    let app = host.app_created(OWNER, LISTED.to_string());
    assert_eq!(host.app_anchored(&app, Some("bar".to_string())), None);

    let announced = host.app_mapped(&app, mapped());

    let anchored = HostMessage::AppAnchored {
        app_id: app.clone(),
        anchor: Some("bar".to_string()),
    };
    assert!(
        matches!(announced.first(), Some(HostMessage::AppAppeared { .. })),
        "{announced:?}"
    );
    assert_eq!(announced.last(), Some(&anchored));
    assert!(host.open_apps().contains(&anchored));
}

#[test]
fn a_window_that_changes_its_anchor_says_so_once() {
    let mut host = Host::new();
    let app = drawn(&mut host);

    assert_eq!(host.app_anchored(&app, None), None, "it had none");
    assert_eq!(
        host.app_anchored(&app, Some("bar".to_string())),
        Some(HostMessage::AppAnchored {
            app_id: app.clone(),
            anchor: Some("bar".to_string()),
        })
    );
    assert_eq!(host.app_anchored(&app, Some("bar".to_string())), None);
    assert_eq!(
        host.app_anchored(&app, None),
        Some(HostMessage::AppAnchored {
            app_id: app.clone(),
            anchor: None,
        })
    );
    assert_eq!(host.app_anchored("app-nowhere", None), None);
}

#[test]
fn a_window_is_announced_when_it_first_draws_with_what_its_client_said_before() {
    // A client sets its title, app id and limits before its first frame. The
    // shell places a window once, so it needs them in the announcement.
    let mut host = Host::new();
    let app = host.app_created(OWNER, LISTED.to_string());

    assert_eq!(host.app_titled(&app, Some("pinentry".to_string())), None);
    assert_eq!(host.app_desktop_id(&app, "pinentry-qt".to_string()), None);
    assert_eq!(host.app_min_size(&app, (300.0, 0.0)), None);
    assert_eq!(host.app_resized(&app, SIZE.into()), None);
    assert_eq!(
        host.open_apps(),
        vec![HostMessage::FocusChanged { app_id: None }],
        "a reloaded chrome is not told about a window that has not drawn"
    );

    let announced = vec![
        HostMessage::AppAppeared {
            app_id: app.clone(),
            title: Some("pinentry".to_string()),
            desktop_id: Some("pinentry-qt".to_string()),
            size: SIZE,
            dialog: false,
            client_frame: true,
            owner: OWNER,
            toplevel_id: LISTED.to_string(),
            frame: 0,
        },
        HostMessage::AppMinSize {
            app_id: app.clone(),
            size: [300.0, 0.0],
        },
    ];
    assert_eq!(
        host.app_mapped(
            &app,
            Mapped {
                client_frame: true,
                ..mapped()
            }
        ),
        announced
    );
    assert_eq!(host.app_mapped(&app, mapped()), vec![], "announced once");
    assert_eq!(host.app_mapped("app-nowhere", mapped()), vec![]);
}

#[test]
fn a_window_with_a_parent_or_a_fixed_size_is_a_dialog() {
    let dialog = |limits: ((f64, f64), (f64, f64)), hints: Mapped| {
        let mut host = Host::new();
        let app = host.app_created(OWNER, LISTED.to_string());
        host.app_min_size(&app, limits.0);
        host.app_max_size(&app, limits.1);
        match host.app_mapped(&app, hints).first() {
            Some(HostMessage::AppAppeared { dialog, .. }) => *dialog,
            other => panic!("expected AppAppeared, got {other:?}"),
        }
    };
    let free = ((0.0, 0.0), (0.0, 0.0));

    assert!(!dialog(free, mapped()));
    assert!(dialog(
        free,
        Mapped {
            has_parent: true,
            ..mapped()
        }
    ));
    // Fixed on one axis, as sway reads it.
    assert!(dialog(((300.0, 200.0), (300.0, 0.0)), mapped()));
    // A minimum alone is a window that cannot shrink, not a dialog.
    assert!(!dialog(((300.0, 200.0), (0.0, 0.0)), mapped()));
    // A minimum on one axis only says nothing about the other.
    assert!(!dialog(((300.0, 0.0), (300.0, 0.0)), mapped()));
}

#[test]
fn a_dialog_says_whose_it_is_whenever_that_changes() {
    let mut host = Host::new();
    let parent = drawn(&mut host);
    let dialog = drawn(&mut host);

    assert_eq!(
        host.app_transient_for(&dialog, Some(parent.clone())),
        Some(HostMessage::AppTransientFor {
            app_id: dialog.clone(),
            transient_for: Some(parent.clone()),
        })
    );
    assert_eq!(host.app_transient_for(&dialog, Some(parent)), None);
    assert_eq!(
        host.app_transient_for(&dialog, None),
        Some(HostMessage::AppTransientFor {
            app_id: dialog,
            transient_for: None,
        })
    );
}

#[test]
fn a_dialog_whose_parent_closes_belongs_to_its_grandparent() {
    // xdg-shell: the children of an unmapped parent take its parent.
    let mut host = Host::new();
    let grandparent = drawn(&mut host);
    let parent = drawn(&mut host);
    let dialog = drawn(&mut host);
    host.app_transient_for(&parent, Some(grandparent.clone()));
    host.app_transient_for(&dialog, Some(parent.clone()));

    assert_eq!(
        host.app_closed(&parent),
        vec![
            HostMessage::AppClosed { app_id: parent },
            HostMessage::AppTransientFor {
                app_id: dialog,
                transient_for: Some(grandparent),
            },
        ]
    );
}

#[test]
fn what_a_window_said_before_drawing_follows_its_announcement() {
    // Also the replay a chrome that arrives late hears.
    let mut host = Host::new();
    let parent = drawn(&mut host);
    let dialog = host.app_created(OWNER, LISTED.to_string());
    assert_eq!(host.app_transient_for(&dialog, Some(parent.clone())), None);
    assert_eq!(host.app_urgent(&dialog), None);

    let announced = host.app_mapped(&dialog, mapped());

    assert_eq!(
        announced[1..],
        [
            HostMessage::AppTransientFor {
                app_id: dialog.clone(),
                transient_for: Some(parent),
            },
            HostMessage::AppUrgent {
                app_id: dialog,
                urgent: true,
            },
        ]
    );
    assert!(host.open_apps().ends_with(&[
        announced[1].clone(),
        announced[2].clone(),
        HostMessage::FocusChanged { app_id: None },
    ]));
}

#[test]
fn a_window_that_has_not_drawn_is_never_mentioned_to_the_chromes() {
    // The chromes have not heard of it.
    let mut host = Host::new();
    let app = host.app_created(OWNER, LISTED.to_string());

    assert_eq!(host.focus_requested(&app), None);
    assert_eq!(host.popup_placed(&app, (0.0, 0.0), (1.0, 1.0), false), None);
    assert_eq!(host.app_closed(&app), vec![], "nor hear that it closed");
    assert_eq!(host.app_mapped(&app, mapped()), vec![], "it is gone");
}

#[test]
fn a_chrome_that_arrives_late_is_told_about_every_window_already_open() {
    // `app_appeared` is sent once, when the client first draws. A chrome
    // that connects later, or reloads, learns about existing windows only
    // from this replay.
    let mut host = Host::new();
    let first = drawn(&mut host);
    host.app_titled(&first, Some("a terminal".to_string()));
    let second = drawn(&mut host);
    // Enough apps that hash map order almost surely differs from arrival
    // order. With two, an unordered implementation passes half the time.
    let rest: Vec<AppId> = (0..10).map(|_| drawn(&mut host)).collect();

    let announcements = host.open_apps();

    // In arrival order, so the chrome mounts windows the same way on each
    // reload.
    let expected: Vec<HostMessage> = [
        HostMessage::AppAppeared {
            app_id: first,
            title: Some("a terminal".to_string()),
            desktop_id: None,
            size: SIZE,
            dialog: false,
            client_frame: false,
            owner: OWNER,
            toplevel_id: LISTED.to_string(),
            frame: 0,
        },
        HostMessage::AppAppeared {
            app_id: second,
            title: None,
            desktop_id: None,
            size: SIZE,
            dialog: false,
            client_frame: false,
            owner: OWNER,
            toplevel_id: LISTED.to_string(),
            frame: 0,
        },
    ]
    .into_iter()
    .chain(rest.into_iter().map(|app_id| HostMessage::AppAppeared {
        app_id,
        title: None,
        desktop_id: None,
        size: SIZE,
        dialog: false,
        client_frame: false,
        owner: OWNER,
        toplevel_id: LISTED.to_string(),
        frame: 0,
    }))
    // Then the focus holder: the chrome, since no app has focus.
    .chain(std::iter::once(HostMessage::FocusChanged { app_id: None }))
    .collect();
    assert_eq!(announcements, expected);
}

#[test]
fn focus_is_reported_when_it_moves_and_not_when_it_does_not() {
    // A click in the compositor also moves focus, so the chrome needs a
    // message to track the active window.
    //
    // `focus_change` runs after every chrome message, so it reports only
    // actual changes. Otherwise every mouse move would send a message.
    let mut host = Host::new();
    let app = drawn(&mut host);

    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: app.clone(),
    })
    .unwrap();

    assert_eq!(
        host.focus_change(),
        vec![HostMessage::FocusChanged {
            app_id: Some(app.clone())
        }]
    );
    assert_eq!(host.focus_change(), vec![], "nothing moved the second time");
}

#[test]
fn the_keyboard_coming_back_to_the_chrome_is_reported_too() {
    // The chrome cannot infer this case, so it must be reported.
    let mut host = Host::new();
    let app = drawn(&mut host);
    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: app.clone(),
    })
    .unwrap();
    host.focus_change();

    host.handle_chrome_message(ChromeMessage::FocusChrome)
        .unwrap();

    assert_eq!(
        host.focus_change(),
        vec![HostMessage::FocusChanged { app_id: None }]
    );
}

#[test]
fn a_client_asking_for_the_keyboard_is_a_question_rather_than_a_move() {
    // The shell owns focus policy. The host forwards the request and leaves
    // the keyboard alone, so a shell can refuse a window that would interrupt
    // typing.
    let mut host = Host::new();
    let asking = drawn(&mut host);
    let typing = drawn(&mut host);
    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: typing.clone(),
    })
    .unwrap();
    host.focus_change();

    assert_eq!(
        host.focus_requested(&asking),
        Some(HostMessage::FocusRequested {
            app_id: asking.clone(),
        })
    );
    assert_eq!(
        host.focus_holder(),
        Some(typing),
        "asking is not getting: the keyboard has not moved"
    );
    assert_eq!(
        host.focus_change(),
        vec![],
        "and the chromes are told nothing"
    );
}

#[test]
fn a_window_refused_the_keyboard_wants_attention_until_it_gets_it() {
    let mut host = Host::new();
    let asking = drawn(&mut host);

    assert_eq!(
        host.app_urgent(&asking),
        Some(HostMessage::AppUrgent {
            app_id: asking.clone(),
            urgent: true,
        })
    );
    assert_eq!(host.app_urgent(&asking), None, "it already does");

    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: asking.clone(),
    })
    .unwrap();
    assert_eq!(
        host.focus_change(),
        vec![
            HostMessage::FocusChanged {
                app_id: Some(asking.clone())
            },
            HostMessage::AppUrgent {
                app_id: asking,
                urgent: false,
            },
        ]
    );
}

#[test]
fn a_window_holding_the_keyboard_never_wants_attention() {
    let mut host = Host::new();
    let typing = drawn(&mut host);
    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: typing.clone(),
    })
    .unwrap();
    host.focus_change();

    assert_eq!(host.app_urgent(&typing), None);
}

#[test]
fn a_client_nobody_has_heard_of_cannot_ask_for_the_keyboard() {
    // Same check as `focus_app`: no shell can act on a window it does not
    // know, so the host drops the request instead of every shell checking.
    let host = Host::new();

    assert_eq!(host.focus_requested("app-404"), None);
}

#[test]
fn a_focused_window_closing_hands_the_keyboard_back_and_says_so() {
    // The client may have crashed. Without a focus message the chrome would
    // keep marking the closed app active.
    let mut host = Host::new();
    let app = drawn(&mut host);
    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: app.clone(),
    })
    .unwrap();
    host.focus_change();

    host.app_closed(&app);

    assert_eq!(
        host.focus_change(),
        vec![HostMessage::FocusChanged { app_id: None }]
    );
}

#[test]
fn a_chrome_that_arrives_late_is_told_who_has_the_keyboard() {
    // A newly loaded page has no other way to learn the focus holder.
    let mut host = Host::new();
    let app = drawn(&mut host);
    host.handle_chrome_message(ChromeMessage::FocusApp {
        app_id: app.clone(),
    })
    .unwrap();

    let announced = host.open_apps();

    assert_eq!(
        announced.last(),
        Some(&HostMessage::FocusChanged {
            app_id: Some(app.clone())
        }),
        "after the windows, since it names one of them"
    );
    // The replay must not consume the change still owed to other chromes.
    assert_eq!(
        host.focus_change(),
        vec![HostMessage::FocusChanged { app_id: Some(app) }],
        "the delta the other chromes are still owed is untouched"
    );
}

#[test]
fn each_window_gets_its_own_id() {
    let mut host = Host::new();

    assert_ne!(
        host.app_created(OWNER, LISTED.to_string()),
        host.app_created(OWNER, LISTED.to_string())
    );
}

#[test]
fn a_popup_is_announced_as_its_own_app_over_its_window() {
    let mut host = Host::new();
    let window = drawn(&mut host);

    let (popup, placed) = host
        .popup_placed(&window, (12.0, 30.0), (180.0, 240.0), true)
        .expect("a window's popup is announced");

    // The engine embeds by id, so the popup takes one from the window
    // counter.
    assert_ne!(popup, window);
    assert_eq!(
        placed,
        HostMessage::PopupPlaced {
            app_id: popup.clone(),
            parent: window.clone(),
            position: [12.0, 30.0],
            size: [180.0, 240.0],
            grab: true,
            frames: vec![],
        }
    );
    // A popup over a popup is a submenu.
    assert!(host
        .popup_placed(&popup, (180.0, 0.0), (100.0, 100.0), true)
        .is_some());
    // A popup over an unknown app is not announced.
    assert!(host
        .popup_placed("app-nowhere", (0.0, 0.0), (1.0, 1.0), false)
        .is_none());
}

/// A press on a menu belongs to the window under it, so focusing a menu (or a
/// submenu) focuses that window and the menu's grab holds.
#[test]
fn focusing_a_popup_focuses_its_window() {
    let mut host = Host::new();
    let window = drawn(&mut host);
    let (menu, _) = host
        .popup_placed(&window, (12.0, 30.0), (180.0, 240.0), true)
        .unwrap();
    let (submenu, _) = host
        .popup_placed(&menu, (180.0, 0.0), (100.0, 100.0), true)
        .unwrap();

    host.handle_chrome_message(ChromeMessage::FocusApp { app_id: submenu })
        .unwrap();

    assert_eq!(host.focus_holder(), Some(window));
}

#[test]
fn a_popup_moved_is_placed_again_and_closed_like_a_window() {
    let mut host = Host::new();
    let window = drawn(&mut host);
    let (popup, _) = host
        .popup_placed(&window, (12.0, 30.0), (180.0, 240.0), false)
        .unwrap();

    assert_eq!(
        host.popup_moved(&popup, (40.0, 30.0), (180.0, 200.0)),
        Some(HostMessage::PopupPlaced {
            app_id: popup.clone(),
            parent: window.clone(),
            position: [40.0, 30.0],
            size: [180.0, 200.0],
            grab: false,
            frames: vec![],
        })
    );
    assert_eq!(
        host.popup_moved(&popup, (40.0, 30.0), (180.0, 200.0)),
        None,
        "a popup that stayed put is not placed again"
    );
    assert_eq!(host.popup_moved(&window, (0.0, 0.0), (1.0, 1.0)), None);

    assert_eq!(
        host.app_closed(&popup),
        vec![HostMessage::AppClosed {
            app_id: popup.clone()
        }]
    );
    assert_eq!(host.popup_moved(&popup, (0.0, 0.0), (1.0, 1.0)), None);
}

#[test]
fn a_reloaded_chrome_is_told_each_popup_after_what_it_is_over() {
    let mut host = Host::new();
    let window = drawn(&mut host);
    let (menu, _) = host
        .popup_placed(&window, (0.0, 30.0), (180.0, 240.0), true)
        .unwrap();
    let (submenu, _) = host
        .popup_placed(&menu, (180.0, 0.0), (100.0, 100.0), true)
        .unwrap();

    let told: Vec<String> =
        host.open_apps()
            .into_iter()
            .filter_map(|message| match message {
                HostMessage::AppAppeared { app_id, .. }
                | HostMessage::PopupPlaced { app_id, .. } => Some(app_id),
                _ => None,
            })
            .collect();

    assert_eq!(told, vec![window, menu, submenu]);
}

#[test]
fn each_synced_submit_of_a_surface_gets_the_next_frame() {
    // Frame 0 is the id the page allocated, so a surface's first synced
    // frame is 1. See docs/architecture/WINDOW-COMPOSITING.md#synced-frames.
    let mut host = Host::new();
    let window = drawn(&mut host);
    let (popup, _) = host
        .popup_placed(&window, (12.0, 30.0), (180.0, 240.0), false)
        .unwrap();

    assert_eq!(host.sync_frame(&window), Some(1));
    assert_eq!(host.sync_frame(&window), Some(2));
    // Each surface counts its own.
    assert_eq!(host.sync_frame(&popup), Some(1));
    assert_eq!(host.sync_frame("app-nowhere"), None);
}

#[test]
fn a_reloaded_chrome_is_told_the_frame_each_surface_is_at() {
    // A page that reloads allocates no new ids, so frame 0 would show a
    // stale frame until the next move.
    let mut host = Host::new();
    let window = drawn(&mut host);
    let (popup, _) = host
        .popup_placed(&window, (12.0, 30.0), (180.0, 240.0), false)
        .unwrap();
    host.sync_frame(&window);
    host.sync_frame(&window);
    host.sync_frame(&popup);

    let told = host.open_apps();

    assert!(
        matches!(
            told.first(),
            Some(HostMessage::AppAppeared { frame: 2, .. })
        ),
        "{told:?}"
    );
    assert!(
        told.iter().any(|message| matches!(
            message,
            HostMessage::PopupPlaced { frames, .. }
                if *frames == vec![AppFrame { app_id: popup.clone(), frame: 1 }]
        )),
        "{told:?}"
    );
}

#[test]
fn a_windows_size_limits_are_reported_when_they_change() {
    let mut host = Host::new();
    let id = drawn(&mut host);

    assert_eq!(
        host.app_min_size(&id, (680.0, 500.0)),
        Some(HostMessage::AppMinSize {
            app_id: id.clone(),
            size: [680.0, 500.0],
        })
    );
    // Clients restate their limits on unrelated commits; only changes are
    // reported.
    assert_eq!(host.app_min_size(&id, (680.0, 500.0)), None);
    assert_eq!(
        host.app_max_size(&id, (1920.0, 0.0)),
        Some(HostMessage::AppMaxSize {
            app_id: id.clone(),
            size: [1920.0, 0.0],
        })
    );
    assert_eq!(host.app_max_size(&id, (1920.0, 0.0)), None);
    // Zero means no limit, which is the initial state.
    let fresh = drawn(&mut host);
    assert_eq!(host.app_min_size(&fresh, (0.0, 0.0)), None);
    assert_eq!(host.app_min_size("app-nowhere", (1.0, 1.0)), None);
}

#[test]
fn a_reloaded_chrome_is_told_every_windows_size_limits() {
    let mut host = Host::new();
    let limited = drawn(&mut host);
    let free = drawn(&mut host);
    host.app_min_size(&limited, (680.0, 500.0));
    host.app_max_size(&limited, (1000.0, 800.0));

    let replayed = host.open_apps();

    let limits: Vec<&HostMessage> = replayed
        .iter()
        .filter(|message| {
            matches!(
                message,
                HostMessage::AppMinSize { .. } | HostMessage::AppMaxSize { .. }
            )
        })
        .collect();
    assert_eq!(
        limits,
        vec![
            &HostMessage::AppMinSize {
                app_id: limited.clone(),
                size: [680.0, 500.0],
            },
            &HostMessage::AppMaxSize {
                app_id: limited.clone(),
                size: [1000.0, 800.0],
            },
        ],
        "{free} has no limits, so nothing is said about it"
    );
    // Limits follow the window's announcement, which the chrome needs first.
    let appeared = replayed
        .iter()
        .position(|message| matches!(message, HostMessage::AppAppeared { app_id, .. } if *app_id == limited))
        .unwrap();
    let limited_at = replayed
        .iter()
        .position(|message| matches!(message, HostMessage::AppMinSize { .. }))
        .unwrap();
    assert!(appeared < limited_at);
}

#[test]
fn resizing_and_closing_report_to_chrome() {
    let mut host = Host::new();
    let id = drawn(&mut host);

    match host.app_resized(&id, (200.0, 150.0)) {
        Some(HostMessage::AppResized { app_id, size }) => {
            assert_eq!(app_id, id);
            assert_eq!(size, [200.0, 150.0]);
        }
        other => panic!("expected AppResized, got {other:?}"),
    }
    // The compositor reports the size of every frame; only a change is news.
    assert_eq!(host.app_resized(&id, (200.0, 150.0)), None);
    assert!(host.app_resized("ghost", (1.0, 1.0)).is_none());

    assert_eq!(
        host.app_closed(&id),
        vec![HostMessage::AppClosed { app_id: id.clone() }]
    );
    assert!(host.app_closed(&id).is_empty(), "closing twice is a no-op");
}

// ---- focus ----------------------------------------------------------------

#[test]
fn focus_routes_keyboard_between_app_and_chrome() {
    let mut host = Host::new();
    let id = drawn(&mut host);

    assert_eq!(host.keyboard_target(), KeyboardTarget::Chrome);

    host.handle_chrome_message(ChromeMessage::FocusApp { app_id: id.clone() })
        .unwrap();
    assert_eq!(host.keyboard_target(), KeyboardTarget::App(id.clone()));

    host.handle_chrome_message(ChromeMessage::FocusChrome)
        .unwrap();
    assert_eq!(host.keyboard_target(), KeyboardTarget::Chrome);
}

#[test]
fn spawn_is_a_no_op_in_the_brain() {
    // The compositor handles `Spawn` before it reaches `Host`.
    let mut host = Host::new();
    let before = format!("{host:?}");
    host.handle_chrome_message(ChromeMessage::Spawn {
        command: vec!["kitty".into()],
    })
    .unwrap();
    assert_eq!(format!("{host:?}"), before);
}

#[test]
fn asking_a_client_to_close_leaves_the_window_where_it_is() {
    // The client decides whether to close; an editor with unsaved work stays
    // up. Dropping the window here would remove its tab for good, since
    // `app_appeared` is sent once.
    let mut host = Host::new();
    let id = drawn(&mut host);

    host.handle_chrome_message(ChromeMessage::CloseApp { app_id: id.clone() })
        .unwrap();

    assert!(host.app(&id).is_some());
}

// ---- displays -------------------------------------------------------------

#[test]
fn the_displays_are_answered_after_the_welcome() {
    // The chrome must know the agreed protocol version before it reads any
    // other message in the handshake reply.
    let mut host = Host::new();
    host.describe_displays(vec![lying_down("left", [0, 0], [1920, 1080], 1)]);
    let mut ready = false;
    let answered = apply_chrome_message(
        &mut host,
        &mut ready,
        ChromeMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            checked: false,
        },
    );
    assert_eq!(
        answered,
        vec![
            HostMessage::Welcome {
                protocol_version: PROTOCOL_VERSION,
            },
            HostMessage::Displays {
                displays: vec![lying_down("left", [0, 0], [1920, 1080], 1)],
            },
            HostMessage::Theme { theme: Theme::Dark },
            HostMessage::WindowsTheme { theme: Theme::Dark },
            HostMessage::Appearance(Appearance::default()),
            HostMessage::ForceDark { sites: vec![] },
        ]
    );
}

#[test]
fn a_display_is_found_by_any_name_a_profile_calls_it() {
    // A person names a monitor by its connector or panel, not by the
    // `drm-<id>` it is advertised as.
    let mut host = Host::new();
    host.describe_monitors(vec![laptop(), monitor(&["HDMI-A-1"])]);

    assert_eq!(host.display_named("drm-1"), Ok("drm-1"));
    assert_eq!(host.display_named("eDP-1"), Ok("drm-1"));
    assert_eq!(host.display_named("BOE NE135A1M-NY1"), Ok("drm-1"));
    assert_eq!(host.display_named("HDMI-A-1"), Ok("HDMI-A-1"));
}

#[test]
fn a_display_not_found_lists_every_display_by_its_names() {
    let mut host = Host::new();
    host.describe_monitors(vec![laptop(), monitor(&["HDMI-A-1"])]);

    assert_eq!(
        host.display_named("DP-1"),
        Err(
            r#"no display "DP-1"; displays: "drm-1" / "eDP-1" / "BOE NE135A1M-NY1", "HDMI-A-1""#
                .to_string()
        )
    );
}

#[test]
fn a_name_two_displays_share_finds_neither() {
    // Identical monitors with no serial share a panel name.
    let mut host = Host::new();
    host.describe_monitors(vec![
        monitor(&["drm-1", "DP-1", "DEL DELL U2720Q"]),
        monitor(&["drm-2", "DP-2", "DEL DELL U2720Q"]),
    ]);

    assert_eq!(host.display_named("drm-2"), Ok("drm-2"));
    assert_eq!(
        host.display_named("DEL DELL U2720Q"),
        Err(
            r#"2 displays are "DEL DELL U2720Q"; displays: "drm-1" / "DP-1" / "DEL DELL U2720Q", "drm-2" / "DP-2" / "DEL DELL U2720Q""#
                .to_string()
        )
    );
}

/// The laptop panel, advertised as `drm-1`.
fn laptop() -> MonitorInfo {
    monitor(&["drm-1", "eDP-1", "BOE NE135A1M-NY1"])
}

/// A monitor answering to `names`, the first its output name.
fn monitor(names: &[&str]) -> MonitorInfo {
    MonitorInfo {
        names: names.iter().map(|name| name.to_string()).collect(),
        hdr: DisplayHdr::Unsupported,
    }
}

// ---- theme ----------------------------------------------------------------

#[test]
fn a_host_nobody_told_a_theme_is_the_one_the_chrome_was_drawn_against() {
    // Unlike the keymap, the theme always has a value. The default is dark,
    // which the chrome is designed for.
    assert_eq!(
        Host::new().describe_theme(),
        HostMessage::Theme { theme: Theme::Dark }
    );
}

#[test]
fn a_theme_that_moved_is_what_every_chrome_is_told() {
    // The compositor broadcasts the returned message to every chrome, not
    // only the one that toggled the theme.
    let mut host = Host::new();

    assert_eq!(
        host.set_theme(Theme::Light),
        vec![HostMessage::Theme {
            theme: Theme::Light
        }]
    );
    assert_eq!(
        host.describe_theme(),
        HostMessage::Theme {
            theme: Theme::Light
        },
        "and the chrome that connects next is told the one the desk is on"
    );
}

#[test]
fn a_theme_that_did_not_move_is_not_restated() {
    // Setting the current theme is common (config rewrites, new pages). A
    // broadcast would make every chrome run the wipe animation for nothing.
    let mut host = Host::new();
    host.set_theme(Theme::Light);

    assert_eq!(host.set_theme(Theme::Light), Vec::new());
}

#[test]
fn a_theme_with_its_own_appearance_restates_it() {
    // A cursor theme per mode: the browser redraws the pointer when the theme
    // flips, and a chrome that connects later is told the current one.
    let mut host = Host::new();
    let in_mode = |name: &str| Appearance {
        cursor: Some(CursorTheme {
            name: name.into(),
            size: 24,
        }),
        ..Appearance::default()
    };
    host.set_appearance(Appearances {
        dark: in_mode("Numix-Cursor"),
        light: in_mode("Numix-Cursor-Light"),
    });

    assert_eq!(
        host.set_theme(Theme::Light),
        vec![
            HostMessage::Theme {
                theme: Theme::Light
            },
            HostMessage::Appearance(in_mode("Numix-Cursor-Light")),
        ]
    );
    assert_eq!(
        host.describe_appearance(),
        HostMessage::Appearance(in_mode("Numix-Cursor-Light"))
    );
}

#[test]
fn the_windows_theme_is_kept_apart_from_the_chromes() {
    // Windows change theme only after every chrome captures its wipe's start
    // frame. Until then the chromes and windows have different themes, and a
    // chrome connecting in that gap needs both.
    let mut host = Host::new();
    host.set_theme(Theme::Light);

    assert_eq!(
        host.describe_windows_theme(),
        HostMessage::WindowsTheme { theme: Theme::Dark }
    );
    assert_eq!(
        host.set_windows_theme(Theme::Light),
        Some(HostMessage::WindowsTheme {
            theme: Theme::Light
        })
    );
    assert_eq!(host.set_windows_theme(Theme::Light), None);
}

#[test]
fn a_desktop_described_again_replaces_the_one_before_it() {
    // When nested, the compositor re-describes on every resize or scale
    // change of its window. Appending would keep every stale size.
    //
    // Checked on `describe_desktop` so a handshake bug does not fail this
    // test.
    let mut host = Host::new();
    host.describe_displays(vec![lying_down("old", [0, 0], [800, 600], 1)]);
    host.describe_displays(vec![lying_down("new", [0, 0], [1920, 1080], 2)]);
    assert_eq!(
        host.describe_desktop(),
        HostMessage::Displays {
            displays: vec![lying_down("new", [0, 0], [1920, 1080], 2)],
        }
    );
}

/// A display with no rotation and a mode equal to its size.
fn lying_down(name: &str, position: [i32; 2], size: [u32; 2], scale: u32) -> DisplayInfo {
    DisplayInfo {
        name: name.to_string(),
        position,
        size,
        scale,
        mode: size,
        refresh_mhz: 0,
        adaptive_sync: AdaptiveSync::Unsupported,
        hdr: DisplayHdr::Unsupported,
        peak_luminance: 0,
        sdr_white: 0,
        transform: DisplayTransform::Normal,
    }
}

/// The size [`drawn`] windows draw at.
const SIZE: [f64; 2] = [640.0, 480.0];

/// What a plain window says when it first draws.
fn mapped() -> Mapped {
    Mapped {
        size: SIZE.into(),
        has_parent: false,
        client_frame: false,
    }
}

/// A window that has drawn its first frame, announced to the chromes.
fn drawn(host: &mut Host) -> AppId {
    let app = host.app_created(OWNER, LISTED.to_string());
    host.app_mapped(&app, mapped());
    app
}

#[test]
fn the_inputs_listed_are_the_engines_last_report() {
    let mut host = Host::new();
    assert_eq!(
        host.list_inputs(),
        HostMessage::InputList { inputs: Vec::new() }
    );

    let keyboard = ListedInput {
        id: 4,
        name: "AT Translated Set 2 keyboard".into(),
        kind: InputKind::Keyboard,
        connection: InputConnection::Internal,
        sys_path: "/sys/devices/platform/i8042/serio0/input/input4".into(),
        vendor: 1,
        product: 1,
    };
    host.input_devices(vec![keyboard.clone()]);
    assert_eq!(
        host.list_inputs(),
        HostMessage::InputList {
            inputs: vec![keyboard]
        }
    );
}

#[test]
fn a_native_window_is_found_by_its_toplevel_id_and_others_are_refused_by_name() {
    let mut host = Host::new();
    let owner = Owner { pid: 4242, ..OWNER };
    let editor = host.app_created(owner, "kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA".to_string());
    host.app_mapped(&editor, mapped());
    host.app_created(OWNER, "nW1zT5yB8vC2xF6hJ9pL4sR0gAkD3mQ7".to_string());
    host.browser_toplevel_ids(BTreeMap::from([(
        "3".to_string(),
        "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE".to_string(),
    )]));

    assert_eq!(
        host.native_window("kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA"),
        Ok((editor, 4242))
    );
    let browser = host
        .native_window("Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE")
        .expect_err("a browser window is the shell's");
    assert!(browser.contains("browser window"), "{browser}");
    // An undrawn window is not listed, so it is not found either.
    let undrawn = host
        .native_window("nW1zT5yB8vC2xF6hJ9pL4sR0gAkD3mQ7")
        .expect_err("not listed");
    assert!(undrawn.contains("list-windows"), "{undrawn}");
}
