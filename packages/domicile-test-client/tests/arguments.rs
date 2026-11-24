//! Command-line parsing for the test client.
//!
//! The window itself is tested against a compositor by the e2e checks in
//! `packages/e2e-harness/tests/`.

use std::ffi::OsString;

use domicile_test_client::arguments::{
    arguments, ArgumentError, Arguments, AskForFocus, AskTo, DeepFormat, HoldTheScreensOn,
    TakeTheShortcuts,
};
use wayland_client::protocol::wl_output::Transform;

/// Parse a command line given as strings.
fn given(args: &[&str]) -> Result<Arguments, ArgumentError> {
    arguments(args.iter().map(OsString::from))
}

#[test]
fn a_client_told_nothing_still_opens_a_window() {
    // Most checks pass no arguments, so every default must be a plain window.
    let asked = given(&[]).expect("nothing is a valid thing to say");

    assert_eq!(asked.title, "domicile-test-client");
    assert!(!asked.trace, "a client nobody asked to report stays quiet");
    assert!(
        !asked.translucent,
        "a window is opaque unless a check needs to see past it",
    );
    assert!(
        !asked.follow_configure,
        "a client keeps the size it opened at unless a check says otherwise",
    );
    assert!(
        asked.ask_for_focus.is_none(),
        "a client takes the keyboard it is given rather than asking for one",
    );
    assert_eq!(
        asked.copy, None,
        "a client copies nothing unless a check gives it something to copy",
    );
    assert_eq!(
        asked.copy_primary, None,
        "and the middle-click selection is its own flag, left alone by the other",
    );
    assert!(
        !asked.paste,
        "a client reads neither selection unless a check asks it to",
    );
    assert_eq!(
        asked.hold_the_screens_on, None,
        "and a window is not a film: a client lets the desk blank under it",
    );
    assert!(
        !asked.outlive_its_window,
        "a client is done when its window is closed, unless a check needs it there after",
    );
    assert_eq!(
        asked.inhibit_shortcuts, None,
        "a client leaves the desktop its shortcuts unless a check asks it to take them",
    );
}

#[test]
fn a_client_can_be_asked_to_hold_the_screens_on() {
    let asked = given(&["--hold-the-screens-on"]).expect("a client that keeps a desk awake");

    assert_eq!(
        asked.hold_the_screens_on,
        Some(HoldTheScreensOn::OnItsWindow)
    );
    assert!(
        asked.ask_for_focus.is_none(),
        "and nothing else came on with it"
    );
}

#[test]
fn a_client_can_take_its_inhibitor_before_it_has_a_window() {
    // The protocol allows an inhibitor on a surface with no role, but a
    // desktop must not honor it.
    let asked = given(&["--hold-the-screens-on-before-it-has-a-window"])
        .expect("a client that asks before it shows anything");

    assert_eq!(
        asked.hold_the_screens_on,
        Some(HoldTheScreensOn::BeforeItHasAWindow)
    );
}

#[test]
fn a_client_cannot_take_its_inhibitor_at_both_moments() {
    // Both flags set the same option, so the second is a repeat.
    assert_eq!(
        given(&[
            "--hold-the-screens-on",
            "--hold-the-screens-on-before-it-has-a-window"
        ]),
        Err(ArgumentError::Repeated {
            flag: "--hold-the-screens-on-before-it-has-a-window".to_string()
        })
    );
}

#[test]
fn a_client_can_be_asked_to_take_the_desktops_shortcuts() {
    let asked = given(&["--inhibit-shortcuts"]).expect("a client that wants every key");

    assert_eq!(asked.inhibit_shortcuts, Some(TakeTheShortcuts::OnItsWindow));
    assert!(
        asked.hold_the_screens_on.is_none(),
        "and nothing else came on with it"
    );
}

#[test]
fn a_client_can_take_the_shortcuts_before_it_has_a_window() {
    // The surface has no role yet, so the compositor has no window to say it
    // of until it becomes one.
    let asked = given(&["--inhibit-shortcuts-before-it-has-a-window"])
        .expect("a client that asks before it shows anything");

    assert_eq!(
        asked.inhibit_shortcuts,
        Some(TakeTheShortcuts::BeforeItHasAWindow)
    );
}

#[test]
fn a_client_can_be_asked_to_outlive_its_window() {
    let asked = given(&["--outlive-its-window"]).expect("a client that stays when its window goes");

    assert!(asked.outlive_its_window);
    assert!(
        asked.ask_for_focus.is_none(),
        "and nothing else came on with it"
    );
}

