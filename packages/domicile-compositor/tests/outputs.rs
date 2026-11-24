//! What a real Wayland client is told the screens are.
//!
//! `desktop.rs` covers what the chrome is told. A compositor can describe two
//! displays to the chrome while advertising one `wl_output`, or update the
//! chrome on reload while leaving open windows on the old displays. These
//! checks catch that.
//!
//! A window enters every display until the page reports its bounds
//! (`set_app_bounds`), then the displays it overlaps. The reload check also
//! reads `wl_surface.leave`, so it can tell a compositor that updates a
//! window's displays from one that never does.
//!
//! The client's own trace reports the outputs, so no `wayland-info` is
//! needed.

mod running;

use std::os::unix::net::UnixStream;

use domicile_launch::compositor_socket::monitors;
use domicile_protocol::{ChromeMessage, DisplayHdr, HostMessage, MonitorInfo};
use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle};

use crate::running::{Client, Compositor};

/// The left display at the origin and the right one beside it, at twice the
/// density.
///
/// Every field matters: the position places the screen on the desktop, the
/// size is what a filling client gets, and the scale is what it draws at.
const TWO_DISPLAYS: &str = r#"
{
  "output": {
    "displays": [
      { "name": "left", "size": [1920, 1080] },
      {
        "name": "right",
        "position": [1920, 0],
        "size": [2560, 1440],
        "scale": 2
      }
    ]
  }
}
"#;

/// What a client should be told those two displays are.
///
/// The right screen's mode is `5120x2880`, not `2560x1440`, because a mode is
/// in physical pixels: logical size times scale.
///
/// `0mHz` and `0x0mm` mean "unknown" in the protocol. A config gives no
/// physical size or refresh rate, and inventing them would give clients a
/// wrong DPI.
const AS_TOLD: [&str; 2] = [
    "left@0,0@1=1920x1080(current preferred) 0mHz 0x0mm",
    "right@1920,0@2=5120x2880(current preferred) 0mHz 0x0mm",
];

/// A two-display config becomes two `wl_output`s, each described in full.
#[test]
fn both_configured_displays_are_advertised_to_a_client() {
    let compositor = Compositor::started_with(TWO_DISPLAYS);
    let mut client = compositor.client("app");

    assert!(
        client.wait_for_trace(".done(", 2),
        "the client was never told about two screens in full; it traced:\n{}",
        client.trace()
    );

    assert_eq!(
        client.screens(),
        AS_TOLD,
        "a client was told the wrong thing about the screens; it traced:\n{}",
        client.trace()
    );
}

/// A window on a two-display desktop enters both outputs.
///
/// A toolkit reads `wl_surface.enter` to pick its density, so a surface
/// entered on only one screen draws wrongly on the other. The check above
/// reads only what was advertised.
///
/// Counts distinct outputs, so two `enter`s for the same screen fail.
#[test]
fn a_window_enters_both_screens_rather_than_the_first() {
    let compositor = Compositor::started_with(TWO_DISPLAYS);
    let mut client = compositor.client("app");

    assert!(
        client.wait_for_trace(".enter(", 2),
        "the window never entered two screens; it traced:\n{}",
        client.trace()
    );

    let trace = client.trace();
    let mut entered: Vec<&str> = trace
        .lines()
        .filter_map(|line| line.split_once(".enter("))
        .map(|(_, rest)| rest.trim_end_matches(')'))
        .collect();
    entered.sort_unstable();
    entered.dedup();

    assert_eq!(
        entered.len(),
        2,
        "the window entered {} screen(s) and there are two; it traced:\n{}",
        entered.len(),
        trace
    );
}

