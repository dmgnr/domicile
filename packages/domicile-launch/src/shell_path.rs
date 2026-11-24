//! Resolves the shell argument to a JavaScript module to load.
//!
//! The argument is either a path to a built module, or a name a packaged
//! desktop passes along with the module in `DOMICILE_PAGE`. The filesystem is
//! injected so the rules can be tested.
//!
//! The path is made absolute up front (see `resolved`), so the engine, the
//! output of `domicile which-shell` and the log all show the same path.

use std::path::{Path, PathBuf};

use crate::shell_manifest::declared_shell;

/// A built shell, split into the directory to serve and the module in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shell {
    /// The module's directory, served over `domicile://shell/`. Absolute. The
    /// page can reach nothing outside it. With [`ShellFiles::DevServer`], the
    /// dev server's socket instead.
    pub root: PathBuf,
    /// The module, relative to `root` because it goes in a `<script src>`.
    pub module: PathBuf,
    /// Where the engine reads the shell's files.
    pub files: ShellFiles,
}

/// Where the engine reads a shell's files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFiles {
    /// Out of the root, a directory.
    Directory,
    /// From the dev server listening on the root, a unix socket: `domicile
    /// dev` serves an entry with hot module replacement.
    DevServer,
}

/// The shell argument could not be resolved to a module.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ShellPathError {
    #[error(
        "given both a page and a path to one, and they are not the same \
         instruction: DOMICILE_PAGE={page}, the argument {argument}. Pass one."
    )]
    TwoPages { page: String, argument: String },
    #[error("no shell at '{0}' — it is neither a file nor a directory")]
    NotThere(String),
    #[error(
        "'{0}' is a directory, and a shell is one built JavaScript module. \
         Name the module itself — `domicile {0}/shell.js`, if that is what \
         your build emitted — or name it in the directory's package.json: \
         `\"domicile\": {{ \"shell\": \"dist/shell.js\" }}`."
    )]
    Directory(String),
    #[error("cannot read {file}: {why}")]
    Manifest { file: String, why: String },
    #[error("{file} names {module} as its shell, and that is not a file")]
    NotAModule { file: String, module: String },
    #[error(
        "'{0}' starts at a home directory and HOME is not set, so there is \
         nowhere for it to start. Write the path out in full."
    )]
    NoHome(String),
}

/// Resolves the shell from the argument or `DOMICILE_PAGE` (`handed_in`).
///
/// `here` is the working directory and `home` expands `~`. `exists` returns
/// `Some(true)` for a directory, `Some(false)` for a file and `None` for
/// neither. `read` returns a file's text, for a directory's `package.json`.
/// Both inputs go through the same rules.
pub fn shell_module(
    argument: &str,
    handed_in: Option<&str>,
    here: &Path,
    home: Option<&Path>,
    exists: &dyn Fn(&Path) -> Option<bool>,
    read: &dyn Fn(&Path) -> Option<String>,
) -> Result<Shell, ShellPathError> {
    located_module(argument, handed_in, here, home, exists, read).map(|(shell, _)| shell)
}

/// [`shell_module`], and whether a directory's `package.json` named the
/// module, which makes it prebuilt.
pub(crate) fn located_module(
    argument: &str,
    handed_in: Option<&str>,
    here: &Path,
    home: Option<&Path>,
    exists: &dyn Fn(&Path) -> Option<bool>,
    read: &dyn Fn(&Path) -> Option<String>,
) -> Result<(Shell, bool), ShellPathError> {
    let named = if is_path(argument, handed_in, here, exists) {
        // A path argument and a handed-in module conflict. Neither is safe to
        // pick.
        if let Some(page) = handed_in {
            return Err(ShellPathError::TwoPages {
                argument: argument.to_string(),
                page: page.to_string(),
            });
        }
        argument
    } else {
        // A bare name needs a handed-in module; this program builds nothing.
        handed_in.ok_or_else(|| ShellPathError::NotThere(argument.to_string()))?
    };

    let path = resolved(named, here, home)?;
    // Errors show the resolved path, so a surprising `~` or relative path is
    // visible.
    match exists(&path) {
        Some(false) => Ok((file_shell(&path), false)),
        // A directory is never searched for a fixed file name: its
        // `package.json` names the module, as a package's does, or it is
        // refused.
        Some(true) => match declared_shell(&path, read)? {
            Some(module) if exists(&module) == Some(false) => Ok((file_shell(&module), true)),
            Some(module) => Err(ShellPathError::NotAModule {
                file: said(&path.join("package.json")),
                module: said(&module),
            }),
            None => Err(ShellPathError::Directory(said(&path))),
        },
        None => Err(ShellPathError::NotThere(said(&path))),
    }
}

/// The shell at `path`, which `exists` said is a file.
fn file_shell(path: &Path) -> Shell {
    root_and_module(path).expect(
        "`exists` said this names a file, and a path that names a file has \
         both a last component and something in front of it",
    )
}

/// Whether the argument is a path rather than a name.
///
/// A separator, `.`, `..` or a leading `~` always makes a path. A bare word is
/// a path only if it exists under `here` and no module was handed in.
/// Otherwise a packaged desktop's name would turn into a path whenever the
/// working directory held a matching entry.
fn is_path(
    argument: &str,
    handed_in: Option<&str>,
    here: &Path,
    exists: &dyn Fn(&Path) -> Option<bool>,
) -> bool {
    if argument.contains('/') || argument == "." || argument == ".." || argument.starts_with('~') {
        return true;
    }
    handed_in.is_none() && exists(&here.join(argument)).is_some()
}

/// Makes `named` absolute against `here`.
///
/// Expands `~` and `~/`, since `DOMICILE_PAGE` and quoted arguments arrive
/// unexpanded. `~user` is left as is. Drops `.` components for readable
/// output.
///
/// Keeps `..`: removing it lexically is wrong when the previous component is
/// a symlink.
fn resolved(named: &str, here: &Path, home: Option<&Path>) -> Result<PathBuf, ShellPathError> {
    let path = match named.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => home
            .ok_or_else(|| ShellPathError::NoHome(named.to_string()))?
            .join(rest.trim_start_matches('/')),
        Some(_) | None => PathBuf::from(named),
    };
    Ok(here.join(path).components().collect())
}

/// Formats a path for an error message.
fn said(path: &Path) -> String {
    path.display().to_string()
}

/// Splits an absolute file path into a [`Shell`].
///
/// `None` for a path with no file name, such as `/` or one ending in `..`.
/// The path must be absolute so the root is never empty.
fn root_and_module(path: &Path) -> Option<Shell> {
    Some(Shell {
        root: path.parent()?.to_path_buf(),
        module: PathBuf::from(path.file_name()?),
        files: ShellFiles::Directory,
    })
}
