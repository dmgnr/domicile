//! The host Domicile's apps spawn: `domicile-app-host`.
//!
//! An app spawns this host and the two exchange messages over the host's
//! stdin and stdout, each a 4-byte length and UTF-8 JSON. For Settings, the
//! host asks the running desktop which files to edit
//! ([`Request::SettingsFiles`]) rather than taking a path from the page,
//! refuses a config whose `shell_options` the shell's declaration refuses, and
//! forwards site permissions, site data, extensions, media devices and
//! addresses to open to the engine through the desktop, and lists, stops and
//! forgets agents through the compositor, and
//! reads and signs out agents on the web from the files `domicile mcp`
//! keeps. For History, it forwards history
//! searches, deletions and clearing browsing data. See `docs/SETTINGS.md` and
//! `docs/HISTORY.md`.
//!
//! ```text
//! {"id":1,"type":"read"}
//!   {"id":1,"type":"files","config":{"path":…,"text":…,"writable":true},"evaluated":null,"shell":null,"options":"{…}"}   (options null if the shell declares none)
//! {"id":2,"type":"write","file":"config","text":"{…}"}
//!   {"id":2,"type":"written"}
//! {"id":3,"type":"site_permissions"}
//!   {"id":3,"type":"site_permissions","defaults":{…},"sites":[…]}
//! {"id":4,"type":"set_site_permission","site":{…}}
//!   {"id":4,"type":"stored"}
//! {"id":5,"type":"load_unpacked","directory":"~/src/my-extension"}
//!   {"id":5,"type":"loaded_unpacked","extension":"…"}
//! {"id":6,"type":"uninstall_extension","extension":"…"}
//!   {"id":6,"type":"uninstalled"}
//! {"id":7,"type":"config_extensions"}
//!   {"id":7,"type":"config_extensions","ids":["…"]}
//! {"id":8,"type":"choose_folder"}
//!   {"id":8,"type":"folder","path":"/home/me/src/my-extension"}   (null if canceled)
//! {"id":8,"type":"media_devices"}
//!   {"id":8,"type":"media_devices","cameras":[{"id":…,"name":…}],"microphones":[…]}
//! {"id":9,"type":"set_media_device","kind":"camera","device":"…"}
//!   {"id":9,"type":"stored"}
//! {"id":10,"type":"extensions"}
//!   {"id":10,"type":"extensions","extensions":[{"id":…,"name":…,"description":…,"version":…,"enabled":true,"options_url":…,"settings":{…},"icon":"data:image/png;base64,…"}]}   (options_url and icon null if none)
//! {"id":11,"type":"set_extension_enabled","extension":"…","enabled":false}
//! {"id":11,"type":"set_extension_enabled","extension":"…","enabled":false,"profile":"work"}
//!   {"id":11,"type":"stored"}
//! {"id":11,"type":"browser_profiles"}
//!   {"id":11,"type":"browser_profiles","default_profile":"personal","default_private_profile":"private","profiles":[{"id":"work","name":"Work","color":"#d97706","private":false,"extensions":[{"id":…,"enabled":true,"locked":false}]}],"sites":[{"site":"github.com/acme","profile":"work","pinned":true}]}
//! {"id":11,"type":"pin_browser_site","site":"github.com/acme","profile":"work"}
//!   {"id":11,"type":"stored"}
//! {"id":11,"type":"configure_extension","extension":"…","settings":{"private":true}}
//!   {"id":11,"type":"stored"}
//! {"id":12,"type":"open_url","url":"chrome-extension://…/options.html"}
//!   {"id":12,"type":"opened"}
//! {"id":13,"type":"history","text":"…","end_time":1700000000123.5,"max_results":100}
//!   {"id":13,"type":"history","items":[{"url":…,"title":…,"favicon":"data:…"}]}   (favicon null if none)
//! {"id":14,"type":"visits","url":"https://example.com/"}
//!   {"id":14,"type":"visits","times":[1700000000123.5]}
//! {"id":15,"type":"delete_history","visits":[1700000000123.5]}
//!   {"id":15,"type":"deleted"}
//! {"id":16,"type":"clear_browsing_data","since":0,"types":["cookies"],"origins":["https://example.com"]}
//!   {"id":16,"type":"cleared"}   (no origins clears every origin)
//! {"id":17,"type":"site_data"}
//!   {"id":17,"type":"site_data","sites":[{"host":"mail.example","bytes":20480.0,"cookies":3}]}
//! {"id":18,"type":"clear_site_data","host":"mail.example"}
//!   {"id":18,"type":"cleared"}
//! {"id":19,"type":"monitors"}
//!   {"id":19,"type":"monitors","monitors":[{"names":["drm-1","DEL DELL U3219Q 2ZLS413",…],"hdr":"unsupported"}]}
//! {"id":20,"type":"agents"}
//!   {"id":20,"type":"agents","agents":{"connected":[{"session":4,"agent":"Claude Code","reach":{"type":"desk"}}],"remembered":[{"agent":"Codex","last_used_ms":…}]}}
//! {"id":21,"type":"stop_agent","session":4}
//!   {"id":21,"type":"done"}
//! {"id":22,"type":"forget_agent","agent":"Codex"}
//!   {"id":22,"type":"done"}
//! {"id":23,"type":"web_agents"}
//!   {"id":23,"type":"web_agents","status":{"address":"https://….mcp.domicile-desktop.com/mcp","ready":true,"problem":null},"signed_in":[{"client":"…","name":"claude.ai","last_used_ms":…}]}   (status null until `domicile mcp --relay` runs)
//! {"id":24,"type":"sign_out_web_agent","client":"…"}
//!   {"id":24,"type":"done"}
//! {"id":25,"type":"detailed_logging"}
//!   {"id":25,"type":"detailed_logging","on":false}
//! {"id":26,"type":"set_detailed_logging","on":true}
//!   {"id":26,"type":"detailed_logging","on":true}
//! {"id":27,"type":"export_logs","redact":true}
//!   {"id":27,"type":"exported_logs","path":"/home/me/Downloads/domicile-logs-2026-11-27-091203.txt","unhidden":null}
//! {"id":28,"type":"open_downloads"}
//!   {"id":28,"type":"opened"}
//! any request
//!   {"id":…,"type":"refused","why":"…"}
//! pushed when a file changes on disk
//!   {"type":"changed"}
//! ```

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use domicile_config::Config;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config_path::is_module;
use crate::control::{Request, Response, SettingsFiles};
use crate::extensions::{ExtensionSettings, InstalledExtension};
use crate::history::{BrowsingData, HistoryQuery};
use crate::media_devices::MediaKind;
use crate::shell_options::problems;
use crate::site_permissions::SitePermission;
use domicile_protocol::{LogLevel, LogLevels};

