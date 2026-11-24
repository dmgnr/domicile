//! Finds the compositor and engine next to the `domicile` binary.
//!
//! ```text
//! <prefix>/bin/domicile
//! <prefix>/bin/domicile-compositor
//! <prefix>/libexec/domicile/engine     the Chromium tree, `chrome` inside it
//! ```
//!
//! `current_exe` resolves symlinks, so a binary run from `~/.nix-profile`
//! finds its siblings in the store.

use std::path::{Path, PathBuf};

/// A component missing next to the binary and not set in the environment.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "no {what} at {}, and {variable} is not set. The components ship beside \
     `domicile`; set {variable} to point at one built somewhere else.",
    .looked.display()
)]
pub struct Missing {
    pub what: &'static str,
    pub looked: PathBuf,
    pub variable: &'static str,
}

/// Paths to the engine and compositor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Components {
    /// The directory holding `chrome`.
    pub engine: PathBuf,
    pub compositor: PathBuf,
}

/// Resolves both components from the running binary's path.
///
/// Paths from the environment are not checked: a build may not have produced
/// them yet, and a failure to run them reports a better error.
pub fn components(
    binary: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<Components, Missing> {
    let bin = binary.parent().unwrap_or_else(|| Path::new("."));
    Ok(Components {
        compositor: one(
            "compositor",
            "DOMICILE_COMPOSITOR",
            bin.join("domicile-compositor"),
            env,
            exists,
        )?,
        engine: engine(binary, env, exists)?,
    })
}

/// The engine alone: `DOMICILE_ENGINE`, or `libexec/domicile/engine`.
pub fn engine(
    binary: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, Missing> {
    one(
        "engine",
        "DOMICILE_ENGINE",
        libexec(binary).join("engine"),
        env,
        exists,
    )
}

/// The shell builder: `DOMICILE_BUILDER`, or `libexec/domicile/builder`.
///
/// Separate from [`components`] so a prebuilt shell can run without one.
pub fn builder(
    binary: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, Missing> {
    one(
        "shell builder",
        "DOMICILE_BUILDER",
        libexec(binary).join("builder"),
        env,
        exists,
    )
}

/// What runs an Electron app's main process: `DOMICILE_ELECTRON_HOST`, or
/// `libexec/domicile/electron-host`. See `docs/architecture/ELECTRON-APPS.md`.
pub fn electron_host(
    binary: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, Missing> {
    one(
        "Electron app host",
        "DOMICILE_ELECTRON_HOST",
        libexec(binary).join("electron-host"),
        env,
        exists,
    )
}

/// The Perfetto install `domicile trace` records with, holding `bin/traced`
/// and `bin/perfetto`: `DOMICILE_PERFETTO`, or `libexec/domicile/perfetto`.
pub fn perfetto(
    binary: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, Missing> {
    one(
        "Perfetto",
        "DOMICILE_PERFETTO",
        libexec(binary).join("perfetto"),
        env,
        exists,
    )
}

/// The directory of Domicile's prebuilt shell `name`, under
/// `DOMICILE_SHELLS` or `libexec/domicile/shells`.
pub fn our_shell(
    binary: &Path,
    name: &str,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, Missing> {
    let shells = env("DOMICILE_SHELLS")
        .map(PathBuf::from)
        .unwrap_or_else(|| libexec(binary).join("shells"));
    let root = shells.join(name);
    if exists(&root.join("shell.js")) {
        Ok(root)
    } else {
        Err(Missing {
            looked: root,
            variable: "DOMICILE_SHELLS",
            what: "shell of Domicile's by that name",
        })
    }
}

/// The entry module of Domicile's own app `name`, `<name>/<name>.js` in
/// `DOMICILE_APP_MODULES` or `libexec/domicile/app-modules`. See
/// `docs/architecture/APP-MODULES.md`.
pub fn app_module(
    binary: &Path,
    name: &str,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, Missing> {
    let root = match env("DOMICILE_APP_MODULES") {
        Some(named) => PathBuf::from(named).join(name),
        None => one(
            "app of Domicile's by that name",
            "DOMICILE_APP_MODULES",
            libexec(binary).join("app-modules").join(name),
            env,
            exists,
        )?,
    };
    Ok(root.join(format!("{name}.js")))
}

/// The file naming the installed version and commit: `libexec/domicile/version`.
/// `flake.nix` and `packages/distro/stage.sh` write it.
pub fn version_file(binary: &Path) -> PathBuf {
    libexec(binary).join("version")
}

/// The `libexec/domicile` directory next to `binary`'s `bin`.
fn libexec(binary: &Path) -> PathBuf {
    binary
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."))
        .join("libexec")
        .join("domicile")
}

/// The path from `variable`, or `beside` if it exists.
fn one(
    what: &'static str,
    variable: &'static str,
    beside: PathBuf,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, Missing> {
    match env(variable) {
        Some(named) => Ok(PathBuf::from(named)),
        None if exists(&beside) => Ok(beside),
        None => Err(Missing {
            looked: beside,
            variable,
            what,
        }),
    }
}
