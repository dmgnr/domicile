//! Tests for turning StatusNotifierItem registrations and properties into
//! tray items.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use domicile_host::tray::{
    address, item, menu_clicked, method, Landed, Pixmap, Properties, Reads, Registry, Status,
    TrayIcons,
};
use domicile_protocol::{Bus, SystemRequest, TrayAction, TrayItem};

/// A temporary data directory holding `files` as (relative path, bytes).
fn data_dir(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a directory to write in");
    for (path, bytes) in files {
        let at = dir.path().join(path);
        fs::create_dir_all(at.parent().expect("a parent")).unwrap();
        fs::write(at, bytes).unwrap();
    }
    dir
}

fn icons_in(dir: &Path) -> TrayIcons {
    TrayIcons::new(vec![dir.to_path_buf()], None)
}

/// A data directory with `sync` in `hicolor` and in the theme `Papirus`.
fn themed_data_dir() -> tempfile::TempDir {
    data_dir(&[
        ("icons/hicolor/22x22/status/sync.png", b"hicolor"),
        (
            "icons/Papirus/index.theme",
            b"[Icon Theme]\nDirectories=22x22/panel\n[22x22/panel]\nSize=22\nContext=Panel\n",
        ),
        ("icons/Papirus/22x22/panel/sync.svg", b"<svg/>"),
    ])
}

fn properties() -> Properties {
    Properties {
        id: "nm-applet".into(),
        title: String::new(),
        tooltip: String::new(),
        status: Status::Active,
        icon_name: String::new(),
        icon_pixmaps: Vec::new(),
        attention_icon_name: String::new(),
        attention_pixmaps: Vec::new(),
        icon_theme_path: String::new(),
        menu: String::new(),
        item_is_menu: false,
    }
}

/// An opaque red square pixmap in StatusNotifierItem format (big-endian
/// ARGB).
fn red_pixel(size: i32) -> Pixmap {
    Pixmap {
        width: size,
        height: size,
        argb: [0xff, 0xff, 0x00, 0x00].repeat((size * size) as usize),
    }
}

mod addresses {
    use super::*;

    #[test]
    fn a_bus_name_is_answered_at_the_specs_path() {
        // KDE registers a well-known name; the item is at the spec's default
        // path.
        assert_eq!(
            address("org.kde.StatusNotifierItem-4071-1", ":1.9"),
            (
                "org.kde.StatusNotifierItem-4071-1".into(),
                "/StatusNotifierItem".into()
            )
        );
    }

    #[test]
    fn a_path_is_answered_by_whoever_registered_it() {
        // libappindicator registers a path on the calling connection.
        assert_eq!(
            address("/org/ayatana/NotificationItem/nm_applet", ":1.42"),
            (
                ":1.42".into(),
                "/org/ayatana/NotificationItem/nm_applet".into()
            )
        );
    }

    #[test]
    fn a_name_with_a_path_after_it_is_both() {
        assert_eq!(
            address(":1.42/org/blueman/sni", ":1.9"),
            (":1.42".into(), "/org/blueman/sni".into())
        );
    }
}

mod items {
    use super::*;

    #[test]
    fn a_passive_item_is_not_in_the_tray() {
        // Trays hide passive items.
        let dir = data_dir(&[]);
        let passive = Properties {
            status: Status::Passive,
            ..properties()
        };

        assert_eq!(
            item("an-id", ":1.42", passive, &mut icons_in(dir.path())),
            None
        );
    }

    #[test]
    fn the_title_is_the_tooltip_then_the_title_then_the_id() {
        let dir = data_dir(&[]);
        let mut icons = icons_in(dir.path());
        let title = |properties: Properties, icons: &mut TrayIcons| {
            item("an-id", ":1.42", properties, icons).map(|told| told.title)
        };

        assert_eq!(
            title(
                Properties {
                    title: "Network".into(),
                    tooltip: "Wired connection 1".into(),
                    ..properties()
                },
                &mut icons
            ),
            Some("Wired connection 1".into())
        );
        assert_eq!(
            title(
                Properties {
                    title: "Network".into(),
                    ..properties()
                },
                &mut icons
            ),
            Some("Network".into())
        );
        assert_eq!(title(properties(), &mut icons), Some("nm-applet".into()));
    }

