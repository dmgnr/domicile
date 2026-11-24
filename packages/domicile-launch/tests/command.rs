//! Tests for the engine command socket protocol.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use domicile_launch::command::{
    browser_profiles_line, clear_browsing_data_line, clear_site_data_line, config_extensions_line,
    configure_extension_line, delete_history_line, devtools_line, disable_while_typing_line,
    extensions_line, history_line, load_shell_line, load_unpacked_line, media_devices_line,
    open_app_line, open_url_line, pin_browser_site_line, reply, run_app_line,
    set_extension_enabled_line, set_log_levels_line, set_media_device_line,
    set_site_permission_line, site_data_line, site_permissions_line, uninstall_extension_line,
    visits_line, Reply,
};
use domicile_launch::control::AppReuse;
use domicile_launch::extensions::{
    ExtensionSettings, InstalledExtension, SiteAccess, SiteAccessMode,
};
use domicile_launch::history::{BrowsingData, HistoryItem, HistoryQuery};
use domicile_launch::media_devices::{MediaDevice, MediaDevices, MediaKind};
use domicile_launch::shell_path::{Shell, ShellFiles};
use domicile_launch::site_data::SiteData;
use domicile_launch::site_permissions::{Permission, Setting, SitePermission, SiteSettings};

#[test]
fn a_load_shell_names_the_version_it_is_written_in() {
    // Each request carries the version, since there is no handshake. The
    // expected line is written out because the engine's `command_protocol.cc`
    // does not share this crate's serializer.
    assert_eq!(
        load_shell_line(&Shell {
            files: ShellFiles::Directory,
            module: PathBuf::from("shell.js"),
            root: PathBuf::from("/x/dist"),
        }),
        "{\"type\":\"load_shell\",\"version\":1,\"root\":\"/x/dist\",\"module\":\"shell.js\"}\n"
    );
}

#[test]
fn a_load_shell_from_a_dev_server_says_so() {
    // The engine reads `root` as the dev server's socket only when told.
    assert_eq!(
        load_shell_line(&Shell {
            files: ShellFiles::DevServer,
            module: PathBuf::from("domicile-dev-shell.js"),
            root: PathBuf::from("/run/dev.sock"),
        }),
        "{\"type\":\"load_shell\",\"version\":1,\"root\":\"/run/dev.sock\",\
         \"module\":\"domicile-dev-shell.js\",\"dev_server\":true}\n"
    );
}

#[test]
fn a_run_app_names_the_apps_root_and_module() {
    assert_eq!(
        run_app_line(Path::new("/opt/notes"), Path::new("notes.js")),
        "{\"type\":\"run_app\",\"version\":1,\"root\":\"/opt/notes\",\"module\":\"notes.js\"}\n"
    );
}

#[test]
fn an_open_url_names_the_version_it_is_written_in() {
    assert_eq!(
        open_url_line("https://example.com/?q=\"x\"", None),
        "{\"type\":\"open_url\",\"version\":1,\"url\":\"https://example.com/?q=\\\"x\\\"\"}\n"
    );
}

#[test]
fn an_open_url_names_its_browser_profile_when_it_has_one() {
    assert_eq!(
        open_url_line("https://example.com/", Some("work")),
        "{\"type\":\"open_url\",\"version\":1,\"url\":\"https://example.com/\",\"profile\":\"work\"}\n"
    );
}

#[test]
fn an_open_app_is_an_open_url_that_asks_for_an_app_window() {
    // A key rather than a new type, so an engine older than it opens a browser
    // window instead of refusing.
    assert_eq!(
        open_app_line("https://example.com/", None, AppReuse::New, None),
        "{\"type\":\"open_url\",\"version\":1,\"url\":\"https://example.com/\",\"app\":true}\n"
    );
}

