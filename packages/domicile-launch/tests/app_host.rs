//! Tests for `domicile-app-host`, which Domicile's apps spawn.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use domicile_launch::app_host::{answer, downloads, read_message, watched, write_message, Host};
use domicile_launch::browser_profiles::{
    BrowserProfileList, ListedBrowserProfile, ListedBrowserSite, ProfileExtension,
};
use domicile_launch::control::{Request, Response, SettingsFiles};
use domicile_launch::extensions::{
    ExtensionSettings, InstalledExtension, SiteAccess, SiteAccessMode,
};
use domicile_launch::history::{BrowsingData, HistoryItem, HistoryQuery};
use domicile_launch::media_devices::{MediaDevice, MediaDevices, MediaKind};
use domicile_launch::site_data::SiteData;
use domicile_launch::site_permissions::{Permission, Setting, SitePermission, SiteSettings};
use domicile_protocol::{DisplayHdr, LogLevel, LogLevels, MonitorInfo};
use serde_json::{json, Value};

#[test]
fn a_message_is_its_length_then_its_json() {
    // A 32-bit length in native byte order, then that many bytes of UTF-8
    // JSON.
    let mut sent = Vec::new();
    write_message(&mut sent, &json!({"type": "changed"})).expect("a Vec takes any write");

    let mut expected = 18_u32.to_ne_bytes().to_vec();
    expected.extend_from_slice(b"{\"type\":\"changed\"}");
    assert_eq!(sent, expected);
}

#[test]
fn a_message_reads_back_and_the_end_of_input_is_no_message() {
    let mut framed = Vec::new();
    write_message(&mut framed, &json!({"id": 1, "type": "read"})).expect("a Vec takes any write");
    let mut reader = framed.as_slice();

    assert_eq!(
        read_message(&mut reader).expect("a whole message"),
        Some(json!({"id": 1, "type": "read"}))
    );
    // The app closes stdin when it is done with the host.
    assert_eq!(read_message(&mut reader).expect("a clean end"), None);
}

#[test]
fn reading_gives_each_file_with_whether_it_can_be_written() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 7, "type": "read"})),
        json!({
            "id": 7,
            "type": "files",
            "config": {
                "path": "/home/me/.config/domicile/domicile.json",
                "text": "{\"theme\":{\"mode\":\"dark\"}}",
                "writable": true,
            },
            "evaluated": null,
            "shell": {
                "path": "/nix/store/x-shell.ts",
                "text": "export const Shell = runManganese();",
                "writable": false,
            },
            "options": DECLARED,
        })
    );
}

#[test]
fn a_shell_that_declares_no_options_has_none_to_read() {
    let host = a_host(SettingsFiles {
        options: Some(PathBuf::from("/nix/store/x-plain/options.json")),
        ..FILES.clone()
    });
    assert_eq!(
        host.answer(&json!({"id": 1, "type": "read"}))["options"],
        Value::Null
    );
}

#[test]
fn a_config_with_options_the_shell_declares_is_written() {
    let host = a_host(FILES.clone());
    let text = r#"{"shell_options":{"clock":{"format":"12h"}}}"#;
    assert_eq!(
        host.answer(&json!({"id": 2, "type": "write", "file": "config", "text": text})),
        json!({"id": 2, "type": "written"})
    );
}

#[test]
fn a_config_with_options_the_shell_refuses_is_not_written() {
    // The shell would drop them and run its defaults; say why here instead.
    let host = a_host(FILES.clone());
    let reply = host.answer(&json!({
        "id": 3,
        "type": "write",
        "file": "config",
        "text": r#"{"shell_options":{"clock":{"format":"13h"},"shape":"round"}}"#,
    }));
    assert_eq!(reply["type"], json!("refused"));
    assert_eq!(
        reply["why"],
        json!(
            r#"the shell would drop these options: clock.format: "13h" is not one of 24h, 12h; shape: no such option"#
        )
    );
    assert!(host.written.take().is_empty());
}

#[test]
fn an_option_the_file_already_had_wrong_does_not_stop_another_change() {
    // A shell that drops an option leaves it in the file. Refusing every
    // write for it would leave the form unable to change anything.
    let host = a_host(SettingsFiles {
        config: Some(PathBuf::from(STALE)),
        ..FILES.clone()
    });
    let text = r#"{"shell_options":{"shape":"round"},"theme":{"mode":"light"}}"#;
    assert_eq!(
        host.answer(&json!({"id": 4, "type": "write", "file": "config", "text": text}))["type"],
        json!("written")
    );
}

