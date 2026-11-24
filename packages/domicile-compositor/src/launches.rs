//! The clients this desktop launched, kept in a file so the next compositor
//! starts again the ones a crash took.
//!
//! - Each launch is written down with its pid and start time, and struck off
//!   when it exits.
//! - A compositor that crashes leaves the file. The next one reads it, binds
//!   the same Wayland display name, and launches again each client that is no
//!   longer running.
//! - A client still running was not taken by the crash, such as a Qt app that
//!   reconnected (`QT_WAYLAND_RECONNECT`). It is left alone, and not followed.
//!
//! See "Crashes are recovered" in docs/architecture/THE-DOMICILE-BINARY.md.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The file's contents.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// The display the clients were pointed at, so the next compositor binds
    /// it and a reconnecting client finds it.
    pub wayland_display: String,
    /// The running clients, by pid.
    pub clients: BTreeMap<u32, Launch>,
}

/// One launched client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launch {
    pub command: Vec<String>,
    /// When the process started, in clock ticks after boot (`/proc/PID/stat`
    /// field 22), so a reused pid is not mistaken for it.
    pub started: u64,
}

/// What the last compositor left: its display, if it left one, and the
/// commands of the clients that are gone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Left {
    pub wayland_display: Option<String>,
    pub lost: Vec<Vec<String>>,
}

/// Reads the record at `path`. No file is a clean start.
///
/// `started` is when a pid's process started, or `None` for no such process;
/// see [`started`].
pub fn left(path: &Path, started: impl Fn(u32) -> Option<u64>) -> Left {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Left::default(),
        Err(err) => {
            tracing::error!(%err, path = %path.display(), "the last compositor's launches would not read; launching none of them again");
            return Left::default();
        }
    };
    match serde_json::from_str::<Record>(&text) {
        Ok(record) => lost(record, started),
        Err(err) => {
            tracing::error!(%err, path = %path.display(), "the last compositor's launches would not parse; launching none of them again");
            Left::default()
        }
    }
}

/// The commands of `record`'s clients that are gone: no process with the pid,
/// or a process that started at another time.
fn lost(record: Record, started: impl Fn(u32) -> Option<u64>) -> Left {
    Left {
        wayland_display: Some(record.wayland_display),
        lost: record
            .clients
            .into_iter()
            .filter(|(pid, launch)| started(*pid) != Some(launch.started))
            .map(|(_, launch)| launch.command)
            .collect(),
    }
}

/// When process `pid` started, from `/proc`. `None` when there is no such
/// process.
pub fn started(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    start_time(&stat)
}

/// Field 22 of a `/proc/PID/stat` line. The command name in field 2 may hold
/// spaces and parentheses, so fields are counted after its last `)`.
fn start_time(stat: &str) -> Option<u64> {
    let (_, after) = stat.rsplit_once(')')?;
    // `after` starts at field 3.
    after.split_whitespace().nth(19)?.parse().ok()
}

/// The running record, written to its file on each change.
pub struct Launches {
    path: PathBuf,
    record: Mutex<Record>,
}

impl Launches {
    /// A record of no clients on `wayland_display`, written to `path`.
    pub fn new(path: PathBuf, wayland_display: String) -> Self {
        let launches = Launches {
            path,
            record: Mutex::new(Record {
                wayland_display,
                clients: BTreeMap::new(),
            }),
        };
        launches.write(&launches.record.lock().expect("never poisoned"));
        launches
    }

    /// `pid` was launched with `command`.
    pub fn launched(&self, pid: u32, command: &[String]) {
        // A process gone before it is read was not running at the crash.
        let Some(started) = started(pid) else {
            return;
        };
        let mut record = self.record.lock().expect("never poisoned");
        record.clients.insert(
            pid,
            Launch {
                command: command.to_vec(),
                started,
            },
        );
        self.write(&record);
    }

    /// `pid` exited.
    pub fn ended(&self, pid: u32) {
        let mut record = self.record.lock().expect("never poisoned");
        if record.clients.remove(&pid).is_some() {
            self.write(&record);
        }
    }

    /// Writes `record`, held under the lock so writes land in order.
    ///
    /// A failed write is logged: the desktop runs on, and the next compositor
    /// misses what the file lacks.
    fn write(&self, record: &Record) {
        let document = serde_json::to_string(record).expect("a record is plain data");
        let staging = self.path.with_extension("new");
        let written =
            std::fs::write(&staging, document).and_then(|()| std::fs::rename(&staging, &self.path));
        if let Err(err) = written {
            tracing::error!(%err, path = %self.path.display(), "the launched clients would not save; a compositor crash will not launch them again");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{left, lost, start_time, Launch, Launches, Left, Record};

    fn record(clients: &[(u32, &str, u64)]) -> Record {
        Record {
            wayland_display: "wayland-1".to_string(),
            clients: clients
                .iter()
                .map(|&(pid, program, started)| {
                    (
                        pid,
                        Launch {
                            command: vec![program.to_string()],
                            started,
                        },
                    )
                })
                .collect::<BTreeMap<_, _>>(),
        }
    }

    #[test]
    fn a_client_that_is_gone_is_lost_and_one_still_running_is_not() {
        let left = lost(
            record(&[
                (10, "kitty", 500),
                (11, "firefox", 600),
                (12, "qt-app", 700),
            ]),
            |pid| match pid {
                // A new process under the same pid.
                11 => Some(601),
                12 => Some(700),
                _ => None,
            },
        );

        assert_eq!(
            left,
            Left {
                wayland_display: Some("wayland-1".to_string()),
                lost: vec![vec!["kitty".to_string()], vec!["firefox".to_string()]],
            }
        );
    }

    #[test]
    fn no_file_is_a_clean_start() {
        let dir = tempfile::tempdir().expect("a temporary directory");

        assert_eq!(
            left(&dir.path().join("launches.json"), |_| None),
            Left::default()
        );
    }

    #[test]
    fn what_one_compositor_writes_the_next_reads() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("launches.json");
        let me = std::process::id();
        let launches = Launches::new(path.clone(), "wayland-3".to_string());
        launches.launched(me, &["kitty".to_string()]);
        launches.launched(me + 1_000_000, &["gone".to_string()]);
        drop(launches);

        assert_eq!(
            left(&path, |_| None),
            Left {
                wayland_display: Some("wayland-3".to_string()),
                lost: vec![vec!["kitty".to_string()]],
            }
        );
    }

    #[test]
    fn an_exited_client_is_struck_off() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("launches.json");
        let me = std::process::id();
        let launches = Launches::new(path.clone(), "wayland-3".to_string());
        launches.launched(me, &["kitty".to_string()]);
        launches.ended(me);

        assert_eq!(left(&path, |_| None).lost, Vec::<Vec<String>>::new());
    }

    #[test]
    fn the_start_time_is_read_past_a_command_name_with_spaces() {
        let stat =
            "4242 (a (b) c) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 10";

        assert_eq!(start_time(stat), Some(98765));
    }
}
