//! Behavior tests for `domicile-protocol`.
//!
//! Every message must round-trip through JSON, and tag and field names are
//! pinned because the JS client hard-codes them.

use domicile_protocol::{
    negotiate, AdaptiveSync, AppCursorImage, AppFrame, Appearance, BrowserProfile, ChromeMessage,
    ClipboardEntry, CursorHiding, CursorImage, CursorShape, CursorTheme, DisplayHdr, DisplayInfo,
    DisplayTransform, HostMessage, Owner, Passphrase, PointerConstraint, PointerOverWindow,
    SurfaceRect, PROTOCOL_VERSION,
};

fn chrome_round_trip(msg: &ChromeMessage) {
    let json = serde_json::to_string(msg).unwrap();
    let back: ChromeMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(*msg, back, "round-trip changed the message (json: {json})");
}

fn host_round_trip(msg: &HostMessage) {
    let json = serde_json::to_string(msg).unwrap();
    let back: HostMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(*msg, back, "round-trip changed the message (json: {json})");
}

#[test]
fn scroll_source_and_axis_stops_survive_the_wire() {
    for source in ["wheel", "finger", "continuous", "wheel_tilt"] {
        let wire = serde_json::json!({
            "type": "pointer_axis", "app_id": "term", "dx": 0.0, "dy": 4.5,
            "v120_x": 0, "v120_y": 0, "source": source,
            "stop_x": true, "stop_y": false,
        });
        let message: ChromeMessage = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(message).unwrap(), wire);
    }
}

#[test]
fn chrome_messages_round_trip() {
    chrome_round_trip(&ChromeMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        checked: true,
    });
    chrome_round_trip(&ChromeMessage::AppHello {
        protocol_version: PROTOCOL_VERSION,
    });
    chrome_round_trip(&ChromeMessage::FocusApp {
        app_id: "term".into(),
    });
    chrome_round_trip(&ChromeMessage::SetDevicePixelRatio { ratio: 1.5 });
    chrome_round_trip(&ChromeMessage::FocusChrome);
    chrome_round_trip(&ChromeMessage::Activity { input: None });
    chrome_round_trip(&ChromeMessage::Activity {
        input: Some("KeyPressed from AT Translated Set 2 keyboard".into()),
    });
    chrome_round_trip(&ChromeMessage::EngineFault {
        what: "A page stayed in fullscreen.".into(),
    });
    chrome_round_trip(&ChromeMessage::DeskPointer {
        at: Some((12.5, 3.0)),
        windows: vec![PointerOverWindow {
            id: "4".into(),
            at: (0.25, 0.5),
        }],
    });
    chrome_round_trip(&ChromeMessage::DeskPointer {
        at: None,
        windows: Vec::new(),
    });
    chrome_round_trip(&ChromeMessage::DeskCursor {
        image: Some(CursorImage {
            size: (1, 1),
            hotspot: (0, 0),
            scale: 2.0,
            bgra: "AQID/w==".into(),
        }),
    });
    chrome_round_trip(&ChromeMessage::DeskCursor { image: None });
    chrome_round_trip(&ChromeMessage::CloseApp {
        app_id: "term".into(),
    });
    chrome_round_trip(&ChromeMessage::Spawn {
        command: vec!["kitty".into(), "--hold".into()],
    });
    chrome_round_trip(&ChromeMessage::CopyClipboardEntry { entry: 7 });
    chrome_round_trip(&ChromeMessage::RemoveClipboardEntry { entry: 7 });
    chrome_round_trip(&ChromeMessage::PointerMotion {
        app_id: "term".into(),
        x: 12.5,
        y: 3.0,
        moved: true,
    });
    chrome_round_trip(&ChromeMessage::PointerRelative {
        app_id: "term".into(),
        dx: 3.5,
        dy: -2.0,
        dx_unaccel: 1.25,
        dy_unaccel: -0.5,
    });
    assert_eq!(
        serde_json::from_str::<ChromeMessage>(
            r#"{"type":"pointer_relative","app_id":"term","dx":3.5,"dy":-2.0,"dx_unaccel":1.25,"dy_unaccel":-0.5}"#
        )
        .unwrap(),
        ChromeMessage::PointerRelative {
            app_id: "term".into(),
            dx: 3.5,
            dy: -2.0,
            dx_unaccel: 1.25,
            dy_unaccel: -0.5,
        },
        "the engine's line parses"
    );
    chrome_round_trip(&ChromeMessage::PointerConstrained {
        app_id: "game".into(),
        active: true,
    });
    assert_eq!(
        serde_json::from_str::<ChromeMessage>(
            r#"{"type":"pointer_constrained","app_id":"game","active":false}"#
        )
        .unwrap(),
        ChromeMessage::PointerConstrained {
            app_id: "game".into(),
            active: false,
        },
        "the engine's line parses"
    );
    chrome_round_trip(&ChromeMessage::PointerLeave {
        app_id: "term".into(),
    });
    chrome_round_trip(&ChromeMessage::PointerButton {
        app_id: "term".into(),
        button: 0x110,
        pressed: true,
    });
    chrome_round_trip(&ChromeMessage::PointerAxis {
        app_id: "term".into(),
        dx: 0.0,
        dy: -15.0,
        v120_x: 0,
        v120_y: -120,
        source: domicile_protocol::PointerAxisSource::Wheel,
        stop_x: false,
        stop_y: false,
    });
    chrome_round_trip(&ChromeMessage::Key {
        app_id: "term".into(),
        keycode: 30,
        pressed: true,
    });
    chrome_round_trip(&ChromeMessage::SearchFiles {
        query: "plan".into(),
    });
    chrome_round_trip(&ChromeMessage::Unlock {
        passphrase: Passphrase::from("open sesame"),
    });
    chrome_round_trip(&ChromeMessage::Lock);
}

