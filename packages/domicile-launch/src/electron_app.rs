//! Finds the installed Electron app `domicile open --electron` runs on the
//! engine: its `resources/` directory, from a desktop entry or a path. See
//! "Running an app" in `docs/architecture/ELECTRON-APPS.md`.
//!
//! An entry's `Exec` rarely names the Electron binary itself: packages wrap
//! it in scripts that set flags and variables (`makeWrapper` on NixOS, shell
//! scripts in `/usr/bin`). So the program is followed through symlinks and
//! through the paths a wrapper script, or a compiled wrapper, names until one of them is beside an
//! app: a directory holding `app.asar`, or an unpacked `app/`.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use domicile_host::mime_apps::launch_command;

use crate::electron_wrapper::compiled_wrapper_command;

/// How many wrapper scripts deep the program is followed. Packages wrap at
/// most two or three times; more is a script naming itself.
const WRAPPERS: usize = 6;

/// The largest file read as a wrapper script.
const SCRIPT_MAX: u64 = 4 << 20;

/// The status `electron-host` exits with when the app needs what the engine
/// doesn't do yet, such as Node in a page. The app then runs on its own
/// Electron. Matches `UNSUPPORTED_EXIT` in `packages/electron-host`.
pub const UNSUPPORTED_EXIT: i32 = 3;

/// An installed Electron app, ready for `electron-host`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElectronApp {
    /// The directory holding the app's `app.asar` or `app/`, which
    /// `electron-host` takes first.
    pub resources: PathBuf,
    /// The arguments the app's command gave its program, which the app's
    /// main reads from `process.argv`.
    pub args: Vec<String>,
    /// The app's own command, which runs it on its own Electron when the
    /// engine can't: the command given, else the entry's `Exec`. `None` for
    /// an app named by its path alone.
    pub fallback: Option<Vec<String>>,
}

/// Why no Electron app was found.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ElectronError {
    #[error(
        "no installed application has the desktop entry {id}. Name one by its \
         id, as in `domicile open --electron slack.desktop`, or by the path to \
         its install"
    )]
    NoEntry { id: String },
    #[error("cannot find {program}, which starts {target}, on PATH")]
    NoProgram { program: String, target: String },
    #[error("cannot read {path}: {why}")]
    Unreadable { path: String, why: String },
    #[error(
        "{target} doesn't look like an Electron app: nothing {from} leads to \
         holds an app.asar or an app/ directory"
    )]
    NotElectron { target: String, from: String },
}

/// The Electron app `target` names, relative to `here`.
///
/// - A target with a `/` is a path: the install directory, its `resources/`,
///   an `app.asar`, or a program in the install.
/// - Anything else is a desktop entry id, with or without `.desktop`, found
///   under `application_dirs`.
///
/// `command`, when not empty, is the app's whole command line, as a desktop
/// entry's `Exec` gave it: the fallback, and for an entry id, the program
/// followed instead of the entry's. Bare program names are looked up on
/// `path`, the `PATH` variable.
pub fn electron_app(
    target: &str,
    command: &[String],
    here: &Path,
    application_dirs: &[PathBuf],
    path: Option<&OsStr>,
) -> Result<ElectronApp, ElectronError> {
    let named_by_path = target.contains('/');
    let argv = match (command.is_empty(), named_by_path) {
        (false, _) => Some(command.to_vec()),
        (true, true) => None,
        (true, false) => {
            let name = target.strip_suffix(".desktop").unwrap_or(target);
            let argv = launch_command(name, application_dirs, None).ok_or_else(|| {
                ElectronError::NoEntry {
                    id: format!("{name}.desktop"),
                }
            })?;
            Some(own_command(argv))
        }
    };
    let start = match &argv {
        Some(argv) if !named_by_path => program(&argv[0], target, here, path)?,
        _ => here.join(target),
    };
    let start = fs::canonicalize(&start).map_err(|why| ElectronError::Unreadable {
        path: start.display().to_string(),
        why: why.to_string(),
    })?;
    let resources = resources(&start, WRAPPERS).ok_or_else(|| ElectronError::NotElectron {
        target: target.to_string(),
        from: start.display().to_string(),
    })?;
    Ok(ElectronApp {
        resources,
        args: argv
            .as_ref()
            .map(|argv| argv[1..].to_vec())
            .unwrap_or_default(),
        fallback: argv,
    })
}

