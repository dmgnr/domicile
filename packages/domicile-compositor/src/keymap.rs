//! Compiles the config's keymap as text for the browser process.
//!
//! Wayland clients get the keymap as an fd from the seat. The browser's
//! `KeyboardLayoutEngine` decodes the shell's keys and gets no keymap outside
//! ChromeOS or the Wayland ozone platform, so the compositor sends it as text.
//! See [`domicile_protocol::HostMessage::Keymap`].
//!
//! This compiles separately from the seat because the chrome socket accepts
//! connections before the compositor state exists, and Smithay's
//! `KeyboardHandle::with_xkb_state` needs `&mut D`. Both compile the same
//! [`Keymap`]; the browser must never read `input.keyboard` itself.

use std::collections::BTreeMap;

use domicile_config::Keymap;
use domicile_protocol::ListedKeymap;
use smithay::input::keyboard::xkb;

/// xkb could not compile a keymap from the config.
///
/// Fatal at startup, so the desktop never runs on a fallback layout. On a
/// reload the new config is rejected instead, so a typo does not close every
/// window. See `take_up_the_keymaps`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "xkb cannot compile keymap {:?} of input.keyboard: rules={:?} model={:?} layout={:?} \
     variant={:?} options={:?}",
    .0.name,
    .0.xkb_rules,
    .0.xkb_model,
    .0.xkb_layout,
    .0.xkb_variant,
    .0.xkb_options_string()
)]
// Boxed so a `Result` carrying it stays small.
pub struct UnknownLayout(Box<Keymap>);

/// A config keymap as `XKB_KEYMAP_FORMAT_TEXT_V1` text, the format a
/// `wl_keyboard.keymap` fd carries.
pub fn compiled_keymap(config: &Keymap) -> Result<String, UnknownLayout> {
    compiled(config).map(|keymap| keymap.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1))
}

/// A config keymap, compiled, used to map keybinding keysyms to keys.
pub struct Keyboard {
    keymap: xkb::Keymap,
}

impl Keyboard {
    pub fn compiled(config: &Keymap) -> Result<Keyboard, UnknownLayout> {
        compiled(config).map(|keymap| Keyboard { keymap })
    }

    /// The keyboard `XKB_KEYMAP_FORMAT_TEXT_V1` text describes, as
    /// [`compiled_keymap`] writes it. `None` for text xkb cannot read.
    pub fn from_text(text: &str) -> Option<Keyboard> {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        xkb::Keymap::new_from_string(
            &context,
            text.to_string(),
            xkb::KEYMAP_FORMAT_TEXT_V1,
            xkb::COMPILE_NO_FLAGS,
        )
        .map(|keymap| Keyboard { keymap })
    }
}

impl Keyboard {
    /// Maps each keysym name this keyboard can type to its evdev key. The shell
    /// resolves its keybindings against this.
    ///
    /// Each keysym maps to the lowest key with it on any level of the first
    /// layout. Lowest key, not lowest level, because xkb numbers the main block
    /// first, and `us` also puts `parenleft` and `less` unshifted on keys most
    /// boards lack. Modifiers come from the chord, not from the level.
    pub fn keys(&self) -> BTreeMap<String, u32> {
        let mut keys = BTreeMap::new();
        let all = self.keymap.min_keycode().raw()..=self.keymap.max_keycode().raw();
        for key in all.map(xkb::Keycode::new) {
            for level in 0..self.keymap.num_levels_for_key(key, 0) {
                for &keysym in self.keymap.key_get_syms_by_level(key, 0, level) {
                    // xkb keycodes are evdev codes plus 8. The chrome uses
                    // evdev, as `ChromeMessage::Key` does.
                    keys.entry(xkb::keysym_get_name(keysym))
                        .or_insert(key.raw() - 8);
                }
            }
        }
        keys
    }
}

