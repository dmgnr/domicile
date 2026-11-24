//! What `domicile open --electron` finds of an installed Electron app.

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt as _};
use std::path::{Path, PathBuf};

use domicile_launch::electron_app::{
    app_icon, app_name, electron_app, journal_name, ElectronApp, ElectronError,
};

/// Writes `text` at `path` under `root`, making its directories.
fn write(root: &Path, path: &str, text: &str) -> PathBuf {
    let at = root.join(path);
    fs::create_dir_all(at.parent().expect("a parent")).unwrap();
    fs::write(&at, text).unwrap();
    at
}

/// Writes an executable script.
fn script(root: &Path, path: &str, text: &str) -> PathBuf {
    let at = write(root, path, text);
    fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
    at
}

fn entry(exec: &str) -> String {
    format!("[Desktop Entry]\nType=Application\nName=App\nExec={exec}\n")
}

/// An install as a bundled Electron app ships: its binary beside
/// `resources/app.asar`.
fn bundled(root: &Path) -> PathBuf {
    write(root, "opt/Slack/resources/app.asar", "asar");
    script(root, "opt/Slack/slack", "\x7fELF")
}

fn canonical(path: PathBuf) -> PathBuf {
    fs::canonicalize(path).unwrap()
}

#[test]
fn an_entry_leads_through_its_program_to_resources() {
    let root = tempfile::tempdir().unwrap();
    let slack = bundled(root.path());
    let apps = root.path().join("applications");
    write(
        &apps,
        "slack.desktop",
        &entry(&format!("{} -s %U", slack.display())),
    );

    assert_eq!(
        electron_app("slack.desktop", &[], root.path(), &[apps], None),
        Ok(ElectronApp {
            resources: canonical(root.path().join("opt/Slack/resources")),
            args: vec!["-s".into()],
            fallback: Some(vec![slack.display().to_string(), "-s".into()]),
        })
    );
}

#[test]
fn an_entry_id_may_leave_out_desktop() {
    let root = tempfile::tempdir().unwrap();
    let slack = bundled(root.path());
    let apps = root.path().join("applications");
    write(&apps, "slack.desktop", &entry(&slack.display().to_string()));

    let found = electron_app("slack", &[], root.path(), &[apps], None).unwrap();

    assert_eq!(
        found.resources,
        canonical(root.path().join("opt/Slack/resources"))
    );
}

#[test]
fn a_bare_program_is_found_on_path() {
    let root = tempfile::tempdir().unwrap();
    bundled(root.path());
    let apps = root.path().join("applications");
    write(&apps, "slack.desktop", &entry("slack %U"));
    let path = root.path().join("opt/Slack");

    let found = electron_app(
        "slack.desktop",
        &[],
        root.path(),
        &[apps],
        Some(path.as_os_str()),
    )
    .unwrap();

    assert_eq!(
        found.resources,
        canonical(root.path().join("opt/Slack/resources"))
    );
    assert_eq!(found.fallback, Some(vec!["slack".to_string()]));
}

#[test]
fn wrapper_scripts_are_followed_to_the_app_they_run() {
    // As nixpkgs wraps Element: Electron, given the app's asar.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "element/share/element/app.asar", "asar");
    script(root.path(), "electron/bin/electron", "\x7fELF");
    let unwrapped = script(
        root.path(),
        "element/bin/.element-desktop-wrapped",
        &format!(
            "#! /bin/bash -e\nexport LD_PRELOAD='/nowhere/libsqlcipher.so'\n\
             exec -a \"$0\" \"{}\" {} \"$@\"\n",
            root.path().join("electron/bin/electron").display(),
            root.path().join("element/share/element/app.asar").display(),
        ),
    );
    let wrapper = script(
        root.path(),
        "element-with-flags/bin/element-desktop",
        &format!(
            "#! /bin/bash -e\nexec \"{}\" --ozone-platform-hint=auto \"$@\"\n",
            unwrapped.display()
        ),
    );
    let apps = root.path().join("applications");
    write(
        &apps,
        "element-desktop.desktop",
        &entry(&format!("{} %u", wrapper.display())),
    );

    let found = electron_app("element-desktop", &[], root.path(), &[apps], None).unwrap();

    assert_eq!(
        found.resources,
        canonical(root.path().join("element/share/element"))
    );
}

#[test]
fn a_symlinked_program_is_followed_to_its_install() {
    let root = tempfile::tempdir().unwrap();
    let slack = bundled(root.path());
    fs::create_dir_all(root.path().join("bin")).unwrap();
    symlink(&slack, root.path().join("bin/slack")).unwrap();

    let found = electron_app("./bin/slack", &[], root.path(), &[], None).unwrap();

    assert_eq!(
        found.resources,
        canonical(root.path().join("opt/Slack/resources"))
    );
    assert_eq!(found.fallback, None);
}

#[test]
fn an_install_directory_or_its_unpacked_app_is_found() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "VSCodium/resources/app/package.json", "{}");

    let found = electron_app("./VSCodium", &[], root.path(), &[], None).unwrap();

    assert_eq!(
        found.resources,
        canonical(root.path().join("VSCodium/resources"))
    );
}

