//! The host Domicile's apps spawn. An app spawns it, with the compositor's
//! environment, and it stops when its stdin closes.
//!
//! The protocol is in `domicile_launch::app_host`; this file reads the
//! environment, the files and the sockets. See `docs/SETTINGS.md` and
//! `docs/HISTORY.md`.

use std::ffi::CString;
use std::io::Write;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use domicile_launch::app_host::{answer, read_message, watched, write_message, Host};
use domicile_launch::control::{Request, Response};
use domicile_launch::control_socket::{advertised, ask, PATIENCE, VARIABLE};
use domicile_launch::folder_chooser::choose_folder;
use domicile_launch::history::CLEAR_WITHIN;
use domicile_launch::notification::session_bus;
use notify::Watcher as _;
use serde_json::json;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        // stdout carries the replies to the app, so errors go to stderr.
        Err(why) => {
            eprintln!("domicile-app-host: {why}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    // The desktop waits up to PATIENCE on the engine for most requests, and
    // up to CLEAR_WITHIN to clear browsing data.
    let asking = |request: &Request| {
        let patience = match request {
            Request::ClearBrowsingData(_) => CLEAR_WITHIN + PATIENCE,
            Request::ExportLogs { .. } => domicile_launch::log_export::EXPORT_WITHIN,
            _ => PATIENCE * 2,
        };
        ask(&socket, request, Some(patience)).map_err(|why| why.to_string())
    };
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let _watching = watching(&asking, Arc::clone(&output))?;

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let env = |name: &str| std::env::var(name).ok();
    let web_status = domicile_launch::mcp::web::status_file(&env);
    let signed_in = domicile_launch::profile_path::state_directory(&env)
        .map(|directory| directory.join(domicile_launch::mcp::SIGNED_IN_FILE));
    // Where `xdg-user-dirs` names the Downloads folder.
    let user_dirs = env("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".config")))
        .and_then(|config| std::fs::read_to_string(config.join("user-dirs.dirs")).ok());
    let downloads =
        domicile_launch::app_host::downloads(&env, user_dirs.as_deref(), home.as_deref());
    let host = Host {
        ask: &asking,
        home: home.as_deref(),
        choose_folder: &|| {
            let bus =
                session_bus().map_err(|why| format!("cannot reach the session bus: {why}"))?;
            choose_folder(&bus, "Load an unpacked extension")
        },
        read: &|path| std::fs::read_to_string(path),
        read_bytes: &|path| std::fs::read(path),
        writable: &writable,
        write: &|path, text| std::fs::write(path, text),
        web_status: web_status.as_deref(),
        signed_in: signed_in.as_deref(),
        downloads: downloads.as_deref(),
        // `domicile open`, beside this binary, picks the folder's handler.
        open: &|folder| {
            let domicile = std::env::current_exe()
                .map_err(|why| format!("cannot find myself: {why}"))?
                .with_file_name("domicile");
            let status = std::process::Command::new(&domicile)
                .arg("open")
                .arg(folder)
                .status()
                .map_err(|why| format!("cannot run {}: {why}", domicile.display()))?;
            match status.success() {
                true => Ok(()),
                false => Err(format!("domicile open {} {status}", folder.display())),
            }
        },
    };
    let mut input = std::io::stdin().lock();
    while let Some(message) =
        read_message(&mut input).map_err(|why| format!("cannot read the app: {why}"))?
    {
        let reply = answer(&message, &host);
        say(&output, &reply)?;
    }
    Ok(())
}

/// Tells the app `{"type":"changed"}` whenever a settings file changes on
/// disk, so an edit elsewhere shows in the app.
///
/// Watches each file's directory without recursing: a file is often replaced
/// by a rename, and its directory may be as large as the Nix store.
fn watching(
    asking: &dyn Fn(&Request) -> Result<Response, String>,
    output: Arc<Mutex<std::io::Stdout>>,
) -> Result<notify::RecommendedWatcher, String> {
    let files = match asking(&Request::SettingsFiles)? {
        Response::SettingsFiles { files } => files,
        other => return Err(format!("the desktop answered {other:?} for its files")),
    };
    let edited: Vec<PathBuf> = [files.config.clone(), files.shell.clone()]
        .into_iter()
        .flatten()
        .collect();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let event = match event {
            Ok(event) => event,
            // The app still answers; it just misses edits made elsewhere.
            Err(why) => {
                eprintln!("domicile-app-host: a watch failed: {why}");
                return;
            }
        };
        let changed = event.kind.is_create() || event.kind.is_modify() || event.kind.is_remove();
        if changed && event.paths.iter().any(|path| edited.contains(path)) {
            if let Err(why) = say(&output, &json!({"type": "changed"})) {
                eprintln!("domicile-app-host: {why}");
            }
        }
    })
    .map_err(|why| format!("cannot watch the settings files: {why}"))?;
    for directory in watched(&files) {
        watcher
            .watch(&directory, notify::RecursiveMode::NonRecursive)
            .map_err(|why| format!("cannot watch {}: {why}", directory.display()))?;
    }
    Ok(watcher)
}

/// Sends one message to the app. Replies and change notices share stdout.
fn say(output: &Mutex<std::io::Stdout>, message: &serde_json::Value) -> Result<(), String> {
    let mut output = output.lock().expect("no writer panics holding stdout");
    write_message(&mut *output, message)
        .and_then(|()| output.flush())
        .map_err(|why| format!("cannot answer the app: {why}"))
}

/// Whether this user may write `path`, following links: a link into the Nix
/// store is read-only.
fn writable(path: &Path) -> bool {
    let path = CString::new(path.as_os_str().as_bytes()).expect("a path has no NUL byte");
    // SAFETY: `path` is a NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}