/// The app's own command in `argv`, an entry's: the one after `--` when the
/// entry is the copy `electron.apps` wrote, which runs
/// `domicile open --electron <id> -- <its own Exec>`; else `argv`.
fn own_command(argv: Vec<String>) -> Vec<String> {
    let copied = argv.first().is_some_and(|program| {
        Path::new(program)
            .file_name()
            .is_some_and(|name| name == "domicile")
    }) && argv.get(1).is_some_and(|verb| verb == "open")
        && argv.get(2).is_some_and(|flag| flag == "--electron");
    match argv.iter().position(|word| word == "--") {
        Some(dashes) if copied && dashes + 1 < argv.len() => argv[dashes + 1..].to_vec(),
        _ => argv,
    }
}

/// Where `program`, which starts `target`, is: relative to `here` if it
/// has a `/`, else the first on `path`.
fn program(
    program: &str,
    target: &str,
    here: &Path,
    path: Option<&OsStr>,
) -> Result<PathBuf, ElectronError> {
    if program.contains('/') {
        return Ok(here.join(program));
    }
    path.into_iter()
        .flat_map(std::env::split_paths)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| ElectronError::NoProgram {
            program: program.to_string(),
            target: target.to_string(),
        })
}

/// The app directory `at` leads to, following up to `wrappers` scripts.
///
/// - A directory holding an app, or whose `resources/` does.
/// - An `.asar` file's directory.
/// - A program beside a `resources/` holding an app, as Electron's binary
///   is.
/// - A script or compiled wrapper, through each existing absolute path it
///   names, in order.
fn resources(at: &Path, wrappers: usize) -> Option<PathBuf> {
    if at.is_dir() {
        return [at.to_path_buf(), at.join("resources")]
            .into_iter()
            .find(|dir| holds_app(dir));
    }
    if at.extension().is_some_and(|ext| ext == "asar") {
        return at.parent().map(Path::to_path_buf);
    }
    if let Some(beside) = at.parent().map(|dir| dir.join("resources")) {
        if holds_app(&beside) {
            return Some(beside);
        }
    }
    if wrappers == 0 {
        return None;
    }
    let text = if let Some(command) = compiled_wrapper_command(at) {
        command
    } else {
        // Only a regular file small enough to be a script: never a device
        // such as /dev/zero, which a script may name.
        let meta = fs::metadata(at).ok()?;
        if !meta.is_file() || meta.len() > SCRIPT_MAX {
            return None;
        }
        let text = fs::read(at).ok()?;
        if !text.starts_with(b"#!") {
            return None;
        }
        String::from_utf8_lossy(&text).into_owned()
    };
    let named: Vec<PathBuf> = named_paths(&text)
        .filter_map(|named| fs::canonicalize(named).ok())
        .filter(|named| named != at)
        .collect();
    named
        .iter()
        .find_map(|named| resources(named, wrappers - 1))
}

/// Whether `dir` holds an Electron app as `resources/` does.
fn holds_app(dir: &Path) -> bool {
    dir.join("app.asar").is_file() || dir.join("app").join("package.json").is_file()
}

/// The absolute paths `script` names, in order: each run of path characters
/// that starts with `/`.
fn named_paths(script: &str) -> impl Iterator<Item = &str> + '_ {
    script
        .split(|c: char| !(c.is_ascii_alphanumeric() || "/._+-@%,~".contains(c)))
        .filter(|word| word.starts_with('/') && word.len() > 1)
        .map(|word| word.trim_end_matches('/'))
}

/// The name the app in `resources` gives itself: its package's
/// `productName`, else its `name`, as Electron's `app.getName()` does.
pub fn app_name(resources: &Path) -> Result<String, String> {
    let unpacked = resources.join("app").join("package.json");
    let package = if unpacked.is_file() {
        fs::read(&unpacked).map_err(|why| format!("cannot read {}: {why}", unpacked.display()))?
    } else {
        let asar = resources.join("app.asar");
        asar_package(&asar).map_err(|why| format!("cannot read {}: {why}", asar.display()))?
    };
    let package: serde_json::Value =
        serde_json::from_slice(&package).map_err(|why| format!("its package.json: {why}"))?;
    ["productName", "name"]
        .iter()
        .find_map(|key| package.get(key).and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| "its package.json has no productName or name".to_string())
}

