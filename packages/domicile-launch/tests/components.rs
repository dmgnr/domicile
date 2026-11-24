//! Tests for locating the compositor, engine, builder and bundled shells.

use std::path::{Path, PathBuf};

use domicile_launch::components::{
    app_module, builder, components, electron_host, engine, our_shell, perfetto, version_file,
    Components,
};

fn nothing(_: &str) -> Option<String> {
    None
}

/// The paths a package installs.
const INSTALLED: &[&str] = &[
    "/usr/bin/domicile",
    "/usr/bin/domicile-compositor",
    "/usr/libexec/domicile/engine",
];

fn installed(path: &Path) -> bool {
    INSTALLED.iter().any(|there| Path::new(there) == path)
}

#[test]
fn the_two_are_found_beside_the_binary() {
    assert_eq!(
        components(Path::new("/usr/bin/domicile"), &nothing, &installed).unwrap(),
        Components {
            compositor: PathBuf::from("/usr/bin/domicile-compositor"),
            engine: PathBuf::from("/usr/libexec/domicile/engine"),
        }
    );
}

#[test]
fn a_store_path_finds_its_own_siblings() {
    // `current_exe` resolves symlinks such as `~/.nix-profile/bin`, so the
    // siblings are found in the same store path.
    let store = |path: &Path| {
        [
            "/nix/store/abc-domicile/bin/domicile-compositor",
            "/nix/store/abc-domicile/libexec/domicile/engine",
        ]
        .iter()
        .any(|there| Path::new(there) == path)
    };
    let found = components(
        Path::new("/nix/store/abc-domicile/bin/domicile"),
        &nothing,
        &store,
    )
    .unwrap();
    assert_eq!(
        found.compositor,
        PathBuf::from("/nix/store/abc-domicile/bin/domicile-compositor")
    );
}

#[test]
fn the_environment_overrides_one_without_the_others() {
    // A checkout can override one component and use the installed rest.
    let env = |name: &str| {
        (name == "DOMICILE_COMPOSITOR").then(|| "/w/target/debug/domicile-compositor".to_string())
    };
    let found = components(Path::new("/usr/bin/domicile"), &env, &installed).unwrap();
    assert_eq!(
        found.compositor,
        PathBuf::from("/w/target/debug/domicile-compositor")
    );
    assert_eq!(found.engine, PathBuf::from("/usr/libexec/domicile/engine"));
}

#[test]
fn an_override_is_taken_without_asking_whether_it_is_there() {
    // Not checked: the component may not be built yet, and starting it
    // reports any failure.
    let env = |name: &str| (name == "DOMICILE_ENGINE").then(|| "/not/built/yet".to_string());
    let found = components(Path::new("/usr/bin/domicile"), &env, &installed).unwrap();
    assert_eq!(found.engine, PathBuf::from("/not/built/yet"));
}

#[test]
fn a_missing_sibling_names_what_is_missing_and_how_to_say_where_it_is() {
    // Remove only one, so the test does not depend on lookup order.
    let no_compositor =
        |path: &Path| installed(path) && Path::new("/usr/bin/domicile-compositor") != path;
    let refused = components(Path::new("/usr/bin/domicile"), &nothing, &no_compositor)
        .expect_err("the compositor is not beside it");

    assert_eq!(refused.what, "compositor");
    assert_eq!(refused.variable, "DOMICILE_COMPOSITOR");
    assert_eq!(
        refused.looked,
        PathBuf::from("/usr/bin/domicile-compositor")
    );
    // The message names the path that was checked.
    assert!(
        refused.to_string().contains("/usr/bin/domicile-compositor"),
        "{refused}"
    );
}

#[test]
fn the_builder_is_beside_the_engine_or_where_the_environment_says() {
    let beside = |path: &Path| path == Path::new("/usr/libexec/domicile/builder");
    assert_eq!(
        builder(Path::new("/usr/bin/domicile"), &nothing, &beside),
        Ok(PathBuf::from("/usr/libexec/domicile/builder"))
    );
    let named = |name: &str| (name == "DOMICILE_BUILDER").then(|| "/src/builder.sh".to_string());
    assert_eq!(
        builder(Path::new("/usr/bin/domicile"), &named, &|_| false),
        Ok(PathBuf::from("/src/builder.sh"))
    );
}