#[test]
fn a_module_config_comes_with_the_json_it_evaluated_to() {
    // The form shows a module config's values but cannot write them back
    // into code.
    let host = a_host(SettingsFiles {
        config: Some(PathBuf::from("/home/me/.config/domicile/domicile.ts")),
        evaluated: Some(PathBuf::from("/run/d/config.json")),
        shell: None,
        options: None,
    });
    let reply = host.answer(&json!({"id": 1, "type": "read"}));
    assert_eq!(reply["evaluated"], json!("{\"idle\":{}}"));
    assert_eq!(reply["shell"], Value::Null);
}

#[test]
fn a_config_is_written_where_the_desktop_found_it() {
    let host = a_host(FILES.clone());
    let text = "{\"theme\":{\"mode\":\"light\"}}";
    assert_eq!(
        host.answer(&json!({"id": 2, "type": "write", "file": "config", "text": text})),
        json!({"id": 2, "type": "written"})
    );
    assert_eq!(
        host.written.take(),
        vec![(
            PathBuf::from("/home/me/.config/domicile/domicile.json"),
            text.to_string()
        )]
    );
}

#[test]
fn a_json_config_the_compositor_would_refuse_is_not_written() {
    // The compositor keeps the last good config, so a bad one on disk would
    // be silently ignored. Refuse it here, where the app can say why.
    let host = a_host(FILES.clone());
    let reply = host.answer(&json!({"id": 3, "type": "write", "file": "config", "text": "{\"theme\":{\"mode\":\"system\"}}"}));
    assert_eq!(reply["type"], json!("refused"));
    assert!(
        reply["why"].as_str().unwrap().contains("system"),
        "the refusal did not carry the config's error: {reply}"
    );
    assert!(host.written.take().is_empty());
}

#[test]
fn a_file_that_cannot_be_written_is_refused() {
    // Home-manager links the config into the Nix store, which is read-only.
    let host = a_host(FILES.clone());
    let reply = host.answer(&json!({"id": 4, "type": "write", "file": "shell", "text": "x"}));
    assert_eq!(reply["type"], json!("refused"));
    assert!(host.written.take().is_empty());
}

#[test]
fn a_desktop_with_no_shell_file_has_none_to_write() {
    let host = a_host(SettingsFiles::default());
    let reply = host.answer(&json!({"id": 5, "type": "write", "file": "shell", "text": "x"}));
    assert_eq!(reply["type"], json!("refused"));
}

#[test]
fn site_permissions_are_the_desktops() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 6, "type": "site_permissions"})),
        json!({
            "id": 6,
            "type": "site_permissions",
            "defaults": {"camera": "ask"},
            "sites": [{"origin": "https://meet.example", "permission": "camera", "setting": "allow"}],
        })
    );
}

#[test]
fn a_site_permission_is_set_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 8, "type": "set_site_permission", "site": {"origin": "https://meet.example", "permission": "camera", "setting": "block"}})),
        json!({"id": 8, "type": "stored"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::SetSitePermission {
            site: SitePermission {
                origin: "https://meet.example".to_string(),
                permission: Permission::Camera,
                setting: Setting::Block,
            }
        })
    );
}

#[test]
fn media_devices_are_the_desktops() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 9, "type": "media_devices"})),
        json!({
            "id": 9,
            "type": "media_devices",
            "cameras": [{"id": "/dev/video2", "name": "USB Camera"}],
            "microphones": [],
        })
    );
}

#[test]
fn the_monitors_are_the_desktops() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 19, "type": "monitors"})),
        json!({
            "id": 19,
            "type": "monitors",
            "monitors": [{"names": ["drm-1", "DEL DELL U3219Q 2ZLS413"], "hdr": "unsupported"}],
        })
    );
}

#[test]
fn agents_are_listed_stopped_and_forgotten_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 20, "type": "agents"})),
        json!({
            "id": 20,
            "type": "agents",
            "agents": {"connected": [], "remembered": [{"agent": "Codex", "last_used_ms": 9}]},
        })
    );
    assert_eq!(
        host.answer(&json!({"id": 21, "type": "stop_agent", "session": 4})),
        json!({"id": 21, "type": "done"})
    );
    assert_eq!(
        host.answer(&json!({"id": 22, "type": "forget_agent", "agent": "Codex"})),
        json!({"id": 22, "type": "done"})
    );
    assert_eq!(
        host.asked.take()[1..],
        [
            Request::StopAgent { session: 4 },
            Request::ForgetAgent {
                agent: "Codex".to_string()
            }
        ]
    );
}

