//! Tests for sending commands over the engine command socket.

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use domicile_launch::browser_profiles::{
    BrowserProfileList, ListedBrowserProfile, ListedBrowserSite, ProfileExtension,
};
use domicile_launch::command::{
    browser_profiles_line, clear_browsing_data_line, clear_site_data_line, config_extensions_line,
    configure_extension_line, delete_history_line, devtools_line, disable_while_typing_line,
    extensions_line, history_line, load_shell_line, load_unpacked_line, media_devices_line,
    open_url_line, pin_browser_site_line, set_extension_enabled_line, set_log_levels_line,
    set_media_device_line, set_site_permission_line, site_data_line, site_permissions_line,
    uninstall_extension_line, visits_line,
};
use domicile_launch::command_socket::{
    browser_profiles, clear_browsing_data, clear_site_data, config_extensions, configure_extension,
    delete_history, devtools, disable_while_typing, extensions, history, load_shell, load_unpacked,
    media_devices, open_url, pin_browser_site, set_extension_enabled, set_log_levels,
    set_media_device, set_site_permission, site_data, site_permissions, uninstall_extension,
    visits, CommandError,
};
use domicile_launch::extensions::{ExtensionSettings, InstalledExtension};
use domicile_launch::history::{BrowsingData, HistoryItem, HistoryQuery};
use domicile_launch::media_devices::{MediaDevice, MediaDevices, MediaKind};
use domicile_launch::shell_path::{Shell, ShellFiles};
use domicile_launch::site_data::SiteData;
use domicile_launch::site_permissions::{Permission, Setting, SitePermission, SiteSettings};

/// Reply timeout: long enough for a loaded machine, short enough for a fast
/// suite.
const BRIEFLY: Duration = Duration::from_millis(200);

#[test]
fn the_engine_is_sent_the_shell_and_says_it_is_serving_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"loaded\"}\n"));

    load_shell(&path, &other(), BRIEFLY).expect("the engine loaded it");

    // The bytes on the socket match the line `command.rs` checks.
    assert_eq!(
        heard.join().expect("the engine was listening"),
        load_shell_line(&other(),)
    );
}

#[test]
fn the_engine_is_sent_the_address_and_says_it_opened_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"opened\"}\n"));

    open_url(&path, "https://example.com/", None, BRIEFLY).expect("the engine opened it");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        open_url_line("https://example.com/", None)
    );
}

#[test]
fn an_engine_that_refused_is_carried_back_in_its_own_words() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"refused\",\"why\":\"load_shell needs a module\"}\n"),
    );

    let why = load_shell(&path, &other(), BRIEFLY).expect_err("the engine refused it");

    assert_eq!(
        why,
        CommandError::Refused {
            why: "load_shell needs a module".to_string()
        }
    );
    assert!(
        why.to_string().contains("load_shell needs a module"),
        "the sentence a person reads dropped the engine's own: {why}"
    );
    heard.join().expect("the engine was listening");
}

#[test]
fn an_engine_whose_shell_page_has_not_committed_says_it_has_no_shell_window() {
    // The engine binds its socket before its first page commits, and refuses
    // `load_shell` with these exact bytes until it does.
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some(
            "{\"type\":\"refused\",\"why\":\"this engine has no shell window to load a shell into\"}\n",
        ),
    );

    let why = load_shell(&path, &other(), BRIEFLY).expect_err("the engine refused it");

    assert_eq!(why, CommandError::NoShellWindow);
    assert!(
        why.to_string()
            .contains("this engine has no shell window to load a shell into"),
        "the sentence a person reads dropped the engine's own: {why}"
    );
    heard.join().expect("the engine was listening");
}

#[test]
fn an_engine_that_is_not_there_is_said_rather_than_waited_for() {
    // This happens while the supervisor replaces a dead engine. Fail fast
    // rather than hang the user's terminal.
    let (_scratch, path) = scratch();

    let why = load_shell(&path, &other(), BRIEFLY).expect_err("nothing is bound there");

    assert_eq!(
        why,
        CommandError::NoEngine {
            path: path.display().to_string()
        }
    );
}