#[test]
fn a_given_command_is_the_fallback_and_its_arguments_the_apps() {
    let root = tempfile::tempdir().unwrap();
    let slack = bundled(root.path());
    let apps = root.path().join("applications");
    write(&apps, "slack.desktop", &entry("slack %U"));
    let command = vec![
        slack.display().to_string(),
        "-u".to_string(),
        "slack://open".to_string(),
    ];

    let found = electron_app("slack.desktop", &command, root.path(), &[apps], None).unwrap();

    assert_eq!(
        found.args,
        vec!["-u".to_string(), "slack://open".to_string()]
    );
    assert_eq!(found.fallback, Some(command));
}

#[test]
fn a_missing_entry_says_so() {
    let root = tempfile::tempdir().unwrap();

    assert_eq!(
        electron_app(
            "slack",
            &[],
            root.path(),
            &[root.path().to_path_buf()],
            None
        ),
        Err(ElectronError::NoEntry {
            id: "slack.desktop".into()
        })
    );
}

#[test]
fn a_program_that_is_no_electron_app_says_so() {
    let root = tempfile::tempdir().unwrap();
    let vim = script(root.path(), "bin/vim", "\x7fELF");
    let apps = root.path().join("applications");
    write(&apps, "vim.desktop", &entry(&vim.display().to_string()));

    assert!(matches!(
        electron_app("vim", &[], root.path(), &[apps], None),
        Err(ElectronError::NotElectron { .. })
    ));
}

#[test]
fn a_script_naming_itself_ends() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("bin/loop");
    script(
        root.path(),
        "bin/loop",
        &format!("#!/bin/sh\nexec {} \"$@\"\n", path.display()),
    );

    assert!(matches!(
        electron_app("./bin/loop", &[], root.path(), &[], None),
        Err(ElectronError::NotElectron { .. })
    ));
}

#[test]
fn the_entry_electron_apps_wrote_gives_the_apps_own_command() {
    let root = tempfile::tempdir().unwrap();
    let slack = bundled(root.path());
    let apps = root.path().join("applications");
    write(
        &apps,
        "slack.desktop",
        &entry(&format!(
            "domicile open --electron slack.desktop -- {} -s %U",
            slack.display()
        )),
    );

    let found = electron_app("slack.desktop", &[], root.path(), &[apps], None).unwrap();

    assert_eq!(
        found.resources,
        canonical(root.path().join("opt/Slack/resources"))
    );
    assert_eq!(
        found.fallback,
        Some(vec![slack.display().to_string(), "-s".into()])
    );
}

/// A compiled wrapper as nixpkgs' `makeBinaryWrapper` writes it: an ELF
/// program whose strings name what it sets and runs, and that keeps the
/// `makeCWrapper` command that made it.
fn binary_wrapper(root: &Path, path: &str, strings: &[&Path]) -> PathBuf {
    let mut bytes = b"\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0\x03\0\x3e\0".to_vec();
    bytes.extend_from_slice(&[0xe8, 0x1f, 0x00, 0x48, 0x89, 0xc7]);
    let (program, rest) = strings.split_first().expect("a program");
    let mut command = format!("makeCWrapper '{}'", program.display());
    for string in rest {
        command.push_str(&format!(
            " \\\n    --set 'CHATGPT_EXECUTABLE' '{}'",
            string.display()
        ));
    }
    bytes.extend_from_slice(
        format!(
            "\n\n\n# ---\n# The C-code for this binary wrapper has been generated \
             using the following command:\n\n\n{command}\n\n\n# (Use `nix-shell -p \
             makeBinaryWrapper` to get access to makeCWrapper in your shell)\n\0"
        )
        .as_bytes(),
    );
    let at = root.join(path);
    fs::create_dir_all(at.parent().expect("a parent")).unwrap();
    fs::write(&at, bytes).unwrap();
    fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
    at
}

#[test]
fn compiled_wrappers_are_followed_to_the_app_they_run() {
    // As nixpkgs wraps ChatGPT and Claude: wrapGAppsHook3 compiles the
    // wrapper, which sets the app's Electron binary in a variable and runs a
    // launcher script that names no path of its own.
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "chatgpt/lib/chatgpt/resources/app.asar",
        "asar",
    );
    let electron = script(root.path(), "chatgpt/lib/chatgpt/ChatGPT", "\x7fELF");
    let launcher = script(
        root.path(),
        "chatgpt/bin/.chatgpt-wrapped",
        "#!/bin/sh\nexec \"$CHATGPT_EXECUTABLE\" \"$@\"\n",
    );
    let wrapper = binary_wrapper(root.path(), "chatgpt/bin/chatgpt", &[&launcher, &electron]);

    let found = electron_app(
        wrapper.to_str().unwrap(),
        &[wrapper.display().to_string()],
        root.path(),
        &[],
        None,
    )
    .unwrap();

    assert_eq!(
        found.resources,
        canonical(root.path().join("chatgpt/lib/chatgpt/resources"))
    );
}