#[test]
fn try_again_touches_the_retry_file_beside_the_status() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = a_host(FILES.clone());
    host.web_status = Some(dir.path().join("domicile/web-agents.json"));
    assert_eq!(
        host.answer(&json!({"id": 24, "type": "retry_web_agents"})),
        json!({"id": 24, "type": "done"})
    );
    assert!(dir.path().join("domicile/web-agents.retry").exists());
}

#[test]
fn agents_on_the_web_are_read_and_signed_out_from_mcps_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = a_host(FILES.clone());
    host.web_status = Some(dir.path().join("web-agents.json"));
    host.signed_in = Some(dir.path().join("signed-in-agents.json"));
    assert_eq!(
        host.answer(&json!({"id": 23, "type": "web_agents"})),
        json!({"id": 23, "type": "web_agents", "status": null, "signed_in": []})
    );

    std::fs::write(
        dir.path().join("web-agents.json"),
        r#"{"address":"https://desk.relay.example/mcp","ready":true,"problem":null}"#,
    )
    .unwrap();
    std::fs::write(
        dir.path().join("signed-in-agents.json"),
        r#"{"clients":[{"id":"c1","name":"claude.ai","redirect_uris":[]}],"refresh":[{"hash":"h","client":"c1","used_ms":5}]}"#,
    )
    .unwrap();
    assert_eq!(
        host.answer(&json!({"id": 23, "type": "web_agents"})),
        json!({
            "id": 23,
            "type": "web_agents",
            "status": {"address": "https://desk.relay.example/mcp", "ready": true, "problem": null},
            "signed_in": [{"client": "c1", "name": "claude.ai", "last_used_ms": 5}],
        })
    );
    assert_eq!(
        host.answer(&json!({"id": 24, "type": "sign_out_web_agent", "client": "c1"})),
        json!({"id": 24, "type": "done"})
    );
    assert_eq!(
        host.answer(&json!({"id": 25, "type": "web_agents"}))["signed_in"],
        json!([])
    );
}

#[test]
fn a_media_device_is_preferred_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 10, "type": "set_media_device", "kind": "camera", "device": "/dev/video2"})),
        json!({"id": 10, "type": "stored"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::SetMediaDevice {
            kind: MediaKind::Camera,
            id: "/dev/video2".to_string(),
        })
    );
}

#[test]
fn an_unpacked_extension_is_loaded_from_a_folder_under_home() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 11, "type": "load_unpacked", "directory": "~/src/my-extension"})),
        json!({"id": 11, "type": "loaded_unpacked", "extension": ID})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::LoadUnpacked {
            directory: PathBuf::from("/home/me/src/my-extension")
        })
    );
}

#[test]
fn a_folder_that_is_not_absolute_is_not_loaded() {
    let host = a_host(FILES.clone());
    let reply =
        host.answer(&json!({"id": 12, "type": "load_unpacked", "directory": "src/my-extension"}));
    assert_eq!(reply["type"], json!("refused"));
    assert!(host.asked.take().is_empty());
}

#[test]
fn an_extension_is_uninstalled_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 13, "type": "uninstall_extension", "extension": ID})),
        json!({"id": 13, "type": "uninstalled"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::UninstallExtension { id: ID.to_string() })
    );
}

#[test]
fn the_config_s_extensions_are_the_desktop_s() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 14, "type": "config_extensions"})),
        json!({"id": 14, "type": "config_extensions", "ids": [ID]})
    );
}

#[test]
fn every_installed_extension_is_the_desktop_s() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 17, "type": "extensions"})),
        json!({
            "id": 17,
            "type": "extensions",
            "extensions": [{
                "id": ID,
                "name": "Tabs",
                "description": "",
                "version": "1.0",
                "enabled": true,
                "options_url": null,
                "settings": {"file_access": false},
                "icon": "data:image/png;base64,iVBORw==",
            }],
        })
    );
}

#[test]
fn an_extension_is_disabled_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(
            &json!({"id": 18, "type": "set_extension_enabled", "extension": ID, "enabled": false})
        ),
        json!({"id": 18, "type": "stored"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::SetExtensionEnabled {
            id: ID.to_string(),
            enabled: false,
            profile: None,
        })
    );
}

