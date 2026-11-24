//! Reads the prebuilt module a shell's `package.json` names, as in
//! `"domicile": { "shell": "dist/shell.js" }`, as the builder does for an
//! installed package.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::shell_path::ShellPathError;

#[derive(Deserialize)]
struct Manifest {
    domicile: Option<Domicile>,
}

#[derive(Deserialize)]
struct Domicile {
    shell: Option<String>,
}

/// The module the `package.json` in `directory` names, absolute.
///
/// `None` when there is no `package.json` or it names no shell. Refuses one
/// that does not parse.
pub fn declared_shell(
    directory: &Path,
    read: &dyn Fn(&Path) -> Option<String>,
) -> Result<Option<PathBuf>, ShellPathError> {
    let file = directory.join("package.json");
    let Some(text) = read(&file) else {
        return Ok(None);
    };
    let refused = |why: String| ShellPathError::Manifest {
        file: file.display().to_string(),
        why,
    };
    let manifest: Manifest = serde_json::from_str(&text).map_err(|why| refused(why.to_string()))?;
    Ok(manifest
        .domicile
        .and_then(|domicile| domicile.shell)
        .map(|shell| directory.join(shell).components().collect()))
}

/// Whether the nearest `package.json` above `file` names it as its shell.
pub fn is_declared_shell(
    file: &Path,
    read: &dyn Fn(&Path) -> Option<String>,
) -> Result<bool, ShellPathError> {
    let Some(project) = file
        .ancestors()
        .skip(1)
        .find(|directory| read(&directory.join("package.json")).is_some())
    else {
        return Ok(false);
    };
    Ok(declared_shell(project, read)?.as_deref() == Some(file))
}