#[test]
fn a_missing_builder_names_where_it_looked() {
    let missing = builder(Path::new("/usr/bin/domicile"), &nothing, &|_| false).unwrap_err();
    assert_eq!(
        missing.looked,
        PathBuf::from("/usr/libexec/domicile/builder")
    );
    assert_eq!(missing.variable, "DOMICILE_BUILDER");
}

#[test]
fn perfetto_is_beside_the_engine_or_where_the_environment_says() {
    let beside = |path: &Path| path == Path::new("/usr/libexec/domicile/perfetto");
    assert_eq!(
        perfetto(Path::new("/usr/bin/domicile"), &nothing, &beside),
        Ok(PathBuf::from("/usr/libexec/domicile/perfetto"))
    );
    let named = |name: &str| (name == "DOMICILE_PERFETTO").then(|| "/opt/perfetto".to_string());
    assert_eq!(
        perfetto(Path::new("/usr/bin/domicile"), &named, &|_| false),
        Ok(PathBuf::from("/opt/perfetto"))
    );
    let missing = perfetto(Path::new("/usr/bin/domicile"), &nothing, &|_| false).unwrap_err();
    assert_eq!(missing.variable, "DOMICILE_PERFETTO");
}

#[test]
fn electron_host_is_beside_the_engine_or_where_the_environment_says() {
    let beside = |path: &Path| path == Path::new("/usr/libexec/domicile/electron-host");
    assert_eq!(
        electron_host(Path::new("/usr/bin/domicile"), &nothing, &beside),
        Ok(PathBuf::from("/usr/libexec/domicile/electron-host"))
    );
    let named = |name: &str| {
        (name == "DOMICILE_ELECTRON_HOST").then(|| "/src/electron-host.sh".to_string())
    };
    assert_eq!(
        electron_host(Path::new("/usr/bin/domicile"), &named, &|_| false),
        Ok(PathBuf::from("/src/electron-host.sh"))
    );
    let missing = electron_host(Path::new("/usr/bin/domicile"), &nothing, &|_| false).unwrap_err();
    assert_eq!(missing.variable, "DOMICILE_ELECTRON_HOST");
}

#[test]
fn domicile_s_own_shell_is_its_prebuilt_directory() {
    let built = |path: &Path| path == Path::new("/usr/libexec/domicile/shells/manganese/shell.js");
    assert_eq!(
        our_shell(
            Path::new("/usr/bin/domicile"),
            "manganese",
            &nothing,
            &built
        ),
        Ok(PathBuf::from("/usr/libexec/domicile/shells/manganese"))
    );
    assert!(our_shell(Path::new("/usr/bin/domicile"), "nickel", &nothing, &built).is_err());
}

#[test]
fn domicile_s_own_app_module_is_beside_the_engine_or_where_the_environment_says() {
    let shipped = |path: &Path| path == Path::new("/usr/libexec/domicile/app-modules/settings");
    assert_eq!(
        app_module(
            Path::new("/usr/bin/domicile"),
            "settings",
            &nothing,
            &shipped
        ),
        Ok(PathBuf::from(
            "/usr/libexec/domicile/app-modules/settings/settings.js"
        ))
    );
    assert_eq!(
        app_module(
            Path::new("/usr/bin/domicile"),
            "settings",
            &|name| (name == "DOMICILE_APP_MODULES").then(|| "/src/modules".to_string()),
            &shipped
        ),
        Ok(PathBuf::from("/src/modules/settings/settings.js"))
    );
}

#[test]
fn a_missing_app_module_names_where_it_looked() {
    let missing = app_module(
        Path::new("/usr/bin/domicile"),
        "settings",
        &nothing,
        &|_| false,
    )
    .unwrap_err();
    assert_eq!(
        missing.looked,
        PathBuf::from("/usr/libexec/domicile/app-modules/settings")
    );
    assert_eq!(missing.variable, "DOMICILE_APP_MODULES");
}

#[test]
fn the_version_file_is_beside_the_engine() {
    assert_eq!(
        version_file(Path::new("/usr/bin/domicile")),
        PathBuf::from("/usr/libexec/domicile/version")
    );
}

#[test]
fn the_engine_is_found_without_a_compositor() {
    let beside = |path: &Path| path == Path::new("/usr/libexec/domicile/engine");
    assert_eq!(
        engine(Path::new("/usr/bin/domicile"), &nothing, &beside),
        Ok(PathBuf::from("/usr/libexec/domicile/engine"))
    );
}
