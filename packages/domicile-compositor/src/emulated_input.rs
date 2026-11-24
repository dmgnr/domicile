//! `ChromeMessage::Emulate`: input `domicile pointer`, `key` and `type` send
//! to the desk, as the events [`crate::eis`] emulates.

use std::time::Duration;

use domicile_protocol::{EmulatedInput, PointerButton};
use smithay::input::keyboard::xkb;

use crate::eis::Emulated;
use crate::keymap::Keyboard;

/// One event for an [`crate::eis::Emulator`].
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Send(Emulated),
    Keysym { keysym: u32, pressed: bool },
    Wait(Duration),
}

/// The events that send `input` on `keyboard`, or why one cannot be sent.
pub fn steps(input: &[EmulatedInput], keyboard: &Keyboard) -> Result<Vec<Step>, String> {
    input.iter().try_fold(Vec::new(), |steps, event| {
        Ok([steps, steps_of(event, keyboard)?].concat())
    })
}

fn steps_of(event: &EmulatedInput, keyboard: &Keyboard) -> Result<Vec<Step>, String> {
    match event {
        EmulatedInput::PointTo { x, y } => {
            Ok(vec![Step::Send(Emulated::MotionAbsolute { x: *x, y: *y })])
        }
        EmulatedInput::Button { button, pressed } => Ok(vec![Step::Send(Emulated::Button {
            button: code(*button),
            pressed: *pressed,
        })]),
        EmulatedInput::Scroll { dx, dy } => {
            Ok(vec![Step::Send(Emulated::Scroll { dx: *dx, dy: *dy })])
        }
        EmulatedInput::Key { key, pressed } => Ok(vec![Step::Keysym {
            keysym: named(key)?,
            pressed: *pressed,
        }]),
        EmulatedInput::Text { text } => text.chars().try_fold(Vec::new(), |steps, character| {
            Ok([steps, typed(character, keyboard)?].concat())
        }),
        EmulatedInput::Wait { ms } => Ok(vec![Step::Wait(Duration::from_millis(u64::from(*ms)))]),
    }
}

/// The presses that type `character`, holding Shift when its key needs it. A
/// line break is Return, as a hand types one; XKB would make `\n` Linefeed,
/// which no keyboard has.
fn typed(character: char, keyboard: &Keyboard) -> Result<Vec<Step>, String> {
    let keysym = match character {
        '\n' | '\r' => xkb::Keysym::new(xkb::keysyms::KEY_Return),
        character => xkb::utf32_to_keysym(u32::from(character)),
    };
    let tap = [true, false].map(|pressed| Step::Keysym {
        keysym: keysym.raw(),
        pressed,
    });
    match keyboard.shifted(&xkb::keysym_get_name(keysym)) {
        Some(false) => Ok(tap.to_vec()),
        Some(true) => {
            let shift = |pressed| Step::Keysym {
                keysym: xkb::keysyms::KEY_Shift_L,
                pressed,
            };
            Ok([vec![shift(true)], tap.to_vec(), vec![shift(false)]].concat())
        }
        None => Err(format!(
            "no key on the desk's keyboard types {character:?} without AltGr"
        )),
    }
}

/// The evdev code of `button`.
fn code(button: PointerButton) -> u32 {
    match button {
        PointerButton::Left => 0x110,
        PointerButton::Right => 0x111,
        PointerButton::Middle => 0x112,
    }
}

/// The keysym XKB names `key`, ignoring case when no name matches exactly.
fn named(key: &str) -> Result<u32, String> {
    let exact = xkb::keysym_from_name(key, xkb::KEYSYM_NO_FLAGS);
    let keysym = if exact.raw() == xkb::keysyms::KEY_NoSymbol {
        xkb::keysym_from_name(key, xkb::KEYSYM_CASE_INSENSITIVE)
    } else {
        exact
    };
    if keysym.raw() == xkb::keysyms::KEY_NoSymbol {
        Err(format!(
            "{key} names no key; keys are XKB keysym names, such as Return or Control_L"
        ))
    } else {
        Ok(keysym.raw())
    }
}

#[cfg(test)]
mod tests {
    use domicile_config::Keymap;

    use super::*;

    fn us() -> Keyboard {
        Keyboard::compiled(&Keymap::default()).unwrap()
    }

    #[test]
    fn pointing_clicking_and_scrolling_are_emulated_as_they_are() {
        let input = [
            EmulatedInput::PointTo { x: 10.0, y: 20.0 },
            EmulatedInput::Button {
                button: PointerButton::Right,
                pressed: true,
            },
            EmulatedInput::Scroll { dx: 0.0, dy: 30.0 },
        ];

        assert_eq!(
            steps(&input, &us()),
            Ok(vec![
                Step::Send(Emulated::MotionAbsolute { x: 10.0, y: 20.0 }),
                Step::Send(Emulated::Button {
                    button: 0x111,
                    pressed: true
                }),
                Step::Send(Emulated::Scroll { dx: 0.0, dy: 30.0 }),
            ])
        );
    }

    #[test]
    fn a_key_is_its_keysym_by_name_in_any_case() {
        let input = [EmulatedInput::Key {
            key: "return".into(),
            pressed: true,
        }];

        assert_eq!(
            steps(&input, &us()),
            Ok(vec![Step::Keysym {
                keysym: xkb::keysyms::KEY_Return,
                pressed: true
            }])
        );
    }

    #[test]
    fn a_key_no_keysym_names_is_refused_by_name() {
        let input = [EmulatedInput::Key {
            key: "Hyperdrive".into(),
            pressed: true,
        }];

        assert!(steps(&input, &us()).unwrap_err().contains("Hyperdrive"));
    }

    #[test]
    fn text_presses_and_releases_a_key_for_each_character_with_shift_where_it_needs_it() {
        let input = [EmulatedInput::Text { text: "aA".into() }];
        let key = |keysym, pressed| Step::Keysym { keysym, pressed };

        assert_eq!(
            steps(&input, &us()),
            Ok(vec![
                key(xkb::keysyms::KEY_a, true),
                key(xkb::keysyms::KEY_a, false),
                key(xkb::keysyms::KEY_Shift_L, true),
                key(xkb::keysyms::KEY_A, true),
                key(xkb::keysyms::KEY_A, false),
                key(xkb::keysyms::KEY_Shift_L, false),
            ])
        );
    }

    #[test]
    fn a_new_line_in_text_presses_return() {
        let input = [EmulatedInput::Text {
            text: "a\nb\r".into(),
        }];
        let key = |keysym, pressed| Step::Keysym { keysym, pressed };

        assert_eq!(
            steps(&input, &us()),
            Ok(vec![
                key(xkb::keysyms::KEY_a, true),
                key(xkb::keysyms::KEY_a, false),
                key(xkb::keysyms::KEY_Return, true),
                key(xkb::keysyms::KEY_Return, false),
                key(xkb::keysyms::KEY_b, true),
                key(xkb::keysyms::KEY_b, false),
                key(xkb::keysyms::KEY_Return, true),
                key(xkb::keysyms::KEY_Return, false),
            ])
        );
    }

    #[test]
    fn text_no_key_types_is_refused_naming_the_character() {
        let input = [EmulatedInput::Text { text: "aé".into() }];

        assert!(steps(&input, &us()).unwrap_err().contains("'é'"));
    }
}