/// An `app.asar` holding `files`, laid out as Electron's asar writes it.
fn asar(root: &Path, path: &str, files: &[(&str, &str)]) {
    let mut entries = serde_json::Map::new();
    let mut body = Vec::new();
    for (name, text) in files {
        entries.insert(
            (*name).to_string(),
            serde_json::json!({ "size": text.len(), "offset": body.len().to_string() }),
        );
        body.extend_from_slice(text.as_bytes());
    }
    let json = serde_json::json!({ "files": entries }).to_string();
    // A pickle holding the JSON string, padded to 4 bytes, inside a pickle
    // holding its size.
    let padded = json.len().div_ceil(4) * 4;
    let mut header = Vec::new();
    header.extend_from_slice(&u32::try_from(padded + 4).unwrap().to_le_bytes());
    header.extend_from_slice(&u32::try_from(json.len()).unwrap().to_le_bytes());
    header.extend_from_slice(json.as_bytes());
    header.resize(padded + 8, 0);
    let mut out = Vec::new();
    out.extend_from_slice(&4u32.to_le_bytes());
    out.extend_from_slice(&u32::try_from(header.len()).unwrap().to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&body);
    let at = root.join(path);
    fs::create_dir_all(at.parent().unwrap()).unwrap();
    fs::write(at, out).unwrap();
}

#[test]
fn an_apps_name_is_its_product_name_from_its_asar() {
    let root = tempfile::tempdir().unwrap();
    asar(
        root.path(),
        "resources/app.asar",
        &[
            ("main.js", "x"),
            (
                "package.json",
                r#"{"name":"element-desktop","productName":"Element"}"#,
            ),
        ],
    );

    assert_eq!(app_name(&root.path().join("resources")).unwrap(), "Element");
}

#[test]
fn an_unpacked_apps_name_is_its_package_name_without_a_product_name() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "resources/app/package.json",
        r#"{"name":"codium"}"#,
    );

    assert_eq!(app_name(&root.path().join("resources")).unwrap(), "codium");
}

#[test]
fn an_app_whose_package_cannot_be_read_says_why() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "resources/app.asar", "asar");

    let why = app_name(&root.path().join("resources")).unwrap_err();

    assert!(why.contains("app.asar"), "{why}");
}

#[test]
fn an_app_from_an_entry_logs_under_the_entrys_id() {
    let root = tempfile::tempdir().unwrap();

    assert_eq!(
        journal_name("element-desktop.desktop", &root.path().join("resources")),
        "element-desktop"
    );
    assert_eq!(
        journal_name("slack", &root.path().join("resources")),
        "slack"
    );
}

#[test]
fn an_app_from_a_path_logs_under_its_name() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "resources/app/package.json",
        r#"{"name":"codium"}"#,
    );

    assert_eq!(
        journal_name("/opt/codium/codium", &root.path().join("resources")),
        "codium"
    );
}

#[test]
fn an_app_from_a_path_without_a_readable_name_logs_under_its_files_name() {
    let root = tempfile::tempdir().unwrap();

    assert_eq!(
        journal_name("/opt/codium/codium", &root.path().join("resources")),
        "codium"
    );
}

#[test]
fn an_entrys_icon_is_its_icon() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "share/applications/element-desktop.desktop",
        "[Desktop Entry]\nType=Application\nName=Element\nIcon=element\nExec=element-desktop\n",
    );

    assert_eq!(
        app_icon(
            "element-desktop.desktop",
            &root.path().join("lib/resources"),
            &[root.path().join("share/applications")],
        ),
        "element"
    );
}

#[test]
fn an_apps_icon_by_path_is_its_packages_icon_file() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "element/share/applications/element-desktop.desktop",
        "[Desktop Entry]\nType=Application\nName=Element\nIcon=element\nExec=element-desktop\n",
    );
    let icon = write(
        root.path(),
        "element/share/icons/hicolor/128x128/apps/element.png",
        "png",
    );
    write(
        root.path(),
        "element/share/icons/hicolor/16x16/apps/element.png",
        "png",
    );
    let program = script(root.path(), "element/bin/element-desktop", "\x7fELF");

    assert_eq!(
        app_icon(
            program.to_str().unwrap(),
            &root.path().join("unwrapped/lib/resources"),
            &[],
        ),
        icon.to_str().unwrap()
    );
}

#[test]
fn an_apps_icon_by_path_is_found_beside_its_resources_too() {
    let root = tempfile::tempdir().unwrap();
    let program = script(root.path(), "wrapper/bin/slack", "#!/bin/sh\n");
    write(
        root.path(),
        "slack/share/applications/slack.desktop",
        "[Desktop Entry]\nType=Application\nName=Slack\nIcon=slack\nExec=slack\n",
    );

    assert_eq!(
        app_icon(
            program.to_str().unwrap(),
            &root.path().join("slack/lib/slack/resources"),
            &[],
        ),
        "slack"
    );
}