#[test]
fn an_extension_is_switched_in_the_browser_profile_the_app_names() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({
            "id": 31,
            "type": "set_extension_enabled",
            "extension": ID,
            "enabled": true,
            "profile": "work",
        })),
        json!({"id": 31, "type": "stored"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::SetExtensionEnabled {
            id: ID.to_string(),
            enabled: true,
            profile: Some("work".to_string()),
        })
    );
}

#[test]
fn the_desks_browser_profiles_are_the_desktop_s() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 32, "type": "browser_profiles"})),
        json!({
            "id": 32,
            "type": "browser_profiles",
            "default_profile": "personal",
            "default_private_profile": "private",
            "profiles": [{
                "id": "work",
                "name": "Work",
                "color": "#3b82f6",
                "private": false,
                "extensions": [{"id": ID, "enabled": false, "locked": false}],
            }],
            "sites": [{"site": "github.com/acme", "profile": "work", "pinned": false}],
        })
    );
}

#[test]
fn a_site_is_pinned_to_a_browser_profile_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({
            "id": 33,
            "type": "pin_browser_site",
            "site": "github.com/acme",
            "profile": "work",
        })),
        json!({"id": 33, "type": "stored"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::PinBrowserSite {
            site: "github.com/acme".to_string(),
            profile: "work".to_string(),
        })
    );
}

#[test]
fn an_extension_is_configured_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({
            "id": 19,
            "type": "configure_extension",
            "extension": ID,
            "settings": {"file_access": true, "site_access": "on_click"},
        })),
        json!({"id": 19, "type": "stored"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::ConfigureExtension {
            id: ID.to_string(),
            settings: ExtensionSettings {
                file_access: Some(true),
                site_access: Some(SiteAccess::Mode(SiteAccessMode::OnClick)),
                ..ExtensionSettings::default()
            },
        })
    );
}

#[test]
fn an_address_is_opened_in_a_browser_window_on_the_desktop() {
    // How the app opens an extension's options page.
    let host = a_host(FILES.clone());
    let options = format!("chrome-extension://{ID}/options.html");
    assert_eq!(
        host.answer(&json!({"id": 19, "type": "open_url", "url": options})),
        json!({"id": 19, "type": "opened"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::OpenUrl {
            url: options,
            profile: None
        })
    );
}

#[test]
fn history_is_searched_on_the_desktop_and_a_row_without_a_favicon_has_null() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({
            "id": 20,
            "type": "history",
            "text": "a",
            "end_time": 1_700_000_000_123.5,
            "max_results": 10,
        })),
        json!({
            "id": 20,
            "type": "history",
            "items": [{"url": "https://a.example/", "title": "A", "favicon": null}],
        })
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::History(HistoryQuery {
            text: "a".to_string(),
            end_time: 1_700_000_000_123.5,
            max_results: 10,
        }))
    );
}

#[test]
fn a_page_s_visits_are_the_desktop_s() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 21, "type": "visits", "url": "https://a.example/"})),
        json!({"id": 21, "type": "visits", "times": [1_700_000_000_123.5]})
    );
}

#[test]
fn visits_are_deleted_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 22, "type": "delete_history", "visits": [1_700_000_000_123.5]})),
        json!({"id": 22, "type": "deleted"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::DeleteHistory {
            visits: vec![1_700_000_000_123.5]
        })
    );
}

#[test]
fn browsing_data_is_cleared_on_the_desktop_for_the_origins_named() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({
            "id": 23,
            "type": "clear_browsing_data",
            "since": 0,
            "types": ["cookies"],
            "origins": ["https://a.example"],
        })),
        json!({"id": 23, "type": "cleared"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::ClearBrowsingData(BrowsingData {
            since: 0.0,
            types: vec!["cookies".to_string()],
            origins: Some(vec!["https://a.example".to_string()]),
        }))
    );
}

#[test]
fn site_data_is_the_desktop_s() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 24, "type": "site_data"})),
        json!({
            "id": 24,
            "type": "site_data",
            "sites": [{"host": "a.example", "bytes": 2048.0, "cookies": 1}],
        })
    );
    assert_eq!(host.asked.take().last(), Some(&Request::SiteData));
}

