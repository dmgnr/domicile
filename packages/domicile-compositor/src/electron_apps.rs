//! Writes the desktop entries that run the config's `electron.apps` on the
//! engine, at startup and on each reload that changes the list. See
//! `domicile_host::electron_entries`.

use std::path::{Path, PathBuf};

use tracing::{error, info};

use domicile_host::data_dirs::data_dirs;
use domicile_host::electron_entries::write_electron_entries;

/// Writes the entries for `apps` into `out`, from the entries this
/// compositor's data directories hold, less `out`'s own.
///
/// An app without an entry, or whose entry is in the data home where no copy
/// can override it, is logged as an error: starting it runs its own Electron.
pub fn write_the_electron_entries(out: &Path, apps: &[String]) {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs = data_dirs(
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("XDG_DATA_DIRS"),
        home.as_deref(),
    );
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|set| !set.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".local/share")))
        .map(|dir| dir.join("applications"));
    let applications: Vec<PathBuf> = dirs
        .iter()
        .filter(|dir| dir.as_path() != out)
        .map(|dir| dir.join("applications"))
        .collect();
    match write_electron_entries(apps, &applications, data_home.as_deref(), out) {
        Ok(written) => {
            if !written.written.is_empty() {
                info!(apps = ?written.written, "these Electron apps start on the engine");
            }
            for id in written.missing {
                error!(
                    "electron.apps lists {id}, but no data directory has that desktop \
                     entry, so nothing runs it on the engine"
                );
            }
            for (id, entry) in written.shadowed {
                error!(
                    "electron.apps lists {id}, but {} comes before every other data \
                     directory, so starting {id} runs its own Electron. Remove it, or \
                     run `domicile open --electron {id}` from it",
                    entry.display()
                );
            }
        }
        Err(why) => error!(
            "cannot write the entries that run electron.apps on the engine in {}: {why}",
            out.display()
        ),
    }
}