/// The largest message the host reads or writes. A page's file, or a page of
/// history with its icons, is far smaller.
const MOST_A_MESSAGE_HOLDS: u32 = 16 * 1024 * 1024;

/// What the host reaches outside itself, injected for tests.
pub struct Host<'a> {
    /// Asks the running desktop over its control socket.
    pub ask: &'a dyn Fn(&Request) -> Result<Response, String>,
    pub read: &'a dyn Fn(&Path) -> std::io::Result<String>,
    /// Reads a file that is not text, such as an extension's icon.
    pub read_bytes: &'a dyn Fn(&Path) -> std::io::Result<Vec<u8>>,
    /// The user's home directory, which a leading `~` names.
    pub home: Option<&'a Path>,
    /// Shows the desktop's folder picker: the folder, or `None` if canceled.
    /// [`crate::folder_chooser::choose_folder`] outside tests.
    pub choose_folder: &'a dyn Fn() -> Result<Option<PathBuf>, String>,
    /// Whether this user may write the file, following links.
    pub writable: &'a dyn Fn(&Path) -> bool,
    /// Replaces the file's contents in place, so a link stays a link.
    pub write: &'a dyn Fn(&Path, &str) -> std::io::Result<()>,
    /// Where `domicile mcp --relay` says how it is doing
    /// ([`crate::mcp::web::status_file`]), if anywhere.
    pub web_status: Option<&'a Path>,
    /// Where `domicile mcp` keeps signed-in agents
    /// ([`crate::mcp::SIGNED_IN_FILE`]), if anywhere.
    pub signed_in: Option<&'a Path>,
    /// Where Save logs writes ([`downloads`]), if anywhere.
    pub downloads: Option<&'a Path>,
    /// Opens a folder as `domicile open` does.
    pub open: &'a dyn Fn(&Path) -> Result<(), String>,
}

/// The reply to a detailed-logging request: on while everything logs at
/// debug or more.
fn detailed(levels: &LogLevels) -> Value {
    json!({
        "type": "detailed_logging",
        "on": levels.all.is_some_and(|level| level >= LogLevel::Debug),
    })
}