/// A file search carries a query and no path, so a page cannot choose which
/// directory the compositor reads.
#[test]
fn searching_for_something_to_open_names_no_directory() {
    let v = serde_json::to_value(ChromeMessage::SearchFiles {
        query: "plan".into(),
    })
    .unwrap();
    assert_eq!(
        v,
        serde_json::json!({"type": "search_files", "query": "plan"})
    );
}

/// Applications are read by a shell library on the system calls, not asked of
/// the compositor.
#[test]
fn an_app_search_is_not_a_chrome_message() {
    assert!(serde_json::from_value::<ChromeMessage>(
        serde_json::json!({"type": "search_apps", "query": "fire"})
    )
    .is_err());
}

#[test]
fn spawn_wire_shape_is_pinned() {
    let v = serde_json::to_value(ChromeMessage::Spawn {
        command: vec!["kitty".into()],
    })
    .unwrap();
    assert_eq!(v["type"], "spawn");
    assert_eq!(v["command"][0], "kitty");
}

#[test]
fn spellcheck_says_whether_and_in_which_languages() {
    let v = serde_json::to_value(HostMessage::Spellcheck {
        enabled: true,
        languages: vec!["en-US".into(), "de-DE".into()],
    })
    .unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "type": "spellcheck",
            "enabled": true,
            "languages": ["en-US", "de-DE"],
        })
    );
}

#[test]
fn browser_profiles_wire_shape_is_pinned() {
    let v = serde_json::to_value(HostMessage::BrowserProfiles {
        profiles: vec![BrowserProfile {
            id: "work".into(),
            name: "Work".into(),
            color: "#d97706".into(),
            private: false,
            extensions: Some(vec!["aeblfdkhhhdcdjpifhhbdiojplfjncoa".into()]),
        }],
        default_profile: "work".into(),
        default_private_profile: "private".into(),
        sites: [("github.com/acme".to_string(), "work".to_string())].into(),
    })
    .unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "type": "browser_profiles",
            "profiles": [{
                "id": "work",
                "name": "Work",
                "color": "#d97706",
                "private": false,
                "extensions": ["aeblfdkhhhdcdjpifhhbdiojplfjncoa"],
            }],
            "default_profile": "work",
            "default_private_profile": "private",
            "sites": { "github.com/acme": "work" },
        })
    );
}

#[test]
fn host_messages_round_trip() {
    host_round_trip(&HostMessage::ShellConfig {
        keys: [("Return".to_string(), 28), ("l".to_string(), 25)].into(),
        options: r#"{"clock":{"format":"12h"}}"#.to_string(),
    });
}

