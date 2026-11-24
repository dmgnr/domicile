//! Behavior tests for `domicile-config`.
//!
//! The key requirement is hot-reload safety: a bad config file keeps the last
//! good config active and reports the error.

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use domicile_config::{
    AccentColor, Config, ConfigError, ConfigStore, Contrast, DisplayConfig, ExtensionSettings,
    KeyRepeat, LockdownConfig, SiteAccess, SiteAccessMode, ThemeMode,
};

// ---- parsing & defaults ---------------------------------------------------

#[test]
fn a_desk_that_configured_no_keyboard_gets_nobodys_layout() {
    // A config with no keyboard gets plain `us`.
    let keyboard = Config::parse("{}").unwrap().input.keyboard;
    assert_eq!(keyboard.xkb_layout, "us");
    assert_eq!(keyboard.xkb_variant, "");
    assert!(
        keyboard.xkb_options.is_empty(),
        "{:?}",
        keyboard.xkb_options
    );
    // Empty rules and model use libxkbcommon's defaults.
    assert_eq!(keyboard.xkb_rules, "");
    assert_eq!(keyboard.xkb_model, "");
}

#[test]
fn a_desk_that_states_a_keyboard_gets_that_one() {
    // A layout other than `us` comes only from the config.
    let text = r#"
{
  "input": {
    "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:escape"] }
  }
}
"#;
    let keyboard = Config::parse(text)
        .expect("valid config should parse")
        .input
        .keyboard;
    assert_eq!(keyboard.xkb_layout, "us");
    assert_eq!(keyboard.xkb_variant, "dvp");
    assert_eq!(keyboard.xkb_options, vec!["caps:escape".to_string()]);
}

#[test]
fn keys_repeat_after_half_a_second_at_25_a_second_unless_configured() {
    let keyboard = Config::parse("{}").unwrap().input.keyboard;
    assert_eq!(
        keyboard.repeat,
        KeyRepeat {
            delay_ms: 500,
            rate: 25
        }
    );

    let text = r#"{ "input": { "keyboard": { "repeat": { "delay_ms": 250, "rate": 0 } } } }"#;
    let keyboard = Config::parse(text).unwrap().input.keyboard;
    assert_eq!(
        keyboard.repeat,
        KeyRepeat {
            delay_ms: 250,
            rate: 0
        },
        "a rate of 0 turns repeat off"
    );
}

#[test]
fn a_negative_repeat_is_refused() {
    let text = r#"{ "input": { "keyboard": { "repeat": { "rate": -1 } } } }"#;
    assert!(Config::parse(text).is_err());
}

// ---- keyboard / keymap ------------------------------------------------------

#[test]
fn parses_keyboard_settings() {
    let text = r#"
{
  "input": {
    "keyboard": {
      "xkb_rules": "evdev",
      "xkb_model": "pc105",
      "xkb_layout": "us,de",
      "xkb_variant": "dvp,",
      "xkb_options": ["caps:swapescape", "grp:alt_shift_toggle"]
    }
  }
}
"#;
    let keyboard = Config::parse(text)
        .expect("valid keyboard config should parse")
        .input
        .keyboard;
    assert_eq!(keyboard.xkb_rules, "evdev");
    assert_eq!(keyboard.xkb_model, "pc105");
    // Layout and variant are passed to xkb verbatim, so sway's comma-separated
    // multi-layout form works as-is.
    assert_eq!(keyboard.xkb_layout, "us,de");
    assert_eq!(keyboard.xkb_variant, "dvp,");
    assert_eq!(
        keyboard.xkb_options,
        vec![
            "caps:swapescape".to_string(),
            "grp:alt_shift_toggle".to_string()
        ]
    );
}

#[test]
fn joins_xkb_options_for_xkb() {
    let keyboard = Config::parse(
        r#"
{
  "input": { "keyboard": { "xkb_options": ["caps:swapescape", "compose:ralt"] } }
}
"#,
    )
    .unwrap()
    .input
    .keyboard;
    assert_eq!(
        keyboard.keymaps()[0].xkb_options_string(),
        "caps:swapescape,compose:ralt"
    );
}

#[test]
fn empty_xkb_options_disable_every_option() {
    // An empty list means "no options", not "use xkb's defaults".
    let keyboard = Config::parse(
        r#"
{ "input": { "keyboard": { "xkb_options": [] } } }
"#,
    )
    .unwrap()
    .input
    .keyboard;
    assert_eq!(keyboard.keymaps()[0].xkb_options_string(), "");
}