/// The Downloads folder: `XDG_DOWNLOAD_DIR`, else the one `user-dirs.dirs`
/// names (`user_dirs`, its text), else `~/Downloads`. `None` without a home.
pub fn downloads(
    env: &dyn Fn(&str) -> Option<String>,
    user_dirs: Option<&str>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let home = home?;
    let named = env("XDG_DOWNLOAD_DIR")
        .filter(|dir| !dir.is_empty())
        .or_else(|| {
            user_dirs?.lines().find_map(|line| {
                let value = line.trim().strip_prefix("XDG_DOWNLOAD_DIR=")?;
                Some(value.trim_matches('"').to_string())
            })
        });
    Some(match named {
        Some(dir) => match dir.strip_prefix("$HOME") {
            Some(rest) => home.join(rest.trim_start_matches('/')),
            None => PathBuf::from(dir),
        },
        None => home.join("Downloads"),
    })
}

/// Answers one message from the app. The reply carries the request's `id`.
pub fn answer(message: &Value, host: &Host) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let replied = serde_json::from_value::<AppRequest>(message.clone())
        .map_err(|why| format!("{message} is not a request this host knows: {why}"))
        .and_then(|request| carry_out(request, host));
    let mut reply = replied.unwrap_or_else(|why| json!({"type": "refused", "why": why}));
    reply["id"] = id;
    reply
}

/// Reads one framed message, or `None` once the app closes the input.
pub fn read_message(input: &mut impl Read) -> std::io::Result<Option<Value>> {
    let mut length = [0_u8; 4];
    match input.read_exact(&mut length) {
        Err(why) if why.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        other => other?,
    }
    let length = u32::from_ne_bytes(length);
    if length > MOST_A_MESSAGE_HOLDS {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("a {length}-byte message is larger than any file the app edits"),
        ));
    }
    let mut body = vec![0_u8; length as usize];
    input.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|why| std::io::Error::new(std::io::ErrorKind::InvalidData, why))
}

/// Writes one framed message and flushes it.
pub fn write_message(output: &mut impl Write, message: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec(message).map_err(std::io::Error::other)?;
    if body.len() > MOST_A_MESSAGE_HOLDS as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("a {}-byte reply is larger than an app takes", body.len()),
        ));
    }
    let length = u32::try_from(body.len()).expect("checked against MOST_A_MESSAGE_HOLDS");
    output.write_all(&length.to_ne_bytes())?;
    output.write_all(&body)?;
    output.flush()
}

/// A request from the app.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AppRequest {
    Read,
    Write {
        file: Target,
        text: String,
    },
    SitePermissions,
    SetSitePermission {
        site: SitePermission,
    },
    LoadUnpacked {
        directory: PathBuf,
    },
    // `extension`, since the message's own `id` is the request's.
    UninstallExtension {
        extension: String,
    },
    ConfigExtensions,
    ChooseFolder,
    MediaDevices,
    // `device`, since the message's own `id` is the request's.
    SetMediaDevice {
        kind: MediaKind,
        device: String,
    },
    Extensions,
    // `extension`, since the message's own `id` is the request's.
    SetExtensionEnabled {
        extension: String,
        enabled: bool,
        #[serde(default)]
        profile: Option<String>,
    },
    BrowserProfiles,
    PinBrowserSite {
        site: String,
        profile: String,
    },
    // `extension`, since the message's own `id` is the request's.
    ConfigureExtension {
        extension: String,
        settings: ExtensionSettings,
    },
    OpenUrl {
        url: String,
    },
    History(HistoryQuery),
    Visits {
        url: String,
    },
    DeleteHistory {
        visits: Vec<f64>,
    },
    ClearBrowsingData(BrowsingData),
    SiteData,
    ClearSiteData {
        host: String,
    },
    Monitors,
    Agents,
    StopAgent {
        session: u32,
    },
    ForgetAgent {
        agent: String,
    },
    WebAgents,
    DetailedLogging,
    SetDetailedLogging {
        on: bool,
    },
    ExportLogs {
        redact: bool,
    },
    OpenDownloads,
    SignOutWebAgent {
        client: String,
    },
    RetryWebAgents,
}

/// Which file a write replaces.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum Target {
    Config,
    Shell,
}

