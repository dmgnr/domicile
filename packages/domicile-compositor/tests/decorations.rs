//! Tests that both decoration protocols answer "server side".
//!
//! The shell draws every window's frame, so a client-drawn frame would be a
//! second one. The test client asks for client-side decorations. Clients that
//! draw their own anyway (GTK4) are handled by `window_geometry.rs`.

mod running;

use crate::running::Compositor;

/// `zxdg_toplevel_decoration_v1`, which Chromium, Electron and Qt ask through.
#[test]
fn a_window_asking_to_draw_its_own_frame_is_told_the_shell_draws_it() {
    let compositor = Compositor::started_with("{}");
    let _chrome = compositor.chrome();
    let mut client = compositor.client("app");

    assert!(
        client.wait_for_trace("configure(ServerSide)", 1),
        "the compositor did not tell the window the shell draws its frame; it \
         traced:\n{}",
        client.trace()
    );
}

/// `org_kde_kwin_server_decoration`, which GTK3 asks through.
#[test]
fn a_gtk3_window_asking_to_draw_its_own_frame_is_told_the_shell_draws_it() {
    let compositor = Compositor::started_with("{}");
    let _chrome = compositor.chrome();
    let mut client = compositor.client("app");

    assert!(
        client.wait_for_trace("mode(Server)", 1),
        "the compositor did not answer the KDE decoration request with server \
         side; it traced:\n{}",
        client.trace()
    );
}

/// GTK3 and Firefox answer `mode(Server)` by asking for client side again. The
/// compositor must not answer each ask, or the two ping-pong forever and burn
/// CPU (#2466). The test client insists the same way.
#[test]
fn a_gtk3_window_insisting_on_its_own_frame_is_told_server_side_once() {
    let compositor = Compositor::started_with("{}");
    let _chrome = compositor.chrome();
    let mut client = compositor.client("app");

    assert!(
        client.wait_for_trace("insisted on drawing its own frame", 1),
        "the client never insisted on drawing its own frame; it traced:\n{}",
        client.trace()
    );
    let trace = client.trace();
    assert_eq!(trace.matches("mode(Server)").count(), 1, "{trace}");
}