/// The journal name for what the app `target` names, in `resources`, writes:
/// an entry's id, or for a path, the app's own name, else the path's file
/// name.
pub fn journal_name(target: &str, resources: &Path) -> String {
    match target.contains('/') {
        false => target
            .strip_suffix(".desktop")
            .unwrap_or(target)
            .to_string(),
        true => app_name(resources).unwrap_or_else(|_| {
            Path::new(target).file_name().map_or_else(
                || target.to_string(),
                |name| name.to_string_lossy().into_owned(),
            )
        }),
    }
}

/// The `package.json` an `app.asar` holds. The archive opens with a pickle
/// giving its header's size, then the header, a pickle holding a JSON
/// index whose offsets count from the header's end.
fn asar_package(asar: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(asar).map_err(|why| why.to_string())?;
    let word = |at: usize| -> Result<usize, String> {
        bytes
            .get(at..at + 4)
            .map(|word| u32::from_le_bytes(word.try_into().expect("four bytes")) as usize)
            .ok_or_else(|| "it ends inside its header".to_string())
    };
    let header_size = word(4)?;
    let json_size = word(12)?;
    let json = bytes
        .get(16..16 + json_size)
        .ok_or_else(|| "it ends inside its index".to_string())?;
    let index: serde_json::Value =
        serde_json::from_slice(json).map_err(|why| format!("its index: {why}"))?;
    let entry = &index["files"]["package.json"];
    let offset: usize = entry["offset"]
        .as_str()
        .and_then(|offset| offset.parse().ok())
        .ok_or_else(|| "its index has no package.json".to_string())?;
    let size = entry["size"]
        .as_u64()
        .ok_or_else(|| "its index gives package.json no size".to_string())? as usize;
    let start = 8 + header_size + offset;
    bytes
        .get(start..start + size)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| "it ends inside package.json".to_string())
}

/// The sizes an icon is looked for at in a package's own `hicolor` theme,
/// best first: big enough for a notification, small enough for the desktop
/// to take as a file.
const ICON_SIZES: [&str; 6] = ["128x128", "256x256", "96x96", "64x64", "48x48", "scalable"];

/// The icon a notification about the app `target` names draws, as `Notify`'s
/// `app_icon` takes it.
///
/// - An entry id's is its entry's `Icon`, under `application_dirs`.
/// - A path's is the `Icon` of the entry named like its program in the
///   nearest `share/applications` above it, else above `resources`: the
///   app's own package. It is that package's icon file when the package has
///   one, so it is drawn even where the desktop's icon theme lacks it.
pub fn app_icon(target: &str, resources: &Path, application_dirs: &[PathBuf]) -> String {
    let named_by_path = target.contains('/');
    if !named_by_path {
        let id = target.strip_suffix(".desktop").unwrap_or(target);
        return domicile_host::app_names::app(id, application_dirs).icon;
    }
    let program = Path::new(target).file_name().map_or_else(
        || target.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let package = Path::new(target)
        .ancestors()
        .chain(resources.ancestors())
        .find(|dir| dir.join("share/applications").is_dir());
    match package {
        Some(package) => {
            let icon =
                domicile_host::app_names::app(&program, &[package.join("share/applications")]).icon;
            icon_file(package, &icon).unwrap_or(icon)
        }
        None => program,
    }
}

/// `icon`'s file in `package`'s own `hicolor` theme or `pixmaps`, if it has
/// one. An absolute `icon` is a file already.
fn icon_file(package: &Path, icon: &str) -> Option<String> {
    if Path::new(icon).is_absolute() {
        return Some(icon.to_string());
    }
    let themed = ICON_SIZES.iter().flat_map(|size| {
        ["png", "svg"].map(|extension| {
            package.join(format!(
                "share/icons/hicolor/{size}/apps/{icon}.{extension}"
            ))
        })
    });
    themed
        .chain([package.join(format!("share/pixmaps/{icon}.png"))])
        .find(|file| file.is_file())
        .map(|file| file.display().to_string())
}