/// Search results echo the query, list paths relative to home in display
/// order, and give the total match count.
#[test]
fn what_a_search_found_is_named_from_home() {
    let v = serde_json::to_value(HostMessage::FoundFiles {
        query: "o".into(),
        files: vec!["Notes/today.org".into(), "src/".into()],
        matched: 40,
        indexing: true,
    })
    .unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "type": "found_files",
            "query": "o",
            "files": ["Notes/today.org", "src/"],
            "matched": 40,
            "indexing": true,
        })
    );
}

/// Clipboard entries carry an id and a preview, never the full text, newest
/// first. Only an image row has a thumbnail.
#[test]
fn a_clipboard_row_is_an_id_and_enough_to_recognize_it_by() {
    let v = serde_json::to_value(HostMessage::Clipboard {
        entries: vec![
            ClipboardEntry {
                id: 3,
                image: false,
                preview: "the newest".into(),
                thumbnail: None,
                current: true,
            },
            ClipboardEntry {
                id: 1,
                image: true,
                preview: "Image, 3 × 2".into(),
                thumbnail: Some("data:image/png;base64,iVBORw0KGgo=".into()),
                current: false,
            },
        ],
    })
    .unwrap();
    assert_eq!(v["type"], "clipboard");
    assert_eq!(
        v["entries"],
        serde_json::json!([
            {"id": 3, "image": false, "preview": "the newest", "current": true},
            {"id": 1, "image": true, "preview": "Image, 3 × 2",
             "thumbnail": "data:image/png;base64,iVBORw0KGgo=", "current": false},
        ])
    );
}

/// An empty clipboard history serializes as an empty list, not as nothing.
///
/// The history starts empty on every desktop start, so shells must receive it.
#[test]
fn a_desktop_nothing_was_copied_on_has_an_empty_clipboard() {
    let v = serde_json::to_value(HostMessage::Clipboard { entries: vec![] }).unwrap();
    assert_eq!(v["type"], "clipboard");
    assert_eq!(v["entries"], serde_json::json!([]));
}

/// Restoring a clipboard entry carries its id and no text, so a page cannot
/// write arbitrary clipboard contents.
#[test]
fn an_entry_is_handed_back_by_id_rather_than_by_its_text() {
    let v = serde_json::to_value(ChromeMessage::CopyClipboardEntry { entry: 7 }).unwrap();
    assert_eq!(v["type"], "copy_clipboard_entry");
    assert_eq!(v["entry"], 7);
}

/// Idle is sent as a state, not an edge, so a reloaded page can be told where
/// the desktop stands.
#[test]
fn whether_anybody_is_at_the_desk_is_a_state_rather_than_an_edge() {
    let dark = serde_json::to_value(HostMessage::Idle { idle: true }).unwrap();
    assert_eq!(dark["type"], "idle");
    assert_eq!(dark["idle"], true);

    let here = serde_json::to_value(HostMessage::Idle { idle: false }).unwrap();
    assert_eq!(here["type"], "idle");
    assert_eq!(
        here["idle"], false,
        "somebody coming back is the same message saying the other thing"
    );
}

/// Locked is sent as a state, so a reloaded page can be told `true` and show
/// its lock screen again.
#[test]
fn whether_the_desk_is_locked_is_a_state_rather_than_an_edge() {
    let shut = serde_json::to_value(HostMessage::Locked { locked: true }).unwrap();
    assert_eq!(shut["type"], "locked");
    assert_eq!(shut["locked"], true);

    let open = serde_json::to_value(HostMessage::Locked { locked: false }).unwrap();
    assert_eq!(open["type"], "locked");
    assert_eq!(
        open["locked"], false,
        "a desk that has just been opened is the same message saying the other thing"
    );
}

/// An unlock carries only the passphrase; the answer is
/// [`HostMessage::Locked`] to every chrome.
#[test]
fn an_unlock_carries_the_passphrase_and_nothing_else() {
    let v = serde_json::to_value(ChromeMessage::Unlock {
        passphrase: Passphrase::from("open sesame"),
    })
    .unwrap();
    assert_eq!(
        v,
        serde_json::json!({"type": "unlock", "passphrase": "open sesame"})
    );
}

/// A lock request carries only its tag.
#[test]
fn a_lock_is_the_tag_and_nothing_else() {
    let v = serde_json::to_value(ChromeMessage::Lock).unwrap();
    assert_eq!(v, serde_json::json!({"type": "lock"}));
}