#[test]
fn an_engine_that_takes_the_command_and_says_nothing_is_not_a_shell_that_loaded() {
    // No reply is an error, so the terminal never reports a load that did
    // not happen.
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, None);

    let why = load_shell(&path, &other(), BRIEFLY).expect_err("the engine never answered");

    assert_eq!(
        why,
        CommandError::NoAnswer {
            path: path.display().to_string()
        }
    );
    heard.join().expect("the engine was listening");
}

/// A fake engine at `path` that reads one line and replies `with`, or hangs up
/// if `with` is `None`.
fn an_engine(path: &Path, with: Option<&'static str>) -> std::thread::JoinHandle<String> {
    let listener = UnixListener::bind(path).expect("the engine binds its command socket");
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("a supervisor dialed");
        let mut line = String::new();
        BufReader::new(stream.try_clone().expect("the connection is readable"))
            .read_line(&mut line)
            .expect("the supervisor wrote a line");
        if let Some(answer) = with {
            let mut answering = stream;
            answering
                .write_all(answer.as_bytes())
                .expect("the engine answers");
        }
        line
    })
}

/// A temporary directory and an unused socket path in it.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("a temp directory");
    let path = directory.path().join("command.sock");
    (directory, path)
}

#[test]
fn the_engine_is_asked_for_site_permissions_and_lists_them() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"site_permissions\",\"defaults\":{\"camera\":\"ask\"},\"sites\":[{\"origin\":\"https://meet.example\",\"permission\":\"camera\",\"setting\":\"allow\"}]}\n"),
    );

    assert_eq!(
        site_permissions(&path, BRIEFLY).expect("the engine listed them"),
        SiteSettings {
            defaults: BTreeMap::from([(Permission::Camera, Setting::Ask)]),
            sites: vec![SitePermission {
                origin: "https://meet.example".to_string(),
                permission: Permission::Camera,
                setting: Setting::Allow,
            }],
        }
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        site_permissions_line()
    );
}

#[test]
fn the_engine_is_sent_a_site_s_setting_and_says_it_stored_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"set\"}\n"));
    let site = SitePermission {
        origin: "https://meet.example".to_string(),
        permission: Permission::Microphone,
        setting: Setting::Block,
    };

    set_site_permission(&path, &site, BRIEFLY).expect("the engine stored it");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        set_site_permission_line(&site)
    );
}

#[test]
fn the_engine_is_sent_log_levels_and_says_it_set_them() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"set\"}\n"));

    set_log_levels(&path, 0, "*/domicile/*=1", BRIEFLY).expect("the engine set them");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        set_log_levels_line(0, "*/domicile/*=1")
    );
}

#[test]
fn the_engine_lists_media_devices() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"media_devices\",\"cameras\":[],\"microphones\":[{\"id\":\"default\",\"name\":\"Default\"}]}\n"),
    );

    assert_eq!(
        media_devices(&path, BRIEFLY).expect("the engine listed them"),
        MediaDevices {
            cameras: vec![],
            microphones: vec![MediaDevice {
                id: "default".to_string(),
                name: "Default".to_string(),
            }],
        }
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        media_devices_line()
    );
}

#[test]
fn the_engine_lists_the_desks_browser_profiles() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"browser_profiles\",\"default_profile\":\"personal\",\"default_private_profile\":\"private\",\"profiles\":[{\"id\":\"work\",\"name\":\"Work\",\"color\":\"#3b82f6\",\"private\":false,\"extensions\":[{\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"enabled\":true,\"locked\":true}]}],\"sites\":[{\"site\":\"github.com/acme\",\"profile\":\"work\",\"pinned\":true}]}\n"),
    );

    assert_eq!(
        browser_profiles(&path, BRIEFLY).expect("the engine listed them"),
        BrowserProfileList {
            default_profile: "personal".to_string(),
            default_private_profile: "private".to_string(),
            profiles: vec![ListedBrowserProfile {
                id: "work".to_string(),
                name: "Work".to_string(),
                color: "#3b82f6".to_string(),
                private: false,
                extensions: vec![ProfileExtension {
                    id: "abcdefghijklmnopabcdefghijklmnop".to_string(),
                    enabled: true,
                    locked: true,
                }],
            }],
            sites: vec![ListedBrowserSite {
                site: "github.com/acme".to_string(),
                profile: "work".to_string(),
                pinned: true,
            }],
        }
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        browser_profiles_line()
    );
}

