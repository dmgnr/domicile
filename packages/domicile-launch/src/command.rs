//! The protocol the supervisor uses to send `load-shell`, `open`, the
//! Settings app's site permissions, extensions, media devices and site data, the History
//! app's history and browsing data, and `disable-while-typing` to the engine.
//!
//! One JSON line each way per connection:
//!
//! ```text
//! {"type":"load_shell","version":1,"root":"/x/dist","module":"shell.js"}
//! {"type":"load_shell","version":1,"root":"/run/user/1000/dev.sock",
//!  "module":"domicile-dev-shell.js","dev_server":true}
//! {"type":"loaded"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"open_url","version":1,"url":"https://example.com/"}
//! {"type":"open_url","version":1,"url":"https://example.com/","app":true}
//! {"type":"opened"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"site_permissions","version":1}
//! {"type":"site_permissions","defaults":{"camera":"ask",…},"sites":[{"origin":"https://meet.example","permission":"camera","setting":"allow"}]}
//!
//! {"type":"set_site_permission","version":1,"origin":"https://meet.example","permission":"camera","setting":"block"}
//! {"type":"set"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"load_unpacked","version":1,"directory":"/home/me/src/my-extension"}
//! {"type":"loaded_unpacked","id":"…"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"uninstall_extension","version":1,"id":"…"}
//! {"type":"uninstalled"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"config_extensions","version":1}
//! {"type":"config_extensions","ids":["…"]}
//!
//! {"type":"media_devices","version":1}
//! {"type":"media_devices","cameras":[{"id":"/dev/video2","name":"USB Camera"}],"microphones":[…]}
//!
//! {"type":"set_media_device","version":1,"kind":"camera","id":"/dev/video2"}
//! {"type":"set"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"extensions","version":1}
//! {"type":"extensions","extensions":[{"id":"…","name":"…","description":"…","version":"1.0","enabled":true,"options_url":"chrome-extension://…/options.html","settings":{"private":false,"site_access":"all_sites"}}]}
//! {"type":"refused","why":"…"}
//!
//! {"type":"set_extension_enabled","version":1,"id":"…","enabled":false}
//! {"type":"set"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"configure_extension","version":1,"id":"…","settings":{"private":true,"site_access":["github.com"]}}
//! {"type":"set"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"history","version":1,"text":"…","end_time":1700000000123.5,"max_results":100}
//! {"type":"history","items":[{"url":"…","title":"…","favicon":"data:…"}]}   |   {"type":"refused","why":"…"}
//!
//! {"type":"visits","version":1,"url":"https://example.com/"}
//! {"type":"visits","times":[1700000000123.5]}   |   {"type":"refused","why":"…"}
//!
//! {"type":"delete_history","version":1,"visits":[1700000000123.5]}
//! {"type":"deleted"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"clear_browsing_data","version":1,"since":0,"types":["cookies"],"origins":["https://example.com"]}
//! {"type":"cleared"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"site_data","version":1}
//! {"type":"site_data","sites":[{"host":"mail.example","bytes":20480.0,"cookies":3}]}   |   {"type":"refused","why":"…"}
//!
//! {"type":"clear_site_data","version":1,"host":"mail.example"}
//! {"type":"cleared"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"set_log_levels","version":1,"min_level":0,"vmodule":"*/domicile/*=1"}
//! {"type":"set"}   |   {"type":"refused","why":"…"}
//!
//! {"type":"disable_while_typing","version":1,"enabled":false}
//! {"type":"disable_while_typing","enabled":false}   |   {"type":"refused","why":"…"}
//! ```
//!
//! `options_url` is left out for an extension without an options page, and
//! `favicon` for a history row without a favicon. `origins` is left out to
//! clear every origin. `enabled` is left out of `disable_while_typing` to ask
//! without setting. Times are milliseconds since the epoch, fractional.
//!
//! The engine side is C++ in the fork
//! (`components/domicile/browser/command_protocol.cc`, tested in
//! `command_protocol_unittest.cc`) and is released separately
//! (`packages/domicile-engine/engine-release.nix`). Nothing shares code
//! between the two, so the tests here assert the exact bytes.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::browser_profiles::BrowserProfileList;
use crate::control::AppReuse;
use crate::extensions::{ExtensionSettings, InstalledExtension};
use crate::history::{BrowsingData, HistoryItem, HistoryQuery};
use crate::media_devices::{MediaDevices, MediaKind};
use crate::shell_path::{Shell, ShellFiles};
use crate::site_data::SiteData;
use crate::site_permissions::{Permission, Setting, SitePermission, SiteSettings};