#[test]
fn outliving_a_window_twice_is_refused_like_any_other_repeat() {
    assert_eq!(
        given(&["--outlive-its-window", "--outlive-its-window"]),
        Err(ArgumentError::Repeated {
            flag: "--outlive-its-window".to_string()
        })
    );
}

#[test]
fn a_chrome_is_the_client_that_takes_the_size_it_is_given() {
    // Off by default because most checks rely on a fixed window size.
    let asked = given(&["--follow-configure"]).expect("a chrome-shaped client");

    assert!(asked.follow_configure);
    assert!(!asked.translucent, "and nothing else came on with it");
    assert!(!asked.trace);
}

#[test]
fn following_a_configure_twice_is_refused() {
    assert_eq!(
        given(&["--follow-configure", "--follow-configure"]),
        Err(ArgumentError::Repeated {
            flag: "--follow-configure".to_string()
        })
    );
}

#[test]
fn a_title_is_what_a_check_tells_two_windows_apart_by() {
    let asked = given(&["--title", "left"]).expect("a title");

    assert_eq!(asked.title, "left");
}

#[test]
fn a_flag_with_nothing_after_it_is_refused() {
    // `--title $NAME` with `NAME` unset ends up here.
    assert_eq!(
        given(&["--title"]),
        Err(ArgumentError::NeedsValue {
            flag: "--title".to_string()
        })
    );
}

#[test]
fn an_empty_value_is_refused_rather_than_used() {
    // `--title "$NAME"` with `NAME` unset ends up here.
    assert_eq!(
        given(&["--title", ""]),
        Err(ArgumentError::EmptyValue {
            flag: "--title".to_string()
        })
    );
}

#[test]
fn a_flag_given_twice_is_refused_rather_than_one_of_them_obeyed() {
    assert_eq!(
        given(&["--title", "one", "--title", "two"]),
        Err(ArgumentError::Repeated {
            flag: "--title".to_string()
        })
    );
}

#[test]
fn a_client_can_be_asked_to_report_what_it_sees() {
    let asked = given(&["--trace"]).expect("a request to report");

    assert!(asked.trace);
}

#[test]
fn asking_to_report_twice_is_refused_like_any_other_repeat() {
    assert_eq!(
        given(&["--trace", "--trace"]),
        Err(ArgumentError::Repeated {
            flag: "--trace".to_string()
        })
    );
}

#[test]
fn a_client_can_be_asked_for_a_window_that_is_not_opaque() {
    let asked = given(&["--translucent"]).expect("a request for a see-through window");

    assert!(asked.translucent);
}

#[test]
fn asking_for_a_see_through_window_twice_is_refused_like_any_other_repeat() {
    assert_eq!(
        given(&["--translucent", "--translucent"]),
        Err(ArgumentError::Repeated {
            flag: "--translucent".to_string()
        })
    );
}

#[test]
fn a_client_can_be_asked_to_ask_for_the_keyboard() {
    let asked = given(&["--ask-for-focus"]).expect("a client that wants the keyboard");

    assert_eq!(asked.ask_for_focus, Some(AskForFocus::OnceMapped));
    assert!(!asked.translucent, "and nothing else came on with it");
}

#[test]
fn a_client_can_be_asked_to_ask_for_the_keyboard_with_the_serial_it_was_given_it() {
    assert_eq!(
        given(&["--ask-for-focus-when-entered"])
            .expect("a client that asks as the keyboard arrives")
            .ask_for_focus,
        Some(AskForFocus::WhenEntered)
    );
    assert_eq!(
        given(&["--ask-for-focus-when-left"])
            .expect("a client that asks for the keyboard back")
            .ask_for_focus,
        Some(AskForFocus::WhenLeft)
    );
}

#[test]
fn a_client_asks_for_the_keyboard_one_way() {
    assert_eq!(
        given(&["--ask-for-focus", "--ask-for-focus-when-left"]),
        Err(ArgumentError::Repeated {
            flag: "--ask-for-focus-when-left".to_string()
        })
    );
}

#[test]
fn asking_for_the_keyboard_twice_is_refused_like_any_other_repeat() {
    assert_eq!(
        given(&["--ask-for-focus", "--ask-for-focus"]),
        Err(ArgumentError::Repeated {
            flag: "--ask-for-focus".to_string()
        })
    );
}