#[test]
fn the_engine_is_told_to_pin_a_site_and_says_it_stored_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"set\"}\n"));

    pin_browser_site(&path, "github.com/acme", "work", BRIEFLY).expect("the engine stored it");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        pin_browser_site_line("github.com/acme", "work")
    );
}

#[test]
fn the_engine_is_sent_a_preferred_media_device_and_says_it_stored_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"set\"}\n"));

    set_media_device(&path, MediaKind::Microphone, "default", BRIEFLY)
        .expect("the engine stored it");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        set_media_device_line(MediaKind::Microphone, "default")
    );
}

#[test]
fn the_engine_loads_an_unpacked_extension_and_names_its_id() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"loaded_unpacked\",\"id\":\"abcdefghijklmnopabcdefghijklmnop\"}\n"),
    );
    let directory = Path::new("/home/me/src/my-extension");

    assert_eq!(
        load_unpacked(&path, directory, BRIEFLY).expect("the engine loaded it"),
        "abcdefghijklmnopabcdefghijklmnop"
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        load_unpacked_line(directory)
    );
}

#[test]
fn the_engine_uninstalls_an_extension() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"uninstalled\"}\n"));

    uninstall_extension(&path, "abcdefghijklmnopabcdefghijklmnop", BRIEFLY)
        .expect("the engine uninstalled it");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        uninstall_extension_line("abcdefghijklmnopabcdefghijklmnop")
    );
}

#[test]
fn the_engine_lists_the_extensions_the_config_installed() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"config_extensions\",\"ids\":[\"abcdefghijklmnopabcdefghijklmnop\"]}\n"),
    );

    assert_eq!(
        config_extensions(&path, BRIEFLY).expect("the engine listed them"),
        vec!["abcdefghijklmnopabcdefghijklmnop".to_string()]
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        config_extensions_line()
    );
}

#[test]
fn the_engine_lists_every_installed_extension() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"extensions\",\"extensions\":[{\"id\":\"abcdefghijklmnopabcdefghijklmnop\",\"name\":\"Tabs\",\"description\":\"\",\"version\":\"1.0\",\"enabled\":true,\"settings\":{}}]}\n"),
    );

    assert_eq!(
        extensions(&path, BRIEFLY).expect("the engine listed them"),
        vec![InstalledExtension {
            id: "abcdefghijklmnopabcdefghijklmnop".to_string(),
            name: "Tabs".to_string(),
            description: String::new(),
            version: "1.0".to_string(),
            enabled: true,
            options_url: None,
            settings: ExtensionSettings::default(),
            icon_path: None,
        }]
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        extensions_line()
    );
}

#[test]
fn the_engine_is_told_to_disable_an_extension_and_says_it_stored_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"set\"}\n"));

    set_extension_enabled(
        &path,
        "abcdefghijklmnopabcdefghijklmnop",
        false,
        None,
        BRIEFLY,
    )
    .expect("the engine stored it");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        set_extension_enabled_line("abcdefghijklmnopabcdefghijklmnop", false, None)
    );
}

#[test]
fn the_engine_is_told_an_extension_s_settings_and_says_it_stored_them() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"set\"}\n"));
    let settings = ExtensionSettings {
        file_access: Some(true),
        ..ExtensionSettings::default()
    };

    configure_extension(
        &path,
        "abcdefghijklmnopabcdefghijklmnop",
        &settings,
        BRIEFLY,
    )
    .expect("the engine stored them");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        configure_extension_line("abcdefghijklmnopabcdefghijklmnop", &settings)
    );
}