#[test]
fn an_open_app_with_an_id_names_it_and_how_to_reuse_its_window() {
    assert_eq!(
        open_app_line("https://example.com/", Some("mail"), AppReuse::Focus, None),
        "{\"type\":\"open_url\",\"version\":1,\"url\":\"https://example.com/\",\"app\":true,\
         \"app_id\":\"mail\",\"reuse\":\"focus\"}\n"
    );
    // "new" is the engine's default, so the line leaves it out.
    assert_eq!(
        open_app_line("https://example.com/", Some("mail"), AppReuse::New, None),
        "{\"type\":\"open_url\",\"version\":1,\"url\":\"https://example.com/\",\"app\":true,\
         \"app_id\":\"mail\"}\n"
    );
}

#[test]
fn an_engine_that_opened_the_address_says_so() {
    assert_eq!(reply("{\"type\":\"opened\"}").unwrap(), Reply::Opened);
}

#[test]
fn an_engine_that_served_the_shell_says_so() {
    assert_eq!(reply("{\"type\":\"loaded\"}").unwrap(), Reply::Loaded);
}

#[test]
fn an_engine_that_refused_says_why() {
    // Keep the engine's reason verbatim; each cause needs a different fix.
    assert_eq!(
        reply("{\"type\":\"refused\",\"why\":\"this engine speaks version 1\"}").unwrap(),
        Reply::Refused {
            why: "this engine speaks version 1".to_string()
        }
    );
}

#[test]
fn an_answer_that_is_not_one_is_not_read_as_a_refusal() {
    // An unknown reply, such as from an older engine, is an error, not a
    // refusal.
    assert!(reply("{\"type\":\"loading\"}").is_err());
}

#[test]
fn a_question_about_site_permissions_names_the_version_it_is_written_in() {
    assert_eq!(
        site_permissions_line(),
        "{\"type\":\"site_permissions\",\"version\":1}\n"
    );
}

#[test]
fn a_site_permission_is_set_by_origin_permission_and_setting() {
    assert_eq!(
        set_site_permission_line(&SitePermission {
            origin: "https://meet.example".to_string(),
            permission: Permission::Camera,
            setting: Setting::Block,
        }),
        "{\"type\":\"set_site_permission\",\"version\":1,\"origin\":\"https://meet.example\",\"permission\":\"camera\",\"setting\":\"block\"}\n"
    );
}

#[test]
fn an_engine_lists_each_site_s_stored_permissions() {
    assert_eq!(
        reply(
            "{\"type\":\"site_permissions\",\"defaults\":{\"camera\":\"ask\",\"notifications\":\"allow\"},\"sites\":[\
             {\"origin\":\"https://meet.example\",\"permission\":\"microphone\",\"setting\":\"allow\"},\
             {\"origin\":\"https://maps.example\",\"permission\":\"location\",\"setting\":\"block\"}]}"
        )
        .unwrap(),
        Reply::SitePermissions(SiteSettings {
            defaults: BTreeMap::from([
                (Permission::Camera, Setting::Ask),
                (Permission::Notifications, Setting::Allow),
            ]),
            sites: vec![
                SitePermission {
                    origin: "https://meet.example".to_string(),
                    permission: Permission::Microphone,
                    setting: Setting::Allow,
                },
                SitePermission {
                    origin: "https://maps.example".to_string(),
                    permission: Permission::Location,
                    setting: Setting::Block,
                },
            ]
        })
    );
}

#[test]
fn an_engine_that_stored_a_setting_says_so() {
    assert_eq!(reply("{\"type\":\"set\"}").unwrap(), Reply::Set);
}

#[test]
fn an_unpacked_extension_is_loaded_from_its_directory() {
    assert_eq!(
        load_unpacked_line(Path::new("/home/me/src/my-extension")),
        "{\"type\":\"load_unpacked\",\"version\":1,\"directory\":\"/home/me/src/my-extension\"}\n"
    );
    assert_eq!(
        reply("{\"type\":\"loaded_unpacked\",\"id\":\"abcdefghijklmnopabcdefghijklmnop\"}")
            .unwrap(),
        Reply::LoadedUnpacked {
            id: "abcdefghijklmnopabcdefghijklmnop".to_string()
        }
    );
}