fn carry_out(request: AppRequest, host: &Host) -> Result<Value, String> {
    match request {
        AppRequest::Read => {
            let files = settings_files(host)?;
            Ok(json!({
                "type": "files",
                "config": file(files.config.as_deref(), host)?,
                "evaluated": files
                    .evaluated
                    .as_deref()
                    .map(|path| read(path, host))
                    .transpose()?,
                "shell": file(files.shell.as_deref(), host)?,
                "options": files
                    .options
                    .as_deref()
                    .map(|path| read_if_there(path, host))
                    .transpose()?
                    .flatten(),
            }))
        }
        AppRequest::Write { file, text } => {
            let files = settings_files(host)?;
            let path = match file {
                Target::Config => files.config,
                Target::Shell => files.shell,
            }
            .ok_or_else(|| match file {
                Target::Config => "this desktop runs without a config file".to_string(),
                Target::Shell => "this desktop's shell is a package, not a file".to_string(),
            })?;
            write(&path, file, &text, files.options.as_deref(), host)
                .map(|()| json!({"type": "written"}))
        }
        AppRequest::SitePermissions => match (host.ask)(&Request::SitePermissions)? {
            Response::SitePermissions(settings) => Ok(json!({
                "type": "site_permissions",
                "defaults": settings.defaults,
                "sites": settings.sites,
            })),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::SetSitePermission { site } => {
            match (host.ask)(&Request::SetSitePermission { site })? {
                Response::Stored => Ok(json!({"type": "stored"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::LoadUnpacked { directory } => {
            let directory = absolute(&directory, host.home)?;
            match (host.ask)(&Request::LoadUnpacked { directory })? {
                Response::LoadedUnpacked { id } => {
                    Ok(json!({"type": "loaded_unpacked", "extension": id}))
                }
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::UninstallExtension { extension } => {
            match (host.ask)(&Request::UninstallExtension { id: extension })? {
                Response::Uninstalled => Ok(json!({"type": "uninstalled"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::ChooseFolder => {
            (host.choose_folder)().map(|path| json!({"type": "folder", "path": path}))
        }
        AppRequest::ConfigExtensions => match (host.ask)(&Request::ConfigExtensions)? {
            Response::ConfigExtensions { ids } => {
                Ok(json!({"type": "config_extensions", "ids": ids}))
            }
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::MediaDevices => match (host.ask)(&Request::MediaDevices)? {
            Response::MediaDevices(devices) => Ok(json!({
                "type": "media_devices",
                "cameras": devices.cameras,
                "microphones": devices.microphones,
            })),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::SetMediaDevice { kind, device } => {
            match (host.ask)(&Request::SetMediaDevice { kind, id: device })? {
                Response::Stored => Ok(json!({"type": "stored"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::Extensions => match (host.ask)(&Request::Extensions)? {
            Response::Extensions { extensions } => {
                let listed: Vec<Value> = extensions
                    .into_iter()
                    .map(|extension| with_icon(extension, host))
                    .collect();
                Ok(json!({"type": "extensions", "extensions": listed}))
            }
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::SetExtensionEnabled {
            extension,
            enabled,
            profile,
        } => match (host.ask)(&Request::SetExtensionEnabled {
            id: extension,
            enabled,
            profile,
        })? {
            Response::Stored => Ok(json!({"type": "stored"})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::BrowserProfiles => match (host.ask)(&Request::BrowserProfiles)? {
            Response::BrowserProfiles(list) => {
                let mut reply = serde_json::to_value(list).map_err(|why| why.to_string())?;
                reply["type"] = json!("browser_profiles");
                Ok(reply)
            }
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::PinBrowserSite { site, profile } => {
            match (host.ask)(&Request::PinBrowserSite { site, profile })? {
                Response::Stored => Ok(json!({"type": "stored"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::ConfigureExtension {
            extension,
            settings,
        } => match (host.ask)(&Request::ConfigureExtension {
            id: extension,
            settings,
        })? {
            Response::Stored => Ok(json!({"type": "stored"})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::OpenUrl { url } => {
            match (host.ask)(&Request::OpenUrl { url, profile: None })? {
                Response::Opened => Ok(json!({"type": "opened"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::History(query) => match (host.ask)(&Request::History(query))? {
            Response::History { items } => Ok(json!({"type": "history", "items": items})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::Visits { url } => match (host.ask)(&Request::Visits { url })? {
            Response::Visits { times } => Ok(json!({"type": "visits", "times": times})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::DeleteHistory { visits } => {
            match (host.ask)(&Request::DeleteHistory { visits })? {
                Response::Deleted => Ok(json!({"type": "deleted"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::ClearBrowsingData(data) => {
            match (host.ask)(&Request::ClearBrowsingData(data))? {
                Response::Cleared => Ok(json!({"type": "cleared"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::SiteData => match (host.ask)(&Request::SiteData)? {
            Response::SiteData { sites } => Ok(json!({"type": "site_data", "sites": sites})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::ClearSiteData { host: site } => {
            match (host.ask)(&Request::ClearSiteData { host: site })? {
                Response::Cleared => Ok(json!({"type": "cleared"})),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::Monitors => match (host.ask)(&Request::Monitors)? {
            Response::Monitors { monitors } => {
                Ok(json!({"type": "monitors", "monitors": monitors}))
            }
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::Agents => match (host.ask)(&Request::Agents)? {
            Response::Agents { agents } => Ok(json!({"type": "agents", "agents": agents})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::StopAgent { session } => match (host.ask)(&Request::StopAgent { session })? {
            Response::Done => Ok(json!({"type": "done"})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::ForgetAgent { agent } => match (host.ask)(&Request::ForgetAgent { agent })? {
            Response::Done => Ok(json!({"type": "done"})),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::WebAgents => Ok(json!({
            "type": "web_agents",
            "status": host.web_status.and_then(crate::mcp::web::WebStatus::load),
            "signed_in": host.signed_in.map(crate::mcp::signed_in).unwrap_or_default(),
        })),
        AppRequest::DetailedLogging => match (host.ask)(&Request::LogLevels)? {
            Response::LogLevels { levels } => Ok(detailed(&levels)),
            other => Err(refusal_or_surprise(other)),
        },
        AppRequest::SetDetailedLogging { on } => {
            let request = match on {
                true => Request::SetLogLevel {
                    level: LogLevel::Debug,
                    subsystems: Vec::new(),
                },
                false => Request::ResetLogLevels,
            };
            match (host.ask)(&request)? {
                Response::LogLevels { levels } => Ok(detailed(&levels)),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::ExportLogs { redact } => {
            let folder = host
                .downloads
                .ok_or("HOME is not set, so there is no Downloads folder to save to")?;
            std::fs::create_dir_all(folder)
                .map_err(|why| format!("cannot make {}: {why}", folder.display()))?;
            let file = folder.join(crate::log_export::file_name(crate::recent_log::now()));
            match (host.ask)(&Request::ExportLogs { file, redact })? {
                Response::ExportedLogs { file, unhidden } => Ok(json!({
                    "type": "exported_logs",
                    "path": file,
                    "unhidden": unhidden,
                })),
                other => Err(refusal_or_surprise(other)),
            }
        }
        AppRequest::OpenDownloads => {
            let folder = host
                .downloads
                .ok_or("HOME is not set, so there is no Downloads folder to open")?;
            (host.open)(folder)?;
            Ok(json!({"type": "opened"}))
        }
        AppRequest::SignOutWebAgent { client } => {
            let path = host
                .signed_in
                .ok_or("there is no state directory to sign agents out of")?;
            crate::mcp::sign_out(path, &client)
                .map_err(|why| format!("could not sign {client} out: {why}"))?;
            Ok(json!({"type": "done"}))
        }
        AppRequest::RetryWebAgents => {
            let path = host
                .web_status
                .ok_or("XDG_RUNTIME_DIR is not set, so there is no desk to ask")?;
            crate::mcp::web::retry_now(path)
                .map_err(|why| format!("could not ask the desk to try again: {why}"))?;
            Ok(json!({"type": "done"}))
        }
    }
}

/// `directory` with a leading `~` or `~/` expanded, refused unless absolute:
/// the engine does not share the app's idea of a working directory.
fn absolute(directory: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    let expanded = match (directory.strip_prefix("~"), home) {
        (Ok(rest), Some(home)) => home.join(rest),
        (Ok(_), None) => return Err("HOME is not set, so ~ names no folder".to_string()),
        (Err(_), _) => directory.to_path_buf(),
    };
    match expanded.is_absolute() {
        true => Ok(expanded),
        false => Err(format!(
            "{} is not a folder this host can find: write an absolute path, or one under ~",
            directory.display()
        )),
    }
}

/// Which files the desktop edits, asked fresh each time so a page can never
/// name one.
fn settings_files(host: &Host) -> Result<SettingsFiles, String> {
    match (host.ask)(&Request::SettingsFiles)? {
        Response::SettingsFiles { files } => Ok(files),
        other => Err(refusal_or_surprise(other)),
    }
}

/// A file's path, text and whether it can be written, or null for none.
fn file(path: Option<&Path>, host: &Host) -> Result<Value, String> {
    path.map(|path| {
        Ok(json!({
            "path": path,
            "text": read(path, host)?,
            "writable": (host.writable)(path),
        }))
    })
    .transpose()
    .map(|found| found.unwrap_or(Value::Null))
}

/// `extension` as the Settings app takes it: its icon as a `data:` URL in
/// place of the icon's path, since the app cannot read files. Null when it has
/// no icon, or the icon cannot be read, so the app draws its own placeholder.
fn with_icon(extension: InstalledExtension, host: &Host) -> Value {
    let icon = extension
        .icon_path
        .as_deref()
        .and_then(|path| icon_data_url(Path::new(path), host));
    let mut value = json!(extension);
    if let Some(entry) = value.as_object_mut() {
        entry.remove("icon_path");
        entry.insert("icon".to_string(), icon.map_or(Value::Null, Value::String));
    }
    value
}

/// The image at `path` as a `data:` URL, or `None` for a file that cannot be
/// read or is not an image a manifest may name.
fn icon_data_url(path: &Path, host: &Host) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    let bytes = (host.read_bytes)(path).ok()?;
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// Standard base64, with padding.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = chunk.iter().enumerate().fold(0_u32, |acc, (at, byte)| {
            acc | u32::from(*byte) << (16 - 8 * at)
        });
        for at in 0..4 {
            if at <= chunk.len() {
                let index = (triple >> (18 - 6 * at)) & 0x3f;
                encoded.push(char::from(ALPHABET[index as usize]));
            } else {
                encoded.push('=');
            }
        }
    }
    encoded
}

fn read(path: &Path, host: &Host) -> Result<String, String> {
    (host.read)(path).map_err(|why| format!("cannot read {}: {why}", path.display()))
}

/// [`read`], or `None` when there is no file.
fn read_if_there(path: &Path, host: &Host) -> Result<Option<String>, String> {
    match (host.read)(path) {
        Ok(text) => Ok(Some(text)),
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(why) => Err(format!("cannot read {}: {why}", path.display())),
    }
}

/// Writes `text` to `path`, refusing a read-only file, a JSON config the
/// compositor would refuse, and one whose `shell_options` the declaration at
/// `options` refuses.
fn write(
    path: &Path,
    target: Target,
    text: &str,
    options: Option<&Path>,
    host: &Host,
) -> Result<(), String> {
    if !(host.writable)(path) {
        return Err(format!("{} is read-only", path.display()));
    }
    if matches!(target, Target::Config) && !is_module(path) {
        let config = Config::parse(text)
            .map_err(|why| format!("the compositor would refuse this: {why}"))?;
        if let Some(declared) = options
            .map(|options| read_if_there(options, host))
            .transpose()?
        {
            check_shell_options(&config, path, declared.as_deref(), host)?;
        }
    }
    (host.write)(path, text).map_err(|why| format!("cannot write {}: {why}", path.display()))
}

/// Refuses `config` when it gives the shell's options values the declaration
/// `declared` refuses, except ones the file at `path` already gave: a shell
/// that drops an option leaves it in the file, and refusing every write for it
/// would leave the form unable to change anything.
fn check_shell_options(
    config: &Config,
    path: &Path,
    declared: Option<&str>,
    host: &Host,
) -> Result<(), String> {
    let Some(declared) = declared else {
        return Ok(());
    };
    // A file that does not read or parse gave no options.
    let before = match (host.read)(path)
        .ok()
        .and_then(|text| Config::parse(&text).ok())
    {
        Some(before) => problems(declared, &before.shell_options)?,
        None => Vec::new(),
    };
    let added: Vec<String> = problems(declared, &config.shell_options)?
        .into_iter()
        .filter(|problem| !before.contains(problem))
        .collect();
    match added.is_empty() {
        true => Ok(()),
        false => Err(format!(
            "the shell would drop these options: {}",
            added.join("; ")
        )),
    }
}

/// The desktop's own refusal, or a note that it answered another question.
fn refusal_or_surprise(response: Response) -> String {
    match response {
        Response::Refused { why } => why,
        other => format!("the desktop answered {other:?}, which was not asked"),
    }
}

/// The directories to watch for edits to `files`: each file's own.
pub fn watched(files: &SettingsFiles) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = [files.config.as_deref(), files.shell.as_deref()]
        .into_iter()
        .flatten()
        .filter_map(|file| file.parent().map(Path::to_path_buf))
        .collect();
    directories.sort();
    directories.dedup();
    directories
}