/// The one display this reload starts from.
const ONE_DISPLAY: &str = r#"
{ "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] } }
"#;

/// A window already open when a display appears is told it is on it.
///
/// `desktop.rs` covers what the chrome is told about a config change. This
/// covers a client mapped before the change: without `wl_surface.enter` for
/// the new display it keeps drawing at the old density there.
///
/// The client is started before the edit, so its window exists before the
/// new display does. It should end up on both.
#[test]
fn a_window_open_across_a_reload_is_told_about_the_display_that_arrived() {
    let compositor = Compositor::started_with(ONE_DISPLAY);
    let mut client = compositor.client("app");

    assert!(
        client.wait_for_trace(".enter(", 1),
        "the window never entered the one screen there was, so the reload \
         below has nothing to add to; it traced:\n{}",
        client.trace()
    );

    compositor.reconfigure(TWO_DISPLAYS);
    compositor.wait_for_log("taking up a reloaded desktop");

    assert!(
        client.wait_for_trace(".enter(", 2),
        "the window was open when the second display appeared and was never \
         told it is on it; it traced:\n{}",
        client.trace()
    );

    assert_eq!(
        client.on_screens(),
        vec!["left".to_string(), "right".to_string()],
        "the window is on the wrong screens after the reload; it traced:\n{}",
        client.trace()
    );
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

/// The page put `app_id`'s window at `position` with `size`.
fn placed(
    chrome: &mut domicile_test_chrome::Chrome,
    app_id: &str,
    position: [f64; 2],
    size: [f64; 2],
) {
    chrome
        .say(&ChromeMessage::SetAppBounds {
            app_id: app_id.to_string(),
            position,
            size,
        })
        .expect("the chrome reports where it put the window");
}

/// Until the page says where a window is, it draws for the densest screen,
/// since it is on them all.
///
/// `wp_fractional_scale_v1` counts in 120ths, so the right screen's 2 is 240.
#[test]
fn a_window_the_page_has_not_placed_draws_for_the_densest_screen() {
    let compositor = Compositor::started_with(TWO_DISPLAYS);
    let mut client = compositor.client("app");

    assert!(
        client.wait_for_trace(".preferred_scale(240)", 1),
        "the window was never given the densest screen's scale; it traced:\n{}",
        client.trace()
    );
}

/// A window the page put on one screen is on that screen alone, at its scale,
/// and both follow the window to the next screen.
#[test]
fn a_window_takes_the_scale_of_the_screen_the_page_put_it_on() {
    let compositor = Compositor::started_with(TWO_DISPLAYS);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client("app");
    let app_id = appeared(&mut chrome);

    placed(&mut chrome, &app_id, [100.0, 100.0], [800.0, 600.0]);

    assert!(
        client.wait_for_trace(".preferred_scale(120)", 1),
        "a window on the 1x screen was not given scale 1; it traced:\n{}",
        client.trace()
    );
    assert!(
        client.wait_for_trace(".leave(", 1),
        "a window on the left screen alone never left the right one; it \
         traced:\n{}",
        client.trace()
    );
    assert_eq!(client.on_screens(), vec!["left".to_string()]);

    placed(&mut chrome, &app_id, [2000.0, 100.0], [800.0, 600.0]);

    assert!(
        client.wait_for_trace(".preferred_scale(240)", 2),
        "a window moved to the 2x screen kept scale 1; it traced:\n{}",
        client.trace()
    );
    assert!(
        client.wait_for_trace(".leave(", 2),
        "a window moved to the right screen never left the left one; it \
         traced:\n{}",
        client.trace()
    );
    assert_eq!(client.on_screens(), vec!["right".to_string()]);
}

/// A menu is on the screen its window is on, at that screen's scale, and
/// follows the window to the next screen. A window the page hides keeps its
/// menu where it was.
#[test]
fn a_popup_takes_the_screen_and_scale_of_its_window() {
    let compositor = Compositor::started_with(TWO_DISPLAYS);
    let mut chrome = compositor.chrome();
    let mut client = compositor.client_with("app", &["--popup"]);
    let app_id = appeared(&mut chrome);
    let popup = popup_surface(&mut client);

    placed(&mut chrome, &app_id, [100.0, 100.0], [800.0, 600.0]);

    let scaled = format!("{popup}.preferred_scale(120)");
    assert!(
        client.wait_for_trace(&scaled, 1),
        "a menu over a window on the 1x screen was not given scale 1; it \
         traced:\n{}",
        client.trace()
    );
    assert_eq!(client.surface_on_screens(&popup), vec!["left".to_string()]);

    placed(&mut chrome, &app_id, [2000.0, 100.0], [800.0, 600.0]);

    let rescaled = format!("{popup}.preferred_scale(240)");
    assert!(
        client.wait_for_trace(&rescaled, 1),
        "a menu over a window moved to the 2x screen kept scale 1; it \
         traced:\n{}",
        client.trace()
    );
    assert!(
        // Its first leave was the right screen's, once its window was placed.
        client.wait_for_trace(&format!("{popup}.leave("), 2),
        "a menu over a window moved to the right screen never left the left \
         one; it traced:\n{}",
        client.trace()
    );
    assert_eq!(client.surface_on_screens(&popup), vec!["right".to_string()]);

    placed(&mut chrome, &app_id, [0.0, 0.0], [0.0, 0.0]);
    placed(&mut chrome, &app_id, [2100.0, 100.0], [800.0, 600.0]);
    assert!(
        client.wait_for_trace(&rescaled, 1),
        "the window came back; it traced:\n{}",
        client.trace()
    );
    assert_eq!(
        client.surface_on_screens(&popup),
        vec!["right".to_string()],
        "hiding the window moved its menu; it traced:\n{}",
        client.trace()
    );
}

/// The `wl_surface@N` of the popup a `--popup` client opened.
fn popup_surface(client: &mut Client) -> String {
    assert!(
        client.wait_for_trace(".opened(", 1),
        "the client never opened its popup; it traced:\n{}",
        client.trace()
    );
    let trace = client.trace();
    let (_, opened) = trace.split_once(".opened(").expect("the wait found it");
    let (surface, _) = opened.split_once(')').expect("a whole line");
    surface.to_string()
}

/// A client that binds a display just as it goes away is not disconnected.
///
/// A client binds each `wl_output` it is told about, and the
/// `global_remove` for one can cross that `bind` in flight. Unplugging a TV
/// the desk extended onto then killed every client caught that way. The
/// client here lists the outputs, the right display goes, and it binds them
/// all before reading the removal.
#[test]
fn a_bind_that_crosses_a_displays_removal_does_not_kill_the_client() {
    let compositor = Compositor::started_with(TWO_DISPLAYS);
    let socket = UnixStream::connect(compositor.wayland_socket())
        .expect("the apps' display takes a connection");
    let connection = Connection::from_socket(socket).expect("a Wayland connection");
    let mut queue = connection.new_event_queue();
    let registry = connection.display().get_registry(&queue.handle(), ());
    let mut late = LateBinder::default();
    queue.roundtrip(&mut late).expect("globals listed");
    assert_eq!(late.outputs.len(), 2, "both displays are advertised");

    compositor.reconfigure(ONE_DISPLAY);
    compositor.wait_for_log("taking up a reloaded desktop");
    for (name, version) in &late.outputs {
        let _: wl_output::WlOutput = registry.bind(*name, *version, &queue.handle(), ());
    }

    queue
        .roundtrip(&mut late)
        .expect("binding a display as it went away disconnected the client");
}

/// Lists the `wl_output`s it is told about without binding them.
#[derive(Default)]
struct LateBinder {
    outputs: Vec<(u32, u32)>,
}

impl Dispatch<wl_registry::WlRegistry, ()> for LateBinder {
    fn event(
        late: &mut LateBinder,
        _: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<LateBinder>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            if interface == "wl_output" {
                late.outputs.push((name, version));
            }
        }
    }
}

impl Dispatch<wl_output::WlOutput, ()> for LateBinder {
    fn event(
        _: &mut LateBinder,
        _: &wl_output::WlOutput,
        _: wl_output::Event,
        (): &(),
        _: &Connection,
        _: &QueueHandle<LateBinder>,
    ) {
    }
}

#[test]
fn settings_is_told_each_monitor_by_name_and_whether_it_takes_hdr() {
    // `domicile-app-host` asks this for Settings. A described desktop has no
    // panels, so no monitor takes HDR and only the output names are known.
    let compositor = Compositor::started_with(TWO_DISPLAYS);
    assert_eq!(
        monitors(compositor.socket(), Some(std::time::Duration::from_secs(5))),
        Ok(vec![
            MonitorInfo {
                names: vec!["left".to_string()],
                hdr: DisplayHdr::Unsupported,
            },
            MonitorInfo {
                names: vec!["right".to_string()],
                hdr: DisplayHdr::Unsupported,
            },
        ])
    );
}
