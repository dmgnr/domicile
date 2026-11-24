//! The desktop entries that start the desk config's `electron.apps` on the
//! engine. See "Running an app" in `docs/architecture/ELECTRON-APPS.md`.
//!
//! Each is a copy of the app's own entry whose `Exec` lines run
//! `domicile open --electron <id> -- <the original Exec>`. They go in a
//! directory first on the desk's `XDG_DATA_DIRS`, so whatever starts the
//! entry by its id (a shell's launcher, a link through `domicile open` or GIO,
//! a press on a notification) starts it on the engine, with no shell
//! knowing. The original `Exec` stays as the fallback.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The line marking an entry as one of these, so a later write removes only
/// its own.
const MARK: &str = "X-Domicile-Electron=true";

/// Keys dropped from the copy. `DBusActivatable` would have GIO start the
/// app through its D-Bus service instead of `Exec`, and `TryExec` names the
/// app's program, which `domicile` replaces.
const DROPPED: [&str; 2] = ["DBusActivatable", "TryExec"];

/// The entry `entry`, desktop file id `id`, with each `Exec` line in any
/// group running it through `domicile open --electron`, marked as written
/// here.
pub fn on_the_engine(entry: &str, id: &str) -> String {
    let mut out = String::with_capacity(entry.len() + 64);
    for line in entry.lines() {
        let trimmed = line.trim_start();
        let key = trimmed.split('=').next().unwrap_or_default().trim_end();
        if DROPPED.contains(&key) {
            continue;
        }
        match (key, trimmed.split_once('=')) {
            ("Exec", Some((_, exec))) => {
                out.push_str(&format!(
                    "Exec=domicile open --electron {id} -- {}\n",
                    exec.trim_start()
                ));
            }
            _ => {
                out.push_str(line);
                out.push('\n');
            }
        }
        if trimmed == "[Desktop Entry]" {
            out.push_str(MARK);
            out.push('\n');
        }
    }
    out
}

/// What [`write_electron_entries`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Written {
    /// The ids written.
    pub written: Vec<String>,
    /// The ids no directory has an entry for.
    pub missing: Vec<String>,
    /// The ids whose own entry is in the data home, which comes before every
    /// `XDG_DATA_DIRS` directory, so the copy is never read. Each with the
    /// entry that wins.
    pub shadowed: Vec<(String, PathBuf)>,
}

/// Writes [`on_the_engine`] copies of `apps`, desktop file ids, into
/// `out/applications`, and removes the copies it wrote before for any other
/// id.
///
/// Each app's entry is the first `<dir>/<id>` of `application_dirs`, highest
/// priority first, which must not include `out`'s. `data_home` is the data
/// home's `applications` directory, whose entries the copies can't override.
/// An id without `.desktop` has it added.
pub fn write_electron_entries(
    apps: &[String],
    application_dirs: &[PathBuf],
    data_home: Option<&Path>,
    out: &Path,
) -> io::Result<Written> {
    let applications = out.join("applications");
    fs::create_dir_all(&applications)?;
    let ids: Vec<String> = apps
        .iter()
        .map(|app| match app.ends_with(".desktop") {
            true => app.clone(),
            false => format!("{app}.desktop"),
        })
        .collect();
    for listed in fs::read_dir(&applications)? {
        let path = listed?.path();
        let ours = fs::read_to_string(&path)
            .map(|text| text.lines().any(|line| line == MARK))
            .unwrap_or(false);
        let kept = path
            .file_name()
            .is_some_and(|name| ids.iter().any(|id| name == id.as_str()));
        if ours && !kept {
            fs::remove_file(&path)?;
        }
    }
    let mut written = Written::default();
    for id in ids {
        let found = application_dirs
            .iter()
            .map(|dir| dir.join(&id))
            .find(|path| path.is_file());
        match found {
            None => written.missing.push(id),
            Some(path) => {
                if data_home.is_some_and(|home| path.parent() == Some(home)) {
                    written.shadowed.push((id.clone(), path.clone()));
                }
                let entry = fs::read_to_string(&path)?;
                fs::write(applications.join(&id), on_the_engine(&entry, &id))?;
                written.written.push(id);
            }
        }
    }
    Ok(written)
}
