//! What the launcher's file index leaves out of the home directory.
//!
//! The index walks the whole home (see `domicile_host::home_walk`), which can
//! include mail stores and build directories. The config omits paths with
//! globs relative to the home. See `docs/LAUNCHER.md#files`.

use globset::{Glob, GlobBuilder, GlobMatcher};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// What the file index is built from.
// `PartialEq` lets a reload detect a change; see the compositor's
// `Restatement`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct FilesConfig {
    pub omit: Omit,
}

/// The paths the file index leaves out, and everything under them.
///
/// Patterns follow gitignore's rules:
/// - Each is a glob over a path relative to the home. `*` stops at `/`; `**`
///   does not.
/// - A pattern starting with `!` takes a path back.
/// - The last matching pattern wins.
/// - An omitted directory is not walked, so nothing under it can be taken
///   back.
///
/// The default is `**/.*`, which omits hidden paths. A configured list
/// replaces the default.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(try_from = "Vec<String>", into = "Vec<String>")]
// Renamed in the schema so the generated TypeScript does not shadow `Omit`.
#[schemars(with = "Vec<String>", rename = "FilesOmit")]
pub struct Omit {
    /// The patterns as written, for [`PartialEq`]. Two lists that match the
    /// same paths compare unequal, which costs one extra walk on reload.
    written: Vec<String>,
    rules: Vec<Rule>,
}

impl From<Omit> for Vec<String> {
    fn from(omit: Omit) -> Self {
        omit.written
    }
}

/// One pattern, compiled.
#[derive(Debug, Clone)]
struct Rule {
    /// Whether this pattern takes paths back rather than leaving them out.
    keeps: bool,
    glob: GlobMatcher,
}

impl Omit {
    /// Whether `path`, named relative to the home, is left out of the index.
    ///
    /// Checks only `path` itself, not its ancestors. A walk never enters an
    /// omitted directory, but a watch must test each ancestor of a changed
    /// path.
    pub fn omits(&self, path: &str) -> bool {
        self.rules
            .iter()
            .rev()
            .find(|rule| rule.glob.is_match(path))
            .is_some_and(|rule| !rule.keeps)
    }
}

impl Default for Omit {
    fn default() -> Self {
        Omit::try_from(vec!["**/.*".to_string()]).expect("the default pattern is a glob")
    }
}

impl PartialEq for Omit {
    fn eq(&self, other: &Self) -> bool {
        self.written == other.written
    }
}

impl Eq for Omit {}

impl TryFrom<Vec<String>> for Omit {
    type Error = globset::Error;

    fn try_from(written: Vec<String>) -> Result<Self, Self::Error> {
        let rules = written
            .iter()
            .map(|pattern| {
                let (keeps, glob) = match pattern.strip_prefix('!') {
                    Some(glob) => (true, glob),
                    None => (false, pattern.as_str()),
                };
                Ok(Rule {
                    keeps,
                    glob: compiled(glob)?.compile_matcher(),
                })
            })
            .collect::<Result<_, globset::Error>>()?;
        Ok(Omit { written, rules })
    }
}

/// `pattern` as a glob whose `*` stops at `/`, so `*/*` means two levels
/// deep and no more.
fn compiled(pattern: &str) -> Result<Glob, globset::Error> {
    GlobBuilder::new(pattern).literal_separator(true).build()
}