#[test]
fn an_extension_is_uninstalled_by_id() {
    assert_eq!(
        uninstall_extension_line("abcdefghijklmnopabcdefghijklmnop"),
        "{\"type\":\"uninstall_extension\",\"version\":1,\"id\":\"abcdefghijklmnopabcdefghijklmnop\"}\n"
    );
    assert_eq!(
        reply("{\"type\":\"uninstalled\"}").unwrap(),
        Reply::Uninstalled
    );
}

#[test]
fn an_engine_lists_the_extensions_the_config_installed() {
    assert_eq!(
        config_extensions_line(),
        "{\"type\":\"config_extensions\",\"version\":1}\n"
    );
    assert_eq!(
        reply("{\"type\":\"config_extensions\",\"ids\":[\"abcdefghijklmnopabcdefghijklmnop\"]}")
            .unwrap(),
        Reply::ConfigExtensions {
            ids: vec!["abcdefghijklmnopabcdefghijklmnop".to_string()]
        }
    );
}

#[test]
fn an_engine_lists_every_installed_extension_and_its_options_page() {
    assert_eq!(
        extensions_line(),
        "{\"type\":\"extensions\",\"version\":1}\n"
    );
    // An extension without an options page has no `options_url`, and one without
    // an icon no `icon_path`.
    assert_eq!(
        reply(
            "{\"type\":\"extensions\",\"extensions\":[\
             {\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"name\":\"Dark Reader\",\"description\":\"Dark mode\",\"version\":\"4.9\",\"enabled\":true,\"options_url\":\"chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html\",\"settings\":{\"file_access\":true,\"site_access\":[\"github.com\"]},\"icon_path\":\"/ext/dark/128.png\"},\
             {\"id\":\"bcdefghijklmnopabcdefghijklmnopa\",\"name\":\"Tabs\",\"description\":\"\",\"version\":\"1.0\",\"enabled\":false,\"settings\":{}}]}"
        )
        .unwrap(),
        Reply::Extensions {
            extensions: vec![
                InstalledExtension {
                    id: "abcdefghijklmnopabcdefghijklmnop".to_string(),
                    name: "Dark Reader".to_string(),
                    description: "Dark mode".to_string(),
                    version: "4.9".to_string(),
                    enabled: true,
                    options_url: Some(
                        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html"
                            .to_string()
                    ),
                    settings: ExtensionSettings {
                        file_access: Some(true),
                        site_access: Some(SiteAccess::Sites(vec!["github.com".to_string()])),
                        ..ExtensionSettings::default()
                    },
                    icon_path: Some("/ext/dark/128.png".to_string()),
                },
                InstalledExtension {
                    id: "bcdefghijklmnopabcdefghijklmnopa".to_string(),
                    name: "Tabs".to_string(),
                    description: String::new(),
                    version: "1.0".to_string(),
                    enabled: false,
                    options_url: None,
                    settings: ExtensionSettings::default(),
                    icon_path: None,
                },
            ]
        }
    );
}

#[test]
fn an_extension_s_settings_are_changed_by_id_naming_only_those_that_change() {
    assert_eq!(
        configure_extension_line(
            "abcdefghijklmnopabcdefghijklmnop",
            &ExtensionSettings {
                file_access: Some(true),
                site_access: Some(SiteAccess::Mode(SiteAccessMode::OnClick)),
                ..ExtensionSettings::default()
            }
        ),
        "{\"type\":\"configure_extension\",\"version\":1,\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"settings\":{\"file_access\":true,\"site_access\":\"on_click\"}}\n"
    );
}

#[test]
fn an_extension_is_enabled_or_disabled_by_id() {
    assert_eq!(
        set_extension_enabled_line("abcdefghijklmnopabcdefghijklmnop", false, None),
        "{\"type\":\"set_extension_enabled\",\"version\":1,\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"enabled\":false}\n"
    );
}

