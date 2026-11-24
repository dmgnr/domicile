//! Tests that input a chrome forwards reaches a real Wayland client, and that
//! the keymap reaches both.
//!
//! The compositor passes keys and pointer events from the chrome socket into
//! the Smithay seat. Unit tests stop at the request reaching the Wayland
//! thread; only a real client shows delivery.

mod running;

use domicile_protocol::{
    AppCursorImage, ChromeMessage, CursorShape, HostMessage, PointerConstraint, SurfaceRect,
};
use smithay::input::keyboard::xkb;

use crate::running::Compositor;

const ONE_DISPLAY: &str = r#"
{ "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] } }
"#;

/// A Dvorak keyboard.
///
/// Uses `dvorak`, not the default `dvp`, so the keymap can only come from this
/// config.
const A_DVORAK_KEYBOARD: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] },
  "input": { "keyboard": { "xkb_layout": "us", "xkb_variant": "dvorak" } }
}
"#;

/// [`A_DVORAK_KEYBOARD`] repeating after 300 ms at 40 a second.
const A_DVORAK_KEYBOARD_REPEATING_FAST: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] },
  "input": { "keyboard": {
    "xkb_layout": "us", "xkb_variant": "dvorak",
    "repeat": { "delay_ms": 300, "rate": 40 }
  } }
}
"#;

/// [`A_DVORAK_KEYBOARD`] that does not repeat.
const A_DVORAK_KEYBOARD_NOT_REPEATING: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] },
  "input": { "keyboard": {
    "xkb_layout": "us", "xkb_variant": "dvorak",
    "repeat": { "delay_ms": 600, "rate": 0 }
  } }
}
"#;

/// A US QWERTY keyboard.
///
/// The displays match [`A_DVORAK_KEYBOARD`] so a reload changes only the
/// keyboard.
const A_PLAIN_KEYBOARD: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] },
  "input": { "keyboard": { "xkb_layout": "us" } }
}
"#;

/// A keyboard config that parses but xkb cannot compile.
///
/// Uses missing rules because xkb reports those, while it silently falls back
/// on an unknown layout.
const A_KEYBOARD_XKB_HAS_NEVER_HEARD_OF: &str = r#"
{
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] },
  "input": { "keyboard": { "xkb_rules": "no-such-rules" } }
}
"#;

/// The Linux code for the left mouse button.
const BTN_LEFT: u32 = 0x110;

/// The Linux code for the right mouse button.
const BTN_RIGHT: u32 = 0x111;

/// The evdev code for `a`, which a chrome sends. The keymap uses X keycodes,
/// which are 8 higher.
const EVDEV_KEY_A: u32 = 30;

/// Evdev codes for `b` and `c`, keys that `drive` does not type.
const EVDEV_KEY_B: u32 = 48;
const EVDEV_KEY_C: u32 = 46;

/// Focuses the window, then moves the pointer, clicks and types `a`.
///
/// Coordinates are surface-local, so the window needs no placement.
fn drive(chrome: &mut domicile_test_chrome::Chrome, app_id: &str) {
    for message in [
        ChromeMessage::FocusApp {
            app_id: app_id.to_string(),
        },
        ChromeMessage::PointerMotion {
            app_id: app_id.to_string(),
            x: 10.0,
            y: 10.0,
            moved: true,
        },
        ChromeMessage::PointerMotion {
            app_id: app_id.to_string(),
            x: 20.0,
            y: 20.0,
            moved: true,
        },
        ChromeMessage::PointerButton {
            app_id: app_id.to_string(),
            button: BTN_LEFT,
            pressed: true,
        },
        ChromeMessage::PointerButton {
            app_id: app_id.to_string(),
            button: BTN_LEFT,
            pressed: false,
        },
        ChromeMessage::Key {
            app_id: app_id.to_string(),
            keycode: EVDEV_KEY_A,
            pressed: true,
        },
        ChromeMessage::Key {
            app_id: app_id.to_string(),
            keycode: EVDEV_KEY_A,
            pressed: false,
        },
    ] {
        chrome.say(&message).expect("the chrome socket takes input");
    }
}

/// Connects a chrome, starts a client and drives input at its window.
///
/// Returns the window's app id so tests can reject messages naming another
/// window. Waits for the log line `keyboard focus -> client`, which shows the
/// fixture worked; a window with no surface logs a different line.
///
/// One pass is enough: the test client binds its keyboard and pointer before
/// it creates the toplevel that `app_appeared` announces.
fn a_client_being_typed_at(
    compositor: &Compositor,
) -> (domicile_test_chrome::Chrome, crate::running::Client, String) {
    let mut chrome = compositor.chrome();
    let client = compositor.client("app");

    let appeared = chrome
        .wait_for(|message| matches!(message, HostMessage::AppAppeared { .. }))
        .expect("a client that opened a window is announced to the chrome");
    let HostMessage::AppAppeared { app_id, .. } = appeared else {
        unreachable!("the wait matched on this variant")
    };

    drive(&mut chrome, &app_id);
    compositor.wait_for_log("keyboard focus -> client");

    (chrome, client, app_id)
}

/// Forwarded key and button presses and releases reach the client.
///
/// The client traces `key(serial, time, code, state)`, so matching the tail
/// checks the code and the state. A dropped release would leave the key held.
#[test]
fn a_key_and_a_click_the_chrome_forwarded_reach_the_client() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (_chrome, mut client, _app) = a_client_being_typed_at(&compositor);

    for (what, tail) in [
        ("a key press", format!(", {EVDEV_KEY_A}, 1)")),
        ("that key's release", format!(", {EVDEV_KEY_A}, 0)")),
        ("a click", format!(", {BTN_LEFT}, 1)")),
        ("that click's release", format!(", {BTN_LEFT}, 0)")),
    ] {
        assert!(
            client.wait_for_trace(&tail, 1),
            "the chrome forwarded {what} and the client was never given one; \
             it traced:\n{}",
            client.trace()
        );
    }
}