#[test]
fn the_engine_searches_its_history() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some(
            "{\"type\":\"history\",\"items\":[{\"url\":\"https://a.example/\",\"title\":\"A\"}]}\n",
        ),
    );
    let query = HistoryQuery {
        text: "a".to_string(),
        end_time: 1_700_000_000_123.5,
        max_results: 10,
    };

    assert_eq!(
        history(&path, &query, BRIEFLY).expect("the engine searched it"),
        vec![HistoryItem {
            url: "https://a.example/".to_string(),
            title: "A".to_string(),
            favicon: None,
        }]
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        history_line(&query)
    );
}

#[test]
fn the_engine_lists_a_page_s_visits() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"visits\",\"times\":[1700000000123.5]}\n"),
    );

    assert_eq!(
        visits(&path, "https://a.example/", BRIEFLY).expect("the engine listed them"),
        vec![1_700_000_000_123.5]
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        visits_line("https://a.example/")
    );
}

#[test]
fn the_engine_is_told_to_delete_visits_and_says_it_deleted_them() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"deleted\"}\n"));

    delete_history(&path, &[1_700_000_000_123.5], BRIEFLY).expect("the engine deleted them");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        delete_history_line(&[1_700_000_000_123.5])
    );
}

#[test]
fn the_engine_is_told_to_clear_browsing_data_and_says_it_cleared_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"cleared\"}\n"));
    let data = BrowsingData {
        since: 0.0,
        types: vec!["cookies".to_string()],
        origins: Some(vec!["https://a.example".to_string()]),
    };

    clear_browsing_data(&path, &data, BRIEFLY).expect("the engine cleared it");

    assert_eq!(
        heard.join().expect("the engine was listening"),
        clear_browsing_data_line(&data)
    );
}

#[test]
fn the_engine_lists_site_data() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"site_data\",\"sites\":[{\"host\":\"a.example\",\"bytes\":2048.0,\"cookies\":1}]}\n"),
    );

    assert_eq!(
        site_data(&path, BRIEFLY).expect("the engine listed them"),
        vec![SiteData {
            host: "a.example".to_string(),
            bytes: 2048.0,
            cookies: 1,
        }]
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        site_data_line()
    );
}

#[test]
fn the_engine_is_told_to_clear_a_host_s_site_data_and_says_it_cleared_it() {
    let (_scratch, path) = scratch();
    let heard = an_engine(&path, Some("{\"type\":\"cleared\"}\n"));

    clear_site_data(&path, "a.example", BRIEFLY).expect("the engine cleared it");
    assert_eq!(
        heard.join().expect("the engine was listening"),
        clear_site_data_line("a.example")
    );
}

#[test]
fn the_engine_is_told_to_disable_while_typing_and_says_what_it_does() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"disable_while_typing\",\"enabled\":false}\n"),
    );

    assert!(!disable_while_typing(&path, Some(false), BRIEFLY).expect("the engine set it"));
    assert_eq!(
        heard.join().expect("the engine was listening"),
        disable_while_typing_line(Some(false))
    );
}

#[test]
fn the_engine_sends_a_devtools_method_and_answers_its_result() {
    let (_scratch, path) = scratch();
    let heard = an_engine(
        &path,
        Some("{\"type\":\"devtools\",\"result\":{\"frameId\":\"F\"}}\n"),
    );
    let params = serde_json::json!({"url": "https://example.com/"});

    assert_eq!(
        devtools(&path, "w7", "Page.navigate", &params, BRIEFLY).expect("the page answered"),
        serde_json::json!({"frameId": "F"})
    );
    assert_eq!(
        heard.join().expect("the engine was listening"),
        devtools_line("w7", "Page.navigate", &params)
    );
}

/// The shell these tests load.
fn other() -> Shell {
    Shell {
        files: ShellFiles::Directory,
        module: PathBuf::from("shell.js"),
        root: PathBuf::from("/desktops/other"),
    }
}