    #[test]
    fn an_item_that_names_itself_nothing_is_titled_by_its_id() {
        // The id is always present, so a shell never draws an unlabeled
        // button.
        let dir = data_dir(&[]);
        let nameless = Properties {
            id: String::new(),
            ..properties()
        };

        assert_eq!(
            item(
                ":1.9/StatusNotifierItem",
                ":1.9",
                nameless,
                &mut icons_in(dir.path())
            )
            .map(|told| told.title),
            Some(":1.9/StatusNotifierItem".into())
        );
    }

    #[test]
    fn a_named_icon_is_found_where_status_icons_are() {
        // nm-applet's icons are in `status`, which the launcher's lookup
        // skips.
        let dir = data_dir(&[("icons/hicolor/22x22/status/nm-signal-75.png", b"wifi")]);
        let named = Properties {
            icon_name: "nm-signal-75".into(),
            ..properties()
        };

        assert_eq!(
            item("an-id", ":1.42", named, &mut icons_in(dir.path())),
            Some(TrayItem {
                id: "an-id".into(),
                title: "nm-applet".into(),
                icon: Some("data:image/png;base64,d2lmaQ==".into()),
                bus: ":1.42".into(),
                menu: None,
                item_is_menu: false,
            })
        );
    }

    #[test]
    fn the_items_own_theme_path_is_looked_in_first() {
        // Apps that ship private icons point to them with `IconThemePath`.
        let dir = data_dir(&[("icons/hicolor/22x22/status/sync.png", b"system")]);
        let own = data_dir(&[("hicolor/22x22/status/sync.png", b"own")]);
        let named = Properties {
            icon_name: "sync".into(),
            icon_theme_path: own.path().to_string_lossy().into_owned(),
            ..properties()
        };

        assert_eq!(
            item("an-id", ":1.42", named, &mut icons_in(dir.path())).and_then(|told| told.icon),
            Some("data:image/png;base64,b3du".into())
        );
    }

    #[test]
    fn the_icon_theme_comes_before_hicolor_even_in_the_items_own_path() {
        let dir = themed_data_dir();
        let own = data_dir(&[("hicolor/22x22/status/sync.png", b"own")]);
        let named = Properties {
            icon_name: "sync".into(),
            icon_theme_path: own.path().to_string_lossy().into_owned(),
            ..properties()
        };
        let mut icons = TrayIcons::new(vec![dir.path().to_path_buf()], Some("Papirus".into()));

        assert_eq!(
            item("an-id", ":1.42", named, &mut icons).and_then(|told| told.icon),
            Some("data:image/svg+xml;base64,PHN2Zy8+".into())
        );
    }

    #[test]
    fn a_new_icon_theme_redraws_icons_already_looked_up() {
        let dir = themed_data_dir();
        let mut icons = icons_in(dir.path());
        assert_eq!(
            icons.icon("sync", ""),
            Some("data:image/png;base64,aGljb2xvcg==".into())
        );

        icons.retheme(Some("Papirus".into()));

        assert_eq!(
            icons.icon("sync", ""),
            Some("data:image/svg+xml;base64,PHN2Zy8+".into())
        );
    }

    #[test]
    fn a_pixmap_is_drawn_when_no_name_is_found() {
        let dir = data_dir(&[]);
        let pictured = Properties {
            icon_name: "nothing-installed-this".into(),
            icon_pixmaps: vec![red_pixel(1)],
            ..properties()
        };

        let icon = item("an-id", ":1.42", pictured, &mut icons_in(dir.path()))
            .and_then(|told| told.icon)
            .expect("the pixmap, drawn");
        assert!(icon.starts_with("data:image/png;base64,iVBORw0KGgo"));
    }

    /// The icon an item with `pixmaps` gets.
    fn drawn(pixmaps: Vec<Pixmap>) -> Option<String> {
        let dir = data_dir(&[]);
        let pictured = Properties {
            icon_pixmaps: pixmaps,
            ..properties()
        };
        item("an-id", ":1.42", pictured, &mut icons_in(dir.path())).and_then(|told| told.icon)
    }

    #[test]
    fn the_smallest_pixmap_big_enough_is_drawn() {
        // Prefer downscaling to upscaling, by as little as possible.
        assert_eq!(
            drawn(vec![red_pixel(16), red_pixel(64), red_pixel(48)]),
            drawn(vec![red_pixel(48)])
        );
    }