/// Finger scrolling keeps its source, independent axis stops and frame order.
#[test]
fn a_finger_scroll_reaches_the_client_without_wheel_steps() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);

    for (dx, dy, stop_x, stop_y) in [
        (2.5, 4.5, false, false),
        (0.0, 1.5, true, false),
        (0.0, 0.0, false, true),
    ] {
        let message = serde_json::from_value(serde_json::json!({
            "type": "pointer_axis", "app_id": app, "source": "finger",
            "dx": dx, "dy": dy, "v120_x": 0, "v120_y": 0,
            "stop_x": stop_x, "stop_y": stop_y,
        }))
        .unwrap();
        chrome
            .say(&message)
            .expect("the chrome socket takes a scroll");
    }
    chrome
        .say(&ChromeMessage::Key {
            app_id: app,
            keycode: EVDEV_KEY_C,
            pressed: true,
        })
        .unwrap();
    assert!(client.wait_for_trace(&format!(", {EVDEV_KEY_C}, 1)"), 1));
    let trace = client.trace();
    let scrolls: Vec<_> = trace
        .lines()
        .filter_map(|line| {
            let (_, event) = line.split_once('.')?;
            (event.starts_with("axis") || event == "frame()").then_some(event)
        })
        .collect();
    assert!(trace.contains("axis_source(1)"), "{trace}");
    assert!(!trace.contains("axis_discrete("), "{trace}");
    assert!(
        scrolls
            .windows(3)
            .any(|events| events[0].starts_with("axis_stop(")
                && events[0].ends_with(", 1)")
                && events[1].starts_with("axis(")
                && events[2] == "frame()"),
        "{trace}"
    );
    assert!(
        scrolls
            .windows(2)
            .any(|events| events[0].starts_with("axis_stop(")
                && events[0].ends_with(", 0)")
                && events[1] == "frame()"),
        "{trace}"
    );
}

#[test]
fn continuous_scrolling_and_wheel_detents_keep_distinct_sources() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);
    for (source, dy, v120_y) in [("continuous", 7.5, 0), ("wheel", 15.0, 120)] {
        let message = serde_json::from_value(serde_json::json!({
            "type": "pointer_axis", "app_id": app, "source": source,
            "dx": 0.0, "dy": dy, "v120_x": 0, "v120_y": v120_y,
            "stop_x": false, "stop_y": false,
        }))
        .unwrap();
        chrome.say(&message).unwrap();
    }
    chrome
        .say(&ChromeMessage::Key {
            app_id: app,
            keycode: EVDEV_KEY_C,
            pressed: true,
        })
        .unwrap();
    assert!(client.wait_for_trace(&format!(", {EVDEV_KEY_C}, 1)"), 1));
    let trace = client.trace();
    let sources: Vec<_> = trace
        .lines()
        .filter_map(|line| line.split_once(".axis_source(").map(|(_, source)| source))
        .collect();
    assert_eq!(sources, ["2)", "0)"], "{trace}");
    assert_eq!(trace.matches("axis_discrete(0, 1)").count(), 1, "{trace}");
    assert_eq!(trace.matches("axis_discrete(").count(), 1, "{trace}");
    assert!(
        trace
            .lines()
            .any(|line| line.contains(".axis(") && line.ends_with(", 0, 7.5)")),
        "{trace}"
    );
}

/// Wheel tilt keeps its source for modern clients and follows the protocol's
/// wheel fallback for clients below version 6.
#[test]
fn wheel_tilt_keeps_its_source_and_detents() {
    for (arguments, expected_source) in [(&[][..], "0)"), (&["--wl-seat-v7"][..], "3)")] {
        let compositor = Compositor::started_with(ONE_DISPLAY);
        let mut chrome = compositor.chrome();
        let mut client = compositor.client_with("wheel tilt", arguments);
        let app = appeared(&mut chrome);
        drive(&mut chrome, &app);
        let message = serde_json::from_value(serde_json::json!({
            "type": "pointer_axis", "app_id": app, "source": "wheel_tilt",
            "dx": 15.0, "dy": 0.0, "v120_x": 120, "v120_y": 0,
            "stop_x": false, "stop_y": false,
        }))
        .unwrap();
        chrome.say(&message).unwrap();
        chrome
            .say(&ChromeMessage::Key {
                app_id: app,
                keycode: EVDEV_KEY_C,
                pressed: true,
            })
            .unwrap();
        assert!(client.wait_for_trace(&format!(", {EVDEV_KEY_C}, 1)"), 1));
        let trace = client.trace();
        let sources: Vec<_> = trace
            .lines()
            .filter_map(|line| line.split_once(".axis_source(").map(|(_, source)| source))
            .collect();
        assert_eq!(sources, [expected_source], "{trace}");
        assert!(trace.contains("axis_discrete(1, 1)"), "{trace}");
        assert!(
            trace
                .lines()
                .any(|line| line.contains(".axis(") && line.ends_with(", 1, 15)")),
            "{trace}"
        );
    }
}

/// A release for a key the seat never saw pressed is not forwarded.
///
/// The page forwards every release, including keys pressed while it had focus.
#[test]
fn a_release_the_seat_never_saw_pressed_does_not_reach_the_client() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);

    for (keycode, pressed) in [(EVDEV_KEY_B, false), (EVDEV_KEY_C, true)] {
        chrome
            .say(&ChromeMessage::Key {
                app_id: app.clone(),
                keycode,
                pressed,
            })
            .expect("the chrome socket takes a key");
    }

    // Events arrive in order, so once this press is traced, a forwarded
    // release would be too.
    assert!(
        client.wait_for_trace(&format!(", {EVDEV_KEY_C}, 1)"), 1),
        "the key pressed after the stray release never arrived; it traced:\n{}",
        client.trace()
    );
    assert!(
        !client.trace().contains(&format!(", {EVDEV_KEY_B}, 0)")),
        "a key nobody pressed was released at the client; it traced:\n{}",
        client.trace()
    );
}