#[test]
fn a_client_can_be_asked_to_show_a_tray_icon() {
    assert!(!given(&[]).expect("nothing").tray);
    assert!(given(&["--tray"]).expect("a client in the tray").tray);
}

#[test]
fn a_client_can_be_given_something_to_copy() {
    let asked = given(&["--copy", "hello"]).expect("a client with something to copy");

    assert_eq!(asked.copy, Some("hello".to_string()));
    assert_eq!(
        asked.copy_primary, None,
        "the clipboard is not the middle-click selection, here or anywhere",
    );
}

#[test]
fn the_middle_click_selection_is_a_separate_thing_to_copy_to() {
    let asked = given(&["--copy-primary", "brushed past"]).expect("a client selecting a word");

    assert_eq!(asked.copy_primary, Some("brushed past".to_string()));
    assert_eq!(asked.copy, None);
}

#[test]
fn a_client_can_be_asked_to_read_what_is_offered() {
    // One flag reads both selections, so a check can catch a compositor that
    // offers clipboard data on the primary selection.
    let asked = given(&["--paste"]).expect("a client that pastes");

    assert!(asked.paste);
    assert_eq!(asked.copy, None, "and nothing else came on with it");
}

#[test]
fn a_client_can_be_asked_to_open_a_menu_over_its_window() {
    assert!(given(&["--popup"]).expect("a client with a menu").popup);
    assert!(!given(&[]).unwrap().popup);
}

#[test]
fn a_menu_can_be_asked_to_take_the_keyboard_and_pointer() {
    // `--popup-grab` implies `--popup`.
    let asked = given(&["--popup-grab"]).expect("a client with a grabbing menu");
    assert!(asked.popup && asked.popup_grab);
    assert!(!given(&["--popup"]).unwrap().popup_grab);
}

#[test]
fn a_client_can_be_asked_to_open_sliding_menus_on_presses() {
    assert!(
        given(&["--sliding-menu"])
            .expect("a client whose menus slide")
            .sliding_menu
    );
    assert!(!given(&[]).unwrap().sliding_menu);
}

#[test]
fn a_client_can_be_asked_to_scroll_its_window_under_a_bubble() {
    let asked = given(&["--scrolling-bubble"]).expect("a client whose bubble scrolls");
    assert!(asked.scrolling_bubble);
    assert!(!asked.bubble, "the bubble that grows is another flag");
    assert!(!given(&[]).unwrap().scrolling_bubble);
}

#[test]
fn a_client_can_be_asked_to_move_its_scrolling_bubble_a_frame_late() {
    let asked = given(&["--scrolling-bubble", "--late-bubble"])
        .expect("a client whose bubble scrolls a frame late");
    assert!(asked.scrolling_bubble);
    assert!(asked.late_bubble);
    assert!(!given(&["--scrolling-bubble"]).unwrap().late_bubble);
}

#[test]
fn a_client_can_be_asked_to_open_a_dialog_for_its_window() {
    assert!(given(&["--dialog"]).expect("a client with a dialog").dialog);
    assert!(!given(&[]).unwrap().dialog);
}

#[test]
fn a_client_can_be_given_limits_on_its_size() {
    // Limits an Electron app with a minimum window size sends (these are
    // Bitwarden's).
    let asked = given(&["--min-size", "680x500", "--max-size", "1920x0"])
        .expect("a client that will only be so small or so big");

    assert_eq!(asked.min_size, Some((680, 500)));
    assert_eq!(asked.max_size, Some((1920, 0)));
    assert_eq!(given(&[]).unwrap().min_size, None, "and none unless asked");
}

#[test]
fn a_client_can_resize_itself_after_its_first_frame() {
    // As a client that picks its own size does.
    let asked = given(&["--resize-to", "400x300"]).expect("a client that grows");

    assert_eq!(asked.resize_to, Some((400, 300)));
    assert_eq!(
        given(&[]).unwrap().resize_to,
        None,
        "and keeps its size unless asked"
    );
}

#[test]
fn a_client_can_crop_its_buffer_and_later_scale_it_with_a_viewport() {
    let asked = given(&["--viewport-source", "200x150", "--viewport-to", "400x300"])
        .expect("a client that sizes its window with wp_viewport");

    assert_eq!(asked.viewport_source, Some((200, 150)));
    assert_eq!(asked.viewport_to, Some((400, 300)));
    let plain = given(&[]).unwrap();
    assert_eq!(
        (plain.viewport_source, plain.viewport_to),
        (None, None),
        "and sets no viewport unless asked"
    );
}