/// The protocol version the supervisor sends and the engine checks.
///
/// Versioned per [`DATA.md`](/docs/guidelines/DATA.md) because the pinned
/// engine is often older than `domicile`. The engine refuses versions it does
/// not support. Bump this when a request changes in a way an older engine
/// would misread.
const VERSION: u32 = 1;

/// The engine's refusal of `load_shell` while it has no window showing a
/// `domicile://` page, as its first page has not committed yet.
///
/// Matched whole: the protocol carries no refusal codes, and the engine's text
/// is fixed by `command_protocol.cc`.
pub(crate) const NO_SHELL_WINDOW: &str = "this engine has no shell window to load a shell into";

/// The engine's reply.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    /// The engine is serving the shell.
    Loaded,
    /// The engine passed the address to the shell.
    Opened,
    /// Every permission's default and every site's own setting.
    SitePermissions(SiteSettings),
    /// The engine stored a site's setting, a preferred media device, whether
    /// an extension is enabled or an extension's settings.
    Set,
    /// The engine loaded an unpacked extension, which has this id.
    LoadedUnpacked { id: String },
    /// The engine uninstalled an extension.
    Uninstalled,
    /// The ids of the extensions the desk's config installed.
    ConfigExtensions { ids: Vec<String> },
    /// Each kind's media devices, most preferred first.
    MediaDevices(MediaDevices),
    /// Every extension installed in the engine's profile.
    Extensions { extensions: Vec<InstalledExtension> },
    /// The desk's browser profiles and the sites that open outside the
    /// default one.
    BrowserProfiles(BrowserProfileList),
    /// The history rows a search found, newest first.
    History { items: Vec<HistoryItem> },
    /// When a page was visited, in milliseconds since the epoch.
    Visits { times: Vec<f64> },
    /// The engine deleted the visits.
    Deleted,
    /// The engine cleared the browsing data or a host's site data.
    Cleared,
    /// Every host that stores data.
    SiteData { sites: Vec<SiteData> },
    /// Whether the touchpads rest while a keyboard types.
    DisableWhileTyping { enabled: bool },
    /// A DevTools Protocol method's result.
    #[serde(rename = "devtools")]
    DevTools { result: serde_json::Value },
    /// The engine refused, with its reason.
    Refused { why: String },
}

/// The request to serve `shell`.
///
/// Its root must be absolute; the engine refuses relative paths. Resolve user
/// input with [`crate::shell_path`] first.
pub fn load_shell_line(shell: &Shell) -> String {
    line(&Command::LoadShell {
        module: &shell.module,
        root: &shell.root,
        dev_server: shell.files == ShellFiles::DevServer,
        version: VERSION,
    })
}

/// The request to serve the app module `module` under `root` and open an app
/// window on it. See `docs/architecture/APP-MODULES.md`.
pub fn run_app_line(root: &Path, module: &Path) -> String {
    line(&Command::RunApp {
        module,
        root,
        version: VERSION,
    })
}

/// The request to open `url` in the shell, in browser profile `profile` or
/// with none in the one its site opens in. The engine validates both.
pub fn open_url_line(url: &str, profile: Option<&str>) -> String {
    line(&Command::OpenUrl {
        url,
        version: VERSION,
        profile,
        app: false,
        app_id: None,
        reuse: AppReuse::New,
    })
}

/// The request to open `url` in an app window: a browser window the shell
/// draws without an address bar. An engine that predates `app` ignores it and
/// opens a browser window.
///
/// With `id`, the window is that app's, and `reuse` says what to do when one
/// of its windows is open.
pub fn open_app_line(
    url: &str,
    id: Option<&str>,
    reuse: AppReuse,
    profile: Option<&str>,
) -> String {
    line(&Command::OpenUrl {
        url,
        version: VERSION,
        profile,
        app: true,
        app_id: id,
        reuse,
    })
}