impl Keyboard {
    /// Whether typing the keysym named `name` takes Shift on the key
    /// [`Keyboard::keys`] maps it to. `None` when that key has it on neither
    /// of its first two levels, or no key has it.
    pub fn shifted(&self, name: &str) -> Option<bool> {
        let key = xkb::Keycode::new(self.keys().get(name)? + 8);
        let keysym = xkb::keysym_from_name(name, xkb::KEYSYM_NO_FLAGS);
        (0..self.keymap.num_levels_for_key(key, 0).min(2))
            .find(|level| {
                self.keymap
                    .key_get_syms_by_level(key, 0, *level)
                    .contains(&keysym)
            })
            .map(|level| level == 1)
    }
}

/// `keymaps` as `SystemEvent::Keymaps` lists them, each with xkb's name for
/// its layouts.
pub fn listed_keymaps(keymaps: &[Keymap]) -> Vec<ListedKeymap> {
    keymaps
        .iter()
        .map(|keymap| ListedKeymap {
            name: keymap.name.clone(),
            description: described(keymap),
        })
        .collect()
}

/// xkb's names for `config`'s layouts, such as `English (programmer
/// Dvorak)`, joined for a keymap of several. `None` when xkb names none, or
/// cannot compile it.
fn described(config: &Keymap) -> Option<String> {
    let keymap = compiled(config).ok()?;
    let names: Vec<&str> = (0..keymap.num_layouts())
        .map(|layout| keymap.layout_get_name(layout))
        .filter(|name| !name.is_empty())
        .collect();
    (!names.is_empty()).then(|| names.join(", "))
}