#[test]
fn a_size_that_is_not_two_numbers_is_refused() {
    assert_eq!(
        given(&["--min-size", "680"]),
        Err(ArgumentError::NotASize {
            flag: "--min-size".to_string(),
            value: "680".to_string(),
        })
    );
}

#[test]
fn an_argument_this_does_not_know_is_named_rather_than_ignored() {
    // An ignored argument would be a request that silently did not happen.
    assert_eq!(
        given(&["--fullscreen"]),
        Err(ArgumentError::Unknown {
            argument: "--fullscreen".to_string()
        })
    );
}

#[test]
fn a_client_can_be_asked_to_draw_its_buffer_turned() {
    let asked = given(&["--buffer-transform", "90"]).expect("a buffer drawn on its side");

    assert_eq!(asked.buffer_transform, Some(Transform::_90));
    assert_eq!(
        given(&["--buffer-transform", "flipped-270"])
            .unwrap()
            .buffer_transform,
        Some(Transform::Flipped270)
    );
    assert_eq!(
        given(&[]).unwrap().buffer_transform,
        None,
        "and drawn as it is unless asked"
    );
}

#[test]
fn a_turn_wl_output_has_no_name_for_is_refused() {
    assert_eq!(
        given(&["--buffer-transform", "45"]),
        Err(ArgumentError::NotATransform {
            value: "45".to_string(),
        })
    );
}

#[test]
fn a_client_can_be_asked_to_draw_in_a_deep_format() {
    for (value, format) in [
        ("abgr2101010", DeepFormat::Abgr2101010),
        ("xbgr2101010", DeepFormat::Xbgr2101010),
        ("abgr16161616f", DeepFormat::Abgr16161616f),
        ("xbgr16161616f", DeepFormat::Xbgr16161616f),
    ] {
        assert_eq!(given(&["--format", value]).unwrap().format, Some(format));
    }
    assert_eq!(
        given(&[]).unwrap().format,
        None,
        "and in 8 bits unless asked"
    );
}

#[test]
fn a_format_without_more_than_8_bits_is_refused() {
    assert_eq!(
        given(&["--format", "argb8888"]),
        Err(ArgumentError::NotADeepFormat {
            value: "argb8888".to_string(),
        })
    );
}

#[test]
fn a_client_can_be_asked_to_ask_for_a_window_state() {
    for (value, ask_to) in [
        ("maximize", AskTo::Maximize),
        ("unmaximize", AskTo::Unmaximize),
        ("fullscreen", AskTo::Fullscreen),
        ("unfullscreen", AskTo::Unfullscreen),
        ("minimize", AskTo::Minimize),
    ] {
        assert_eq!(given(&["--ask-to", value]).unwrap().ask_to, Some(ask_to));
    }
    assert_eq!(
        given(&[]).unwrap().ask_to,
        None,
        "and asks nothing unless told"
    );
}

#[test]
fn a_window_request_xdg_toplevel_has_no_name_for_is_refused() {
    assert_eq!(
        given(&["--ask-to", "shade"]),
        Err(ArgumentError::NotAWindowRequest {
            value: "shade".to_string(),
        })
    );
}

#[test]
fn a_client_can_be_asked_to_bind_the_first_xdg_wm_base() {
    assert!(given(&["--xdg-wm-base-v1"]).unwrap().xdg_wm_base_v1);
    assert!(
        !given(&[]).unwrap().xdg_wm_base_v1,
        "and binds the newest it knows unless told"
    );
}

#[test]
fn a_client_can_be_asked_to_bind_wl_seat_7() {
    assert!(given(&["--wl-seat-v7"]).unwrap().wl_seat_v7);
    assert!(
        !given(&[]).unwrap().wl_seat_v7,
        "and binds version 5 unless told"
    );
}

#[test]
fn a_popup_that_moves_is_a_popup() {
    let asked = given(&["--repositioned-popup"]).expect("a popup that moves once drawn");

    assert!(asked.repositioned_popup);
    assert!(asked.popup, "it opens the popup it moves");
}

#[test]
fn a_client_can_ask_for_a_page_anchor() {
    let asked = given(&["--anchor", "bar"]).expect("a window anchored in the page");

    assert_eq!(asked.anchor.as_deref(), Some("bar"));
    assert_eq!(given(&[]).expect("no arguments").anchor, None);
}