/// A click on one window reaches it after the chrome lost a release on another.
///
/// The page forwards a release only over the window's own element, so a button
/// let go over the shell never reaches the seat. Until the seat lets go of that
/// button, the window that had the press keeps every later click.
#[test]
fn a_click_reaches_its_window_after_the_chrome_lost_a_release_on_another() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut held = compositor.client("held");
    let held_id = appeared(&mut chrome);
    let mut clicked = compositor.client("clicked");
    let clicked_id = appeared(&mut chrome);

    for message in [
        motion(&held_id),
        button(&held_id, BTN_RIGHT, true),
        ChromeMessage::PointerLeave {
            app_id: held_id.clone(),
        },
        motion(&clicked_id),
        button(&clicked_id, BTN_LEFT, true),
        button(&clicked_id, BTN_LEFT, false),
    ] {
        chrome.say(&message).expect("the chrome socket takes input");
    }

    assert!(
        clicked.wait_for_trace(&format!(", {BTN_LEFT}, 1)"), 1),
        "the click went to the window holding the lost press; it traced:\n{}",
        clicked.trace()
    );
    assert!(
        held.wait_for_trace(&format!(", {BTN_RIGHT}, 0)"), 1),
        "the window that had the press was never told it came up; it traced:\n{}",
        held.trace()
    );
}

/// Clicks reach each window after one closed holding a press the chrome lost.
///
/// The seat forgets a grab whose window is gone but still counts the button as
/// held. Each later click would then keep the pointer on whatever it clicked.
#[test]
fn clicks_reach_each_window_after_one_closed_holding_a_lost_press() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut held = compositor.client("held");
    let held_id = appeared(&mut chrome);
    let mut first = compositor.client("first");
    let first_id = appeared(&mut chrome);
    let mut second = compositor.client("second");
    let second_id = appeared(&mut chrome);

    for message in [motion(&held_id), button(&held_id, BTN_RIGHT, true)] {
        chrome.say(&message).expect("the chrome socket takes input");
    }
    assert!(
        held.wait_for_trace(&format!(", {BTN_RIGHT}, 1)"), 1),
        "the window that closes was never pressed; it traced:\n{}",
        held.trace()
    );
    drop(held);
    chrome
        .wait_for(
            |message| matches!(message, HostMessage::AppClosed { app_id } if *app_id == held_id),
        )
        .expect("the window holding the press closes");

    for app_id in [&first_id, &second_id] {
        for message in [
            motion(app_id),
            button(app_id, BTN_LEFT, true),
            button(app_id, BTN_LEFT, false),
        ] {
            chrome.say(&message).expect("the chrome socket takes input");
        }
    }

    assert!(
        first.wait_for_trace(&format!(", {BTN_LEFT}, 1)"), 1),
        "the first window was never clicked; it traced:\n{}",
        first.trace()
    );
    assert!(
        second.wait_for_trace(&format!(", {BTN_LEFT}, 1)"), 1),
        "the second click stayed with the first window; it traced:\n{}",
        second.trace()
    );
}

/// The pointer at a point inside `app_id`'s window.
fn motion(app_id: &str) -> ChromeMessage {
    ChromeMessage::PointerMotion {
        app_id: app_id.to_string(),
        x: 10.0,
        y: 10.0,
        moved: true,
    }
}

/// A press or release of `button` over `app_id`'s window.
fn button(app_id: &str, button: u32, pressed: bool) -> ChromeMessage {
    ChromeMessage::PointerButton {
        app_id: app_id.to_string(),
        button,
        pressed,
    }
}

/// The id of the next window the chrome is told about.
fn appeared(chrome: &mut domicile_test_chrome::Chrome) -> String {
    let appeared = chrome
        .wait_for(|message| matches!(message, HostMessage::AppAppeared { .. }))
        .expect("a client that opened a window is announced to the chrome");
    let HostMessage::AppAppeared { app_id, .. } = appeared else {
        unreachable!("the wait matched on this variant")
    };
    app_id
}

/// A focus the chrome requested is reported back over the socket.
///
/// `a_chrome_asking_for_focus_is_answered_to_every_chrome` checks the hub's
/// queue. This checks `serve_outbound` writes it to the socket.
#[test]
fn a_focus_the_chrome_asked_for_comes_back_over_the_socket() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, _client, app) = a_client_being_typed_at(&compositor);

    // Match this window's id: the handshake already sent a `focus_changed`
    // naming none, and `Some(_)` would accept the wrong window.
    chrome
        .wait_for(|message| {
            matches!(message, HostMessage::FocusChanged { app_id: Some(id) } if *id == app)
        })
        .expect("the chrome is told the window it focused has the keyboard");
}

/// A client's cursor on pointer enter reaches the chrome as `app_cursor`.
///
/// The chrome draws the pointer, so the compositor converts the client's
/// cursor into a CSS keyword for the app's element.
#[test]
fn a_pointer_over_a_window_asks_the_chrome_for_that_window_s_cursor() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, _client, app) = a_client_being_typed_at(&compositor);

    // Match this window's id. The shape is not checked: the client always
    // sends `Default`.
    chrome
        .wait_for(
            |message| matches!(message, HostMessage::AppCursor { app_id, .. } if *app_id == app),
        )
        .expect("a client the pointer entered asks the chrome for a cursor");
}

