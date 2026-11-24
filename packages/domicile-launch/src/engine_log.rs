//! Turns the engine's stderr into journal entries.
//!
//! Chromium starts each line with `[pid:tid:time:LEVEL:file:line]`. The level
//! becomes the entry's priority and the file and line its `CODE_FILE` and
//! `CODE_LINE`. The shell's `console` lines go under `domicile-shell`, so a
//! shell author reads them apart from the engine's, and those the SDK's
//! `logger` wrote carry its subsystem as `DOMICILE_SUBSYSTEM`.
//!
//! Every process the engine forks writes to the same stderr, so the pid is
//! kept as `DOMICILE_PID`: journald's own `_PID` is the launcher's.

use std::sync::RwLock;

use domicile_protocol::LogLevels;

use crate::engine_log_levels::Gate;
use crate::journal::{Entry, Priority};

/// The name the engine's entries carry.
pub const ENGINE: &str = "domicile-engine";

/// The name the shell's `console` lines carry.
pub const SHELL: &str = "domicile-shell";

/// Where the shell is served from. See `docs/architecture/DOMICILE-SCHEME.md`.
const SHELL_SOURCE: &str = ", source: domicile://shell/";

/// Reads the engine's stderr one line at a time.
///
/// Holds the last prefixed line's name and priority: a line without a prefix
/// continues it, as a stack under a `console.error` does.
pub struct EngineLog {
    last: Option<(&'static str, Priority)>,
    /// Whether the last prefixed line showed, which a line it continues
    /// follows.
    showed: bool,
    /// Whether a `console` message spread over lines has yet to end: Chromium
    /// ends one with its `", source: …`.
    open: bool,
    /// Whether the last line continued the one before it.
    continued: bool,
}

/// The engine's lines that show at the levels set now, or none to show every
/// line. See [`Gate`], [`start`] and [`set`].
static GATE: RwLock<Option<Gate>> = RwLock::new(None);

/// Shows the engine's lines at `levels` from now on.
pub fn set(levels: &LogLevels) {
    *GATE.write().expect("nothing panics holding the gate") = Some(Gate::new(levels));
}

/// Gates the engine's lines at the starting levels, unless `extra`, the
/// engine's `DOMICILE_ENGINE_ARGS`, starts it at others: then every line it
/// logs shows, as asked, until `domicile set-log-level` sets levels.
pub fn start(extra: Option<&str>) {
    *GATE.write().expect("nothing panics holding the gate") =
        (!raises_logging(extra)).then(Gate::default);
}

/// Whether `extra` sets the engine's own levels.
pub fn raises_logging(extra: Option<&str>) -> bool {
    extra.unwrap_or_default().split_whitespace().any(|switch| {
        ["--log-level=", "--v=", "--vmodule="]
            .iter()
            .any(|own| switch.starts_with(own))
    })
}

impl EngineLog {
    /// Whether `line`, which has no prefix, continues the line before it: an
    /// indented line, as in a stack, or the rest of a `console` message.
    fn continues(&self, line: &str) -> bool {
        self.open || line.starts_with(char::is_whitespace)
    }

    pub fn new() -> Self {
        EngineLog {
            last: None,
            showed: true,
            open: false,
            continued: false,
        }
    }

    /// The entry for one line of the engine's stderr, if it shows at the
    /// levels [`set`]: Chromium logs more than was asked for when one
    /// subsystem is turned up. See [`Gate`].
    pub fn heard(&mut self, line: &str) -> Option<Entry> {
        let gate = GATE.read().expect("nothing panics holding the gate");
        match gate.as_ref() {
            Some(gate) => self.through(line, gate),
            None => Some(self.entry(line)),
        }
    }

    /// The entry for `line`, if it shows through `gate`.
    pub fn through(&mut self, line: &str, gate: &Gate) -> Option<Entry> {
        let entry = self.entry(line);
        match prefixed(line) {
            Some(said) => {
                self.showed = gate.shows(said.priority, said.file, entry.identifier == SHELL);
            }
            None if !self.continued => {
                self.showed = gate.shows(entry.priority, "", false);
            }
            None => {}
        }
        self.showed.then_some(entry)
    }