#[test]
fn an_extension_is_switched_in_the_browser_profile_the_line_names() {
    assert_eq!(
        set_extension_enabled_line("abcdefghijklmnopabcdefghijklmnop", true, Some("work")),
        "{\"type\":\"set_extension_enabled\",\"version\":1,\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"enabled\":true,\"profile\":\"work\"}\n"
    );
}

#[test]
fn a_question_about_browser_profiles_names_the_version_it_is_written_in() {
    assert_eq!(
        browser_profiles_line(),
        "{\"type\":\"browser_profiles\",\"version\":1}\n"
    );
}

#[test]
fn a_site_is_pinned_to_the_browser_profile_the_line_names() {
    assert_eq!(
        pin_browser_site_line("github.com/acme", "work"),
        "{\"type\":\"pin_browser_site\",\"version\":1,\"site\":\"github.com/acme\",\"profile\":\"work\"}\n"
    );
}

#[test]
fn a_question_about_media_devices_names_the_version_it_is_written_in() {
    assert_eq!(
        media_devices_line(),
        "{\"type\":\"media_devices\",\"version\":1}\n"
    );
}

#[test]
fn a_media_device_is_preferred_by_kind_and_id() {
    assert_eq!(
        set_media_device_line(MediaKind::Camera, "/dev/video2"),
        "{\"type\":\"set_media_device\",\"version\":1,\"kind\":\"camera\",\"id\":\"/dev/video2\"}\n"
    );
}

#[test]
fn an_engine_lists_each_kind_s_devices_most_preferred_first() {
    assert_eq!(
        reply(
            "{\"type\":\"media_devices\",\"cameras\":[{\"id\":\"/dev/video2\",\"name\":\"USB Camera\"}],\"microphones\":[]}"
        )
        .unwrap(),
        Reply::MediaDevices(MediaDevices {
            cameras: vec![MediaDevice {
                id: "/dev/video2".to_string(),
                name: "USB Camera".to_string(),
            }],
            microphones: vec![],
        })
    );
}

#[test]
fn history_is_searched_by_text_before_a_time_and_each_row_may_carry_a_favicon() {
    // Times are fractional milliseconds, as `chrome.history` gives them.
    assert_eq!(
        history_line(&HistoryQuery {
            text: "news".to_string(),
            end_time: 1_700_000_000_123.5,
            max_results: 100,
        }),
        "{\"type\":\"history\",\"version\":1,\"text\":\"news\",\"end_time\":1700000000123.5,\"max_results\":100}\n"
    );
    // A row without a favicon has no `favicon`.
    assert_eq!(
        reply(
            "{\"type\":\"history\",\"items\":[\
             {\"url\":\"https://a.example/\",\"title\":\"A\",\"favicon\":\"data:image/png;base64,AAAA\"},\
             {\"url\":\"https://b.example/\",\"title\":\"\"}]}"
        )
        .unwrap(),
        Reply::History {
            items: vec![
                HistoryItem {
                    url: "https://a.example/".to_string(),
                    title: "A".to_string(),
                    favicon: Some("data:image/png;base64,AAAA".to_string()),
                },
                HistoryItem {
                    url: "https://b.example/".to_string(),
                    title: String::new(),
                    favicon: None,
                },
            ]
        }
    );
}

#[test]
fn a_page_s_visits_are_the_times_it_was_visited() {
    assert_eq!(
        visits_line("https://a.example/"),
        "{\"type\":\"visits\",\"version\":1,\"url\":\"https://a.example/\"}\n"
    );
    assert_eq!(
        reply("{\"type\":\"visits\",\"times\":[1700000000123.5,1700000000456.25]}").unwrap(),
        Reply::Visits {
            times: vec![1_700_000_000_123.5, 1_700_000_000_456.25]
        }
    );
}

#[test]
fn visits_are_deleted_by_their_times() {
    assert_eq!(
        delete_history_line(&[1_700_000_000_123.5]),
        "{\"type\":\"delete_history\",\"version\":1,\"visits\":[1700000000123.5]}\n"
    );
    assert_eq!(reply("{\"type\":\"deleted\"}").unwrap(), Reply::Deleted);
}

