//! Tests that the config's extensions reach the chrome and follow edits.
//!
//! Unit tests cover the handshake and reload logic. See
//! `docs/architecture/EXTENSIONS.md`.

mod running;

use domicile_protocol::{ExtensionSettings, HostMessage};

use crate::running::Compositor;

const ONE_EXTENSION: &str = r#"
{
  "extensions": {
    "web_store": ["ddkjiahejlhfcafbddmgiahcphecmpfh"],
    "settings": { "ddkjiahejlhfcafbddmgiahcphecmpfh": { "file_access": true } }
  },
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] }
}
"#;

const AN_UNPACKED_EXTENSION: &str = r#"
{
  "extensions": { "unpacked": ["/home/you/src/my-extension"] },
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] }
}
"#;

#[test]
fn the_extensions_the_config_names_reach_the_chrome_and_follow_an_edit() {
    let compositor = Compositor::started_with(ONE_EXTENSION);
    let mut chrome = compositor.chrome();

    chrome
        .wait_for(|message| {
            *message
                == HostMessage::Extensions {
                    web_store: vec!["ddkjiahejlhfcafbddmgiahcphecmpfh".into()],
                    unpacked: vec![],
                    settings: [(
                        "ddkjiahejlhfcafbddmgiahcphecmpfh".into(),
                        ExtensionSettings {
                            file_access: Some(true),
                            ..Default::default()
                        },
                    )]
                    .into(),
                }
        })
        .expect("the extensions and their settings ride with the handshake");

    compositor.reconfigure(AN_UNPACKED_EXTENSION);

    chrome
        .wait_for(|message| {
            *message
                == HostMessage::Extensions {
                    web_store: vec![],
                    unpacked: vec!["/home/you/src/my-extension".into()],
                    settings: Default::default(),
                }
        })
        .expect("a connected chrome is told the list the edit names");
}

#[test]
fn an_unpacked_extension_under_a_tilde_reaches_the_chrome_under_the_home() {
    // The engine does not expand `~`, so the compositor expands it from its
    // own home.
    let home = tempfile::tempdir().expect("a home");
    let compositor = Compositor::started_in_a_home(
        r#"
{
  "extensions": { "unpacked": ["~/src/my-extension"] },
  "output": { "displays": [{ "name": "left", "size": [1920, 1080] }] }
}
"#,
        Some(home.path()),
    );
    let mut chrome = compositor.chrome();

    let expanded = home.path().join("src/my-extension").display().to_string();
    chrome
        .wait_for(|message| {
            *message
                == HostMessage::Extensions {
                    web_store: vec![],
                    unpacked: vec![expanded.clone()],
                    settings: Default::default(),
                }
        })
        .expect("the chrome is told the path the tilde stands for");
}