/// A cursor a client draws on its own surface reaches the chrome as an image
/// on `app_cursor`, with its hotspot, and again each time the client redraws
/// it.
#[test]
fn a_cursor_a_client_draws_reaches_the_chrome_as_its_image() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let _client = compositor.client_with("app", &["--cursor-surface"]);
    let appeared = chrome
        .wait_for(|message| matches!(message, HostMessage::AppAppeared { .. }))
        .expect("a client that opened a window is announced to the chrome");
    let HostMessage::AppAppeared { app_id, .. } = appeared else {
        unreachable!("the wait matched on this variant")
    };
    drive(&mut chrome, &app_id);

    let first = drawn_cursor(&mut chrome, &app_id, 4);
    assert_eq!(first.hotspot, (1, 2));
    assert_eq!(first.scale, 1);
    assert_eq!(pixels_of(&first.png), (4, 4, [0xc0, 0x40, 0x20, 0xff]));

    chrome
        .say(&ChromeMessage::PointerButton {
            app_id: app_id.clone(),
            button: 0x110,
            pressed: true,
        })
        .expect("the chrome can press");
    let redrawn = drawn_cursor(&mut chrome, &app_id, 6);
    assert_eq!(redrawn.hotspot, (1, 2), "a redraw keeps the hotspot");
}

/// The next cursor image for `app_id` that is `size` pixels square.
fn drawn_cursor(
    chrome: &mut domicile_test_chrome::Chrome,
    app_id: &str,
    size: u32,
) -> AppCursorImage {
    let told = chrome
        .wait_for(|message| {
            matches!(
                message,
                HostMessage::AppCursor { app_id: of, image: Some(image), .. }
                    if of == app_id && pixels_of(&image.png).0 == size
            )
        })
        .expect("the client's cursor image reaches the chrome");
    let HostMessage::AppCursor {
        cursor,
        image: Some(image),
        ..
    } = told
    else {
        unreachable!("the wait matched on this variant")
    };
    assert_eq!(
        cursor,
        CursorShape::Default,
        "an older engine shows the arrow"
    );
    image
}

/// A cursor PNG's width, height and first pixel.
fn pixels_of(png: &str) -> (u32, u32, [u8; 4]) {
    let bytes = domicile_host::base64::decoded(png).expect("the PNG is base64");
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .expect("the image is a PNG");
    let mut rgba = vec![0; reader.output_buffer_size().expect("it fits")];
    let info = reader.next_frame(&mut rgba).expect("it decodes");
    (
        info.width,
        info.height,
        [rgba[0], rgba[1], rgba[2], rgba[3]],
    )
}

/// A hand on the mouse over a window reaches a client holding a relative
/// pointer as relative motion, accelerated and not. A delta for a window the
/// pointer has left is dropped.
#[test]
fn relative_motion_reaches_the_window_under_the_pointer() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);

    chrome
        .say(&ChromeMessage::PointerRelative {
            app_id: app.clone(),
            dx: 3.5,
            dy: -2.0,
            dx_unaccel: 1.25,
            dy_unaccel: -0.5,
        })
        .expect("the chrome can move the pointer");
    assert!(
        client.wait_for_trace(".relative_motion(3.5, -2, 1.25, -0.5)", 1),
        "the client heard no relative motion; it traced:\n{}",
        client.trace()
    );

    chrome
        .say(&ChromeMessage::PointerRelative {
            app_id: "app-elsewhere".into(),
            dx: 9.0,
            dy: 9.0,
            dx_unaccel: 9.0,
            dy_unaccel: 9.0,
        })
        .expect("the chrome can move the pointer");
    compositor.wait_for_log("relative motion off the app under the pointer -> dropped");
    assert!(
        !client.trace().contains(".relative_motion(9"),
        "a delta for another window reached this one"
    );
}

/// A window asking to lock the pointer is offered to the page, and its client
/// is told it is locked only once the page took the pointer. While locked,
/// only relative motion reaches it; the page letting go unlocks it, and the
/// pointer leaving withdraws the offer.
#[test]
fn a_lock_the_page_takes_holds_the_pointer_for_the_client() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client_with("app", &["--constrain-pointer", "lock"]);
    let app = an_app_under_the_pointer(&mut chrome);
    assert!(
        client.wait_for_trace(".lock_pointer()", 1),
        "the client never asked for a lock; it traced:\n{}",
        client.trace()
    );
    chrome
        .wait_for(|message| {
            *message
                == HostMessage::AppPointerConstraint {
                    app_id: app.clone(),
                    constraint: Some(PointerConstraint::Lock),
                    region: None,
                }
        })
        .expect("the lock is offered to the page");
    assert!(
        !client.trace().contains(".locked()"),
        "the client was told it is locked before the page took the pointer"
    );

    say(
        &mut chrome,
        ChromeMessage::PointerConstrained {
            app_id: app.clone(),
            active: true,
        },
    );
    assert!(
        client.wait_for_trace(".locked()", 1),
        "the page took the pointer and the client was never told; it traced:\n{}",
        client.trace()
    );

    say(
        &mut chrome,
        ChromeMessage::PointerMotion {
            app_id: app.clone(),
            x: 31.0,
            y: 31.0,
            moved: true,
        },
    );
    say(
        &mut chrome,
        ChromeMessage::PointerRelative {
            app_id: app.clone(),
            dx: 4.0,
            dy: 2.0,
            dx_unaccel: 4.0,
            dy_unaccel: 2.0,
        },
    );
    assert!(
        client.wait_for_trace(".relative_motion(4, 2, 4, 2)", 1),
        "a locked client heard no relative motion; it traced:\n{}",
        client.trace()
    );
    assert!(
        !client.trace().contains(", 31, 31)"),
        "the pointer moved for a locked client:\n{}",
        client.trace()
    );

    say(
        &mut chrome,
        ChromeMessage::PointerConstrained {
            app_id: app.clone(),
            active: false,
        },
    );
    assert!(
        client.wait_for_trace(".unlocked()", 1),
        "the page let go and the client was never told; it traced:\n{}",
        client.trace()
    );

    say(
        &mut chrome,
        ChromeMessage::PointerLeave {
            app_id: app.clone(),
        },
    );
    chrome
        .wait_for(|message| {
            *message
                == HostMessage::AppPointerConstraint {
                    app_id: app.clone(),
                    constraint: None,
                    region: None,
                }
        })
        .expect("the pointer leaving withdraws the offer");
}