#[test]
fn rejects_empty_keyboard_layout() {
    let err = Config::parse(
        r#"
{ "input": { "keyboard": { "xkb_layout": "" } } }
"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

#[test]
fn rejects_blank_keyboard_option() {
    // A stray comma would otherwise reach xkb as an empty option.
    let err = Config::parse(
        r#"
{ "input": { "keyboard": { "xkb_options": ["caps:swapescape", ""] } } }
"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

// ---- keymaps ----------------------------------------------------------------

/// The keymap names `text`'s keyboard switches between, first the default.
fn keymap_names(text: &str) -> Vec<String> {
    Config::parse(text)
        .expect("the fixture is a config a desk could run")
        .input
        .keyboard
        .keymaps()
        .into_iter()
        .map(|keymap| keymap.name)
        .collect()
}

/// The validation message `text` is refused with.
fn refusal(text: &str) -> String {
    match Config::parse(text) {
        Err(ConfigError::Validation(message)) => message,
        other => panic!("{text} should be refused, got {other:?}"),
    }
}

#[test]
fn a_keyboard_without_keymaps_is_one_keymap_named_for_its_layout() {
    assert_eq!(keymap_names("{}"), vec!["us"]);
    // The variant names it when there is one, as `dvp` is better known than
    // `us(dvp)`.
    let keymaps = Config::parse(
        r#"{ "input": { "keyboard": { "xkb_variant": "dvp", "xkb_options": ["caps:escape"] } } }"#,
    )
    .unwrap()
    .input
    .keyboard
    .keymaps();
    let [keymap] = keymaps.as_slice() else {
        panic!("one keymap, got {keymaps:?}");
    };
    assert_eq!(keymap.name, "dvp");
    assert_eq!(keymap.xkb_layout, "us");
    assert_eq!(keymap.xkb_variant, "dvp");
    assert_eq!(keymap.xkb_options_string(), "caps:escape");
}

#[test]
fn each_keymap_is_a_whole_keymap_with_the_keyboard_s_defaults() {
    let keymaps = Config::parse(
        r#"
{ "input": { "keyboard": { "keymaps": [
  { "name": "dvp", "xkb_variant": "dvp", "xkb_options": ["caps:escape"] },
  { "name": "us" },
  { "name": "de", "xkb_layout": "de", "xkb_model": "pc105", "xkb_rules": "evdev" }
] } } }
"#,
    )
    .unwrap()
    .input
    .keyboard
    .keymaps();
    let names: Vec<&str> = keymaps.iter().map(|keymap| keymap.name.as_str()).collect();
    assert_eq!(names, ["dvp", "us", "de"], "in the config's order");
    assert_eq!(keymaps[0].xkb_options_string(), "caps:escape");
    assert_eq!(
        keymaps[1].xkb_options_string(),
        "",
        "options are the keymap's own, not another's"
    );
    assert_eq!(keymaps[1].xkb_layout, "us", "layout defaults to us");
    assert_eq!(keymaps[2].xkb_layout, "de");
    assert_eq!(keymaps[2].xkb_model, "pc105");
    assert_eq!(keymaps[2].xkb_rules, "evdev");
}

#[test]
fn a_keyboard_with_keymaps_and_its_own_layout_is_refused() {
    // Which one would be the default is unclear.
    let message = refusal(
        r#"{ "input": { "keyboard": { "xkb_variant": "dvp", "keymaps": [{ "name": "us" }] } } }"#,
    );
    assert!(message.contains("input.keyboard.keymaps"), "{message}");
}

#[test]
fn a_keymap_needs_a_name_it_alone_has() {
    for keymaps in [
        r#"[{ "name": "" }]"#,
        r#"[{ "name": " us" }]"#,
        r#"[{ "name": "us" }, { "name": "us", "xkb_variant": "dvp" }]"#,
        // `keymap next` is the command that cycles.
        r#"[{ "name": "next" }]"#,
    ] {
        let message = refusal(&format!(
            r#"{{ "input": {{ "keyboard": {{ "keymaps": {keymaps} }} }} }}"#
        ));
        assert!(
            message.contains("input.keyboard.keymaps[0]")
                || message.contains("input.keyboard.keymaps[1]"),
            "{message}"
        );
    }
    assert!(Config::parse(r#"{ "input": { "keyboard": { "keymaps": [{}] } } }"#).is_err());
}

#[test]
fn a_keymap_is_checked_as_the_keyboard_is() {
    for keymap in [
        r#"{ "name": "x", "xkb_layout": "" }"#,
        r#"{ "name": "x", "xkb_options": [""] }"#,
    ] {
        let message = refusal(&format!(
            r#"{{ "input": {{ "keyboard": {{ "keymaps": [{keymap}] }} }} }}"#
        ));
        assert!(message.contains("input.keyboard.keymaps[0]"), "{message}");
    }
}

// ---- idle -----------------------------------------------------------------

#[test]
fn a_desk_that_asked_for_no_timeout_never_blanks() {
    // No idle key means the screens never blank: a blank screen with no
    // warning looks like a crash.
    assert_eq!(Config::parse("{}").unwrap().idle.blank_after(), None);
}

#[test]
fn a_desk_that_states_a_timeout_gets_it() {
    let idle = Config::parse(
        r#"
{ "idle": { "blank_after_seconds": 600 } }
"#,
    )
    .unwrap()
    .idle;
    assert_eq!(idle.blank_after(), Some(Duration::from_secs(600)));
}

#[test]
fn rejects_a_timeout_of_no_time_at_all() {
    // Zero could mean "blank immediately" or "never"; "never" is spelled by
    // leaving the key out. So zero is refused.
    let err = Config::parse(
        r#"
{ "idle": { "blank_after_seconds": 0 } }
"#,
    )
    .unwrap_err();
    let ConfigError::Validation(message) = &err else {
        panic!("a zero timeout is refused rather than taken: {err:?}");
    };
    assert!(
        message.contains("idle.blank_after_seconds"),
        "the message should name the key: {message}"
    );
}

#[test]
fn a_desk_that_asked_for_no_lock_timeout_never_locks_on_its_own() {
    // Blanking alone does not lock; only the shell's `lock()` would.
    let idle = Config::parse(
        r#"
{ "idle": { "blank_after_seconds": 600 } }
"#,
    )
    .unwrap()
    .idle;
    assert_eq!(idle.lock_after(), None);
}

#[test]
fn a_lock_timeout_stands_on_its_own_clock() {
    // Shorter, longer, or with no blanking at all.
    for (stated, lock_after) in [
        (
            r#"{ "blank_after_seconds": 600, "lock_after_seconds": 300 }"#,
            300,
        ),
        (
            r#"{ "blank_after_seconds": 300, "lock_after_seconds": 600 }"#,
            600,
        ),
        (r#"{ "lock_after_seconds": 900 }"#, 900),
    ] {
        let idle = Config::parse(&format!(r#"{{ "idle": {stated} }}"#))
            .unwrap()
            .idle;
        assert_eq!(
            idle.lock_after(),
            Some(Duration::from_secs(lock_after)),
            "{stated}"
        );
    }
}

#[test]
fn rejects_a_lock_timeout_of_no_time_at_all() {
    // "Never" is spelled by leaving the key out.
    let err = Config::parse(
        r#"
{ "idle": { "lock_after_seconds": 0 } }
"#,
    )
    .unwrap_err();
    let ConfigError::Validation(message) = &err else {
        panic!("a zero lock timeout is refused rather than taken: {err:?}");
    };
    assert!(
        message.contains("idle.lock_after_seconds"),
        "the message should name the key: {message}"
    );
}

// ---- lock -----------------------------------------------------------------

#[test]
fn a_desk_that_names_no_pam_service_unlocks_through_domicile() {
    // The NixOS module and the distribution packages declare `domicile`.
    assert_eq!(Config::parse("{}").unwrap().lock.service(), "domicile");
}

#[test]
fn a_desk_that_names_a_pam_service_unlocks_through_it() {
    let lock = Config::parse(
        r#"
{ "lock": { "pam_service": "login" } }
"#,
    )
    .unwrap()
    .lock;
    assert_eq!(lock.service(), "login");
}

#[test]
fn rejects_a_passphrase_of_its_own_in_either_form() {
    // The account password unlocks the desk, so the error names the key that
    // is left.
    for stated in [
        r#"{ "lock": { "passphrase": "open sesame" } }"#,
        r#"{ "lock": { "passphrase_hash": "$y$j9T$salt$hash" } }"#,
    ] {
        let err = Config::parse(stated).unwrap_err();
        assert!(
            err.to_string().contains("pam_service"),
            "the message should name the key that is left: {err}"
        );
    }
}

#[test]
fn rejects_a_pam_service_that_is_no_file_name_in_pam_d() {
    // PAM reads the service from a file named after it.
    for service in ["", ".", "..", "../shadow", "domicile\\u0000"] {
        let err = Config::parse(&format!(
            r#"{{ "lock": {{ "pam_service": "{service}" }} }}"#
        ))
        .unwrap_err();
        let ConfigError::Validation(message) = &err else {
            panic!("{service:?} is refused rather than taken: {err:?}");
        };
        assert!(
            message.contains("lock.pam_service"),
            "the message should name the key: {message}"
        );
    }
}

// ---- theme ----------------------------------------------------------------

#[test]
fn a_desk_that_says_nothing_about_the_theme_is_dark() {
    // Dark is the default: there is no system preference above the chrome to
    // follow, and the chrome is designed for dark.
    assert_eq!(Config::parse("{}").unwrap().theme.mode, ThemeMode::Dark);
}

#[test]
fn a_desk_that_states_a_theme_gets_it() {
    let theme = Config::parse(
        r#"
{ "theme": { "mode": "light" } }
"#,
    )
    .unwrap()
    .theme;
    assert_eq!(theme.mode, ThemeMode::Light);
}

#[test]
fn rejects_a_theme_that_is_neither() {
    // Only `dark` and `light` exist. `system` is refused: Domicile is the
    // system, so there is nothing to follow.
    let err = Config::parse(
        r#"
{ "theme": { "mode": "system" } }
"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "got {err:?}");
}

#[test]
fn a_desk_that_says_nothing_about_its_look_has_no_accent_normal_contrast_and_motion() {
    let theme = Config::parse("{}").unwrap().theme;
    assert_eq!(
        (
            theme.accent_color,
            theme.contrast,
            theme.reduced_motion,
            theme.icon_theme
        ),
        (None, Contrast::Normal, false, None)
    );
}

#[test]
fn a_desk_that_states_its_look_gets_it() {
    let theme = Config::parse(
        r##"
{ "theme": { "accent_color": "#3584E4", "contrast": "high", "reduced_motion": true,
             "icon_theme": "Papirus-Dark" } }
"##,
    )
    .unwrap()
    .theme;
    assert_eq!(
        (
            theme.accent_color,
            theme.contrast,
            theme.reduced_motion,
            theme.icon_theme.as_deref()
        ),
        (
            Some(AccentColor([0x35, 0x84, 0xe4])),
            Contrast::High,
            true,
            Some("Papirus-Dark")
        )
    );
}

#[test]
fn a_desk_that_states_its_cursor_and_fonts_gets_them() {
    let theme = Config::parse(
        r#"
{ "theme": { "cursor_theme": "Bibata-Modern-Ice", "cursor_size": 32,
             "font_name": "Inter 11", "monospace_font_name": "Iosevka 12" } }
"#,
    )
    .unwrap()
    .theme;
    let cursor_theme = theme.cursor_theme.as_ref().unwrap();
    assert_eq!(
        (
            cursor_theme.in_mode(ThemeMode::Dark),
            cursor_theme.in_mode(ThemeMode::Light),
            theme.cursor_size,
            theme.font_name.as_deref(),
            theme.monospace_font_name.as_deref()
        ),
        (
            "Bibata-Modern-Ice",
            "Bibata-Modern-Ice",
            Some(32),
            Some("Inter 11"),
            Some("Iosevka 12")
        )
    );
}

#[test]
fn a_cursor_theme_can_differ_by_mode() {
    let cursor_theme = Config::parse(
        r#"
{ "theme": { "cursor_theme": { "dark": "Bibata-Modern-Ice",
                               "light": "Bibata-Modern-Classic" } } }
"#,
    )
    .unwrap()
    .theme
    .cursor_theme
    .unwrap();
    assert_eq!(
        (
            cursor_theme.in_mode(ThemeMode::Dark),
            cursor_theme.in_mode(ThemeMode::Light)
        ),
        ("Bibata-Modern-Ice", "Bibata-Modern-Classic")
    );
}

#[test]
fn rejects_a_per_mode_cursor_theme_without_both_modes() {
    let err =
        Config::parse(r#"{ "theme": { "cursor_theme": { "light": "Adwaita" } } }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "got {err:?}");
}

#[test]
fn rejects_an_icon_or_cursor_theme_that_is_not_a_directory_name() {
    let written = |name: &str| {
        [
            format!(r#""icon_theme": "{name}""#),
            format!(r#""cursor_theme": "{name}""#),
            format!(r#""cursor_theme": {{ "dark": "{name}", "light": "Adwaita" }}"#),
            format!(r#""cursor_theme": {{ "dark": "Adwaita", "light": "{name}" }}"#),
        ]
    };
    for name in ["", ".", "..", "Papirus/Dark"] {
        for key in written(name) {
            let err = Config::parse(&format!(r#"{{ "theme": {{ {key} }} }}"#)).unwrap_err();
            assert!(
                matches!(err, ConfigError::Validation(_)),
                "{key}: got {err:?}"
            );
        }
    }
}

#[test]
fn a_desk_that_names_sites_to_force_dark_gets_them() {
    let theme = Config::parse(r#"{ "theme": { "force_dark": ["mail.google.com"] } }"#)
        .unwrap()
        .theme;
    assert_eq!(theme.force_dark, ["mail.google.com"]);
}

#[test]
fn rejects_a_site_to_force_dark_that_is_not_a_host_name() {
    for site in [
        "",
        "https://mail.google.com",
        "mail.google.com/mail",
        "mail.google.com:443",
    ] {
        let err = Config::parse(&format!(r#"{{ "theme": {{ "force_dark": ["{site}"] }} }}"#))
            .unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "{site:?}: got {err:?}"
        );
    }
}

#[test]
fn a_desk_can_hide_the_pointer_while_typing_and_after_a_pause() {
    let theme = Config::parse(
        r#"{ "theme": { "cursor_hide_after_ms": 1000, "cursor_hide_when_typing": true } }"#,
    )
    .unwrap()
    .theme;
    assert_eq!(
        (theme.cursor_hide_after_ms, theme.cursor_hide_when_typing),
        (Some(1000), true)
    );
    let unset = Config::parse("{}").unwrap().theme;
    assert_eq!(
        (unset.cursor_hide_after_ms, unset.cursor_hide_when_typing),
        (None, false)
    );
}

#[test]
fn rejects_hiding_the_pointer_after_zero_ms() {
    let err = Config::parse(r#"{ "theme": { "cursor_hide_after_ms": 0 } }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

#[test]
fn rejects_a_cursor_size_of_zero() {
    let err = Config::parse(r#"{ "theme": { "cursor_size": 0 } }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

#[test]
fn rejects_an_accent_that_is_not_a_hex_color() {
    for accent in ["blue", "#35e", "#3584e4ff", "#3584g4", "#+1+2+3"] {
        let err = Config::parse(&format!(
            r#"{{ "theme": {{ "accent_color": "{accent}" }} }}"#
        ))
        .unwrap_err();
        assert!(
            matches!(err, ConfigError::Parse(_)),
            "{accent}: got {err:?}"
        );
    }
}

// ---- lockdown -------------------------------------------------------------

#[test]
fn a_desk_that_says_nothing_about_lockdown_disables_nothing() {
    assert_eq!(
        Config::parse("{}").unwrap().lockdown,
        LockdownConfig {
            disable_printing: false,
            disable_save_to_disk: false,
            disable_application_handlers: false,
            disable_location: false,
            disable_camera: false,
            disable_microphone: false,
            disable_sound_output: false,
        }
    );
}

#[test]
fn a_desk_that_disables_something_disables_only_that() {
    let lockdown = Config::parse(
        r#"
{ "lockdown": { "disable_camera": true, "disable_printing": true } }
"#,
    )
    .unwrap()
    .lockdown;
    assert_eq!(
        lockdown,
        LockdownConfig {
            disable_printing: true,
            disable_camera: true,
            ..LockdownConfig::default()
        }
    );
}

// ---- applications ---------------------------------------------------------

#[test]
fn applications_are_a_shell_s_and_the_section_is_refused() {
    // A shell lists applications and bookmarks itself, through the system
    // calls; manganese takes them as its `applications` option.
    let err = Config::parse(r#"{ "applications": { "omit": ["*"] } }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "{err:?}");
}

// ---- startup --------------------------------------------------------------

#[test]
fn a_desk_that_says_nothing_about_startup_runs_nothing() {
    assert!(Config::parse("{}").unwrap().startup.commands.is_empty());
}

#[test]
fn a_startup_command_is_an_argv() {
    let commands = Config::parse(
        r#"
{ "startup": { "commands": [["emacsclient", "-e", "t"], ["mako"]] } }
"#,
    )
    .unwrap()
    .startup
    .commands;
    assert_eq!(commands, [vec!["emacsclient", "-e", "t"], vec!["mako"]]);
}

#[test]
fn an_empty_startup_command_is_refused() {
    // An empty command is a mistake in the file.
    let err = Config::parse(
        r#"
{ "startup": { "commands": [[]] } }
"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

// ---- browser profiles -----------------------------------------------------

#[test]
fn a_desk_that_says_nothing_about_profiles_has_a_default_and_a_private_one() {
    let browser = Config::parse("{}").unwrap().browser;
    assert_eq!(browser.default_profile, "default");
    assert_eq!(browser.default_private_profile, "private");
    assert!(!browser.profiles["default"].private);
    assert!(browser.profiles["private"].private);
    assert!(browser.sites.is_empty());
}

const PROFILES: &str = r##""profiles": {
    "personal": { "name": "Personal", "color": "#0d9488" },
    "work": { "name": "Work", "color": "#d97706", "extensions": ["aeblfdkhhhdcdjpifhhbdiojplfjncoa"] },
    "incognito": { "name": "Private", "color": "#a78bfa", "private": true }
  },
  "default_profile": "personal",
  "default_private_profile": "incognito""##;

fn browser_config(rest: &str) -> String {
    format!(r#"{{ "browser": {{ {PROFILES}{rest} }} }}"#)
}

#[test]
fn profiles_map_sites_to_profiles() {
    let browser = Config::parse(&browser_config(
        r#", "sites": { "*.acme.com": "work", "github.com/acme": "work", "chase.com": "incognito" }"#,
    ))
    .unwrap()
    .browser;
    assert_eq!(browser.sites["github.com/acme"], "work");
    assert_eq!(browser.sites["chase.com"], "incognito");
    assert_eq!(
        browser.profiles["work"].extensions,
        Some(vec!["aeblfdkhhhdcdjpifhhbdiojplfjncoa".to_string()])
    );
    assert_eq!(browser.profiles["personal"].extensions, None);
}

#[test]
fn profiles_list_in_their_order_then_by_id() {
    let browser = Config::parse(&browser_config(r#", "order": ["work"]"#))
        .unwrap()
        .browser;
    let ids: Vec<&str> = browser
        .ordered_profiles()
        .map(|(id, _)| id.as_str())
        .collect();
    assert_eq!(ids, ["work", "incognito", "personal"]);
}

#[test]
fn a_profile_config_that_contradicts_itself_is_refused() {
    let refused = [
        // A site in a profile that doesn't exist.
        browser_config(r#", "sites": { "acme.com": "office" }"#),
        // A site in the default profile, which every unlisted site opens in.
        browser_config(r#", "sites": { "acme.com": "personal" }"#),
        // A site that is no host.
        browser_config(r#", "sites": { "https://acme.com": "work" }"#),
        browser_config(r#", "sites": { "acme.com/": "work" }"#),
        // An order naming a profile that doesn't exist, or one twice.
        browser_config(r#", "order": ["office"]"#),
        browser_config(r#", "order": ["work", "work"]"#),
    ];
    for text in refused {
        let err = Config::parse(&text).unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "{text}: got {err:?}"
        );
    }
}

#[test]
fn default_profiles_must_exist_and_be_the_right_kind() {
    let refused = [
        // The default profile is missing.
        r##"{ "browser": { "profiles": { "work": { "name": "Work", "color": "#d97706" } } } }"##,
        // The default profile is private.
        r##"{ "browser": { "default_profile": "private" } }"##,
        // The default private profile is not private.
        r##"{ "browser": { "default_private_profile": "default" } }"##,
    ];
    for text in refused {
        let err = Config::parse(text).unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "{text}: got {err:?}"
        );
    }
}

#[test]
fn a_profile_id_is_a_directory_name() {
    let err = Config::parse(
        r##"{ "browser": { "profiles": {
            "default": { "name": "Default", "color": "#0d9488" },
            "private": { "name": "Private", "color": "#a78bfa", "private": true },
            "../work": { "name": "Work", "color": "#d97706" }
        } } }"##,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

#[test]
fn a_profile_names_extensions_by_id() {
    let err = Config::parse(
        r##"{ "browser": { "profiles": {
            "default": { "name": "Default", "color": "#0d9488", "extensions": ["bitwarden"] },
            "private": { "name": "Private", "color": "#a78bfa", "private": true }
        } } }"##,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

// ---- electron -------------------------------------------------------------

#[test]
fn a_desk_that_says_nothing_about_electron_runs_no_app_on_the_engine() {
    assert!(Config::parse("{}").unwrap().electron.apps.is_empty());
}

#[test]
fn electron_apps_are_desktop_file_ids() {
    let apps = Config::parse(r#"{ "electron": { "apps": ["slack.desktop", "element-desktop"] } }"#)
        .unwrap()
        .electron
        .apps;
    assert_eq!(apps, ["slack.desktop", "element-desktop"]);
}

#[test]
fn an_electron_app_given_as_a_path_is_refused() {
    let err =
        Config::parse(r#"{ "electron": { "apps": ["/usr/share/applications/slack.desktop"] } }"#)
            .unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

// ---- terminal -------------------------------------------------------------

#[test]
fn a_desk_that_names_no_terminal_has_none() {
    // No default: #877 decided against one.
    assert_eq!(Config::parse("{}").unwrap().terminal, None);
}

#[test]
fn a_terminal_is_an_argv() {
    let terminal = Config::parse(r#"{ "terminal": ["kitty", "--"] }"#)
        .unwrap()
        .terminal;
    assert_eq!(terminal, Some(vec!["kitty".to_string(), "--".to_string()]));
}

#[test]
fn an_empty_terminal_is_refused() {
    let err = Config::parse(r#"{ "terminal": [] }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

// ---- files ----------------------------------------------------------------

#[test]
fn a_desk_that_says_nothing_about_files_omits_what_is_hidden_at_any_depth() {
    // By default hidden paths, such as `.git` directories, are omitted.
    let omit = Config::parse("{}").unwrap().files.omit;
    assert!(omit.omits(".config"));
    assert!(omit.omits("src/.git"));
    assert!(!omit.omits("src"));
    assert!(!omit.omits("src/main.rs"));
}

#[test]
fn a_desk_that_states_what_to_omit_replaces_the_default() {
    // A configured list replaces the default, so a desk can offer its
    // dotfiles.
    let omit = Config::parse(
        r#"
{ "files": { "omit": ["Library/*/*"] } }
"#,
    )
    .unwrap()
    .files
    .omit;
    assert!(omit.omits("Library/Mail/inbox"));
    assert!(!omit.omits("Library/Mail"));
    assert!(!omit.omits("Projects/.archive"));
}

#[test]
fn the_last_pattern_to_match_a_path_decides_it() {
    // Gitignore's rule: a later `!` takes back what an earlier pattern
    // omitted. `*` stops at `/`, so `*/*` is two levels deep and no more.
    let omit = Config::parse(
        r#"
{ "files": { "omit": ["*/*", "!Scratch/*"] } }
"#,
    )
    .unwrap()
    .files
    .omit;
    assert!(!omit.omits("src"));
    assert!(omit.omits("src/domicile"));
    assert!(!omit.omits("Scratch/notes"));
    assert!(!omit.omits("Scratch/notes/today.org"));
}

#[test]
fn rejects_a_pattern_that_is_not_a_glob() {
    // Refused at load, where the file can be named. Otherwise the index would
    // be built silently without the rule.
    let err = Config::parse(
        r#"
{ "files": { "omit": ["Library/[unclosed"] } }
"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "got {err:?}");
}

// ---- extensions -----------------------------------------------------------

#[test]
fn a_desk_that_says_nothing_about_extensions_names_none() {
    let extensions = Config::parse("{}").unwrap().extensions;
    assert!(extensions.web_store.is_empty());
    assert!(extensions.unpacked.is_empty());
}

#[test]
fn a_desk_that_names_extensions_gets_them() {
    let extensions = Config::parse(
        r#"
{
  "extensions": {
    "web_store": ["ddkjiahejlhfcafbddmgiahcphecmpfh"],
    "unpacked": ["/home/you/src/my-extension"]
  }
}
"#,
    )
    .unwrap()
    .extensions;
    assert_eq!(extensions.web_store, ["ddkjiahejlhfcafbddmgiahcphecmpfh"]);
    assert_eq!(
        extensions.unpacked,
        [PathBuf::from("/home/you/src/my-extension")]
    );
}

#[test]
fn rejects_a_web_store_id_that_is_not_one() {
    // A Store id is 32 letters from `a` to `p`. Refusing others here avoids a
    // failure later in the engine's log.
    for id in [
        "ddkjiahejlhfcafbddmgiahcphecmpf",  // one short
        "ddkjiahejlhfcafbddmgiahcphecmpfz", // a letter past `p`
        "DDKJIAHEJLHFCAFBDDMGIAHCPHECMPFH", // shouted
    ] {
        let err = Config::parse(&format!(
            r#"{{ "extensions": {{ "web_store": [{id:?}] }} }}"#
        ))
        .unwrap_err();
        let ConfigError::Validation(message) = &err else {
            panic!("{id}: got {err:?}");
        };
        assert!(message.contains(id), "{id}: {message}");
    }
}

#[test]
fn a_desk_sets_its_extensions_settings() {
    let extensions = Config::parse(
        r#"
{
  "extensions": {
    "settings": {
      "ddkjiahejlhfcafbddmgiahcphecmpfh": {
        "file_access": false,
        "site_access": ["github.com", "*.example.com"]
      },
      "eimadpbcbfnmbkopoojfekhnkhdbieeh": { "user_scripts": true, "site_access": "on_click" }
    }
  }
}
"#,
    )
    .unwrap()
    .extensions;
    assert_eq!(
        extensions.settings["ddkjiahejlhfcafbddmgiahcphecmpfh"],
        ExtensionSettings {
            file_access: Some(false),
            user_scripts: None,
            site_access: Some(SiteAccess::Sites(vec![
                "github.com".into(),
                "*.example.com".into()
            ])),
        }
    );
    assert_eq!(
        extensions.settings["eimadpbcbfnmbkopoojfekhnkhdbieeh"],
        ExtensionSettings {
            user_scripts: Some(true),
            site_access: Some(SiteAccess::Mode(SiteAccessMode::OnClick)),
            ..ExtensionSettings::default()
        }
    );
}

#[test]
fn rejects_settings_for_an_id_that_is_not_one() {
    let message =
        refusal(r#"{ "extensions": { "settings": { "ublock": { "file_access": true } } } }"#);
    assert!(message.contains("ublock"), "{message}");
}

#[test]
fn rejects_a_site_that_is_not_a_host() {
    // Chrome grants a host on http and https, so a scheme or a path has no
    // meaning here.
    // Nor does one Chrome cannot parse as a host, which the engine would
    // refuse: empty labels, an edge hyphen, a number that is not an address.
    for site in [
        "https://github.com",
        "github.com/login",
        "",
        ".",
        "*..",
        "github.com.",
        "-github.com",
        "foo.123",
        "1.2.3.999",
        "*.10.0.0.1",
        "010.0.0.1",
        "foo.0x1f",
        "0x7f",
    ] {
        let message = refusal(&format!(
            r#"{{ "extensions": {{ "settings": {{ "ddkjiahejlhfcafbddmgiahcphecmpfh": {{ "site_access": [{site:?}] }} }} }} }}"#
        ));
        assert!(message.contains(&format!("{site:?}")), "{site}: {message}");
    }
}

#[test]
fn a_site_may_be_a_dotted_address_or_a_single_name() {
    for site in ["10.0.0.1", "localhost", "*.github.io"] {
        Config::parse(&format!(
            r#"{{ "extensions": {{ "settings": {{ "ddkjiahejlhfcafbddmgiahcphecmpfh": {{ "site_access": [{site:?}] }} }} }} }}"#
        ))
        .unwrap_or_else(|err| panic!("{site}: {err:?}"));
    }
}

#[test]
fn rejects_an_extension_setting_it_does_not_know() {
    let err = Config::parse(
        r#"{ "extensions": { "settings": { "ddkjiahejlhfcafbddmgiahcphecmpfh": { "pinned": true } } } }"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "got {err:?}");
}

#[test]
fn rejects_an_unpacked_extension_that_is_not_an_absolute_path() {
    // A relative path has no defined base, so it is refused at load. `~` is
    // tested in the crate's unit tests, which can set the home directory.
    let err =
        Config::parse(r#"{ "extensions": { "unpacked": ["src/my-extension"] } }"#).unwrap_err();
    let ConfigError::Validation(message) = &err else {
        panic!("got {err:?}");
    };
    assert!(message.contains("src/my-extension"), "{message}");
}

#[test]
fn rejects_an_unpacked_extension_in_another_users_home() {
    // `~alice` would need a lookup of another user's home, so it is refused
    // as such rather than as a relative path.
    let err = Config::parse(r#"{ "extensions": { "unpacked": ["~alice/src/my-extension"] } }"#)
        .unwrap_err();
    let ConfigError::Validation(message) = &err else {
        panic!("got {err:?}");
    };
    assert!(message.contains("~alice/src/my-extension"), "{message}");
    assert!(message.contains("another user's home"), "{message}");
}

#[test]
fn rejects_invalid_syntax() {
    let err = Config::parse("{ this is not json").unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "got {err:?}");
}

/// An unknown key is refused rather than ignored.
///
/// A shell generates this file, so an unknown key is a bug in that program.
#[test]
fn rejects_a_key_nothing_reads() {
    // A misspelled key in an existing section.
    let err = Config::parse(
        r#"
{ "output": { "max_scaale": 2 } }
"#,
    )
    .unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "got {err:?}");
    assert!(
        format!("{err}").contains("max_scaale"),
        "the message should name the key: {err}"
    );

    // A misspelled section at the top level.
    let err = Config::parse(r#"{ "outputs": {} }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "got {err:?}");

    // Every section with `deny_unknown_fields`, not just `Config`, so a
    // misspelled `xkb_optoins` is caught too.
    for section in [
        r#"
{ "idle": { "blank_after_secons": 600 } }
"#,
        r#"
{ "input": { "keyboard": { "xkb_optoins": [] } } }
"#,
        r#"{ "input": { "keyboardd": {} } }"#,
        r#"
{
  "output": { "displays": [{ "name": "a", "size": [1, 1], "scaale": 2 }] }
}
"#,
    ] {
        let err = Config::parse(section).unwrap_err();
        assert!(
            matches!(err, ConfigError::Parse(_)),
            "{section} should be refused, got {err:?}"
        );
    }
}

#[test]
fn the_startup_placeholder_is_not_a_setting() {
    // The startup desktop size is a compositor constant: DRM or the chrome's
    // `SetDesktopSize` replaces it right away. A `compositor` section is
    // refused.
    for stated in [
        r#"
{ "compositor": { "nested_size": [800, 600] } }
"#,
        r#"{ "compositor": {} }"#,
    ] {
        let err = Config::parse(stated).unwrap_err();
        assert!(
            matches!(err, ConfigError::Parse(_)),
            "{stated} should be refused, got {err:?}"
        );
    }
}

// ---- hot-reload semantics ---------------------------------------------------

#[test]
fn store_reload_valid_swaps_current_and_clears_error() {
    let mut store = ConfigStore::new(Config::default());
    store
        .reload_from_str(
            r#"
{ "output": { "max_scale": 3 } }
"#,
        )
        .unwrap();
    assert_eq!(store.current().output.max_scale, 3);
    assert!(store.last_error().is_none());
}

#[test]
fn store_reload_invalid_keeps_last_good_and_records_error() {
    let mut store = ConfigStore::new(Config::default());
    store
        .reload_from_str(
            r#"
{ "output": { "max_scale": 3 } }
"#,
        )
        .unwrap();

    // A later bad edit must not change the live config.
    let err = store
        .reload_from_str(r#"{ "output": { "max_scale": } }"#)
        .unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)));
    assert_eq!(
        store.current().output.max_scale,
        3,
        "last-good config must remain active after a bad edit"
    );
    assert!(store.last_error().is_some());
}

#[test]
fn store_recovers_after_fixing_a_bad_edit() {
    let mut store = ConfigStore::new(Config::default());
    let _ = store.reload_from_str(r#"{ "output": "#);
    assert!(store.last_error().is_some());

    store
        .reload_from_str(
            r#"
{ "output": { "max_scale": 4 } }
"#,
        )
        .unwrap();
    assert_eq!(store.current().output.max_scale, 4);
    assert!(
        store.last_error().is_none(),
        "error must clear once config is valid again"
    );
}

// ---- filesystem loading ----------------------------------------------------

#[test]
fn loads_from_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("domicile.json");
    std::fs::write(
        &path,
        r#"
{ "output": { "max_scale": 3 } }
"#,
    )
    .unwrap();

    let cfg = Config::load(&path).unwrap();
    assert_eq!(cfg.output.max_scale, 3);
}

#[test]
fn missing_file_is_an_io_error() {
    let err = Config::load("/no/such/domicile.json").unwrap_err();
    assert!(matches!(err, ConfigError::Io { .. }), "got {err:?}");
}

/// An error loading a file names the file.
///
/// A machine can have several configs, so the error must say which one.
/// `Config::parse` has no path; `load` adds it.
#[test]
fn a_file_that_will_not_load_says_which_file() {
    let dir = tempfile::tempdir().unwrap();

    let unparseable = dir.path().join("syntax.json");
    std::fs::write(&unparseable, r#"{ "compositor": {} }"#).unwrap();
    let err = Config::load(&unparseable).unwrap_err();
    let said = format!("{err}");
    assert!(
        said.contains(&unparseable.display().to_string()),
        "the complaint should name the file: {said}"
    );
    assert!(
        said.contains("`compositor`"),
        "and keep what the parser said about it: {said}"
    );

    // A config that parses but fails validation also names the file.
    let invalid = dir.path().join("validation.json");
    std::fs::write(&invalid, r#"{ "output": { "max_scale": 0 } }"#).unwrap();
    let err = Config::load(&invalid).unwrap_err();
    let said = format!("{err}");
    assert!(
        said.contains(&invalid.display().to_string()),
        "a config that will not validate names it too: {said}"
    );
    assert!(
        said.contains("max_scale"),
        "and keeps what was wrong with it: {said}"
    );
}

#[test]
fn store_reload_from_path_keeps_last_good_on_bad_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("domicile.json");
    std::fs::write(
        &path,
        r#"
{ "output": { "max_scale": 3 } }
"#,
    )
    .unwrap();

    let mut store = ConfigStore::new(Config::load(&path).unwrap());
    assert_eq!(store.current().output.max_scale, 3);

    // Simulate a user saving a broken file.
    std::fs::write(&path, r#"{ "output": { "max_scale": "#).unwrap();
    assert!(store.reload_from_path(&path).is_err());
    assert_eq!(store.current().output.max_scale, 3);
}

#[test]
fn a_save_reloads_and_then_the_watcher_goes_quiet() {
    // Reading the config must not count as a change, or each reload sets off
    // the next and the watcher spins forever.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("domicile.json");
    std::fs::write(&path, "{}").unwrap();
    let watcher = domicile_config::watch(&path).unwrap();

    // Save the way `std::fs::write` and many editors do: truncate, then write.
    // The pause lets the watcher read the empty file in between.
    let mut file = std::fs::File::create(&path).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    file.write_all(br#"{ "output": { "max_scale": 3 } }"#)
        .unwrap();
    // Each event in the save sends a result, the empty read's error among
    // them, so read to the end of the burst like the compositor does. Bounded,
    // since a spinning watcher never stops sending.
    let mut reloaded = watcher.rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let save_settles_by = std::time::Instant::now() + Duration::from_secs(2);
    while let Some(left) = save_settles_by.checked_duration_since(std::time::Instant::now()) {
        if let Ok(next) = watcher.rx.recv_timeout(left) {
            reloaded = next;
        }
    }
    assert_eq!(reloaded.unwrap().output.max_scale, 3);

    let quiet_for = Duration::from_millis(500);
    assert!(
        watcher.rx.recv_timeout(quiet_for).is_err(),
        "reloaded with nothing written"
    );
}

#[test]
fn a_save_that_truncates_before_it_writes_reloads_only_the_written_file() {
    // Editors and `std::fs::write` truncate, then write. A reload in between
    // reads an empty file and reports a parse error the user never saved.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("domicile.json");
    std::fs::write(&path, "{}").unwrap();
    let watcher = domicile_config::watch(&path).unwrap();

    let mut file = std::fs::File::create(&path).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    std::io::Write::write_all(&mut file, br#"{ "output": { "max_scale": 3 } }"#).unwrap();

    let reloaded = watcher.rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(reloaded.unwrap().output.max_scale, 3);
}

#[test]
fn a_write_to_another_file_beside_the_config_does_not_reload() {
    // The directory also holds the chrome socket and session document. Their
    // writes would hold off a reload until they stop.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("domicile.json");
    std::fs::write(&path, "{}").unwrap();
    let watcher = domicile_config::watch(&path).unwrap();

    std::fs::write(dir.path().join("session.json"), "{}").unwrap();

    assert!(
        watcher.rx.recv_timeout(Duration::from_millis(500)).is_err(),
        "reloaded for another file"
    );
}

// ---- output ---------------------------------------------------------------

#[test]
fn output_scaling_is_on_by_default_up_to_a_retina_display() {
    // The default covers a common 2x display; higher scales cost more than
    // they are worth.
    assert_eq!(Config::parse("{}").unwrap().output.max_scale, 2);
}

#[test]
fn max_scale_one_turns_hidpi_off() {
    // A client at scale N renders N² times the pixels, so a user can trade
    // sharpness for speed without a rebuild.
    assert_eq!(
        Config::parse(
            r#"
{ "output": { "max_scale": 1 } }
"#
        )
        .unwrap()
        .output
        .max_scale,
        1
    );
}

#[test]
fn max_scale_must_leave_a_usable_scale() {
    let err = Config::parse(
        r#"
{ "output": { "max_scale": 0 } }
"#,
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("output.max_scale"),
        "the message should name the setting: {err}"
    );
}

// ---- statically described displays -----------------------------------------

#[test]
fn no_displays_configured_means_the_output_follows_domiciles_window() {
    // With no displays configured, one output is sized to Domicile's window.
    assert_eq!(Config::parse("{}").unwrap().output.displays, vec![]);
}

#[test]
fn parses_a_side_by_side_desktop() {
    let text = r#"
{
  "output": {
    "displays": [
      { "name": "left", "position": [0, 0], "size": [1920, 1080] },
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
    let displays = Config::parse(text)
        .expect("a described desktop should parse")
        .output
        .displays;
    assert_eq!(
        displays,
        vec![
            DisplayConfig {
                name: "left".into(),
                position: (0, 0),
                scale: 1,
                size: (1920, 1080),
            },
            DisplayConfig {
                name: "right".into(),
                position: (1920, 0),
                scale: 2,
                size: (2560, 1440),
            },
        ]
    );
}

#[test]
fn a_display_sits_at_the_origin_unless_placed() {
    // With one display there is nothing for a position to be relative to.
    let displays = Config::parse(
        r#"
{ "output": { "displays": [{ "name": "only", "size": [800, 600] }] } }
"#,
    )
    .unwrap()
    .output
    .displays;
    assert_eq!(displays[0].position, (0, 0));
}

#[test]
fn a_display_needs_a_name_the_shell_can_tell_apart() {
    // The chrome addresses a display by name, so names must be unique.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "hdmi", "size": [800, 600] },
      { "name": "hdmi", "position": [800, 0], "size": [800, 600] }
    ]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "a duplicate name should fail validation, not parsing: {err:?}"
    );
    assert!(
        format!("{err}").contains("hdmi"),
        "the message should name the collision: {err}"
    );
}

#[test]
fn a_display_name_may_not_be_padded() {
    // Names are matched exactly, so a padded name would look like a missing
    // display. One entry, so a trim-and-deduplicate would not pass this test.
    let err = Config::parse(
        r#"
{ "output": { "displays": [{ "name": "left ", "size": [800, 600] }] } }
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "a padded name should fail validation, not parsing: {err:?}"
    );
    assert!(
        format!("{err}").contains("padded"),
        "the message should say what is wrong with the name: {err}"
    );
}

#[test]
fn a_display_named_nothing_is_rejected() {
    // A display with no name is reported by its index.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "real", "size": [800, 600] },
      { "name": "", "position": [800, 0], "size": [800, 600] }
    ]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "a blank name should fail validation, not parsing: {err:?}"
    );
    assert!(
        format!("{err}").contains("output.displays[1]"),
        "the message should say which entry: {err}"
    );
}

#[test]
fn a_display_with_no_pixels_is_rejected() {
    // Either axis: zero width or zero height.
    for size in ["[1920, 0]", "[0, 1080]"] {
        let err = Config::parse(&format!(
            r#"
{{ "output": {{ "displays": [{{ "name": "dead", "size": {size} }}] }} }}
"#
        ))
        .unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "size {size} should fail validation, not parsing: {err:?}"
        );
        assert!(
            format!("{err}").contains("dead"),
            "the message should name the display: {err}"
        );
    }
}

#[test]
fn a_display_must_have_a_usable_scale() {
    let err = Config::parse(
        r#"
{
  "output": { "displays": [{ "name": "tiny", "size": [800, 600], "scale": 0 }] }
}
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "a zero scale should fail validation, not parsing: {err:?}"
    );
    assert!(
        format!("{err}").contains("scale"),
        "the message should name the setting: {err}"
    );
}

#[test]
fn a_display_may_not_run_off_the_edge_of_the_desktop() {
    // The far corner must fit `i32` too: the desktop's bounding box is
    // computed from it, so it is rejected here rather than wrapping later.
    for position in ["[2147483000, 0]", "[0, 2147483000]"] {
        let err = Config::parse(&format!(
            r#"
{{
  "output": {{
    "displays": [{{ "name": "far", "position": {position}, "size": [1920, 1080] }}]
  }}
}}
"#
        ))
        .unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "position {position} should fail validation, not parsing: {err:?}"
        );
        assert!(
            format!("{err}").contains("far"),
            "the message should name the display: {err}"
        );
    }
}

#[test]
fn displays_may_not_cover_the_same_ground() {
    // Overlapping displays leave no answer for which one owns a point.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "left", "size": [1920, 1080] },
      { "name": "right", "position": [1900, 0], "size": [1920, 1080] }
    ]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "an overlap should fail validation, not parsing: {err:?}"
    );
    let message = format!("{err}");
    assert!(
        message.contains("left") && message.contains("right"),
        "the message should name both displays: {err}"
    );
}

#[test]
fn displays_that_only_touch_are_a_desktop_rather_than_a_collision() {
    // Side by side and stacked: displays that share an edge are adjacent,
    // not overlapping. Each layout overlaps fully on its other axis, so a
    // check that drops an axis or uses closed intervals fails here.
    Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "left", "size": [1920, 1080] },
      { "name": "right", "position": [1920, 0], "size": [1920, 1080] }
    ]
  }
}
"#,
    )
    .expect("side-by-side displays should parse");
    Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "top", "size": [1920, 1080] },
      { "name": "bottom", "position": [0, 1080], "size": [1920, 1080] }
    ]
  }
}
"#,
    )
    .expect("stacked displays should parse");
}

#[test]
fn a_desktop_may_reach_exactly_as_far_as_a_position_can_and_no_further() {
    // The boundary: a far corner at `i32::MAX` normalizes to a valid position.
    //
    // Each axis is sized so that reading the other axis's length would
    // exceed the limit, which tells the two axis checks apart.
    Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "here", "size": [1920, 1080] },
      {
        "name": "far",
        "position": [2147479647, 2000],
        "size": [4000, 8000]
      }
    ]
  }
}
"#,
    )
    .expect("a desktop exactly as wide as a position can describe should parse");
    // One pixel past the limit, so the display's length must count toward
    // its reach. The near display sits at -1 so the far display's own corner
    // still fits and the per-display check does not reject it first.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "here", "position": [-1, 0], "size": [10, 10] },
      {
        "name": "far",
        "position": [2147479647, 2000],
        "size": [4000, 8000]
      }
    ]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("from here to far"),
        "the layout check should be the one that answers, not the per-display one: {err}"
    );
    Config::parse(
        r#"
{
  "output": {
    "displays": [
      { "name": "here", "size": [1920, 1080] },
      {
        "name": "below",
        "position": [3000, 2147482567],
        "size": [1920, 1080]
      }
    ]
  }
}
"#,
    )
    .expect("a desktop exactly as tall as a position can describe should parse");
}

#[test]
fn the_desktop_must_fit_the_coordinate_space_on_both_axes() {
    // Stacked, to check that the vertical case reads the right fields.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      {
        "name": "north",
        "position": [0, -2000000000],
        "size": [1920, 1080]
      },
      {
        "name": "south",
        "position": [0, 2000000000],
        "size": [1920, 1080]
      }
    ]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "an unrepresentable desktop should fail validation, not parsing: {err:?}"
    );
    let message = format!("{err}");
    assert!(
        message.contains("from north to south") && message.contains("down"),
        "the message should name the outliers near-to-far, and the axis: {err}"
    );
}

#[test]
fn a_display_too_big_on_its_own_is_reported_as_itself() {
    // A single display whose far corner overflows gets a per-display error,
    // not the layout-wide "span N across" one.
    //
    // A billion at scale 1 is a valid mode, so the earlier mode check does
    // not reject it first.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      {
        "name": "huge",
        "position": [2000000000, 0],
        "size": [1000000000, 1080]
      }
    ]
  }
}
"#,
    )
    .unwrap_err();
    let message = format!("{err}");
    assert!(
        message.contains("output.displays[0]") && message.contains("far corner"),
        "the message should name the display and its own far corner: {err}"
    );

    // With two displays, both checks fail, so their order decides the
    // message. The per-display check runs first because it names `far`, the
    // display at fault.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      {
        "name": "west",
        "position": [-2000000000, 0],
        "size": [1920, 1080]
      },
      {
        "name": "far",
        "position": [2147483000, 0],
        "size": [1920, 1080]
      }
    ]
  }
}
"#,
    )
    .unwrap_err();
    let message = format!("{err}");
    assert!(
        message.contains("far corner") && message.contains("far's"),
        "the display at fault should be named, not the pair: {err}"
    );
}

#[test]
fn the_desktop_as_a_whole_must_fit_the_coordinate_space() {
    // Each display fitting is not enough: two can be four billion apart, and
    // the normalized desktop spans that distance.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      {
        "name": "west",
        "position": [-2000000000, 0],
        "size": [1920, 1080]
      },
      {
        "name": "east",
        "position": [2000000000, 0],
        "size": [1920, 1080]
      }
    ]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "an unrepresentable desktop should fail validation, not parsing: {err:?}"
    );
    let message = format!("{err}");
    assert!(
        message.contains("from west to east") && message.contains("across"),
        "the message should name the outliers near-to-far, and the axis: {err}"
    );
}

#[test]
fn a_displays_mode_must_fit_the_coordinate_space() {
    // The `wl_output` mode is size times scale, which can overflow even when
    // each fits. Rejected here because the Smithay backend computes the mode
    // where no test can reach it.
    //
    // Scale is at least 1, so this also bounds the logical size.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [{ "name": "dense", "size": [1920, 1080], "scale": 2000000 }]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        matches!(err, ConfigError::Validation(_)),
        "an unrepresentable mode should fail validation, not parsing: {err:?}"
    );
    let message = format!("{err}");
    assert!(
        message.contains("output.displays[0]") && message.contains("dense"),
        "the message should name the display: {err}"
    );
    // A single display that does not fit gets a per-display error. The
    // layout-wide message compares two displays.
    assert!(
        !message.contains("dense and dense"),
        "one display cannot be a distance from itself: {err}"
    );

    // The boundary: `>` is correct and `>=` would reject a legal desktop.
    // `i32::MAX` is prime, so only scale 1 reaches it exactly.
    Config::parse(
        r#"
{
  "output": { "displays": [{ "name": "exact", "size": [2147483647, 1080] }] }
}
"#,
    )
    .expect("a mode exactly as wide as a coordinate should parse");
    Config::parse(
        r#"
{
  "output": { "displays": [{ "name": "over", "size": [2147483648, 1080] }] }
}
"#,
    )
    .expect_err("one pixel more than a coordinate should not");

    // Each axis alone, with the other well inside the bound, so each check is
    // tested separately.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [{ "name": "wide", "size": [2147483647, 1], "scale": 2 }]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("wide"),
        "the width half is checked with a height that fits: {err}"
    );
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [{ "name": "tall", "size": [1, 2147483647], "scale": 2 }]
  }
}
"#,
    )
    .unwrap_err();
    assert!(
        format!("{err}").contains("tall"),
        "the height half is checked with a width that fits: {err}"
    );

    // The largest inputs the types allow. A check in `i64` would panic on
    // them in debug.
    //
    // Assert on the message: this display's far corner also overflows, so a
    // wrapping mode check would still be rejected by the corner check.
    let err = Config::parse(
        r#"
{
  "output": {
    "displays": [
      {
        "name": "huge",
        "size": [4294967295, 4294967295],
        "scale": 4294967295
      }
    ]
  }
}
"#,
    )
    .unwrap_err();
    let ConfigError::Validation(message) = &err else {
        panic!("the biggest mode the types allow is rejected, not a panic or a wrap: {err:?}");
    };
    assert!(
        message.contains("a mode of"),
        "rejected for its mode rather than for its far corner: {message}"
    );
}

