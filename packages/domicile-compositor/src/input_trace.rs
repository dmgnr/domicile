//! Every input event, for `domicile set-log-level trace input`.
//!
//! Each line says what the input was and where: which window, where the
//! pointer is, which button. Never which key, nor what was typed into a field:
//! a log of keys is a log of passwords, and logs get attached to bugs.

use std::fmt::Write as _;

use crate::client_requests::ClientRequest;

/// Logs `request` at trace if it is input.
pub fn trace(request: &ClientRequest) {
    if tracing::enabled!(tracing::Level::TRACE) {
        if let Some(input) = described(request) {
            tracing::trace!("{input}");
        }
    }
}

/// What input `request` is, without which key, or `None` if it is not input.
pub fn described(request: &ClientRequest) -> Option<String> {
    let press = |pressed: &bool| if *pressed { "down" } else { "up" };
    let mut said = String::new();
    match request {
        ClientRequest::Key { pressed, .. } => write!(said, "a key {}", press(pressed)),
        ClientRequest::KeyForInputMethod { pressed, .. } => {
            write!(said, "a key {} for the input method", press(pressed))
        }
        ClientRequest::TextInput { .. } => write!(said, "a text field changed"),
        ClientRequest::KeyboardFocus { app_id } => match app_id {
            Some(app_id) => write!(said, "keyboard focus to {app_id}"),
            None => write!(said, "keyboard focus to the shell"),
        },
        ClientRequest::PointerMotion {
            app_id, x, y, moved, ..
        } => write!(
            said,
            "pointer {} ({x:.1}, {y:.1}) over {app_id}",
            if *moved { "at" } else { "still at" }
        ),
        ClientRequest::PointerRelative {
            app_id,
            dx,
            dy,
            dx_unaccel,
            dy_unaccel,
        } => write!(
            said,
            "pointer moved ({dx:.1}, {dy:.1}), unaccelerated ({dx_unaccel:.1}, {dy_unaccel:.1}), over {app_id}"
        ),
        ClientRequest::PointerLeave => write!(said, "pointer left the window"),
        ClientRequest::PointerButton { button, pressed } => {
            write!(said, "button {button:#x} {}", press(pressed))
        }
        ClientRequest::PointerAxis {
            dx,
            dy,
            v120_x,
            v120_y,
            source,
            stop_x,
            stop_y,
        } => write!(
            said,
            "scroll ({dx:.1}, {dy:.1}) v120 ({v120_x}, {v120_y}) from {source:?}{}{}",
            if *stop_x { ", x stops" } else { "" },
            if *stop_y { ", y stops" } else { "" }
        ),
        ClientRequest::PointerPinch { app_id, pinch, .. } => {
            write!(said, "pinch {pinch:?} over {app_id}")
        }
        ClientRequest::PointerSwipe { swipe, .. } => write!(said, "swipe {swipe:?}"),
        ClientRequest::PointerHold { hold, .. } => write!(said, "hold {hold:?}"),
        ClientRequest::Touch { app_id, touch, .. } => {
            write!(said, "touch {touch:?} on {app_id}")
        }
        ClientRequest::Activity { input } => write!(
            said,
            "the browser saw {}",
            input.as_deref().unwrap_or("input")
        ),
        ClientRequest::DeskPointer { at, .. } => match at {
            Some((x, y)) => write!(said, "desk pointer at ({x:.1}, {y:.1})"),
            None => write!(said, "desk pointer hidden"),
        },
        _ => return None,
    }
    .expect("writing to a String succeeds");
    Some(said)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_says_it_was_pressed_and_never_which() {
        let said = described(&ClientRequest::Key {
            keycode: 30,
            pressed: true,
        })
        .unwrap();
        assert_eq!(said, "a key down");
        let said = described(&ClientRequest::KeyForInputMethod {
            keycode: 30,
            pressed: false,
        })
        .unwrap();
        assert!(!said.contains("30"), "{said}");
    }

    #[test]
    fn the_pointer_says_where_and_over_what() {
        assert_eq!(
            described(&ClientRequest::PointerMotion {
                app_id: "kD3m".to_string(),
                x: 12.0,
                y: 40.25,
                moved: true,
            })
            .unwrap(),
            "pointer at (12.0, 40.2) over kD3m"
        );
        assert_eq!(
            described(&ClientRequest::PointerButton {
                button: 0x110,
                pressed: false,
            })
            .unwrap(),
            "button 0x110 up"
        );
    }

    #[test]
    fn what_is_not_input_says_nothing() {
        assert_eq!(described(&ClientRequest::Lock), None);
    }
}