/// A confinement is offered and told the same way, and the pointer still
/// moves for its client. The page answering for a window it was not offered
/// is dropped.
#[test]
fn a_confinement_the_page_takes_is_told_to_the_client() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client_with("app", &["--constrain-pointer", "confine"]);
    let app = an_app_under_the_pointer(&mut chrome);
    chrome
        .wait_for(|message| {
            *message
                == HostMessage::AppPointerConstraint {
                    app_id: app.clone(),
                    constraint: Some(PointerConstraint::Confine),
                    region: None,
                }
        })
        .expect("the confinement is offered to the page");

    say(
        &mut chrome,
        ChromeMessage::PointerConstrained {
            app_id: "app-elsewhere".into(),
            active: true,
        },
    );
    compositor.wait_for_log("pointer constraint not offered -> dropped");

    say(
        &mut chrome,
        ChromeMessage::PointerConstrained {
            app_id: app.clone(),
            active: true,
        },
    );
    assert!(
        client.wait_for_trace(".confined()", 1),
        "the page took the pointer and the client was never told; it traced:\n{}",
        client.trace()
    );
    say(
        &mut chrome,
        ChromeMessage::PointerMotion {
            app_id: app,
            x: 31.0,
            y: 31.0,
            moved: true,
        },
    );
    assert!(
        client.wait_for_trace(", 31, 31)", 1),
        "a confined pointer stopped moving for its client:\n{}",
        client.trace()
    );
}

/// A confinement to part of a window is offered with that part, as
/// rectangles of the surface, so the page can keep the pointer inside it.
#[test]
fn a_confinement_is_offered_with_its_region() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let _client = compositor.client_with(
        "app",
        &[
            "--constrain-pointer",
            "confine",
            "--constrain-region",
            "40x30+10+20",
        ],
    );
    let app = an_app_under_the_pointer(&mut chrome);
    chrome
        .wait_for(|message| {
            *message
                == HostMessage::AppPointerConstraint {
                    app_id: app.clone(),
                    constraint: Some(PointerConstraint::Confine),
                    region: Some(vec![SurfaceRect {
                        x: 10,
                        y: 20,
                        width: 40,
                        height: 30,
                    }]),
                }
        })
        .expect("the confinement is offered with its region");
}

/// Wait for the one window to appear and move the pointer over it.
fn an_app_under_the_pointer(chrome: &mut domicile_test_chrome::Chrome) -> String {
    let appeared = chrome
        .wait_for(|message| matches!(message, HostMessage::AppAppeared { .. }))
        .expect("a client that opened a window is announced to the chrome");
    let HostMessage::AppAppeared { app_id, .. } = appeared else {
        unreachable!("the wait matched on this variant")
    };
    say(
        chrome,
        ChromeMessage::PointerMotion {
            app_id: app_id.clone(),
            x: 10.0,
            y: 10.0,
            moved: true,
        },
    );
    app_id
}

fn say(chrome: &mut domicile_test_chrome::Chrome, message: ChromeMessage) {
    chrome
        .say(&message)
        .expect("the chrome can talk to the compositor");
}

/// The chrome receives the keymap compiled from the config.
///
/// The chrome here stands for the browser process. On DRM/Ozone, Chromium's
/// `KeyboardLayoutEngine` gets no keymap from Wayland, so without this message
/// printable keys decode as unidentified. The test checks a symbol from a
/// non-default variant.
#[test]
fn the_keymap_the_config_names_reaches_the_chrome() {
    let compositor = Compositor::started_with(A_DVORAK_KEYBOARD);
    let mut chrome = compositor.chrome();

    let told = chrome
        .wait_for(|message| matches!(message, HostMessage::Keymap { .. }))
        .expect("the keymap rides with the handshake");

    let HostMessage::Keymap { keymap } = told else {
        unreachable!("the wait matched on the variant");
    };
    assert_eq!(
        unshifted_on(&keymap, "AD01"),
        "apostrophe",
        "on `dvorak` the key qwerty prints `q` on is an apostrophe"
    );
}

/// A client's keyboard repeats as the config says, from the start and after
/// a reload, which sends no new keymap.
#[test]
fn a_client_repeats_keys_as_the_config_says() {
    let compositor = Compositor::started_with(A_DVORAK_KEYBOARD_REPEATING_FAST);
    let mut typing = compositor.client("typing");
    assert!(
        typing.wait_for_trace("repeat_info(40, 300)", 1),
        "a bound keyboard hears the configured repeat:\n{}",
        typing.trace()
    );

    compositor.reconfigure(A_DVORAK_KEYBOARD_NOT_REPEATING);

    assert!(
        typing.wait_for_trace("repeat_info(0, 600)", 1),
        "an open keyboard hears the reloaded repeat:\n{}",
        typing.trace()
    );
    assert_eq!(
        typing.trace().matches("keymap(").count(),
        1,
        "the keymap is not resent:\n{}",
        typing.trace()
    );
}