/// The request for every site's stored permissions.
pub fn site_permissions_line() -> String {
    line(&Command::SitePermissions { version: VERSION })
}

/// The request to store `site`'s setting.
pub fn set_site_permission_line(site: &SitePermission) -> String {
    line(&Command::SetSitePermission {
        version: VERSION,
        origin: &site.origin,
        permission: site.permission,
        setting: site.setting,
    })
}

/// The request to load the unpacked extension in `directory`, which must be
/// absolute.
pub fn load_unpacked_line(directory: &Path) -> String {
    line(&Command::LoadUnpacked {
        version: VERSION,
        directory,
    })
}

/// The request to uninstall extension `id`.
pub fn uninstall_extension_line(id: &str) -> String {
    line(&Command::UninstallExtension {
        version: VERSION,
        id,
    })
}

/// The request for the ids of the extensions the desk's config installed.
pub fn config_extensions_line() -> String {
    line(&Command::ConfigExtensions { version: VERSION })
}

/// The request for the cameras and microphones, most preferred first.
pub fn media_devices_line() -> String {
    line(&Command::MediaDevices { version: VERSION })
}

/// The request to give device `id` to sites that ask for a `kind` without
/// naming one.
pub fn set_media_device_line(kind: MediaKind, id: &str) -> String {
    line(&Command::SetMediaDevice {
        version: VERSION,
        kind,
        id,
    })
}

/// The request for every extension installed in the engine's profile.
pub fn extensions_line() -> String {
    line(&Command::Extensions { version: VERSION })
}

/// The request to enable or disable extension `id`, in browser profile
/// `profile` or the shell's own.
pub fn set_extension_enabled_line(id: &str, enabled: bool, profile: Option<&str>) -> String {
    line(&Command::SetExtensionEnabled {
        version: VERSION,
        id,
        enabled,
        profile,
    })
}

/// The request for the desk's browser profiles.
pub fn browser_profiles_line() -> String {
    line(&Command::BrowserProfiles { version: VERSION })
}

/// The request to open `site` in browser profile `profile` from now on.
pub fn pin_browser_site_line(site: &str, profile: &str) -> String {
    line(&Command::PinBrowserSite {
        version: VERSION,
        site,
        profile,
    })
}

/// The request to change each of `settings` that is set on extension `id`.
pub fn configure_extension_line(id: &str, settings: &ExtensionSettings) -> String {
    line(&Command::ConfigureExtension {
        version: VERSION,
        id,
        settings,
    })
}

/// The request for the history rows `query` finds.
pub fn history_line(query: &HistoryQuery) -> String {
    line(&Command::History {
        version: VERSION,
        text: &query.text,
        end_time: query.end_time,
        max_results: query.max_results,
    })
}

/// The request for the times `url` was visited.
pub fn visits_line(url: &str) -> String {
    line(&Command::Visits {
        version: VERSION,
        url,
    })
}

/// The request to delete the visits made at `visits`, each a time in
/// milliseconds since the epoch.
pub fn delete_history_line(visits: &[f64]) -> String {
    line(&Command::DeleteHistory {
        version: VERSION,
        visits,
    })
}

/// The request to clear `data`.
pub fn clear_browsing_data_line(data: &BrowsingData) -> String {
    line(&Command::ClearBrowsingData {
        version: VERSION,
        since: data.since,
        types: &data.types,
        origins: data.origins.as_deref(),
    })
}

/// The request for every host that stores data.
pub fn site_data_line() -> String {
    line(&Command::SiteData { version: VERSION })
}

/// The request to clear everything `host` stores.
pub fn clear_site_data_line(host: &str) -> String {
    line(&Command::ClearSiteData {
        version: VERSION,
        host,
    })
}

/// The request to set whether the touchpads rest while a keyboard types, or,
/// with no `enabled`, to ask.
pub fn disable_while_typing_line(enabled: Option<bool>) -> String {
    line(&Command::DisableWhileTyping {
        version: VERSION,
        enabled,
    })
}