    /// The entry for one line of the engine's stderr.
    pub fn entry(&mut self, line: &str) -> Entry {
        match prefixed(line) {
            Some(said) => {
                let shell = said.file == "CONSOLE" && said.message.contains(SHELL_SOURCE);
                let identifier = match shell {
                    true => SHELL,
                    false => ENGINE,
                };
                self.last = Some((identifier, said.priority));
                self.open = said.file == "CONSOLE" && !said.message.contains(SOURCE);
                self.continued = false;
                let subsystem = shell
                    .then(|| subsystem(said.message))
                    .flatten()
                    .map(|name| ("DOMICILE_SUBSYSTEM", name.to_string()));
                Entry {
                    identifier,
                    priority: said.priority,
                    message: said.message.to_string(),
                    fields: said.fields().into_iter().chain(subsystem).collect(),
                }
            }
            // An indented line continues the one before, as a stack under a
            // `console.error` does, and so does the rest of a `console`
            // message spread over lines. Any other line is a library writing to
            // stderr itself, such as V8 or Mesa, with no level: a warning,
            // not whatever the line before it was.
            None => {
                let continued = self.continues(line);
                self.continued = continued;
                if continued && line.contains(SOURCE) {
                    self.open = false;
                }
                let (identifier, priority) = match continued {
                    true => self.last.unwrap_or(UNLEVELED),
                    false => UNLEVELED,
                };
                Entry {
                    identifier,
                    priority,
                    message: line.to_string(),
                    fields: Vec::new(),
                }
            }
        }
    }
}

/// A line without a level, and not continuing one.
const UNLEVELED: (&str, Priority) = (ENGINE, Priority::Warning);

/// How Chromium ends a `console` message, before saying where it came from.
const SOURCE: &str = "\", source: ";

impl Default for EngineLog {
    fn default() -> Self {
        EngineLog::new()
    }
}

/// The subsystem a shell's console line names, as the SDK's `logger` starts
/// it: `"[notifications] ...`.
fn subsystem(message: &str) -> Option<&str> {
    let (name, _) = message.strip_prefix("\"[")?.split_once("] ")?;
    (!name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then_some(name)
}

/// A line with Chromium's prefix, split up.
struct Prefixed<'a> {
    pid: &'a str,
    priority: Priority,
    file: &'a str,
    line: Option<&'a str>,
    message: &'a str,
}

impl Prefixed<'_> {
    fn fields(&self) -> Vec<(&'static str, String)> {
        [
            ("CODE_FILE", Some(self.file)),
            ("CODE_LINE", self.line),
            ("DOMICILE_PID", Some(self.pid)),
        ]
        .into_iter()
        .filter_map(|(name, value)| value.map(|value| (name, value.to_string())))
        .collect()
    }
}

/// Splits `[pid:tid:time:LEVEL:where] message`, or `None` for a line without
/// the prefix. `where` is `file:line`, or `file(line)` from older code paths.
fn prefixed(line: &str) -> Option<Prefixed<'_>> {
    let (prefix, message) = line.strip_prefix('[')?.split_once("] ")?;
    let mut parts = prefix.splitn(5, ':');
    let pid = parts.next()?;
    let _tid = parts.next()?;
    let _time = parts.next()?;
    let priority = priority(parts.next()?)?;
    let place = parts.next()?;
    let (file, line) = match place
        .strip_suffix(')')
        .and_then(|place| place.split_once('('))
    {
        Some((file, line)) => (file, Some(line)),
        None => match place.rsplit_once(':') {
            Some((file, line)) => (file, Some(line)),
            None => (place, None),
        },
    };
    Some(Prefixed {
        pid,
        priority,
        file,
        line,
        message,
    })
}

/// The priority for a Chromium severity, or `None` for a word that is not one.
fn priority(level: &str) -> Option<Priority> {
    match level {
        "FATAL" => Some(Priority::Critical),
        "ERROR" => Some(Priority::Error),
        "WARNING" => Some(Priority::Warning),
        "INFO" => Some(Priority::Info),
        verbose if verbose.starts_with("VERBOSE") => Some(Priority::Debug),
        _ => None,
    }
}
