//! Classifies a shell argument: a module, an entry to build, one of
//! Domicile's shells, or a package to install.
//!
//! ```text
//! domicile load-shell /path/to/bundle.js      a module, served as it is
//! domicile load-shell ./entry.ts              an entry, built
//! domicile load-shell @domicile-desktop/manganese     Domicile's own, prebuilt
//! domicile load-shell github:me/my-shell      a package, installed and built
//! ```
//!
//! Only an entry or a package needs the builder. Prebuilt shells start
//! without bun or network access.

use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;

use crate::shell_manifest::is_declared_shell;
use crate::shell_path::{located_module, Shell, ShellPathError};

/// Where a shell comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellSource {
    /// A built module, served as it is.
    Module(Shell),
    /// A TypeScript or JavaScript entry the builder bundles. Absolute.
    Entry(PathBuf),
    /// One of Domicile's own shells, by name: `manganese` for
    /// `@domicile-desktop/manganese`. Prebuilt in Domicile's install.
    Ours(String),
    /// An npm package or a `github:` repository the builder installs.
    Package(String),
}

/// The scope Domicile's own shells are named under.
const OURS: &str = "@domicile-desktop/";

/// Classifies `argument`.
///
/// Paths follow [`shell_module`](crate::shell_path::shell_module)'s rules. `read` returns a file's text, used
/// to tell a bundle from a JavaScript entry. A module the nearest
/// `package.json` names in `"domicile": { "shell": ... }` is prebuilt and
/// never built.
pub fn shell_source(
    argument: &str,
    handed_in: Option<&str>,
    here: &Path,
    home: Option<&Path>,
    exists: &dyn Fn(&Path) -> Option<bool>,
    read: &dyn Fn(&Path) -> Option<String>,
) -> Result<ShellSource, ShellPathError> {
    if handed_in.is_none() {
        if let Some(name) = argument.strip_prefix(OURS) {
            // `@domicile-desktop/shell-simple` is the workspace name of the
            // `simple` shell.
            return Ok(ShellSource::Ours(
                name.strip_prefix("shell-").unwrap_or(name).to_string(),
            ));
        }
        if is_package(argument, here, exists) {
            return Ok(ShellSource::Package(argument.to_string()));
        }
    }
    let (shell, declared) = located_module(argument, handed_in, here, home, exists, read)?;
    let file = shell.root.join(&shell.module);
    Ok(
        if !declared && !is_declared_shell(&file, read)? && needs_building(&file, read) {
            ShellSource::Entry(file)
        } else {
            ShellSource::Module(shell)
        },
    )
}

/// Whether `argument` names a package: a `github:` or `npm:` prefix, a scope,
/// or a bare word that does not exist under `here`.
fn is_package(argument: &str, here: &Path, exists: &dyn Fn(&Path) -> Option<bool>) -> bool {
    argument.starts_with("github:")
        || argument.starts_with("npm:")
        || argument.starts_with('@')
        || (!argument.contains('/')
            && !argument.starts_with('.')
            && !argument.starts_with('~')
            && exists(&here.join(argument)).is_none())
}

/// Whether the file at `file` has to be built before it is served.
///
/// TypeScript and JSX always do. JavaScript does when it imports a package
/// by name, which a browser cannot resolve, or when it does not parse as a
/// module: it may hold JSX, and otherwise the builder reports the error.
fn needs_building(file: &Path, read: &dyn Fn(&Path) -> Option<String>) -> bool {
    match file.extension().and_then(|extension| extension.to_str()) {
        Some("ts" | "tsx" | "mts" | "jsx") => true,
        Some("js" | "mjs") => read(file).is_some_and(|text| imports_a_package(&text)),
        _ => false,
    }
}

/// Whether the module `text` imports a package by name, or does not parse.
///
/// Reads only real `import` and `export ... from` declarations and `import()`
/// calls on a string, never strings or comments that look like them.
pub fn imports_a_package(text: &str) -> bool {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, text, SourceType::mjs()).parse();
    if parsed.fatal_error || parsed.diagnostics.has_errors() {
        return true;
    }
    let record = &parsed.module_record;
    record
        .requested_modules
        .keys()
        .any(|specifier| is_bare(specifier))
        || record
            .dynamic_imports
            .iter()
            .any(|import| literal(import.module_request.source_text(text)).is_some_and(is_bare))
}

/// The text of `expression` when it is a string literal or a template without
/// substitutions.
fn literal(expression: &str) -> Option<&str> {
    let quote = expression
        .chars()
        .next()
        .filter(|c| matches!(c, '"' | '\'' | '`'))?;
    let inner = expression.strip_prefix(quote)?.strip_suffix(quote)?;
    (quote != '`' || !inner.contains("${")).then_some(inner)
}

/// Whether a browser cannot resolve `specifier`: it is not relative,
/// absolute or a URL.
fn is_bare(specifier: &str) -> bool {
    !specifier.is_empty()
        && !specifier.starts_with('.')
        && !specifier.starts_with('/')
        && !specifier.contains("://")
        && !specifier.starts_with("data:")
}