/// The request to log at Chromium's minimum severity `min_level` and VLOG at
/// `vmodule` in every engine process.
pub fn set_log_levels_line(min_level: i32, vmodule: &str) -> String {
    line(&Command::SetLogLevels {
        version: VERSION,
        min_level,
        vmodule,
    })
}

/// The request to send DevTools Protocol `method` with `params` to browser
/// window `window`, by its id in the engine.
pub fn devtools_line(window: &str, method: &str, params: &serde_json::Value) -> String {
    line(&Command::DevTools {
        version: VERSION,
        window,
        method,
        params,
    })
}

/// Parses one reply line, without its trailing newline.
///
/// An unparseable reply is an error, not a [`Reply::Refused`]: it comes from
/// an incompatible engine, which did not refuse anything.
pub fn reply(line: &str) -> Result<Reply, serde_json::Error> {
    serde_json::from_str(line)
}

/// A request to the engine.
///
/// Field order matches the documented key order, so live lines are easy to
/// compare against the docs.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Command<'a> {
    LoadShell {
        version: u32,
        root: &'a Path,
        module: &'a Path,
        /// Left out for a directory, which every engine reads.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        dev_server: bool,
    },
    RunApp {
        version: u32,
        root: &'a Path,
        module: &'a Path,
    },
    OpenUrl {
        version: u32,
        url: &'a str,
        // Left out when none, the profile the site opens in.
        #[serde(skip_serializing_if = "Option::is_none")]
        profile: Option<&'a str>,
        // Left out when false, so a browser window's line is the one every
        // engine reads.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        app: bool,
        // Left out when none, as `app` is.
        #[serde(skip_serializing_if = "Option::is_none")]
        app_id: Option<&'a str>,
        // Left out when new, the engine's default.
        #[serde(skip_serializing_if = "is_new")]
        reuse: AppReuse,
    },
    SitePermissions {
        version: u32,
    },
    SetSitePermission {
        version: u32,
        origin: &'a str,
        permission: Permission,
        setting: Setting,
    },
    LoadUnpacked {
        version: u32,
        directory: &'a Path,
    },
    UninstallExtension {
        version: u32,
        id: &'a str,
    },
    ConfigExtensions {
        version: u32,
    },
    MediaDevices {
        version: u32,
    },
    SetMediaDevice {
        version: u32,
        kind: MediaKind,
        id: &'a str,
    },
    Extensions {
        version: u32,
    },
    SetExtensionEnabled {
        version: u32,
        id: &'a str,
        enabled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        profile: Option<&'a str>,
    },
    BrowserProfiles {
        version: u32,
    },
    PinBrowserSite {
        version: u32,
        site: &'a str,
        profile: &'a str,
    },
    ConfigureExtension {
        version: u32,
        id: &'a str,
        settings: &'a ExtensionSettings,
    },
    History {
        version: u32,
        text: &'a str,
        end_time: f64,
        max_results: u32,
    },
    Visits {
        version: u32,
        url: &'a str,
    },
    DeleteHistory {
        version: u32,
        visits: &'a [f64],
    },
    ClearBrowsingData {
        version: u32,
        since: f64,
        types: &'a [String],
        // Left out for every origin.
        #[serde(skip_serializing_if = "Option::is_none")]
        origins: Option<&'a [String]>,
    },
    SiteData {
        version: u32,
    },
    ClearSiteData {
        version: u32,
        host: &'a str,
    },
    SetLogLevels {
        version: u32,
        min_level: i32,
        vmodule: &'a str,
    },
    DisableWhileTyping {
        version: u32,
        // Left out to ask.
        #[serde(skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
    },
    #[serde(rename = "devtools")]
    DevTools {
        version: u32,
        window: &'a str,
        method: &'a str,
        params: &'a serde_json::Value,
    },
}

/// `command` as one newline-terminated line.
fn line(command: &Command) -> String {
    let mut line =
        serde_json::to_string(command).expect("a command is plain data and always serializes");
    line.push('\n');
    line
}

/// Whether `reuse` is the engine's default, which a line leaves out.
fn is_new(reuse: &AppReuse) -> bool {
    *reuse == AppReuse::New
}