/// Compiles `config` with xkb.
fn compiled(config: &Keymap) -> Result<xkb::Keymap, UnknownLayout> {
    let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
    xkb::Keymap::new_from_names(
        &context,
        &config.xkb_rules,
        &config.xkb_model,
        &config.xkb_layout,
        &config.xkb_variant,
        Some(config.xkb_options_string()),
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    )
    .ok_or_else(|| UnknownLayout(Box::new(config.clone())))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Programmer Dvorak with caps lock swapped for escape.
    fn dvorak() -> Keymap {
        Keymap {
            xkb_variant: "dvp".into(),
            xkb_options: vec!["caps:swapescape".into()],
            ..Keymap::default()
        }
    }

    #[test]
    fn a_listed_keymap_carries_xkbs_name_for_its_layouts() {
        let several = Keymap {
            name: "both".into(),
            xkb_layout: "us,de".into(),
            ..Keymap::default()
        };
        let listed = listed_keymaps(&[dvorak(), several]);

        assert_eq!(
            listed[0].description.as_deref(),
            Some("English (programmer Dvorak)")
        );
        assert_eq!(
            listed[1].description.as_deref(),
            Some("English (US), German"),
            "a keymap of several layouts names each"
        );
    }

    #[test]
    fn the_layout_the_config_names_is_the_keymap_that_comes_out() {
        // Check both the variant (`dvp` puts a semicolon on QWERTY's `q`) and
        // the option, which a keymap could drop while keeping the layout.
        let keymap = compiled_keymap(&dvorak()).expect("us(dvp) exists");

        assert!(
            keymap.starts_with("xkb_keymap"),
            "it is the text format a wl_keyboard.keymap fd carries"
        );
        assert_eq!(
            unshifted_on(&keymap, "AD01"),
            "semicolon",
            "the top-left letter key is dvp's semicolon, not qwerty's q"
        );
        assert_eq!(
            unshifted_on(&keymap, "CAPS"),
            "Escape",
            "caps:swapescape reached xkb too"
        );
    }

    #[test]
    fn a_keyboard_nobody_configured_is_the_plain_one() {
        // An unconfigured keyboard is plain `us`. Checked on the compiled
        // keymap in case xkb reads an empty field as something else.
        let keymap = compiled_keymap(&Keymap::default()).expect("plain us exists");

        assert_eq!(
            unshifted_on(&keymap, "AD01"),
            "q",
            "the top-left letter key is qwerty's q"
        );
        assert_eq!(
            unshifted_on(&keymap, "CAPS"),
            "Caps_Lock",
            "nothing remapped caps lock"
        );
    }

    #[test]
    fn a_layout_xkb_cannot_compile_is_an_error_rather_than_a_fallback() {
        // A fallback keymap could differ between the clients and the browser.
        let nonsense = Keymap {
            xkb_rules: "no-such-rules".into(),
            ..Keymap::default()
        };

        assert!(compiled_keymap(&nonsense).is_err());
    }

    /// Evdev codes from `linux/input-event-codes.h`.
    const KEY_5: u32 = 6;
    const KEY_9: u32 = 10;
    const KEY_P: u32 = 25;
    const KEY_ENTER: u32 = 28;
    const KEY_L: u32 = 38;
    const KEY_COMMA: u32 = 51;

    /// The key for `keysym` on the keyboard `config` names.
    fn key_for(config: &Keymap, keysym: &str) -> Option<u32> {
        Keyboard::compiled(config)
            .expect("the layout exists")
            .keys()
            .get(keysym)
            .copied()
    }

    #[test]
    fn a_keysym_is_the_key_it_is_on_in_the_layout_the_config_names() {
        // `l` is on a different key in each layout.
        assert_eq!(key_for(&Keymap::default(), "l"), Some(KEY_L));
        assert_eq!(key_for(&dvorak(), "l"), Some(KEY_P));
        assert_eq!(key_for(&dvorak(), "Return"), Some(KEY_ENTER));
    }

    #[test]
    fn a_keysym_is_its_key_whichever_level_it_is_on() {
        // `parenleft` is unshifted on `dvp`'s 5 key. The chord, not the level,
        // decides modifiers.
        assert_eq!(key_for(&dvorak(), "parenleft"), Some(KEY_5));
    }

    #[test]
    fn the_lowest_key_wins_whatever_level_it_is_on() {
        // `us` also has `parenleft` on a keypad key and `less` beside the left
        // Shift, both unshifted and both rare. The lowest key is in the main
        // block.
        assert_eq!(key_for(&Keymap::default(), "parenleft"), Some(KEY_9));
        assert_eq!(key_for(&Keymap::default(), "less"), Some(KEY_COMMA));
    }

    #[test]
    fn a_keysym_on_its_keys_second_level_types_with_shift() {
        let us = Keyboard::from_text(&compiled_keymap(&Keymap::default()).unwrap()).unwrap();
        assert_eq!(us.shifted("a"), Some(false));
        assert_eq!(us.shifted("A"), Some(true));
        assert_eq!(us.shifted("exclam"), Some(true));
        let dvp = Keyboard::compiled(&dvorak()).unwrap();
        assert_eq!(dvp.shifted("parenleft"), Some(false));
        assert_eq!(dvp.shifted("Greek_alpha"), None);
    }

    #[test]
    fn a_keysym_the_keyboard_cannot_type_is_not_in_the_table() {
        assert_eq!(key_for(&Keymap::default(), "Retrun"), None);
        assert_eq!(key_for(&Keymap::default(), "Greek_alpha"), None);
    }

    /// The keysym name on the first level of the key named `name` in the
    /// first layout of `keymap`.
    ///
    /// Reads the text back through xkb, as the browser does. Its serialization
    /// varies by libxkbcommon version: 1.12 writes keysyms as hex.
    fn unshifted_on(keymap: &str, name: &str) -> String {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let keymap = xkb::Keymap::new_from_string(
            &context,
            keymap.to_string(),
            xkb::KEYMAP_FORMAT_TEXT_V1,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .expect("xkb reads back the keymap it wrote");
        let key = keymap
            .key_by_name(name)
            .unwrap_or_else(|| panic!("no key <{name}> in the keymap"));
        match keymap.key_get_syms_by_level(key, 0, 0) {
            [keysym] => xkb::keysym_get_name(*keysym),
            other => panic!("<{name}> has {} keysyms unshifted", other.len()),
        }
    }
}
