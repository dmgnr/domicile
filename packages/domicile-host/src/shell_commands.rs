//! The pages listening for `domicile send-shell` commands, across every chrome
//! connection, and their answers. A page listens with
//! `SystemRequest::ShellCommands` and answers each command with
//! `SystemRequest::AnswerShellCommand`; see
//! `docs/architecture/KEYBINDINGS.md`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use domicile_protocol::{ShellBinding, ShellCommandHelp};

use crate::fanout::{Hear, Listener};

/// How long a sent command waits for a page to run it. Pages answer as they
/// hear it; shorter than `domicile`'s own two seconds, so the reason reaches
/// the terminal rather than a timeout.
const ANSWER_WITHIN: Duration = Duration::from_secs(1);

/// How a sent command ended: run by a page, with what it printed if
/// anything, or why not.
pub type Outcome = Result<Option<String>, String>;

/// Hears how a sent command ended, once.
type Done = Box<dyn FnOnce(Outcome) + Send>;

/// Every page listening and every command waiting for an answer. Clones share
/// both, so every connection's [`crate::system::System`] holds a clone of one.
#[derive(Clone)]
pub struct ShellCommands {
    shared: Arc<Mutex<Shared>>,
    patience: Duration,
}

#[derive(Default)]
struct Shared {
    next_page: u64,
    pages: HashMap<u64, Page>,
    next_sent: u64,
    waiting: HashMap<u64, Waiting>,
}

/// A page listening, with the commands it said it runs and the bindings that
/// run them.
struct Page {
    hear: Hear<(Vec<String>, u64)>,
    commands: Vec<ShellCommandHelp>,
    bindings: Vec<ShellBinding>,
}

/// A sent command no page has run yet.
struct Waiting {
    /// The pages that heard it and have not answered.
    unanswered: usize,
    /// Why the pages that answered refused it.
    refusals: Vec<String>,
    done: Done,
}

impl Default for ShellCommands {
    fn default() -> Self {
        ShellCommands::answered_within(ANSWER_WITHIN)
    }
}

impl ShellCommands {
    /// Commands that fail when no page answered within `patience`.
    pub fn answered_within(patience: Duration) -> Self {
        ShellCommands {
            shared: Arc::default(),
            patience,
        }
    }

    /// Calls `hear` with each command and its number until the [`Listener`]
    /// drops. `commands` describes what the page runs meanwhile, and
    /// `bindings` the keys and gestures that run them.
    pub(crate) fn listen(
        &self,
        commands: Vec<ShellCommandHelp>,
        bindings: Vec<ShellBinding>,
        hear: Hear<(Vec<String>, u64)>,
    ) -> Listener {
        let mut shared = self.shared.lock().unwrap();
        let key = shared.next_page;
        shared.next_page += 1;
        shared.pages.insert(
            key,
            Page {
                hear,
                commands,
                bindings,
            },
        );
        let stopping = Arc::clone(&self.shared);
        Listener::stopping(move || {
            stopping.lock().unwrap().pages.remove(&key);
        })
    }

    /// Sends `command` to every page listening, and calls `done` once one ran
    /// it, every one refused it, or none answered in time. Returns false, and
    /// never calls `done`, when no page listens.
    pub(crate) fn send(&self, command: &[String], done: Done) -> bool {
        let (sent, hearing) = {
            let mut shared = self.shared.lock().unwrap();
            let hearing: Vec<_> = shared
                .pages
                .values()
                .map(|page| Arc::clone(&page.hear))
                .collect();
            if hearing.is_empty() {
                return false;
            }
            let sent = shared.next_sent;
            shared.next_sent += 1;
            shared.waiting.insert(
                sent,
                Waiting {
                    unanswered: hearing.len(),
                    refusals: Vec::new(),
                    done,
                },
            );
            (sent, hearing)
        };
        // Outside the lock, since hearing takes its connection's lock, which a
        // page starting to listen holds while it takes this one.
        for hear in &hearing {
            hear(&(command.to_vec(), sent));
        }
        let expiring = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(expiring.patience);
            expiring.expire(sent);
        });
        true
    }

    /// A page ran the command numbered `sent`, printing `output` if any, or
    /// refused it for `refused`. An answer after the command ended is
    /// dropped: another page ran it, or the wait was over.
    pub(crate) fn answer(&self, sent: u64, refused: Option<String>, output: Option<String>) {
        let ended = {
            let mut shared = self.shared.lock().unwrap();
            let Some(waiting) = shared.waiting.get_mut(&sent) else {
                return;
            };
            waiting.unanswered = waiting.unanswered.saturating_sub(1);
            match refused {
                None => shared
                    .waiting
                    .remove(&sent)
                    .map(|waiting| (waiting, Ok(output))),
                Some(why) => {
                    if !waiting.refusals.contains(&why) {
                        waiting.refusals.push(why);
                    }
                    match waiting.unanswered {
                        0 => shared.waiting.remove(&sent).map(|waiting| {
                            let why = waiting.refusals.join("; ");
                            (waiting, Err(why))
                        }),
                        _ => None,
                    }
                }
            }
        };
        if let Some((waiting, outcome)) = ended {
            (waiting.done)(outcome);
        }
    }

    /// End the command numbered `sent` if no page ran it in time.
    fn expire(&self, sent: u64) {
        let ended = self.shared.lock().unwrap().waiting.remove(&sent);
        if let Some(waiting) = ended {
            let why = match waiting.refusals.is_empty() {
                true => format!(
                    "the shell heard the command but did not say it ran it within {} ms",
                    self.patience.as_millis()
                ),
                false => waiting.refusals.join("; "),
            };
            (waiting.done)(Err(why));
        }
    }

    /// Every command the listening pages run, once each, in the order the
    /// pages started listening.
    pub fn described(&self) -> Vec<ShellCommandHelp> {
        self.each_page(|page| &page.commands)
    }

    /// Every binding the listening pages hold, once each, in the order the
    /// pages started listening.
    pub fn bindings(&self) -> Vec<ShellBinding> {
        self.each_page(|page| &page.bindings)
    }

    /// What `of` gives for each page, in listen order, without repeats.
    fn each_page<T: Clone + PartialEq>(&self, of: impl Fn(&Page) -> &Vec<T>) -> Vec<T> {
        let shared = self.shared.lock().unwrap();
        let mut pages: Vec<_> = shared.pages.iter().collect();
        pages.sort_by_key(|(key, _)| **key);
        let mut all: Vec<T> = Vec::new();
        for (_, page) in pages {
            for item in of(page) {
                if !all.contains(item) {
                    all.push(item.clone());
                }
            }
        }
        all
    }
}
