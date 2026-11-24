//! What a config reload must restate, beyond the display list.
//!
//! A reload applies only what differs between the old and new [`Config`].
//! Computing that here, away from the seat, outputs and sockets, keeps it
//! testable; `main` applies the result. Restating only what changed matters:
//! an editor's save can fire several events, and a keyboard change sends
//! every client a new keymap.
//!
//! # Every field, and what a reload does with it
//!
//! | field | on a reload |
//! |---|---|
//! | `input.keyboard.repeat` | sent to every client's keyboard and to the engine (`repeat_keys_at`) |
//! | `input.keyboard.*` | every keymap recompiled; the active one, or the first if the config dropped it, sent to the seat and chrome (`take_up_the_keymaps`) |
//! | `input.touchpad`, `input.mouse` | sent to the engine (`configure_input`) |
//! | `input.pointers` | sent to the engine, resolved against the monitors it last reported (`bind_the_pointers`) |
//! | `output.max_scale` | applied to the running desktop (`cap_the_scale_at`) |
//! | `output.displays` | applied (`Screens::reloaded_into`, `adopt_the_desktop`) |
//! | `output.profiles` | re-matched against the connected monitors, same path |
//! | `idle.blank_after_seconds`, `idle.lock_after_seconds` | idle clock restarted and timer re-armed (`reset_the_idle_clock`) |
//! | `theme.mode` | sent to every chrome and the desk's clients, with the mode's own `cursor_theme` if it has one (`take_up_the_theme`) |
//! | `theme.accent_color`, `contrast`, `reduced_motion`, `icon_theme`, `cursor_theme`, `cursor_size`, `font_name`, `monospace_font_name` | sent to the desk's clients (`Portals::restyle`); `icon_theme` also redraws tray and notification icons; `cursor_theme` and `cursor_size` also go to every chrome's browser, which draws the pointer (`Host::set_appearance`) |
//! | `theme.cursor_hide_after_ms`, `cursor_hide_when_typing` | sent to every chrome's browser, which hides the pointer (`Host::set_appearance`) |
//! | `theme.force_dark` | sent to every chrome, whose browser draws those sites dark from their next load (`Host::set_force_dark`) |
//! | `spellcheck.*` | sent to every chrome, whose browser checks spelling in those languages (`Host::set_spellcheck`) |
//! | `files.omit` | sent to the index, which rewalks the home (`omit_from_the_index`) |
//! | `electron.apps` | the entries that run them on the engine written again (`write_the_electron_entries`) |
//! | `extensions.*` | sent to every chrome, whose browser installs them (`hand_over_the_extensions`) |
//! | `browser.*` | sent to every chrome, whose browser takes up the profiles (`hand_over_the_browser_profiles`) |
//! | `lock.*` | the verifier replaced; the desktop stays as locked as it was (`rekey_the_lock`, `Lock::rekeyed`) |
//! | `agents.web` | runs or stops `domicile mcp --relay` (`WebAgents::set`) |
//! | `lockdown.*` | sent to the Lockdown portal, which signals the change (`Portals::lock_down`) |
//! | `keybindings` | resolved on the keyboard and sent to every chrome (`rebind_the_keys`) |
//! | `modes` | the same, with `keybindings` |
//! | `shells` | the same, with `keybindings` |
//!
//! The last three are also restated when `input.keyboard` changes, because a
//! chord names a keysym and the layout decides which key that is.
//!
//! Limits:
//! - `output.max_scale` only affects the output that follows Domicile's own
//!   window. A described display sets its own scale.
//! - A keyboard xkb cannot compile, or a keysym it cannot type, is refused
//!   (see `take_up_the_keymaps` and `rebind_the_keys`).
//! - A `lock.pam_service` on a machine without libpam is refused (see
//!   `rekey_the_lock`).
//! - Changing the idle timeout wakes blanked screens (see
//!   `reset_the_idle_clock`).
//!
//! A field added to [`Config`] needs a row here, plus either a field in
//! [`Restatement`] and an arm in `adopt_the_rest_of_the_config`, or a row that
//! says why a reload cannot apply it. Copy the tests below: a changed field is
//! restated and an unchanged one is not.