/// A reloaded keyboard reaches both open clients and the chrome.
///
/// The client gets a `wl_keyboard.keymap` fd and the chrome gets text over
/// its socket. Both are checked by layout name, so a recompile of the old
/// config fails.
#[test]
fn a_keyboard_edited_on_disk_reaches_the_client_and_the_chrome() {
    let compositor = Compositor::started_with(A_DVORAK_KEYBOARD);
    let mut typing = compositor.client("typing");
    assert!(
        typing.wait_for_trace("keymap(", 1),
        "a client binds a keyboard and is handed the config's keymap:\n{}",
        typing.trace()
    );
    let mut chrome = compositor.chrome();
    chrome
        .wait_for(|message| matches!(message, HostMessage::Keymap { .. }))
        .expect("the keymap rides with the handshake");

    compositor.reconfigure(A_PLAIN_KEYBOARD);

    let told = chrome
        .wait_for(|message| matches!(message, HostMessage::Keymap { .. }))
        .expect("the chrome is told the keymap the reload compiled");
    let HostMessage::Keymap { keymap } = told else {
        unreachable!("the wait matched on the variant");
    };
    assert_eq!(
        layout_name(&keymap),
        "English (US)",
        "the browser process is typing on the layout the file now names"
    );
    assert!(
        typing.wait_for_trace("keymap(", 2),
        "a window open across the reload is handed the new keymap too:\n{}",
        typing.trace()
    );
    let last = typing
        .trace()
        .rsplit("keymap(")
        .next()
        .expect("rsplit yields at least one piece")
        .to_string();
    assert!(
        last.starts_with("English (US)"),
        "and it is the new layout rather than a second copy of the old one: {last}"
    );
}

/// A client is handed its keymap as a read-only fd, on either path Smithay
/// sends it by: a sealed memfd from `wl_seat` 7, a temporary file below.
///
/// SELinux refuses a confined client a writable fd it may not write, and
/// wezterm exits without a keymap.
#[test]
fn a_client_is_handed_a_read_only_keymap() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut sealed = compositor.client_with("sealed", &["--wl-seat-v7"]);
    let mut unsealed = compositor.client("unsealed");

    for (client, path) in [(&mut sealed, "wl_seat 7"), (&mut unsealed, "wl_seat 5")] {
        assert!(
            client.wait_for_trace("keymap(", 1),
            "a client binds a keyboard and is handed a keymap:\n{}",
            client.trace()
        );
        assert!(
            client.trace().contains(", read-only)"),
            "the keymap fd on {path} is read-only:\n{}",
            client.trace()
        );
    }
}

/// A reloaded keymap that fails to compile is logged and ignored.
///
/// At startup the same failure is fatal. On reload, exiting would close every
/// open window, so the desk keeps its last good keymap. The test checks the
/// keymap a later chrome receives, not only the log.
#[test]
fn a_keymap_the_reload_cannot_compile_leaves_the_desktop_typing() {
    let compositor = Compositor::started_with(A_DVORAK_KEYBOARD);

    compositor.reconfigure(A_KEYBOARD_XKB_HAS_NEVER_HEARD_OF);

    compositor.wait_for_log("keeping the keymap the desktop is typing on");
    let mut chrome = compositor.chrome();
    let told = chrome
        .wait_for(|message| matches!(message, HostMessage::Keymap { .. }))
        .expect("a chrome that connects after the bad edit is told a keymap");
    let HostMessage::Keymap { keymap } = told else {
        unreachable!("the wait matched on the variant");
    };
    assert_eq!(
        layout_name(&keymap),
        "English (Dvorak)",
        "the retained keymap is the last one that compiled, not xkb's own fallback"
    );
}

/// A keymap the chrome was sent, compiled as the browser compiles it.
///
/// The text itself varies by libxkbcommon version: 1.12 writes keysyms as hex
/// and group names as `name[1]`, so the tests read it back rather than search
/// it.
fn read_back(keymap: &str) -> xkb::Keymap {
    let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
    xkb::Keymap::new_from_string(
        &context,
        keymap.to_string(),
        xkb::KEYMAP_FORMAT_TEXT_V1,
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    )
    .unwrap_or_else(|| panic!("xkb cannot read the keymap the chrome was sent:\n{keymap}"))
}

/// The keysym name on the first level of the key named `name` in the first
/// layout of `keymap`.
fn unshifted_on(keymap: &str, name: &str) -> String {
    let keymap = read_back(keymap);
    let key = keymap
        .key_by_name(name)
        .unwrap_or_else(|| panic!("no key <{name}> in the keymap"));
    match keymap.key_get_syms_by_level(key, 0, 0) {
        [keysym] => xkb::keysym_get_name(*keysym),
        other => panic!("<{name}> has {} keysyms unshifted", other.len()),
    }
}

/// The name of the first layout of `keymap`, such as `English (Dvorak)`.
fn layout_name(keymap: &str) -> String {
    read_back(keymap).layout_get_name(0).to_string()
}

/// The native client sees the original pinch lifecycle and unscaled metadata.
#[test]
fn a_pinch_reaches_the_native_client_without_scroll_events() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);
    for frame in [
        serde_json::json!({"phase":"begin", "device":7, "time":10, "fingers":3}),
        serde_json::json!({"phase":"update", "device":7, "time":11,
            "dx":1.25, "dy":-2.5, "scale":1.5, "rotation":-12.0}),
        serde_json::json!({"phase":"end", "device":7, "time":12, "canceled":true}),
    ] {
        let mut frame = frame;
        frame["type"] = "pointer_pinch".into();
        frame["app_id"] = app.clone().into();
        chrome
            .say(&serde_json::from_value::<ChromeMessage>(frame).unwrap())
            .unwrap();
    }
    for receipt in [
        "pinch_begin(10, 3)",
        "pinch_update(11, 1.25, -2.5, 1.5, -12)",
        "pinch_end(12, 1)",
    ] {
        assert!(
            client.wait_for_trace(receipt, 1),
            "{receipt} missing: {}",
            client.trace()
        );
    }
    assert!(
        !client.trace().contains("axis("),
        "pinch must not invent scroll distance"
    );
}

