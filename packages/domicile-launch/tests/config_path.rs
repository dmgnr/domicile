//! Tests for finding the config file when `--config` is not given.

use std::path::{Path, PathBuf};

use domicile_launch::config_path::{config_file, is_module, ConfigFile};

/// A fake environment with `XDG_CONFIG_HOME` and `HOME`.
fn env(xdg: Option<&'static str>, home: Option<&'static str>) -> impl Fn(&str) -> Option<String> {
    move |name| match name {
        "XDG_CONFIG_HOME" => xdg.map(str::to_string),
        "HOME" => home.map(str::to_string),
        _ => None,
    }
}

/// A fake filesystem containing only `entries`.
fn tree(entries: &'static [&'static str]) -> impl Fn(&Path) -> bool {
    move |path| entries.iter().any(|there| Path::new(there) == path)
}

fn nothing(_: &Path) -> bool {
    false
}

const DEFAULT: &str = "/home/somebody/.config/domicile/domicile.json";

/// The config directory, reported when no config is found.
const HOME_DIR: &str = "/home/somebody/.config/domicile";

#[test]
fn the_flag_wins_and_is_not_looked_for() {
    // Passed through unchecked. The compositor reports a missing or invalid
    // file.
    assert_eq!(
        config_file(
            Some(Path::new("/tmp/desk.json")),
            &env(None, Some("/home/somebody")),
            &tree(&[DEFAULT])
        ),
        ConfigFile::Named(PathBuf::from("/tmp/desk.json"))
    );
}

#[test]
fn the_default_is_under_the_config_home() {
    assert_eq!(
        config_file(None, &env(None, Some("/home/somebody")), &tree(&[DEFAULT])),
        ConfigFile::Found(PathBuf::from(DEFAULT))
    );
}

#[test]
fn xdg_config_home_is_preferred_over_the_guess_at_it() {
    assert_eq!(
        config_file(
            None,
            &env(Some("/elsewhere"), Some("/home/somebody")),
            &tree(&["/elsewhere/domicile/domicile.json", DEFAULT])
        ),
        ConfigFile::Found(PathBuf::from("/elsewhere/domicile/domicile.json"))
    );
}

#[test]
fn a_config_home_that_is_not_a_path_is_not_one() {
    // Per the XDG spec, an empty or relative `XDG_CONFIG_HOME` is treated as
    // unset.
    for nonsense in ["", "config", "./config"] {
        assert_eq!(
            config_file(
                None,
                &env(Some(nonsense), Some("/home/somebody")),
                &tree(&[DEFAULT])
            ),
            ConfigFile::Found(PathBuf::from(DEFAULT)),
            "XDG_CONFIG_HOME={nonsense:?}"
        );
    }
}

#[test]
fn no_file_there_is_the_defaults_and_says_where_it_looked() {
    // Not an error: the compositor uses defaults. The directory is kept so
    // the message can say where it looked.
    assert_eq!(
        config_file(None, &env(None, Some("/home/somebody")), &nothing),
        ConfigFile::Absent(PathBuf::from(HOME_DIR))
    );
}

#[test]
fn a_run_with_no_home_at_all_has_nowhere_to_look() {
    // No guessed fallback. Daemons and containers run like this and get the
    // defaults.
    assert_eq!(
        config_file(None, &env(None, None), &tree(&[DEFAULT])),
        ConfigFile::Nowhere
    );
    assert_eq!(
        config_file(None, &env(Some(""), Some("")), &tree(&[DEFAULT])),
        ConfigFile::Nowhere
    );
}

#[test]
fn what_each_answer_is_run_with() {
    // Only a named or found file is passed to the compositor.
    assert_eq!(
        ConfigFile::Named(PathBuf::from("/tmp/desk.json")).path(),
        Some(Path::new("/tmp/desk.json"))
    );
    assert_eq!(
        ConfigFile::Found(PathBuf::from(DEFAULT)).path(),
        Some(Path::new(DEFAULT))
    );
    assert_eq!(ConfigFile::Absent(PathBuf::from(HOME_DIR)).path(), None);
    assert_eq!(ConfigFile::Nowhere.path(), None);
}

#[test]
fn every_answer_says_which_one_it_is() {
    // The binary prints this at startup, so each case says how the file was
    // chosen.
    assert_eq!(
        ConfigFile::Named(PathBuf::from("/tmp/desk.json")).to_string(),
        "/tmp/desk.json, because --config names it"
    );
    assert_eq!(
        ConfigFile::Found(PathBuf::from(DEFAULT)).to_string(),
        DEFAULT
    );
    assert_eq!(
        ConfigFile::Absent(PathBuf::from(HOME_DIR)).to_string(),
        format!(
            "none -- no domicile.{{ts,tsx,js,mjs,json}} in {HOME_DIR} -- so \
             the compositor's defaults"
        )
    );
    assert_eq!(
        ConfigFile::Nowhere.to_string(),
        "none -- neither XDG_CONFIG_HOME nor HOME is set, so there is nowhere \
         to look -- so the compositor's defaults"
    );
}

#[test]
fn a_config_is_a_module_or_json() {
    for name in [
        "domicile.ts",
        "domicile.tsx",
        "domicile.js",
        "domicile.mjs",
        "domicile.json",
    ] {
        let path = format!("{HOME_DIR}/{name}");
        assert_eq!(
            config_file(
                None,
                &env(None, Some("/home/somebody")),
                &|there: &Path| there == Path::new(&path)
            ),
            ConfigFile::Found(PathBuf::from(&path)),
            "{name}"
        );
    }
}

#[test]
fn two_configs_where_one_lives_are_refused_by_name() {
    // Ambiguous, so refused.
    let found = config_file(
        None,
        &env(None, Some("/home/somebody")),
        &tree(&["/home/somebody/.config/domicile/domicile.tsx", DEFAULT]),
    );
    assert_eq!(
        found,
        ConfigFile::Several(vec![
            PathBuf::from("/home/somebody/.config/domicile/domicile.tsx"),
            PathBuf::from(DEFAULT),
        ])
    );
    assert_eq!(found.path(), None);
}

#[test]
fn a_module_config_is_one_to_evaluate() {
    assert!(is_module(Path::new("/x/domicile.tsx")));
    assert!(is_module(Path::new("/x/domicile.js")));
    assert!(!is_module(Path::new("/x/domicile.json")));
}

#[test]
fn a_toml_config_is_not_one() {
    // TOML is not a config format, so the result is the defaults.
    assert_eq!(
        config_file(
            None,
            &env(None, Some("/home/somebody")),
            &tree(&["/home/somebody/.config/domicile/domicile.toml"])
        ),
        ConfigFile::Absent(PathBuf::from(HOME_DIR))
    );
}