use domicile_config::{
    AgentsConfig, BrowserConfig, Config, ExtensionsConfig, IdleConfig, KeyRepeat, KeyboardConfig,
    LockConfig, LockdownConfig, Omit, SpellcheckConfig, ThemeConfig, ThemeMode,
};

/// What a reloaded config asks the compositor to restate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Restatement {
    /// The keyboard to compile a keymap from, or `None` if its keymap is
    /// unchanged.
    pub keyboard: Option<KeyboardConfig>,
    /// How held keys repeat, or `None` if unchanged.
    pub key_repeat: Option<KeyRepeat>,
    /// The new cap on the scale advertised to clients, or `None` if
    /// unchanged.
    pub max_scale: Option<u32>,
    /// When the screens blank, or `None` if unchanged.
    ///
    /// The whole section, so an absent section (never blank) is distinct from
    /// `None`.
    pub idle: Option<IdleConfig>,
    /// The theme mode, or `None` if unchanged.
    ///
    /// Just the mode, unlike `idle`: an absent `theme` means dark, so it needs
    /// no separate value.
    pub theme: Option<ThemeMode>,
    /// The theme, or `None` if nothing but the mode and `force_dark` changed.
    /// Clients read the rest through the settings portal.
    pub appearance: Option<ThemeConfig>,
    /// The sites the browser draws dark, or `None` if unchanged.
    pub force_dark: Option<Vec<String>>,
    /// Whether and in which languages the browser checks spelling, or `None`
    /// if unchanged.
    pub spellcheck: Option<SpellcheckConfig>,
    /// What the file index leaves out, or `None` if unchanged.
    pub omit: Option<Omit>,
    /// The Electron apps that run on the engine, or `None` if unchanged.
    pub electron_apps: Option<Vec<String>>,
    /// The extensions the browser process installs, or `None` if unchanged.
    pub extensions: Option<ExtensionsConfig>,
    /// The browser profiles, or `None` if unchanged.
    pub browser: Option<BrowserConfig>,
    /// Agents that drive the desktop, or `None` if unchanged.
    pub agents: Option<AgentsConfig>,
    /// What applications are asked not to do, or `None` if unchanged.
    pub lockdown: Option<LockdownConfig>,
    /// What opens the lock, or `None` if unchanged.
    pub lock: Option<LockConfig>,
    /// Whether to resend the shell config to the chromes: keysyms depend on
    /// the layout, and the shell's options may have changed.
    pub shell_config: bool,
    /// Whether to tell the engine again which display each tablet covers.
    pub pointers: bool,
    /// Whether to reapply touchpad and mouse settings.
    pub input_devices: bool,
}

impl Restatement {
    /// What changed between the config that was live and the one replacing it.
    pub fn between(was: &Config, now: &Config) -> Restatement {
        // Repeat goes to the seat and the engine without recompiling a keymap.
        let keymap_moved = KeyboardConfig {
            repeat: now.input.keyboard.repeat,
            ..was.input.keyboard.clone()
        } != now.input.keyboard;
        let repeat_moved = was.input.keyboard.repeat != now.input.keyboard.repeat;
        Restatement {
            keyboard: keymap_moved.then(|| now.input.keyboard.clone()),
            key_repeat: repeat_moved.then_some(now.input.keyboard.repeat),
            max_scale: (was.output.max_scale != now.output.max_scale)
                .then_some(now.output.max_scale),
            idle: (was.idle != now.idle).then(|| now.idle.clone()),
            theme: (was.theme.mode != now.theme.mode).then_some(now.theme.mode),
            appearance: (ThemeConfig {
                mode: now.theme.mode,
                force_dark: now.theme.force_dark.clone(),
                ..was.theme.clone()
            } != now.theme)
                .then(|| now.theme.clone()),
            force_dark: (was.theme.force_dark != now.theme.force_dark)
                .then(|| now.theme.force_dark.clone()),
            spellcheck: (was.spellcheck != now.spellcheck).then(|| now.spellcheck.clone()),
            omit: (was.files.omit != now.files.omit).then(|| now.files.omit.clone()),
            electron_apps: (was.electron != now.electron).then(|| now.electron.apps.clone()),
            extensions: (was.extensions != now.extensions).then(|| now.extensions.clone()),
            browser: (was.browser != now.browser).then(|| now.browser.clone()),
            agents: (was.agents != now.agents).then(|| now.agents.clone()),
            lockdown: (was.lockdown != now.lockdown).then(|| now.lockdown.clone()),
            lock: (was.lock != now.lock).then(|| now.lock.clone()),
            shell_config: keymap_moved || was.shell_options != now.shell_options,
            pointers: was.input.pointers != now.input.pointers,
            input_devices: was.input.touchpad != now.input.touchpad
                || was.input.mouse != now.input.mouse
                || repeat_moved,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_that_did_not_change_restates_nothing() {
        let was = parsed(A_DVORAK_DESK);

        assert_eq!(
            Restatement::between(&was, &parsed(A_DVORAK_DESK)),
            Restatement::default()
        );
    }

    #[test]
    fn a_keyboard_that_moved_is_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_PLAIN_DESK);

        let restated = Restatement::between(&was, &now);

        assert_eq!(
            restated.keyboard.expect("the layout moved").xkb_variant,
            "",
            "the keyboard handed back is the new one, not the one being replaced"
        );
    }