#[test]
fn browsing_data_is_cleared_since_a_time_and_for_every_origin_unless_some_are_named() {
    let since = BrowsingData {
        since: 1_700_000_000_123.5,
        types: vec!["cookies".to_string(), "cache".to_string()],
        origins: None,
    };
    assert_eq!(
        clear_browsing_data_line(&since),
        "{\"type\":\"clear_browsing_data\",\"version\":1,\"since\":1700000000123.5,\"types\":[\"cookies\",\"cache\"]}\n"
    );
    assert_eq!(
        clear_browsing_data_line(&BrowsingData {
            origins: Some(vec!["https://a.example".to_string()]),
            ..since
        }),
        "{\"type\":\"clear_browsing_data\",\"version\":1,\"since\":1700000000123.5,\"types\":[\"cookies\",\"cache\"],\"origins\":[\"https://a.example\"]}\n"
    );
    assert_eq!(reply("{\"type\":\"cleared\"}").unwrap(), Reply::Cleared);
}

#[test]
fn disable_while_typing_is_asked_or_set() {
    assert_eq!(
        disable_while_typing_line(None),
        "{\"type\":\"disable_while_typing\",\"version\":1}\n"
    );
    assert_eq!(
        disable_while_typing_line(Some(false)),
        "{\"type\":\"disable_while_typing\",\"version\":1,\"enabled\":false}\n"
    );
    assert_eq!(
        reply("{\"type\":\"disable_while_typing\",\"enabled\":true}").unwrap(),
        Reply::DisableWhileTyping { enabled: true }
    );
}

#[test]
fn log_levels_are_a_minimum_severity_and_vmodule_patterns() {
    assert_eq!(
        set_log_levels_line(0, "*/domicile/*=1"),
        "{\"type\":\"set_log_levels\",\"version\":1,\"min_level\":0,\"vmodule\":\"*/domicile/*=1\"}\n"
    );
}

#[test]
fn site_data_is_listed_by_host() {
    assert_eq!(site_data_line(), "{\"type\":\"site_data\",\"version\":1}\n");
    // The engine writes `bytes` as a double, which can pass what an int holds.
    assert_eq!(
        reply("{\"type\":\"site_data\",\"sites\":[{\"host\":\"mail.example\",\"bytes\":5000000000.0,\"cookies\":3}]}")
            .unwrap(),
        Reply::SiteData {
            sites: vec![SiteData {
                host: "mail.example".to_string(),
                bytes: 5_000_000_000.0,
                cookies: 3,
            }],
        }
    );
}

#[test]
fn a_host_s_site_data_is_cleared() {
    assert_eq!(
        clear_site_data_line("mail.example"),
        "{\"type\":\"clear_site_data\",\"version\":1,\"host\":\"mail.example\"}\n"
    );
}

#[test]
fn an_open_app_names_its_browser_profile_when_it_has_one() {
    assert_eq!(
        open_app_line("https://example.com/", Some("mail"), AppReuse::Focus, Some("work")),
        "{\"type\":\"open_url\",\"version\":1,\"url\":\"https://example.com/\",\"profile\":\"work\",\"app\":true,\"app_id\":\"mail\",\"reuse\":\"focus\"}\n"
    );
}

#[test]
fn devtools_sends_a_method_to_a_browser_window() {
    assert_eq!(
        devtools_line("w7", "DOM.getBoxModel", &serde_json::json!({"backendNodeId": 4})),
        "{\"type\":\"devtools\",\"version\":1,\"window\":\"w7\",\"method\":\"DOM.getBoxModel\",\"params\":{\"backendNodeId\":4}}\n"
    );
    assert_eq!(
        reply("{\"type\":\"devtools\",\"result\":{\"nodes\":[]}}").unwrap(),
        Reply::DevTools {
            result: serde_json::json!({"nodes": []})
        }
    );
}
