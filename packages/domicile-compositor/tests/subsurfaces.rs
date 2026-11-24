//! A client's subsurfaces: drawn inside their window's frame by the engine,
//! never announced to the chrome as popups, and hit-tested by the compositor
//! for the input the chrome sends the window.
//!
//! Drawing is covered by `guard-scrolling-bubble.sh`, which runs the engine.

mod running;

use std::time::{Duration, Instant};

use domicile_protocol::{ChromeMessage, HostMessage};
use domicile_test_chrome::Chrome;
use domicile_test_client::{BUBBLE, BUBBLE_GROWN};

use crate::running::{Client, Compositor};

const ONE_DISPLAY: &str = r#"
{ "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] } }
"#;

/// The window a client opened, by the id the chrome was told.
fn window_of(chrome: &mut Chrome) -> String {
    let appeared = chrome
        .wait_for(|message| matches!(message, HostMessage::AppAppeared { .. }))
        .expect("the client's window is announced");
    let HostMessage::AppAppeared { app_id, .. } = appeared else {
        unreachable!("the wait matched on this variant")
    };
    app_id
}

/// The `--bubble` subsurface's `wl_surface`, as the client traces it.
fn bubble_surface(client: &mut Client) -> String {
    assert!(client.wait_for_trace(".opened(", 1));
    client
        .trace()
        .lines()
        .find_map(|line| line.split_once(".opened(").map(|(_, rest)| rest))
        .and_then(|rest| rest.strip_suffix(')'))
        .expect("the client says which surface its bubble is")
        .to_string()
}

/// A point on the window inside the grown bubble, 5 and 6 from its corner,
/// and outside the bubble as first placed.
fn in_the_grown_bubble() -> (f64, f64) {
    let (x, y, _, _) = BUBBLE_GROWN;
    let (first_x, _, _, _) = BUBBLE;
    assert!(x + 5 < first_x, "the point is clear of the first placement");
    (f64::from(x + 5), f64::from(y + 6))
}

/// Move the pointer to `at` on `window` until the client has traced
/// `entered` `times` times, since the bubble grows into place after its first
/// frame. Returns whether it did.
fn point_until(
    chrome: &mut Chrome,
    client: &mut Client,
    window: &str,
    at: (f64, f64),
    (entered, times): (&str, usize),
) -> bool {
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        chrome
            .say(&ChromeMessage::PointerMotion {
                app_id: window.to_string(),
                x: at.0,
                y: at.1,
                moved: true,
            })
            .expect("the chrome can move the pointer");
        if client.trace().matches(entered).count() >= times {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// The pointer over a subsurface, which the chrome sees only as its window,
/// enters the subsurface at its own point. Chromium draws its extension
/// popups this way.
#[test]
fn a_pointer_over_a_subsurface_enters_it_at_its_own_point() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client_with("a window with a bubble", &["--bubble"]);
    let window = window_of(&mut chrome);
    let bubble = bubble_surface(&mut client);

    let entered = point_until(
        &mut chrome,
        &mut client,
        &window,
        in_the_grown_bubble(),
        (&format!("{bubble}, 5, 6)"), 1),
    );
    assert!(
        entered,
        "the pointer never entered {bubble} at its own point:\n{}",
        client.trace()
    );
}

/// A subsurface is part of its window's frame, so it moves, scales and fades
/// with it. The chrome never hears of it.
#[test]
fn a_subsurface_is_never_announced_as_a_popup() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client_with("a window with a bubble", &["--bubble"]);
    let window = window_of(&mut chrome);
    let bubble = bubble_surface(&mut client);
    assert!(point_until(
        &mut chrome,
        &mut client,
        &window,
        in_the_grown_bubble(),
        (&format!("{bubble}, 5, 6)"), 1),
    ));

    drop(client);

    let next = chrome
        .wait_for(|message| {
            matches!(
                message,
                HostMessage::PopupPlaced { .. } | HostMessage::AppClosed { .. }
            )
        })
        .expect("the window's going is announced");
    assert_eq!(next, HostMessage::AppClosed { app_id: window });
}

/// A subsurface whose input region leaves the point out passes it to the
/// surface under it. Firefox draws its whole window into such a subsurface
/// and reads the pointer only on its toplevel.
#[test]
fn a_subsurface_that_takes_no_input_passes_the_pointer_to_its_window() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client_with(
        "a window under a bubble that takes no input",
        &["--bubble-without-input"],
    );
    let window = window_of(&mut chrome);
    let bubble = bubble_surface(&mut client);
    compositor.wait_for_log("a subsurface");

    let (x, y) = in_the_grown_bubble();
    chrome
        .say(&ChromeMessage::PointerMotion {
            app_id: window.clone(),
            x,
            y,
            moved: true,
        })
        .expect("the chrome can move the pointer");
    assert!(
        client.wait_for_trace(&format!(", {x}, {y})"), 1),
        "the pointer entered the window at its own point:\n{}",
        client.trace()
    );
    assert!(
        !client.trace().contains(&format!("{bubble}, ")),
        "the pointer entered the bubble:\n{}",
        client.trace()
    );
}

/// Chromium hides a subsurface by destroying its `wl_subsurface` and keeping
/// the surface. The pointer then goes to the window under it.
#[test]
fn a_hidden_subsurface_takes_the_pointer_no_more() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client_with("a window with a bubble", &["--bubble"]);
    let window = window_of(&mut chrome);
    let bubble = bubble_surface(&mut client);
    let at = in_the_grown_bubble();
    assert!(point_until(
        &mut chrome,
        &mut client,
        &window,
        at,
        (&format!("{bubble}, 5, 6)"), 1),
    ));

    chrome
        .say(&ChromeMessage::PointerButton {
            app_id: window.clone(),
            button: 0x110,
            pressed: true,
        })
        .expect("the chrome can press");
    assert!(client.wait_for_trace("hid()", 1), "{}", client.trace());

    let window_point = format!(", {}, {})", at.0, at.1);
    let before = client.trace().matches(&window_point).count();
    assert!(
        point_until(
            &mut chrome,
            &mut client,
            &window,
            at,
            (&window_point, before + 1)
        ),
        "the pointer never went to the window under the hidden bubble:\n{}",
        client.trace()
    );
}