/// A gesture belongs to the connection that began it, then ends on focus loss.
#[test]
fn a_pinch_ignores_another_sender_and_cancels_when_the_pointer_leaves() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);
    let mut other = compositor.chrome();
    let begin = serde_json::from_value(serde_json::json!({
        "type": "pointer_pinch", "app_id": app, "phase": "begin",
        "device": 7, "time": 10, "fingers": 2,
    }))
    .unwrap();
    chrome.say(&begin).unwrap();
    assert!(client.wait_for_trace("pinch_begin(10, 2)", 1));
    let update = serde_json::from_value(serde_json::json!({
        "type": "pointer_pinch", "app_id": app, "phase": "update",
        "device": 7, "time": 11, "dx": 1.25, "dy": -2.5,
        "scale": 1.5, "rotation": -12,
    }))
    .unwrap();
    other.say(&update).unwrap();
    chrome
        .say(&ChromeMessage::PointerLeave {
            app_id: app.clone(),
        })
        .unwrap();
    // The canceled sequence's late tail must not reach the client.
    chrome.say(&update).unwrap();
    chrome
        .say(&ChromeMessage::Key {
            app_id: app,
            keycode: EVDEV_KEY_C,
            pressed: true,
        })
        .unwrap();
    assert!(client.wait_for_trace(&format!(", {EVDEV_KEY_C}, 1)"), 1));
    let trace = client.trace();
    assert!(
        trace
            .lines()
            .any(|line| line.contains("pinch_end(") && line.ends_with(", 1)")),
        "{trace}"
    );
    assert!(!trace.contains("pinch_update("), "{trace}");
}

/// A begin for a window the pointer is not on leaves the active pinch alone.
#[test]
fn a_begin_for_another_window_keeps_the_pointer_windows_pinch() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);
    for frame in [
        serde_json::json!({"app_id": app, "phase":"begin", "device":7, "time":10, "fingers":2}),
        serde_json::json!({"app_id": "elsewhere", "phase":"begin", "device":8, "time":11,
            "fingers":2}),
        serde_json::json!({"app_id": app, "phase":"update", "device":7, "time":12,
            "dx":1.0, "dy":2.0, "scale":1.5, "rotation":0.0}),
    ] {
        let mut frame = frame;
        frame["type"] = "pointer_pinch".into();
        chrome
            .say(&serde_json::from_value::<ChromeMessage>(frame).unwrap())
            .unwrap();
    }
    assert!(
        client.wait_for_trace("pinch_update(12, ", 1),
        "the pinch ended under the other begin: {}",
        client.trace()
    );
    assert!(!client.trace().contains("pinch_end("), "{}", client.trace());
}

/// A dropped engine channel cannot leave a native client's pinch active.
#[test]
fn disconnecting_the_sender_cancels_its_pinch() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);
    let begin = serde_json::from_value(serde_json::json!({
        "type": "pointer_pinch", "app_id": app, "phase": "begin",
        "device": 7, "time": 10, "fingers": 2,
    }))
    .unwrap();
    chrome.say(&begin).unwrap();
    assert!(client.wait_for_trace("pinch_begin(10, 2)", 1));
    drop(chrome);
    assert!(client.wait_for_trace("pinch_end(", 1));
    let trace = client.trace();
    assert!(
        trace
            .lines()
            .any(|line| line.contains("pinch_end(") && line.ends_with(", 1)")),
        "{trace}"
    );
}

fn say_json(chrome: &mut domicile_test_chrome::Chrome, frame: serde_json::Value) {
    chrome
        .say(&serde_json::from_value::<ChromeMessage>(frame).unwrap())
        .unwrap();
}

/// The line of `trace` that begins `call(` and ends `tail`.
fn traced(trace: &str, call: &str, tail: &str) -> bool {
    trace
        .lines()
        .any(|line| line.contains(&format!("{call}(")) && line.ends_with(tail))
}

/// A swipe or hold the shell left unbound reaches the window under the
/// pointer, though it names no window.
#[test]
fn an_unbound_swipe_and_hold_reach_the_pointers_window() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, _app) = a_client_being_typed_at(&compositor);
    for frame in [
        serde_json::json!({"type":"pointer_swipe", "phase":"begin", "fingers":3}),
        serde_json::json!({"type":"pointer_swipe", "phase":"update", "dx":1.25, "dy":-2.5}),
        serde_json::json!({"type":"pointer_swipe", "phase":"end", "canceled":false}),
        serde_json::json!({"type":"pointer_hold", "phase":"begin", "fingers":4}),
        serde_json::json!({"type":"pointer_hold", "phase":"end", "canceled":true}),
    ] {
        say_json(&mut chrome, frame);
    }
    assert!(client.wait_for_trace("hold_end(", 1), "{}", client.trace());
    let trace = client.trace();
    for (call, tail) in [
        ("swipe_begin", ", 3)"),
        ("swipe_update", ", 1.25, -2.5)"),
        ("swipe_end", ", 0)"),
        ("hold_begin", ", 4)"),
        ("hold_end", ", 1)"),
    ] {
        assert!(traced(&trace, call, tail), "{call} missing: {trace}");
    }
}