    #[test]
    fn with_none_big_enough_the_biggest_is_drawn() {
        assert_eq!(
            drawn(vec![red_pixel(16), red_pixel(22)]),
            drawn(vec![red_pixel(22)])
        );
    }

    #[test]
    fn a_pixmap_whose_bytes_do_not_add_up_is_passed_over() {
        let short = Pixmap {
            argb: vec![0xff; 3],
            ..red_pixel(1)
        };

        assert_eq!(drawn(vec![short.clone()]), None);
        assert_eq!(
            drawn(vec![short, red_pixel(16)]),
            drawn(vec![red_pixel(16)])
        );
    }

    #[test]
    fn an_item_needing_attention_shows_its_attention_icon() {
        let dir = data_dir(&[
            ("icons/hicolor/22x22/status/mail.png", b"calm"),
            ("icons/hicolor/22x22/status/mail-new.png", b"new"),
        ]);
        let urgent = Properties {
            status: Status::NeedsAttention,
            icon_name: "mail".into(),
            attention_icon_name: "mail-new".into(),
            ..properties()
        };

        assert_eq!(
            item("an-id", ":1.42", urgent, &mut icons_in(dir.path())).and_then(|told| told.icon),
            Some("data:image/png;base64,bmV3".into())
        );
    }

    #[test]
    fn an_item_needing_attention_with_no_attention_icon_shows_its_own() {
        let dir = data_dir(&[("icons/hicolor/22x22/status/mail.png", b"calm")]);
        let urgent = Properties {
            status: Status::NeedsAttention,
            icon_name: "mail".into(),
            ..properties()
        };

        assert_eq!(
            item("an-id", ":1.42", urgent, &mut icons_in(dir.path())).and_then(|told| told.icon),
            Some("data:image/png;base64,Y2FsbQ==".into())
        );
    }

    #[test]
    fn an_item_says_the_bus_it_answers_on_and_where_its_menu_is() {
        // A shell drives the menu itself, over D-Bus.
        let dir = data_dir(&[]);
        let menued = Properties {
            menu: "/MenuBar".into(),
            ..properties()
        };

        assert_eq!(
            item("an-id", ":1.42", menued, &mut icons_in(dir.path()))
                .map(|told| (told.bus, told.menu)),
            Some((":1.42".to_string(), Some("/MenuBar".to_string())))
        );
    }

    #[test]
    fn an_item_that_is_only_a_menu_says_so() {
        // A shell opens its menu on a primary click.
        let dir = data_dir(&[]);
        let menu_only = Properties {
            item_is_menu: true,
            ..properties()
        };

        assert_eq!(
            item("an-id", ":1.42", menu_only, &mut icons_in(dir.path()))
                .map(|told| told.item_is_menu),
            Some(true)
        );
    }

    #[test]
    fn an_item_with_no_menu_says_so() {
        // KDE's items say `/NO_DBUSMENU` for none.
        let dir = data_dir(&[]);
        for none in ["", "/NO_DBUSMENU"] {
            let unmenued = Properties {
                menu: none.into(),
                ..properties()
            };

            assert_eq!(
                item("an-id", ":1.42", unmenued, &mut icons_in(dir.path()))
                    .and_then(|told| told.menu),
                None,
                "{none:?}"
            );
        }
    }

    #[test]
    fn an_item_with_no_picture_is_still_in_the_tray() {
        // A shell can still show its label and click it.
        let dir = data_dir(&[]);

        assert_eq!(
            item("an-id", ":1.42", properties(), &mut icons_in(dir.path())),
            Some(TrayItem {
                id: "an-id".into(),
                title: "nm-applet".into(),
                icon: None,
                bus: ":1.42".into(),
                menu: None,
                item_is_menu: false,
            })
        );
    }
}

mod statuses {
    use super::*;

    #[test]
    fn the_specs_three_words_are_read() {
        assert_eq!(Status::from_wire("Passive"), Status::Passive);
        assert_eq!(Status::from_wire("Active"), Status::Active);
        assert_eq!(Status::from_wire("NeedsAttention"), Status::NeedsAttention);
    }