// ---- shell ------------------------------------------------------------------

#[test]
fn a_config_may_name_the_shell_domicile_runs() {
    // `domicile` reads it when given no shell; the compositor ignores it.
    let config = Config::parse(r#"{ "shell": "@domicile-desktop/manganese" }"#).unwrap();
    assert_eq!(config.shell.as_deref(), Some("@domicile-desktop/manganese"));
}

#[test]
fn a_config_holds_its_shell_s_options_as_it_wrote_them() {
    // The shell declares and reads them; the compositor only carries them.
    let config =
        Config::parse(r#"{ "shell_options": { "clock": { "format": "12h" }, "gaps": 4 } }"#)
            .unwrap();
    assert_eq!(
        serde_json::Value::Object(config.shell_options),
        serde_json::json!({ "clock": { "format": "12h" }, "gaps": 4 })
    );
    assert!(Config::default().shell_options.is_empty());
}

#[test]
fn shell_options_that_are_not_an_object_are_refused() {
    let err = Config::parse(r#"{ "shell_options": [4] }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Parse(_)), "{err:?}");
}

#[test]
fn keys_are_a_shell_s_now_and_the_tables_are_refused() {
    // A shell binds its own keys. The `keybindings`, `modes` and `shells`
    // tables are refused.
    for table in [
        r#"{ "keybindings": {} }"#,
        r#"{ "modes": { "resize": {} } }"#,
        r#"{ "shells": { "manganese": {} } }"#,
    ] {
        let err = Config::parse(table).unwrap_err();
        assert!(matches!(err, ConfigError::Parse(_)), "{table}: {err:?}");
    }
}

// ---- schema -----------------------------------------------------------------

#[test]
fn a_config_may_name_its_json_schema() {
    // Editors read `$schema`; the compositor ignores it.
    let config = Config::parse(
        r#"{ "$schema": "https://unpkg.com/@domicile-desktop/sdk/config.schema.json" }"#,
    )
    .unwrap();
    assert_eq!(config.input.keyboard.xkb_layout, "us");
}

#[test]
fn an_extension_s_private_setting_is_refused_as_private_profiles_switch_it() {
    // A private browser profile's `extensions` says what runs in private
    // windows (docs/architecture/BROWSER-PROFILES.md).
    let text = r#"{ "extensions": { "settings": { "ddkjiahejlhfcafbddmgiahcphecmpfh": { "private": true } } } }"#;
    assert!(Config::parse(text).is_err());
}

#[test]
fn spelling_is_checked_in_american_english_unless_configured() {
    let unset = Config::parse("{}").unwrap().spellcheck;
    assert_eq!(
        (unset.enabled, unset.languages),
        (true, vec!["en-US".to_string()])
    );
    let configured =
        Config::parse(r#"{ "spellcheck": { "enabled": false, "languages": ["en-GB", "de-DE"] } }"#)
            .unwrap()
            .spellcheck;
    assert_eq!(
        (configured.enabled, configured.languages),
        (false, vec!["en-GB".to_string(), "de-DE".to_string()])
    );
}

#[test]
fn rejects_checking_spelling_in_no_language() {
    let err = Config::parse(r#"{ "spellcheck": { "languages": [] } }"#).unwrap_err();
    assert!(matches!(err, ConfigError::Validation(_)), "got {err:?}");
}

#[test]
fn rejects_a_spelling_language_that_is_not_a_language_tag() {
    for language in ["", "en US", "../en-US", "en_US"] {
        let err = Config::parse(&format!(
            r#"{{ "spellcheck": {{ "languages": ["{language}"] }} }}"#
        ))
        .unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "{language:?}: got {err:?}"
        );
    }
}