#[test]
fn a_host_s_site_data_is_cleared_on_the_desktop() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 25, "type": "clear_site_data", "host": "a.example"})),
        json!({"id": 25, "type": "cleared"})
    );
    assert_eq!(
        host.asked.take().last(),
        Some(&Request::ClearSiteData {
            host: "a.example".to_string(),
        })
    );
}

#[test]
fn a_folder_is_chosen_with_the_desktop_s_picker() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 15, "type": "choose_folder"})),
        json!({"id": 15, "type": "folder", "path": "/home/me/src/my-extension"})
    );
    let canceled = Fake {
        chosen: None,
        ..Fake::new(FILES.clone())
    };
    assert_eq!(
        canceled.answer(&json!({"id": 16, "type": "choose_folder"})),
        json!({"id": 16, "type": "folder", "path": null})
    );
}

#[test]
fn a_desktop_that_refused_is_quoted() {
    let host = Fake {
        refuse: true,
        ..Fake::new(FILES.clone())
    };
    assert_eq!(
        host.answer(&json!({"id": 9, "type": "site_permissions"})),
        json!({"id": 9, "type": "refused", "why": "the engine is not answering"})
    );
}

#[test]
fn a_request_the_host_does_not_know_is_refused_with_its_id() {
    let host = a_host(FILES.clone());
    let reply = host.answer(&json!({"id": 10, "type": "reboot"}));
    assert_eq!(reply["id"], json!(10));
    assert_eq!(reply["type"], json!("refused"));
}

#[test]
fn the_host_watches_the_directory_of_each_file_once() {
    // Editors replace a file by renaming over it, which a watch on the file
    // itself would lose.
    assert_eq!(
        watched(&SettingsFiles {
            config: Some(PathBuf::from("/home/me/.config/domicile/domicile.json")),
            evaluated: None,
            shell: Some(PathBuf::from("/home/me/.config/domicile/shell.ts")),
            options: None,
        }),
        vec![PathBuf::from("/home/me/.config/domicile")]
    );
}

/// An extension id.
const ID: &str = "abcdefghijklmnopabcdefghijklmnop";
const ICON: &str = "/home/me/.config/domicile/Extensions/tabs/icon128.png";

static FILES: std::sync::LazyLock<SettingsFiles> = std::sync::LazyLock::new(|| SettingsFiles {
    config: Some(PathBuf::from("/home/me/.config/domicile/domicile.json")),
    evaluated: None,
    shell: Some(PathBuf::from("/nix/store/x-shell.ts")),
    options: Some(PathBuf::from("/nix/store/x-manganese/options.json")),
});

/// What `FILES`' shell declares.
const DECLARED: &str = r#"{"clock":{"kind":"group","options":{"format":{"kind":"choice","label":"Clock format","choices":["24h","12h"],"default":"24h"}}}}"#;

/// A writable config holding an option `DECLARED` does not have.
const STALE: &str = "/home/me/stale/domicile.json";

/// A desktop and a file system in memory.
struct Fake {
    files: SettingsFiles,
    /// What the folder picker returns.
    chosen: Option<PathBuf>,
    refuse: bool,
    asked: RefCell<Vec<Request>>,
    written: RefCell<Vec<(PathBuf, String)>>,
    web_status: Option<PathBuf>,
    signed_in: Option<PathBuf>,
    downloads: Option<PathBuf>,
    opened: RefCell<Vec<PathBuf>>,
}

fn a_host(files: SettingsFiles) -> Fake {
    Fake::new(files)
}

impl Fake {
    fn new(files: SettingsFiles) -> Self {
        Self {
            files,
            chosen: Some(PathBuf::from("/home/me/src/my-extension")),
            refuse: false,
            asked: RefCell::new(Vec::new()),
            written: RefCell::new(Vec::new()),
            web_status: None,
            signed_in: None,
            downloads: None,
            opened: RefCell::new(Vec::new()),
        }
    }