    #[test]
    fn a_word_the_spec_does_not_have_is_shown() {
        // Showing an unknown status is safer than hiding the icon.
        assert_eq!(Status::from_wire("active"), Status::Active);
    }
}

mod menu_clicks {
    use super::*;

    /// The call a shell makes to click entry 4 of the menu on `bus`.
    fn event(bus: Bus, event: &str) -> SystemRequest {
        SystemRequest::DbusCall {
            bus,
            destination: ":1.42".into(),
            path: "/MenuBar".into(),
            interface: "com.canonical.dbusmenu".into(),
            member: "Event".into(),
            signature: "isvu".into(),
            body: format!(r#"[4, "{event}", {{"signature": "i", "value": 0}}, 0]"#),
        }
    }

    #[test]
    fn a_click_on_a_menu_entry_is_told_by_the_bus_it_goes_to() {
        // Entries such as "Show Slack" raise a window, so need a token too.
        assert_eq!(menu_clicked(&event(Bus::Session, "clicked")), Some(":1.42"));
    }

    #[test]
    fn hovering_an_entry_is_not_a_click() {
        assert_eq!(menu_clicked(&event(Bus::Session, "hovered")), None);
    }

    #[test]
    fn a_call_on_the_system_bus_is_not_a_tray_menu() {
        assert_eq!(menu_clicked(&event(Bus::System, "clicked")), None);
    }
}

mod registry {
    use super::*;

    fn shown(id: &str) -> TrayItem {
        TrayItem {
            id: id.into(),
            title: id.into(),
            icon: None,
            bus: ":1.42".into(),
            menu: None,
            item_is_menu: false,
        }
    }

    /// A registry with two items: one registered by well-known name and one
    /// by path.
    fn two() -> Registry {
        let mut registry = Registry::default();
        registry.register("org.kde.SNI-1", ":1.9", "/StatusNotifierItem", Some(9));
        registry.register(":1.42", ":1.42", "/org/ayatana/nm", Some(42));
        registry
    }

    #[test]
    fn an_item_is_named_by_its_bus_and_its_path() {
        let mut registry = Registry::default();

        assert_eq!(
            registry.register("org.kde.SNI-1", ":1.9", "/StatusNotifierItem", None),
            Some("org.kde.SNI-1/StatusNotifierItem".to_string())
        );
    }

    #[test]
    fn an_item_registered_twice_is_one_item() {
        // An app that restarts its tray code registers again on the same
        // connection; it must not get a second icon.
        let mut registry = two();

        assert_eq!(
            registry.register(":1.42", ":1.42", "/org/ayatana/nm", Some(42)),
            None
        );
    }

    #[test]
    fn nothing_is_shown_until_it_has_been_read() {
        // Properties arrive after registration.
        assert_eq!(two().items(), vec![]);
    }

    #[test]
    fn items_are_shown_in_the_order_they_registered() {
        let mut registry = two();
        registry.show(":1.42/org/ayatana/nm", Some(shown("b")));
        registry.show("org.kde.SNI-1/StatusNotifierItem", Some(shown("a")));

        assert_eq!(registry.items(), vec![shown("a"), shown("b")]);
    }

    #[test]
    fn a_passive_item_is_held_but_not_shown() {
        let mut registry = two();
        registry.show("org.kde.SNI-1/StatusNotifierItem", None);

        assert_eq!(registry.items(), vec![]);
        assert_eq!(
            registry.address("org.kde.SNI-1/StatusNotifierItem"),
            Some(("org.kde.SNI-1".into(), "/StatusNotifierItem".into()))
        );
    }

    #[test]
    fn a_signal_is_matched_by_the_connection_that_sent_it() {
        // Signals carry the sender's unique name, not the well-known name the
        // item registered with.
        let registry = two();

        assert_eq!(
            registry.sent_by(":1.9", "/StatusNotifierItem"),
            vec!["org.kde.SNI-1/StatusNotifierItem".to_string()]
        );
        assert_eq!(registry.sent_by(":1.9", "/elsewhere"), Vec::<String>::new());
    }

    #[test]
    fn a_connection_that_goes_takes_its_items_with_it() {
        let mut registry = two();
        registry.show(":1.42/org/ayatana/nm", Some(shown("b")));

        assert_eq!(
            registry.vanished(":1.42"),
            vec![":1.42/org/ayatana/nm".to_string()]
        );
        assert_eq!(registry.items(), vec![]);
        assert_eq!(registry.address(":1.42/org/ayatana/nm"), None);
    }