/// `Debug` output never contains the passphrase, so a `debug!` of a message
/// cannot leak it to the journal.
#[test]
fn a_passphrase_is_never_what_a_log_line_prints() {
    let secret = "correct horse battery staple";

    assert!(!format!("{:?}", Passphrase::from(secret)).contains(secret));

    // Including through the message, as a trace macro would format it.
    let message = ChromeMessage::Unlock {
        passphrase: Passphrase::from(secret),
    };
    assert!(
        !format!("{message:?}").contains(secret),
        "a message that prints its passphrase is one log line from the journal"
    );

    // The value itself is preserved.
    assert_eq!(Passphrase::from(secret).as_str(), secret);
}

/// The chrome assigns the cursor straight to CSS `cursor`, so every shape must
/// serialize to a valid CSS keyword.
#[test]
fn cursor_shapes_are_css_keywords() {
    let shape = |shape: CursorShape| serde_json::to_value(shape).unwrap();
    assert_eq!(shape(CursorShape::None), "none");
    assert_eq!(shape(CursorShape::Default), "default");
    assert_eq!(shape(CursorShape::Text), "text");
    assert_eq!(shape(CursorShape::NotAllowed), "not-allowed");
    assert_eq!(shape(CursorShape::NwseResize), "nwse-resize");
    assert_eq!(shape(CursorShape::ZoomIn), "zoom-in");
}

#[test]
fn the_desktop_is_described_to_the_chrome() {
    // Pin the wire shape as well as round-tripping, because shells read these
    // field names directly.
    let displays = HostMessage::Displays {
        displays: vec![
            DisplayInfo {
                name: "left".into(),
                position: [0, 0],
                size: [1920, 1080],
                scale: 1,
                mode: [1920, 1080],
                refresh_mhz: 0,
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: DisplayHdr::Unsupported,
                peak_luminance: 0,
                sdr_white: 0,
                transform: DisplayTransform::Normal,
            },
            DisplayInfo {
                name: "right".into(),
                position: [1920, 0],
                size: [2560, 1440],
                scale: 2,
                mode: [5120, 2880],
                refresh_mhz: 0,
                adaptive_sync: AdaptiveSync::On,
                hdr: DisplayHdr::On,
                peak_luminance: 1000,
                sdr_white: 203,
                transform: DisplayTransform::Normal,
            },
        ],
    };
    host_round_trip(&displays);

    let v = serde_json::to_value(displays).unwrap();
    assert_eq!(v["type"], "displays");
    assert_eq!(v["displays"][0]["name"], "left");
    assert_eq!(v["displays"][0]["position"], serde_json::json!([0, 0]));
    assert_eq!(v["displays"][1]["name"], "right");
    assert_eq!(v["displays"][1]["position"][0], 1920);
    assert_eq!(v["displays"][1]["size"][1], 1440);
    assert_eq!(v["displays"][1]["scale"], 2);
    assert_eq!(v["displays"][1]["mode"], serde_json::json!([5120, 2880]));
    assert_eq!(v["displays"][1]["transform"], "normal");
    assert_eq!(v["displays"][0]["adaptive_sync"], "unsupported");
    assert_eq!(v["displays"][1]["adaptive_sync"], "on");
    assert_eq!(v["displays"][0]["hdr"], "unsupported");
    assert_eq!(v["displays"][1]["hdr"], "on");
    assert_eq!(v["displays"][1]["peak_luminance"], 1000);
    assert_eq!(v["displays"][1]["sdr_white"], 203);
}

#[test]
fn a_monitor_on_its_side_says_so_and_says_what_it_scans_out() {
    // `size` is the logical box and `mode` the panel's pixels before rotation.
    // Neither derives from the other, because `scale` is the integer
    // `wl_output` scale: 3840x2160 rotated at density 1.2 is 1800x3200.
    // Transforms use the config file's kebab-case spelling.
    let v = serde_json::to_value(DisplayInfo {
        name: "drm-3".into(),
        position: [0, 0],
        size: [1800, 3200],
        scale: 2,
        mode: [3840, 2160],
        refresh_mhz: 0,
        adaptive_sync: AdaptiveSync::Unsupported,
        hdr: DisplayHdr::Unsupported,
        peak_luminance: 0,
        sdr_white: 0,
        transform: DisplayTransform::Rotate270,
    })
    .unwrap();
    assert_eq!(v["size"], serde_json::json!([1800, 3200]));
    assert_eq!(v["mode"], serde_json::json!([3840, 2160]));
    assert_eq!(v["transform"], "rotate-270");
}