    /// Answers `message` with this fake as the host.
    fn answer(&self, message: &Value) -> Value {
        answer(
            message,
            &Host {
                ask: &|request| {
                    self.asked.borrow_mut().push(request.clone());
                    if self.refuse {
                        return Ok(Response::Refused {
                            why: "the engine is not answering".to_string(),
                        });
                    }
                    Ok(match request {
                        Request::SettingsFiles => Response::SettingsFiles {
                            files: self.files.clone(),
                        },
                        Request::SitePermissions => Response::SitePermissions(SiteSettings {
                            defaults: BTreeMap::from([(Permission::Camera, Setting::Ask)]),
                            sites: vec![SitePermission {
                                origin: "https://meet.example".to_string(),
                                permission: Permission::Camera,
                                setting: Setting::Allow,
                            }],
                        }),
                        Request::SetSitePermission { .. } => Response::Stored,
                        Request::LogLevels | Request::ResetLogLevels => Response::LogLevels {
                            levels: LogLevels::default(),
                        },
                        Request::SetLogLevel { level, .. } => Response::LogLevels {
                            levels: LogLevels {
                                all: Some(*level),
                                ..LogLevels::default()
                            },
                        },
                        Request::ExportLogs { file, .. } => Response::ExportedLogs {
                            file: file.clone(),
                            unhidden: None,
                        },
                        Request::MediaDevices => Response::MediaDevices(MediaDevices {
                            cameras: vec![MediaDevice {
                                id: "/dev/video2".to_string(),
                                name: "USB Camera".to_string(),
                            }],
                            microphones: vec![],
                        }),
                        Request::SetMediaDevice { .. } => Response::Stored,
                        Request::LoadUnpacked { .. } => {
                            Response::LoadedUnpacked { id: ID.to_string() }
                        }
                        Request::UninstallExtension { .. } => Response::Uninstalled,
                        Request::ConfigExtensions => Response::ConfigExtensions {
                            ids: vec![ID.to_string()],
                        },
                        Request::Extensions => Response::Extensions {
                            extensions: vec![InstalledExtension {
                                id: ID.to_string(),
                                name: "Tabs".to_string(),
                                description: String::new(),
                                version: "1.0".to_string(),
                                enabled: true,
                                options_url: None,
                                settings: ExtensionSettings {
                                    file_access: Some(false),
                                    ..ExtensionSettings::default()
                                },
                                icon_path: Some(ICON.to_string()),
                            }],
                        },
                        Request::SetExtensionEnabled { .. } => Response::Stored,
                        Request::BrowserProfiles => Response::BrowserProfiles(BrowserProfileList {
                            default_profile: "personal".to_string(),
                            default_private_profile: "private".to_string(),
                            profiles: vec![ListedBrowserProfile {
                                id: "work".to_string(),
                                name: "Work".to_string(),
                                color: "#3b82f6".to_string(),
                                private: false,
                                extensions: vec![ProfileExtension {
                                    id: ID.to_string(),
                                    enabled: false,
                                    locked: false,
                                }],
                            }],
                            sites: vec![ListedBrowserSite {
                                site: "github.com/acme".to_string(),
                                profile: "work".to_string(),
                                pinned: false,
                            }],
                        }),
                        Request::PinBrowserSite { .. } => Response::Stored,
                        Request::ConfigureExtension { .. } => Response::Stored,
                        Request::OpenUrl { .. } => Response::Opened,
                        Request::History(_) => Response::History {
                            items: vec![HistoryItem {
                                url: "https://a.example/".to_string(),
                                title: "A".to_string(),
                                favicon: None,
                            }],
                        },
                        Request::Visits { .. } => Response::Visits {
                            times: vec![1_700_000_000_123.5],
                        },
                        Request::DeleteHistory { .. } => Response::Deleted,
                        Request::ClearBrowsingData(_) => Response::Cleared,
                        Request::SiteData => Response::SiteData {
                            sites: vec![SiteData {
                                host: "a.example".to_string(),
                                bytes: 2048.0,
                                cookies: 1,
                            }],
                        },
                        Request::ClearSiteData { .. } => Response::Cleared,
                        Request::Monitors => Response::Monitors {
                            monitors: vec![MonitorInfo {
                                names: vec![
                                    "drm-1".to_string(),
                                    "DEL DELL U3219Q 2ZLS413".to_string(),
                                ],
                                hdr: DisplayHdr::Unsupported,
                            }],
                        },
                        Request::Agents => Response::Agents {
                            agents: domicile_protocol::KnownAgents {
                                connected: vec![],
                                remembered: vec![domicile_protocol::RememberedAgent {
                                    agent: "Codex".to_string(),
                                    last_used_ms: 9,
                                }],
                            },
                        },
                        Request::StopAgent { .. } | Request::ForgetAgent { .. } => Response::Done,
                        other => panic!("the host never asks {other:?}"),
                    })
                },
                read: &|path| match path.to_str() {
                    Some("/home/me/.config/domicile/domicile.json") => {
                        Ok("{\"theme\":{\"mode\":\"dark\"}}".to_string())
                    }
                    Some("/home/me/.config/domicile/domicile.ts") => {
                        Ok("export const idle = {};".to_string())
                    }
                    Some("/run/d/config.json") => Ok("{\"idle\":{}}".to_string()),
                    Some("/nix/store/x-manganese/options.json") => Ok(DECLARED.to_string()),
                    Some(STALE) => Ok(r#"{"shell_options":{"shape":"round"}}"#.to_string()),
                    Some("/nix/store/x-shell.ts") => {
                        Ok("export const Shell = runManganese();".to_string())
                    }
                    _ => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
                },
                read_bytes: &|path| match path.to_str() {
                    Some(ICON) => Ok(vec![0x89, b'P', b'N', b'G']),
                    _ => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
                },
                home: Some(Path::new("/home/me")),
                choose_folder: &|| Ok(self.chosen.clone()),
                writable: &|path: &Path| !path.starts_with("/nix/store"),
                write: &|path, text| {
                    self.written
                        .borrow_mut()
                        .push((path.to_path_buf(), text.to_string()));
                    Ok(())
                },
                web_status: self.web_status.as_deref(),
                signed_in: self.signed_in.as_deref(),
                downloads: self.downloads.as_deref(),
                open: &|folder| {
                    self.opened.borrow_mut().push(folder.to_path_buf());
                    Ok(())
                },
            },
        )
    }
}

#[test]
fn detailed_logging_is_everything_at_debug_until_turned_off() {
    let host = a_host(FILES.clone());
    assert_eq!(
        host.answer(&json!({"id": 25, "type": "detailed_logging"})),
        json!({"id": 25, "type": "detailed_logging", "on": false})
    );
    assert_eq!(
        host.answer(&json!({"id": 26, "type": "set_detailed_logging", "on": true})),
        json!({"id": 26, "type": "detailed_logging", "on": true})
    );
    assert_eq!(
        host.answer(&json!({"id": 27, "type": "set_detailed_logging", "on": false})),
        json!({"id": 27, "type": "detailed_logging", "on": false})
    );
    assert_eq!(
        host.asked.take(),
        [
            Request::LogLevels,
            Request::SetLogLevel {
                level: LogLevel::Debug,
                subsystems: Vec::new()
            },
            Request::ResetLogLevels,
        ]
    );
}

#[test]
fn save_logs_exports_them_to_downloads() {
    let dir = tempfile::tempdir().unwrap();
    let downloads = dir.path().join("Downloads");
    let mut host = a_host(FILES.clone());
    host.downloads = Some(downloads.clone());
    let reply = host.answer(&json!({"id": 28, "type": "export_logs", "redact": true}));
    assert_eq!(reply["type"], "exported_logs", "{reply}");
    assert!(downloads.is_dir(), "Downloads is made if missing");
    let [Request::ExportLogs { file, redact: true }] = &host.asked.take()[..] else {
        panic!("the export is the desktop's");
    };
    assert_eq!(file.parent(), Some(downloads.as_path()));
    let name = file.file_name().unwrap().to_str().unwrap();
    assert!(
        name.starts_with("domicile-logs-") && name.ends_with(".txt"),
        "{name}"
    );
    assert_eq!(reply["path"], json!(file));
    assert_eq!(
        host.answer(&json!({"id": 29, "type": "open_downloads"})),
        json!({"id": 29, "type": "opened"})
    );
    assert_eq!(host.opened.take(), [downloads]);
}

#[test]
fn the_downloads_folder_is_the_one_xdg_names() {
    let home = Path::new("/home/me");
    let none = |_: &str| None;
    assert_eq!(
        downloads(&none, None, Some(home)),
        Some(PathBuf::from("/home/me/Downloads"))
    );
    assert_eq!(
        downloads(
            &none,
            Some("# comment\nXDG_DOWNLOAD_DIR=\"$HOME/Hämtningar\"\n"),
            Some(home)
        ),
        Some(PathBuf::from("/home/me/Hämtningar"))
    );
    let set = |name: &str| (name == "XDG_DOWNLOAD_DIR").then(|| "/data/dl".to_string());
    assert_eq!(
        downloads(&set, None, Some(home)),
        Some(PathBuf::from("/data/dl"))
    );
    assert_eq!(downloads(&none, None, None), None);
}
