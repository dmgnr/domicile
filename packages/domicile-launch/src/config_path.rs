//! Finds the compositor's config file when `--config` is not given.
//!
//! Looks for `domicile.{ts,tsx,js,mjs,json}` in `$XDG_CONFIG_HOME/domicile/`
//! or `~/.config/domicile/`.
//!
//! The compositor itself has no default paths (see [`crate::arguments`]).
//! `domicile` resolves the default here and passes it explicitly.
//! [`ConfigFile`] records how the path was chosen so the run can print it.

use std::path::{Path, PathBuf};

/// The config file for a run, and how it was chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigFile {
    /// Given by `--config`. Not checked for existence.
    Named(PathBuf),
    /// Found in the config directory.
    Found(PathBuf),
    /// None in this config directory.
    Absent(PathBuf),
    /// More than one in the config directory.
    Several(Vec<PathBuf>),
    /// No config home to search.
    Nowhere,
}

impl ConfigFile {
    /// The path for the compositor, or `None` for its defaults.
    pub fn path(&self) -> Option<&Path> {
        match self {
            Self::Named(path) | Self::Found(path) => Some(path),
            Self::Absent(_) | Self::Several(_) | Self::Nowhere => None,
        }
    }
}

impl std::fmt::Display for ConfigFile {
    /// Formats the value printed after `config: `.
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Named(path) => write!(out, "{}, because --config names it", path.display()),
            Self::Found(path) => write!(out, "{}", path.display()),
            Self::Absent(directory) => write!(
                out,
                "none -- no domicile.{{{}}} in {} -- so the compositor's defaults",
                EXTENSIONS.join(","),
                directory.display()
            ),
            Self::Several(paths) => write!(
                out,
                "more than one: {} -- remove all but one",
                paths
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Self::Nowhere => write!(
                out,
                "none -- neither XDG_CONFIG_HOME nor HOME is set, so there is \
                 nowhere to look -- so the compositor's defaults"
            ),
        }
    }
}

/// Resolves the config file for this run.
///
/// `flag` (`--config`) wins and is not checked; the compositor reports an
/// unreadable file. `exists` is only called for the default paths.
pub fn config_file(
    flag: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> ConfigFile {
    match flag {
        Some(path) => ConfigFile::Named(path.to_path_buf()),
        None => match config_home(env) {
            None => ConfigFile::Nowhere,
            Some(home) => {
                let directory = home.join(DIRECTORY);
                let found: Vec<PathBuf> = EXTENSIONS
                    .iter()
                    .map(|extension| directory.join(format!("{FILE}.{extension}")))
                    .filter(|path| exists(path))
                    .collect();
                match found.as_slice() {
                    [] => ConfigFile::Absent(directory),
                    [one] => ConfigFile::Found(one.clone()),
                    _ => ConfigFile::Several(found),
                }
            }
        },
    }
}

/// The config directory under the config home.
const DIRECTORY: &str = "domicile";

/// The config file name without its extension.
const FILE: &str = "domicile";

/// Config file extensions: modules to evaluate, or JSON.
const EXTENSIONS: [&str; 5] = ["ts", "tsx", "js", "mjs", "json"];

/// Whether the config at `path` is a module to evaluate rather than JSON.
pub fn is_module(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("ts" | "tsx" | "js" | "mjs")
    )
}

/// The user's config home: `XDG_CONFIG_HOME`, or `~/.config`.
///
/// Relative values are ignored, as the XDG spec requires.
fn config_home(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let absolute = |value: String| {
        let path = PathBuf::from(value);
        path.is_absolute().then_some(path)
    };
    env("XDG_CONFIG_HOME").and_then(absolute).or_else(|| {
        env("HOME")
            .and_then(absolute)
            .map(|home| home.join(".config"))
    })
}
