//! A minimal Wayland client that tests open windows with.
//!
//! It needs no weston, libwayland or GPU, so checks that need a real client
//! run on any machine that builds the workspace.
//!
//! The `domicile-test-client` executable is a `[[bin]]` of
//! `domicile-compositor`. Cargo builds a package's binaries when it builds that
//! package's tests, but cannot depend on another package's binary, so this is
//! how `cargo test -p domicile-compositor` gets the client it spawns.

use std::ffi::OsString;
use std::process::ExitCode;

mod anchor_protocol;
pub mod arguments;
mod notification;
pub mod trace;
mod tray;
mod window;

pub use window::{
    scrolled_to, BUBBLE, BUBBLE_GROWN, CARET, CARET_ADVANCE, DEEP_COLOR, POPUP, POPUP_COLOR,
    POPUP_MOVED, SCROLLING_BUBBLE, STRIPE_COLOR, TRANSLUCENT_ALPHA, TRANSLUCENT_COLORS,
    TURNED_COLORS,
};

/// Run the client: open a window on `WAYLAND_DISPLAY` and draw until killed.
///
/// See [`arguments`] for the accepted command line.
pub fn run(command_line: impl IntoIterator<Item = OsString>) -> ExitCode {
    let asked = match arguments::arguments(command_line) {
        Ok(asked) => asked,
        Err(err) => {
            eprintln!("domicile-test-client: {err}");
            eprintln!(
                "usage: domicile-test-client [--title NAME] [--trace] [--translucent] [--follow-configure] [--ask-for-focus | --ask-for-focus-when-entered | --ask-for-focus-when-left] [--hold-the-screens-on] [--hold-the-screens-on-before-it-has-a-window] [--inhibit-shortcuts | --inhibit-shortcuts-before-it-has-a-window] [--outlive-its-window] [--ring-the-bell] [--copy TEXT] [--copy-primary TEXT] [--notify SUMMARY] [--tray] [--paste] [--popup] [--popup-grab] [--repositioned-popup] [--anchor NAME] [--sliding-menu] [--bubble] [--bubble-without-input] [--scrolling-bubble [--late-bubble]] [--min-size WxH] [--max-size WxH] [--viewport-source WxH] [--viewport-to WxH] [--buffer-transform TURN] [--no-touch] [--text-input]"
            );
            return ExitCode::from(2);
        }
    };

    if asked.trace {
        trace::wanted();
    }

    // `window::run` returns only on failure; callers end the client with a
    // signal.
    let Err(err) = window::run(&asked);
    eprintln!("domicile-test-client: {err}");
    ExitCode::FAILURE
}
