//! Where the engine's and compositor's stderr goes.
//!
//! When the desktop's stderr is the journal, each line is sent as an entry
//! with its priority and the component's name. Otherwise it is written as it
//! was said, so a terminal or a test's log file reads the component's own
//! format.

use std::io::Write;

use crate::journal::{self, Entry, Journal, Priority};
use crate::recent_log::{self, Said};

/// The name the compositor's entries carry.
pub const COMPOSITOR: &str = "domicile-compositor";

/// Where component lines go.
pub enum Sink {
    Journal(Journal),
    Stderr,
}

impl Sink {
    /// The journal if this process's stderr is the journal, else stderr.
    ///
    /// A journal stream whose socket refuses a connection still takes lines
    /// written to it, without priorities, so that is said and lines go there.
    pub fn here() -> Sink {
        match journal::stderr_is_the_journal() {
            false => Sink::Stderr,
            true => match Journal::at(std::path::Path::new(journal::SOCKET)) {
                Ok(journal) => Sink::Journal(journal),
                Err(why) => {
                    eprintln!(
                        "domicile: stderr is the journal, but {} refused: {why}. Component logs go to stderr without priorities.",
                        journal::SOCKET
                    );
                    Sink::Stderr
                }
            },
        }
    }

    /// Whether lines go to the journal.
    pub fn is_the_journal(&self) -> bool {
        matches!(self, Sink::Journal(_))
    }

    /// Says `line`, read as `entry`. A line the journal refuses, or any line
    /// off the journal, is written to `stderr` as said. Either way it is kept
    /// for `domicile logs` ([`crate::recent_log`]).
    pub fn say(&self, entry: &Entry, line: &str, stderr: &mut dyn Write) {
        recent_log::keep(Said::of(entry, recent_log::now()));
        let refused = match self {
            Sink::Journal(journal) => journal.send(entry).is_err(),
            Sink::Stderr => true,
        };
        if refused {
            writeln!(stderr, "{line}").expect("stderr takes a line");
        }
    }
}

/// The entry for a line of the compositor's stderr. Its tracing goes to stdout
/// (or the journal), so its stderr holds panics and fatal errors.
pub fn compositor(line: &str) -> Entry {
    Entry {
        identifier: COMPOSITOR,
        priority: Priority::Error,
        message: line.to_string(),
        fields: Vec::new(),
    }
}