    #[test]
    fn a_key_repeat_that_moved_is_restated_without_the_keymap() {
        let was = parsed(A_DVORAK_DESK);
        let restated = Restatement::between(&was, &parsed(A_DVORAK_DESK_REPEATING_FAST));

        assert_eq!(
            restated.key_repeat,
            Some(KeyRepeat {
                delay_ms: 200,
                rate: 40
            })
        );
        assert!(restated.input_devices, "pages repeat through the engine");
        assert_eq!(restated.keyboard, None, "the keymap is not recompiled");
        assert!(!restated.shell_config, "no chord moved");
    }

    #[test]
    fn an_idle_timeout_that_moved_is_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_THAT_BLANKS);

        assert_eq!(
            Restatement::between(&was, &now)
                .idle
                .expect("the timeout moved")
                .blank_after_seconds,
            Some(60)
        );
    }

    #[test]
    fn a_theme_that_moved_is_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_DRAWN_LIGHT);

        assert_eq!(
            Restatement::between(&was, &now).theme,
            Some(ThemeMode::Light)
        );
    }

    #[test]
    fn a_file_that_restates_the_theme_it_already_had_restates_nothing() {
        // `theme` is generated with the rest of the file, so an edit to
        // another field rewrites it unchanged. Restating it would re-theme
        // every page for nothing.
        let was = parsed(A_DESK_DRAWN_LIGHT);

        assert_eq!(
            Restatement::between(&was, &parsed(A_DESK_DRAWN_LIGHT)).theme,
            None
        );
    }

    #[test]
    fn a_look_that_moved_is_restated_without_the_mode() {
        // Repainting every page for an accent change would flash the desk.
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DVORAK_DESK_WITH_AN_ACCENT);

        let restated = Restatement::between(&was, &now);

        assert_eq!(restated.theme, None);
        assert_eq!(restated.appearance, Some(now.theme));
        assert_eq!(
            Restatement::between(&was, &parsed(A_DESK_DRAWN_LIGHT)).appearance,
            None
        );
    }

    #[test]
    fn hiding_the_pointer_is_restated_when_it_moved() {
        // The browser hides the pointer; nothing else reads these keys.
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DVORAK_DESK_HIDING_ITS_POINTER);

        assert_eq!(
            Restatement::between(&was, &now).appearance,
            Some(now.theme.clone())
        );
        assert_eq!(Restatement::between(&now, &now).appearance, None);
    }

    #[test]
    fn the_electron_apps_are_restated_when_they_change() {
        let was = parsed("{}");
        let now = parsed(r#"{ "electron": { "apps": ["slack.desktop"] } }"#);

        assert_eq!(
            Restatement::between(&was, &now).electron_apps,
            Some(vec!["slack.desktop".to_string()])
        );
        assert_eq!(Restatement::between(&now, &now).electron_apps, None);
    }

    #[test]
    fn what_the_index_omits_is_restated_when_it_moved() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_OFFERING_ITS_DOTFILES);

        let omit = Restatement::between(&was, &now)
            .omit
            .expect("the omitted paths moved");
        assert!(
            !omit.omits(".config"),
            "the rule handed back is the new one, not the one being replaced"
        );
    }

    #[test]
    fn sites_to_force_dark_that_moved_are_restated_without_the_look() {
        // The browser reads them; the desk's clients have nothing to redraw.
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_FORCING_A_SITE_DARK);

        let restated = Restatement::between(&was, &now);

        assert_eq!(restated.force_dark, Some(vec!["mail.google.com".into()]));
        assert_eq!(restated.appearance, None);
    }

    #[test]
    fn spell_checking_that_moved_is_restated() {
        let was = parsed("{}");
        let now = parsed(r#"{ "spellcheck": { "languages": ["de-DE"] } }"#);

        assert_eq!(
            Restatement::between(&was, &now).spellcheck,
            Some(SpellcheckConfig {
                enabled: true,
                languages: vec!["de-DE".into()],
            })
        );
        assert_eq!(Restatement::between(&now, &now), Restatement::default());
    }

    #[test]
    fn browser_profiles_that_moved_are_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_WITH_AN_EXTENSION);
        assert_eq!(Restatement::between(&was, &was).browser, None);

        let now = Config {
            browser: domicile_config::BrowserConfig {
                default_profile: "private".into(),
                ..now.browser
            },
            ..now
        };
        assert_eq!(
            Restatement::between(&was, &now)
                .browser
                .expect("the profiles moved")
                .default_profile,
            "private",
            "the profiles handed back are the new ones"
        );
    }

    #[test]
    fn extensions_that_moved_are_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_WITH_AN_EXTENSION);

        assert_eq!(
            Restatement::between(&was, &now)
                .extensions
                .expect("the extensions moved")
                .web_store,
            ["ddkjiahejlhfcafbddmgiahcphecmpfh"],
            "the list handed back is the new one, not the one being replaced"
        );
    }

    #[test]
    fn a_lockdown_that_moved_is_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_WITHOUT_A_CAMERA);

        assert!(
            Restatement::between(&was, &now)
                .lockdown
                .expect("the lockdown moved")
                .disable_camera,
            "the switches handed back are the new ones, not the ones being replaced"
        );
    }

    #[test]
    fn agents_on_the_web_turned_on_are_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(r#"{ "agents": { "web": true } }"#);

        assert!(
            Restatement::between(&was, &now)
                .agents
                .expect("agents moved")
                .web
        );
        assert_eq!(Restatement::between(&now, &now).agents, None);
    }

    #[test]
    fn a_lock_that_moved_is_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DESK_UNLOCKED_BY_LOGIN);

        assert_eq!(
            Restatement::between(&was, &now).lock,
            Some(now.lock),
            "the lock handed back is the new one, not the one being replaced"
        );
    }

    #[test]
    fn the_keys_are_restated_when_the_keyboard_moved() {
        // A chord names a keysym, and the layout decides which key that is.
        let was = parsed(A_DVORAK_DESK);
        assert!(Restatement::between(&was, &parsed(A_PLAIN_DESK)).shell_config);
    }

    #[test]
    fn the_shell_config_is_restated_when_the_shell_s_options_moved() {
        let was = parsed(A_DVORAK_DESK);
        let restated = Restatement::between(&was, &parsed(A_DVORAK_DESK_WITH_A_12_HOUR_CLOCK));
        assert!(restated.shell_config);
        assert_eq!(
            restated.keyboard, None,
            "the options are the shell's, so the keymap is not resent"
        );
    }

    #[test]
    fn pointers_that_moved_are_restated() {
        let was = parsed(A_DVORAK_DESK);
        assert!(Restatement::between(&was, &parsed(A_DESK_WITH_A_TABLET)).pointers);
    }

    #[test]
    fn touchpad_and_mouse_changes_are_restated_and_removal_resets_them() {
        let defaults = parsed("{}");
        for written in [
            r#"{"input":{"touchpad":{"natural_scroll":true}}}"#,
            r#"{"input":{"mouse":{"accel_profile":"flat"}}}"#,
        ] {
            let changed = parsed(written);
            assert_ne!(
                Restatement::between(&defaults, &changed),
                Restatement::default()
            );
            assert_ne!(
                Restatement::between(&changed, &defaults),
                Restatement::default()
            );
            assert_eq!(
                Restatement::between(&changed, &parsed(written)),
                Restatement::default()
            );
        }
    }

    #[test]
    fn a_cap_on_the_scale_that_moved_is_restated() {
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_CAPPED_DESK);

        assert_eq!(Restatement::between(&was, &now).max_scale, Some(1));
    }

    #[test]
    fn a_desk_that_only_moved_its_displays_restates_neither() {
        // An edit to the display list must not resend every client a keymap
        // or scale it already has.
        let was = parsed(A_DVORAK_DESK);
        let now = parsed(A_DVORAK_DESK_WITH_A_SECOND_DISPLAY);

        assert_eq!(
            Restatement::between(&was, &now),
            Restatement::default(),
            "nothing but the displays moved, and the displays are not this function's"
        );
    }

    const A_DVORAK_DESK: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    /// The same desk, with nothing left out of its file index.
    const A_DESK_OFFERING_ITS_DOTFILES: &str = r#"
{
  "files": { "omit": [] },
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    /// The same desk, running one extension from the Web Store.
    const A_DESK_WITH_AN_EXTENSION: &str = r#"
{
  "extensions": { "web_store": ["ddkjiahejlhfcafbddmgiahcphecmpfh"] },
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    /// The same desk, asking applications not to use the camera.
    const A_DESK_WITHOUT_A_CAMERA: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "lockdown": { "disable_camera": true },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    /// The same desk, unlocked through another PAM service.
    const A_DESK_UNLOCKED_BY_LOGIN: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "lock": { "pam_service": "login" },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    /// The same desk with the default US QWERTY layout.
    /// The same desk, with an option set for its shell.
    const A_DVORAK_DESK_WITH_A_12_HOUR_CLOCK: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] },
  "shell_options": { "clock": { "format": "12h" } }
}
"#;

    /// [`A_DVORAK_DESK`] with keys repeating sooner and faster.
    const A_DVORAK_DESK_REPEATING_FAST: &str = r#"
{
  "input": {
    "keyboard": {
      "xkb_variant": "dvp",
      "xkb_options": ["caps:swapescape"],
      "repeat": { "delay_ms": 200, "rate": 40 }
    }
  },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    const A_PLAIN_DESK: &str = r#"
{ "output": { "displays": [{ "name": "one", "size": [1024, 768] }] } }
"#;

    /// The same desk, blanking after a minute idle.
    const A_DESK_THAT_BLANKS: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "idle": { "blank_after_seconds": 60 },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    /// The same desk, with the scale capped at 1.
    const A_CAPPED_DESK: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "output": {
    "max_scale": 1,
    "displays": [{ "name": "one", "size": [1024, 768] }]
  }
}
"#;

    /// The same desk in light mode.
    const A_DESK_DRAWN_LIGHT: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "theme": { "mode": "light" },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    /// The same desk with an accent color, high contrast and less motion.
    const A_DESK_FORCING_A_SITE_DARK: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "theme": { "force_dark": ["mail.google.com"] },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    const A_DVORAK_DESK_HIDING_ITS_POINTER: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "theme": { "cursor_hide_after_ms": 1000, "cursor_hide_when_typing": true },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    const A_DVORAK_DESK_WITH_AN_ACCENT: &str = r##"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "theme": { "accent_color": "#3584e4", "contrast": "high", "reduced_motion": true },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"##;

    const A_DVORAK_DESK_WITH_A_SECOND_DISPLAY: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] }
  },
  "output": {
    "displays": [
      { "name": "one", "size": [1024, 768] },
      { "name": "two", "position": [1024, 0], "size": [1024, 768] }
    ]
  }
}
"#;

    /// The Dvorak desk, with a tablet bound to its first display.
    const A_DESK_WITH_A_TABLET: &str = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:swapescape"] },
    "pointers": [{ "device": "QEMU QEMU USB Tablet", "display": "one" }]
  },
  "output": { "displays": [{ "name": "one", "size": [1024, 768] }] }
}
"#;

    fn parsed(text: &str) -> Config {
        Config::parse(text).expect("the fixtures are configs a desk could run")
    }
}