/// A swipe ends canceled when the pointer leaves its window, and one begun
/// over no window reaches nobody.
#[test]
fn a_swipe_cancels_when_the_pointer_leaves_and_starts_nowhere() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_client_being_typed_at(&compositor);
    say_json(
        &mut chrome,
        serde_json::json!({"type":"pointer_swipe", "phase":"begin", "fingers":3}),
    );
    assert!(client.wait_for_trace("swipe_begin(", 1));
    chrome
        .say(&ChromeMessage::PointerLeave {
            app_id: app.clone(),
        })
        .unwrap();
    // The canceled swipe's late tail, then a swipe over no window.
    for frame in [
        serde_json::json!({"type":"pointer_swipe", "phase":"update", "dx":1.0, "dy":0.0}),
        serde_json::json!({"type":"pointer_swipe", "phase":"end", "canceled":false}),
        serde_json::json!({"type":"pointer_swipe", "phase":"begin", "fingers":4}),
    ] {
        say_json(&mut chrome, frame);
    }
    chrome
        .say(&ChromeMessage::Key {
            app_id: app,
            keycode: EVDEV_KEY_C,
            pressed: true,
        })
        .unwrap();
    assert!(client.wait_for_trace(&format!(", {EVDEV_KEY_C}, 1)"), 1));
    let trace = client.trace();
    assert!(traced(&trace, "swipe_end", ", 1)"), "{trace}");
    assert!(!trace.contains("swipe_update("), "{trace}");
    assert!(!traced(&trace, "swipe_end", ", 0)"), "{trace}");
    assert!(!traced(&trace, "swipe_begin", ", 4)"), "{trace}");
}

/// A dropped engine channel cannot leave a native client's hold going.
#[test]
fn disconnecting_the_sender_cancels_its_hold() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, _app) = a_client_being_typed_at(&compositor);
    say_json(
        &mut chrome,
        serde_json::json!({"type":"pointer_hold", "phase":"begin", "fingers":3}),
    );
    assert!(client.wait_for_trace("hold_begin(", 1));
    drop(chrome);
    assert!(client.wait_for_trace("hold_end(", 1));
    assert!(
        traced(&client.trace(), "hold_end", ", 1)"),
        "{}",
        client.trace()
    );
}

/// A started client and its window's app id, with nothing driven at it yet.
fn a_window(
    compositor: &Compositor,
    extra: &[&str],
) -> (domicile_test_chrome::Chrome, crate::running::Client, String) {
    let mut chrome = compositor.chrome();
    let client = compositor.client_with("app", extra);
    let appeared = chrome
        .wait_for(|message| matches!(message, HostMessage::AppAppeared { .. }))
        .expect("a client that opened a window is announced to the chrome");
    let HostMessage::AppAppeared { app_id, .. } = appeared else {
        unreachable!("the wait matched on this variant")
    };
    (chrome, client, app_id)
}

fn touch(app_id: &str, step: serde_json::Value) -> ChromeMessage {
    let mut frame = step;
    frame["type"] = "touch".into();
    frame["app_id"] = app_id.into();
    serde_json::from_value(frame).expect("a touch step the protocol reads")
}

/// A client that reads `wl_touch` gets every finger as a touch point, each
/// step in a frame, and never a pointer button for it.
#[test]
fn fingers_reach_a_touch_client_as_touch_points() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_window(&compositor, &[]);
    for step in [
        serde_json::json!({"phase":"down", "id":2, "time":10, "x":20.0, "y":30.0}),
        serde_json::json!({"phase":"down", "id":3, "time":11, "x":60.0, "y":30.0}),
        serde_json::json!({"phase":"motion", "id":2, "time":12, "x":25.0, "y":35.0}),
        serde_json::json!({"phase":"up", "id":2, "time":13}),
        serde_json::json!({"phase":"up", "id":3, "time":14}),
    ] {
        chrome.say(&touch(&app, step)).unwrap();
    }
    for receipt in [
        ", 2, 20, 30)",
        ", 3, 60, 30)",
        "touch_motion(12, 2, 25, 35)",
        "up(13, 2)",
        "up(14, 3)",
    ] {
        assert!(
            client.wait_for_trace(receipt, 1),
            "{receipt} missing: {}",
            client.trace()
        );
    }
    let trace = client.trace();
    assert!(trace.contains("touch_frame()"), "{trace}");
    assert!(
        !trace.contains(&format!(", {BTN_LEFT}, 1)")),
        "a finger on a touch client is not also a click: {trace}"
    );
}

/// A client with no `wl_touch` gets the first finger as the pointer and its
/// primary button; a second finger at the same time is not a second press.
#[test]
fn a_client_without_touch_gets_a_finger_as_the_pointer() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_window(&compositor, &["--no-touch"]);
    for step in [
        serde_json::json!({"phase":"down", "id":2, "time":10, "x":20.0, "y":30.0}),
        serde_json::json!({"phase":"down", "id":3, "time":11, "x":60.0, "y":30.0}),
        serde_json::json!({"phase":"up", "id":3, "time":12}),
        serde_json::json!({"phase":"motion", "id":2, "time":13, "x":25.0, "y":35.0}),
        serde_json::json!({"phase":"up", "id":2, "time":14}),
    ] {
        chrome.say(&touch(&app, step)).unwrap();
    }
    assert!(
        client.wait_for_trace(&format!(", {BTN_LEFT}, 0)"), 1),
        "the finger's lift never released the button: {}",
        client.trace()
    );
    let trace = client.trace();
    assert!(trace.contains(".enter("), "{trace}");
    assert_eq!(
        trace.matches(&format!(", {BTN_LEFT}, 1)")).count(),
        1,
        "{trace}"
    );
    assert!(
        trace.contains("motion(") && trace.contains(", 25, 35)"),
        "{trace}"
    );
    assert!(!trace.contains("touch_frame()"), "{trace}");
}

/// A dropped engine channel cannot leave a finger down on a client.
#[test]
fn disconnecting_the_sender_cancels_its_touches() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let (mut chrome, mut client, app) = a_window(&compositor, &[]);
    chrome
        .say(&touch(
            &app,
            serde_json::json!({"phase":"down", "id":2, "time":10, "x":20.0, "y":30.0}),
        ))
        .unwrap();
    assert!(
        client.wait_for_trace(", 2, 20, 30)", 1),
        "{}",
        client.trace()
    );
    drop(chrome);
    assert!(client.wait_for_trace("cancel()", 1), "{}", client.trace());
}