#[test]
fn a_display_that_predates_these_fields_still_reads() {
    // Older messages, such as fixtures, may lack these fields. They default to
    // an unrotated display.
    let old: DisplayInfo =
        serde_json::from_str(r#"{"name":"left","position":[0,0],"size":[1920,1080],"scale":1}"#)
            .expect("it reads");
    assert_eq!(old.transform, DisplayTransform::Normal);
    assert_eq!(old.adaptive_sync, AdaptiveSync::Unsupported);
    assert_eq!(old.hdr, DisplayHdr::Unsupported);
    assert_eq!((old.peak_luminance, old.sdr_white), (0, 0));
    // `[0, 0]`, not the size: an unstated mode stays unstated.
    assert_eq!(old.mode, [0, 0]);
}

#[test]
fn which_turns_trade_a_monitors_width_for_its_height() {
    // Getting this backwards draws the desktop at the wrong scale rather than
    // failing.
    assert!(!DisplayTransform::Normal.swaps_axes());
    assert!(!DisplayTransform::Rotate180.swaps_axes());
    assert!(DisplayTransform::Rotate90.swaps_axes());
    assert!(DisplayTransform::Rotate270.swaps_axes());
}

#[test]
fn a_desktop_of_no_displays_is_a_message_rather_than_a_silence() {
    // The compositor always describes at least one display, but a `Host` with
    // no desktop described (unit tests, the `domicile` daemon) sends an empty
    // list. Check the wire form, since a round trip cannot tell `[]` from a
    // missing field.
    let v = serde_json::to_value(HostMessage::Displays { displays: vec![] }).unwrap();
    assert_eq!(v["type"], "displays");
    assert_eq!(v["displays"], serde_json::json!([]));
}

#[test]
fn wire_shape_is_pinned() {
    // The JS client depends on these exact strings.
    let v = serde_json::to_value(HostMessage::AppAppeared {
        app_id: "term".into(),
        title: None,
        desktop_id: None,
        size: [640.0, 480.0],
        dialog: true,
        client_frame: true,
        owner: Owner {
            pid: 7,
            uid: 1000,
            gid: 1000,
            pidfd_inode: None,
            sandbox: None,
        },
        toplevel_id: "Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa".into(),
        frame: 0,
    })
    .unwrap();
    assert_eq!(v["size"], serde_json::json!([640.0, 480.0]));
    assert_eq!(v["dialog"], true);
    assert_eq!(v["client_frame"], true);

    let v = serde_json::to_value(HostMessage::AppCursor {
        app_id: "term".into(),
        cursor: CursorShape::Pointer,
        image: None,
    })
    .unwrap();
    assert_eq!(v["type"], "app_cursor");
    assert_eq!(v["cursor"], "pointer");
    assert!(v.get("image").is_none(), "a named cursor carries no image");

    let drawn = HostMessage::AppCursor {
        app_id: "gimp".into(),
        cursor: CursorShape::Default,
        image: Some(AppCursorImage {
            png: "iVBORw0KGgo=".into(),
            hotspot: (3, 4),
            scale: 2,
        }),
    };
    host_round_trip(&drawn);
    let v = serde_json::to_value(drawn).unwrap();
    assert_eq!(
        v["image"],
        serde_json::json!({ "png": "iVBORw0KGgo=", "hotspot": [3, 4], "scale": 2 })
    );
}

/// The engine reads a pointer constraint by these names, and `null` for none.
#[test]
fn a_pointer_constraint_goes_out_by_name() {
    for (constraint, wire) in [
        (Some(PointerConstraint::Lock), serde_json::json!("lock")),
        (
            Some(PointerConstraint::Confine),
            serde_json::json!("confine"),
        ),
        (None, serde_json::Value::Null),
    ] {
        let message = HostMessage::AppPointerConstraint {
            app_id: "game".into(),
            constraint,
            region: None,
        };
        host_round_trip(&message);
        let v = serde_json::to_value(&message).unwrap();
        assert_eq!(v["type"], "app_pointer_constraint");
        assert_eq!(v["constraint"], wire);
        assert_eq!(v["region"], serde_json::Value::Null);
    }
}

/// The engine reads a constraint's region as rectangles of the surface.
#[test]
fn a_pointer_constraint_region_goes_out_as_rectangles() {
    let message = HostMessage::AppPointerConstraint {
        app_id: "game".into(),
        constraint: Some(PointerConstraint::Confine),
        region: Some(vec![SurfaceRect {
            x: 10,
            y: 20,
            width: 300,
            height: 200,
        }]),
    };
    host_round_trip(&message);
    assert_eq!(
        serde_json::to_value(&message).unwrap()["region"],
        serde_json::json!([{ "x": 10, "y": 20, "width": 300, "height": 200 }])
    );
}

/// The browser process reads `cursor` off `appearance` by these names.
#[test]
fn the_pointer_theme_rides_on_the_appearance() {
    let themed = HostMessage::Appearance(Appearance {
        cursor: Some(CursorTheme {
            name: "Bibata-Modern-Amber-Right".into(),
            size: 64,
        }),
        ..Appearance::default()
    });
    host_round_trip(&themed);
    let v = serde_json::to_value(themed).unwrap();
    assert_eq!(
        v["cursor"],
        serde_json::json!({ "name": "Bibata-Modern-Amber-Right", "size": 64 })
    );

    let v = serde_json::to_value(HostMessage::Appearance(Appearance::default())).unwrap();
    assert!(v.get("cursor").is_none(), "{v}");
}

/// The browser process reads `cursor_hiding` off `appearance` by these names.
#[test]
fn hiding_the_pointer_rides_on_the_appearance() {
    let hiding = HostMessage::Appearance(Appearance {
        cursor_hiding: Some(CursorHiding {
            after_ms: Some(1000),
            when_typing: true,
        }),
        ..Appearance::default()
    });
    host_round_trip(&hiding);
    let v = serde_json::to_value(hiding).unwrap();
    assert_eq!(
        v["cursor_hiding"],
        serde_json::json!({ "after_ms": 1000, "when_typing": true })
    );

    let v = serde_json::to_value(HostMessage::Appearance(Appearance {
        cursor_hiding: Some(CursorHiding {
            after_ms: None,
            when_typing: true,
        }),
        ..Appearance::default()
    }))
    .unwrap();
    assert_eq!(
        v["cursor_hiding"],
        serde_json::json!({ "when_typing": true })
    );

    let v = serde_json::to_value(HostMessage::Appearance(Appearance::default())).unwrap();
    assert!(v.get("cursor_hiding").is_none(), "{v}");
}

#[test]
fn version_negotiation_accepts_matching_version() {
    assert_eq!(negotiate(PROTOCOL_VERSION).unwrap(), PROTOCOL_VERSION);
}

#[test]
fn version_negotiation_rejects_mismatch() {
    assert!(negotiate(PROTOCOL_VERSION + 1).is_err());
}

/// `resize_app` is not a message, and is rejected rather than ignored.
///
/// The engine reports window size through `xdg_toplevel.configure`. Rejection
/// makes the compositor log any chrome that still sends it.
#[test]
fn a_resize_the_chrome_no_longer_sends_is_not_a_message() {
    let line = r#"{"type":"resize_app","app_id":"term","size":[800.0,600.0]}"#;
    assert!(
        serde_json::from_str::<ChromeMessage>(line).is_err(),
        "the host still reads a resize the chrome no longer sends"
    );
}

/// `preview_file` is not a message: a shell previews a file with its system
/// calls.
#[test]
fn a_preview_the_chrome_no_longer_asks_for_is_not_a_message() {
    let line = r#"{"type":"preview_file","path":"Notes/today.org"}"#;
    assert!(
        serde_json::from_str::<ChromeMessage>(line).is_err(),
        "the host still reads a preview the chrome no longer asks for"
    );
}

/// `shortcut` is not a host message: the engine matches grabbed chords
/// itself, and the compositor never sent one.
#[test]
fn a_shortcut_the_host_never_sent_is_not_a_message() {
    let line = r#"{"type":"shortcut","shortcut":{"key":24,"alt":false,"ctrl":true,"shift":false,"logo":true}}"#;
    assert!(
        serde_json::from_str::<HostMessage>(line).is_err(),
        "the chrome still reads a shortcut the host never sends"
    );
}

/// A move names the synced frame of each surface it goes with, so the page
/// shows them together. See
/// `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.
#[test]
fn a_move_names_the_frames_it_shows_with() {
    let v = serde_json::to_value(HostMessage::PopupPlaced {
        app_id: "app-3".into(),
        parent: "app-2".into(),
        position: [12.0, 30.0],
        size: [180.0, 240.0],
        grab: false,
        frames: vec![AppFrame {
            app_id: "app-2".into(),
            frame: 4,
        }],
    })
    .unwrap();
    assert_eq!(
        v["frames"],
        serde_json::json!([{"app_id": "app-2", "frame": 4}])
    );
}

/// A window can be past frame 0 when a page first hears of it, as after a
/// reload, so its announcement names the frame to show.
#[test]
fn a_window_appears_at_its_synced_frame() {
    let at = |frame| {
        serde_json::to_value(HostMessage::AppAppeared {
            app_id: "app-1".into(),
            title: None,
            desktop_id: None,
            size: [400.0, 300.0],
            dialog: false,
            client_frame: false,
            owner: Owner {
                pid: 1,
                uid: 1000,
                gid: 1000,
                pidfd_inode: None,
                sandbox: None,
            },
            toplevel_id: "Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa".into(),
            frame,
        })
        .unwrap()
    };
    assert_eq!(at(0).get("frame"), None);
    assert_eq!(at(7)["frame"], 7);
}

/// A page that renders `<app frame>` asks for synced frames with the tag
/// alone.
#[test]
fn asking_for_synced_frames_is_the_tag_and_nothing_else() {
    let v = serde_json::to_value(ChromeMessage::SyncFrames).unwrap();
    assert_eq!(v, serde_json::json!({"type": "sync_frames"}));
}

/// A window laid out at a page anchor names it; one that left its anchor
/// names none. See `docs/architecture/WINDOW-COMPOSITING.md#anchored-windows`.
#[test]
fn an_anchored_window_names_its_anchor_or_null() {
    let anchored = |anchor: Option<&str>| {
        serde_json::to_value(HostMessage::AppAnchored {
            app_id: "app-2".into(),
            anchor: anchor.map(str::to_string),
        })
        .unwrap()
    };
    assert_eq!(
        anchored(Some("bar")),
        serde_json::json!({"type": "app_anchored", "app_id": "app-2", "anchor": "bar"})
    );
    assert_eq!(anchored(None)["anchor"], serde_json::Value::Null);
}

/// The engine writes these lines itself (`ControlChannel::DeskPointerMoved`).
#[test]
fn the_desk_pointer_is_a_point_or_nothing_on_the_wire() {
    assert_eq!(
        serde_json::from_str::<ChromeMessage>(r#"{"type":"desk_pointer","at":[12.5,3.0]}"#)
            .expect("parsed"),
        ChromeMessage::DeskPointer {
            at: Some((12.5, 3.0)),
            windows: Vec::new(),
        }
    );
    assert_eq!(
        serde_json::from_str::<ChromeMessage>(r#"{"type":"desk_pointer"}"#).expect("parsed"),
        ChromeMessage::DeskPointer {
            at: None,
            windows: Vec::new(),
        }
    );
    assert_eq!(
        serde_json::from_str::<ChromeMessage>(
            r#"{"type":"desk_pointer","at":[12.5,3.0],"windows":[{"id":"4","at":[0.25,0.5]}]}"#
        )
        .expect("parsed"),
        ChromeMessage::DeskPointer {
            at: Some((12.5, 3.0)),
            windows: vec![PointerOverWindow {
                id: "4".into(),
                at: (0.25, 0.5),
            }],
        }
    );
}

/// The engine writes these lines itself (`ControlChannel::DeskCursorChanged`).
#[test]
fn the_desk_cursor_is_an_image_or_nothing_on_the_wire() {
    assert_eq!(
        serde_json::from_str::<ChromeMessage>(
            r#"{"image":{"bgra":"AQID/w==","hotspot":[0,0],"scale":2.0,"size":[1,1]},"type":"desk_cursor"}"#
        )
        .expect("parsed"),
        ChromeMessage::DeskCursor {
            image: Some(CursorImage {
                size: (1, 1),
                hotspot: (0, 0),
                scale: 2.0,
                bgra: "AQID/w==".into(),
            }),
        }
    );
    assert_eq!(
        serde_json::from_str::<ChromeMessage>(r#"{"type":"desk_cursor"}"#).expect("parsed"),
        ChromeMessage::DeskCursor { image: None }
    );
}
