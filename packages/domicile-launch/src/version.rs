//! What `domicile --version` says about the engine, from the `PROVENANCE`
//! file its release tarball carries (`.github/scripts/engine-release-package.sh`).

/// A `PROVENANCE` that does not say what `--version` prints.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VersionError {
    #[error("the engine's PROVENANCE has no \"{field}:\" line")]
    NoField { field: &'static str },
}

/// The engine's line: its series, build flavor, Chromium pin, the commit it
/// was built at, and when.
pub fn engine(provenance: &str) -> Result<String, VersionError> {
    let field = |field: &'static str| {
        provenance
            .lines()
            .find_map(|line| line.strip_prefix(field)?.strip_prefix(':'))
            .map(str::trim)
            .ok_or(VersionError::NoField { field })
    };
    let identity = field("series identity")?;
    let commit = field("domicile commit")?;
    let flavor = field("build")?
        .split_whitespace()
        .next()
        .ok_or(VersionError::NoField { field: "build" })?;
    Ok(format!(
        "engine   s{}, {flavor} build of Chromium {} at {}, built {}",
        prefix(identity),
        field("chromium pin")?,
        prefix(commit),
        field("built")?,
    ))
}

/// The first twelve characters, as release names and versions shorten hashes.
fn prefix(hash: &str) -> &str {
    &hash[..hash.len().min(12)]
}
