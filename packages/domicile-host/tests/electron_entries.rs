//! The desktop entries that start `electron.apps` on the engine.

use std::fs;
use std::path::Path;

use domicile_host::electron_entries::{on_the_engine, write_electron_entries, Written};

const SLACK: &str = "[Desktop Entry]\n\
Type=Application\n\
Name=Slack\n\
TryExec=/opt/slack/slack\n\
Exec=/opt/slack/slack -s %U\n\
DBusActivatable=true\n\
MimeType=x-scheme-handler/slack;\n\
\n\
[Desktop Action quit]\n\
Name=Quit\n\
Exec=/opt/slack/slack --quit\n";

fn write(dir: &Path, id: &str, text: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(id), text).unwrap();
}

#[test]
fn every_exec_runs_through_domicile_open_electron() {
    assert_eq!(
        on_the_engine(SLACK, "slack.desktop"),
        "[Desktop Entry]\n\
         X-Domicile-Electron=true\n\
         Type=Application\n\
         Name=Slack\n\
         Exec=domicile open --electron slack.desktop -- /opt/slack/slack -s %U\n\
         MimeType=x-scheme-handler/slack;\n\
         \n\
         [Desktop Action quit]\n\
         Name=Quit\n\
         Exec=domicile open --electron slack.desktop -- /opt/slack/slack --quit\n"
    );
}

#[test]
fn listed_apps_are_copied_from_the_first_directory_that_has_them() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first/applications");
    let second = root.path().join("second/applications");
    write(&second, "slack.desktop", "[Desktop Entry]\nExec=old\n");
    write(&first, "slack.desktop", SLACK);
    let out = root.path().join("out");

    let written = write_electron_entries(
        &["slack".to_string(), "element.desktop".to_string()],
        &[first, second],
        None,
        &out,
    )
    .unwrap();

    assert_eq!(
        written,
        Written {
            written: vec!["slack.desktop".into()],
            missing: vec!["element.desktop".into()],
            shadowed: vec![],
        }
    );
    assert_eq!(
        fs::read_to_string(out.join("applications/slack.desktop")).unwrap(),
        on_the_engine(SLACK, "slack.desktop")
    );
}

#[test]
fn copies_of_apps_no_longer_listed_are_removed_and_nothing_else() {
    let root = tempfile::tempdir().unwrap();
    let apps = root.path().join("share/applications");
    write(&apps, "slack.desktop", SLACK);
    let out = root.path().join("out");
    write_electron_entries(
        &["slack.desktop".to_string()],
        std::slice::from_ref(&apps),
        None,
        &out,
    )
    .unwrap();
    write(
        &out.join("applications"),
        "other.desktop",
        "[Desktop Entry]\n",
    );

    write_electron_entries(&[], &[apps], None, &out).unwrap();

    assert!(!out.join("applications/slack.desktop").exists());
    assert!(out.join("applications/other.desktop").exists());
}

#[test]
fn an_app_whose_entry_is_in_the_data_home_is_shadowed() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home/applications");
    write(&home, "slack.desktop", SLACK);
    let out = root.path().join("out");

    let written = write_electron_entries(
        &["slack.desktop".to_string()],
        std::slice::from_ref(&home),
        Some(&home),
        &out,
    )
    .unwrap();

    assert_eq!(
        written.shadowed,
        vec![("slack.desktop".to_string(), home.join("slack.desktop"))]
    );
}