    #[test]
    fn a_well_known_name_that_goes_takes_its_item_with_it() {
        let mut registry = two();

        assert_eq!(
            registry.vanished("org.kde.SNI-1"),
            vec!["org.kde.SNI-1/StatusNotifierItem".to_string()]
        );
    }

    #[test]
    fn a_well_known_name_that_changes_hands_is_heard_from_its_new_owner() {
        // Signals come from the name's current owner. Matching the old owner
        // would freeze the icon.
        let mut registry = two();

        registry.moved("org.kde.SNI-1", ":1.77", Some(77));

        assert_eq!(
            registry.sent_by(":1.77", "/StatusNotifierItem"),
            vec!["org.kde.SNI-1/StatusNotifierItem".to_string()]
        );
        assert_eq!(
            registry.sent_by(":1.9", "/StatusNotifierItem"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn a_named_item_is_traced_to_its_process() {
        // A click lets that process raise its window; see
        // `domicile_compositor::activation::invites`. An item not yet read has
        // no name a shell could click.
        let mut registry = two();
        registry.named(":1.42/org/ayatana/nm", "nm-applet");

        assert_eq!(registry.pids(), HashMap::from([("nm-applet".into(), 42)]));
        // A menu is clicked by bus; any item read or not may have one.
        assert_eq!(
            registry.pids_on_buses(),
            HashMap::from([(":1.42".into(), 42), ("org.kde.SNI-1".into(), 9)])
        );
    }

    #[test]
    fn a_menu_is_traced_to_the_items_on_its_bus() {
        // The shell clicks a menu entry by the bus the menu is on.
        assert_eq!(
            two().paths_on("org.kde.SNI-1"),
            vec!["/StatusNotifierItem".to_string()]
        );
    }

    #[test]
    fn a_well_known_name_that_changes_hands_is_traced_to_its_new_owner() {
        let mut registry = two();
        registry.named("org.kde.SNI-1/StatusNotifierItem", "slack");

        registry.moved("org.kde.SNI-1", ":1.77", Some(77));

        assert_eq!(registry.pids(), HashMap::from([("slack".into(), 77)]));
    }

    #[test]
    fn an_item_is_named_to_a_shell_by_what_it_calls_itself() {
        // `Id` is stable across runs; the bus name is not. A shell keys icon
        // placement on this name, so a restarted app keeps its position.
        let mut registry = two();
        assert_eq!(
            registry.named(":1.42/org/ayatana/nm", "nm-applet"),
            "nm-applet"
        );
        registry.vanished(":1.42");
        registry.register(":1.88", ":1.88", "/org/ayatana/nm", Some(88));

        assert_eq!(
            registry.named(":1.88/org/ayatana/nm", "nm-applet"),
            "nm-applet"
        );
    }

    #[test]
    fn an_item_keeps_its_name_once_named() {
        let mut registry = two();
        registry.named(":1.42/org/ayatana/nm", "nm-applet");

        assert_eq!(
            registry.named(":1.42/org/ayatana/nm", "nm-applet"),
            "nm-applet"
        );
        assert_eq!(
            registry.named(":1.42/org/ayatana/nm", "renamed"),
            "nm-applet"
        );
    }

    #[test]
    fn two_items_calling_themselves_one_thing_are_told_apart() {
        let mut registry = two();
        registry.named(":1.42/org/ayatana/nm", "nm-applet");

        assert_eq!(
            registry.named("org.kde.SNI-1/StatusNotifierItem", "nm-applet"),
            "nm-applet#2"
        );
    }

    #[test]
    fn an_item_calling_itself_nothing_is_named_by_its_bus_and_its_path() {
        assert_eq!(
            two().named(":1.42/org/ayatana/nm", ""),
            ":1.42/org/ayatana/nm"
        );
    }

    #[test]
    fn a_click_finds_its_item_by_the_name_a_shell_was_told() {
        let mut registry = two();
        registry.named(":1.42/org/ayatana/nm", "nm-applet");

        assert_eq!(
            registry.clicked("nm-applet"),
            Some((":1.42".into(), "/org/ayatana/nm".into()))
        );
        assert_eq!(registry.clicked(":1.42/org/ayatana/nm"), None);
    }

    #[test]
    fn every_item_is_listed_by_id() {
        assert_eq!(
            two().ids(),
            vec![
                "org.kde.SNI-1/StatusNotifierItem".to_string(),
                ":1.42/org/ayatana/nm".to_string()
            ]
        );
    }
}

mod actions {
    use super::*;

    #[test]
    fn each_button_is_the_specs_method() {
        assert_eq!(method(TrayAction::Primary), "Activate");
        assert_eq!(method(TrayAction::Secondary), "SecondaryActivate");
        assert_eq!(method(TrayAction::Context), "ContextMenu");
    }
}

mod icon_cache {
    use super::*;

    /// More distinct lookups than the cache holds.
    const MANY: usize = 1000;

    #[test]
    fn the_cache_forgets_icons_not_looked_up_for_a_while() {
        let dir = data_dir(&[("icons/hicolor/22x22/status/sync.png", b"sync")]);
        let mut icons = icons_in(dir.path());
        assert!(icons.icon("sync", "").is_some());
        fs::remove_file(dir.path().join("icons/hicolor/22x22/status/sync.png")).unwrap();

        for n in 0..MANY {
            icons.icon(&format!("missing-{n}"), "");
        }

        assert_eq!(icons.icon("sync", ""), None);
    }

    #[test]
    fn the_cache_keeps_an_icon_looked_up_often() {
        let dir = data_dir(&[("icons/hicolor/22x22/status/sync.png", b"sync")]);
        let mut icons = icons_in(dir.path());
        assert!(icons.icon("sync", "").is_some());
        fs::remove_file(dir.path().join("icons/hicolor/22x22/status/sync.png")).unwrap();

        for n in 0..MANY {
            icons.icon(&format!("missing-{n}"), "");
            assert!(icons.icon("sync", "").is_some(), "kept after {n} others");
        }
    }

    #[test]
    fn an_icon_named_by_its_path_is_read_again_each_time() {
        // Applications rewrite one file in place to change their icon.
        let dir = data_dir(&[("icon.png", b"one")]);
        let path = dir.path().join("icon.png");
        let named = path.to_string_lossy().into_owned();
        let mut icons = icons_in(dir.path());
        assert_eq!(
            icons.icon(&named, ""),
            Some("data:image/png;base64,b25l".into())
        );

        fs::write(&path, b"two").unwrap();

        assert_eq!(
            icons.icon(&named, ""),
            Some("data:image/png;base64,dHdv".into())
        );
    }
}

mod reads {
    use super::*;

    #[test]
    fn a_read_starts_when_none_is_in_flight() {
        let mut reads = Reads::default();
        let first = reads.wanted("a").expect("a read");

        assert_eq!(reads.landed("a", first), Landed::Current { again: None });
        assert!(reads.wanted("a").is_some());
    }

    #[test]
    fn signals_during_a_read_make_one_more_read_after_it() {
        let mut reads = Reads::default();
        let first = reads.wanted("a").expect("a read");
        assert_eq!(reads.wanted("a"), None);
        assert_eq!(reads.wanted("a"), None);

        let Landed::Current {
            again: Some(second),
        } = reads.landed("a", first)
        else {
            panic!("one more read");
        };

        assert_eq!(reads.landed("a", second), Landed::Current { again: None });
    }

    #[test]
    fn items_are_read_independently() {
        let mut reads = Reads::default();
        assert!(reads.wanted("a").is_some());

        assert!(reads.wanted("b").is_some());
    }

    #[test]
    fn a_read_of_an_item_that_went_away_is_stale() {
        let mut reads = Reads::default();
        let gone = reads.wanted("a").expect("a read");
        reads.forget("a");
        let again = reads.wanted("a").expect("a read of the new item");

        assert_eq!(reads.landed("a", gone), Landed::Stale);
        assert_eq!(reads.landed("a", again), Landed::Current { again: None });
    }

    #[test]
    fn an_item_hangs_for_the_first_time_once_per_registration() {
        let mut reads = Reads::default();
        assert!(reads.hung("a"));
        assert!(!reads.hung("a"));
        assert!(reads.hung("b"));

        reads.forget("a");

        assert!(reads.hung("a"));
    }
}
