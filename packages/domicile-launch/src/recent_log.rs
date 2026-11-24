//! The lines a desktop said lately.
//!
//! Off the journal, lines go to a terminal or a file and are gone once it
//! scrolls or closes. The launcher keeps the newest of every part's lines, so
//! `domicile logs` and `domicile export-logs` have them anyway. On the
//! journal, both read the journal instead ([`from_journal`]). See
//! `docs/LOGGING.md`.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::journal::{Entry, Priority};

/// How many lines a running desktop keeps: at a few hundred bytes a line, a
/// few megabytes, and minutes of the chattiest levels.
pub const KEPT: usize = 10_000;

/// One line a part said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Said {
    /// Microseconds since the epoch.
    pub at: u64,
    /// The part, as the journal names it: `domicile-engine`.
    pub identifier: String,
    pub priority: Priority,
    pub message: String,
}

impl Said {
    /// `entry`, said at `at`.
    pub fn of(entry: &Entry, at: u64) -> Said {
        Said {
            at,
            identifier: entry.identifier.to_string(),
            priority: entry.priority,
            message: entry.message.clone(),
        }
    }

    /// The line as `domicile logs` prints it, in a zone `offset` seconds east
    /// of UTC: `2026-11-27 09:12:03.123 domicile-shell warning: no layout`.
    pub fn line(&self, offset: i64) -> String {
        let millis = (self.at / 1000) % 1000;
        format!(
            "{}.{millis:03} {} {}: {}",
            civil(self.at as i64 / 1_000_000 + offset, " ", ":"),
            self.identifier,
            name(self.priority),
            self.message
        )
    }
}

/// `seconds` since the epoch as `2026-11-27<between>09<colon>12<colon>03`.
pub fn civil(seconds: i64, between: &str, colon: &str) -> String {
    let (days, of_day) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}{between}{:02}{colon}{:02}{colon}{:02}",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60
    )
}

/// The priority's name, as `journalctl -p` takes it.
fn name(priority: Priority) -> &'static str {
    match priority {
        Priority::Critical => "crit",
        Priority::Error => "err",
        Priority::Warning => "warning",
        Priority::Info => "info",
        Priority::Debug => "debug",
    }
}

/// The newest lines, up to a number.
pub struct Recent {
    lines: VecDeque<Said>,
    room: usize,
}

impl Recent {
    /// Keeps up to `room` lines.
    pub fn holding(room: usize) -> Recent {
        Recent {
            lines: VecDeque::with_capacity(room),
            room,
        }
    }

    /// Keeps `said`, forgetting the oldest line if there is no room.
    pub fn keep(&mut self, said: Said) {
        if self.lines.len() == self.room {
            self.lines.pop_front();
        }
        self.lines.push_back(said);
    }

    /// The lines kept, oldest first.
    pub fn lines(&self) -> impl Iterator<Item = &Said> {
        self.lines.iter()
    }
}

/// This process's lines.
static KEEPING: Mutex<Option<Recent>> = Mutex::new(None);

/// Microseconds since the epoch, now.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_micros() as u64
}

/// Keeps `said` among this process's lines.
pub fn keep(said: Said) {
    KEEPING
        .lock()
        .expect("nothing panics keeping a line")
        .get_or_insert_with(|| Recent::holding(KEPT))
        .keep(said);
}

/// This process's lines, oldest first.
pub fn kept() -> Vec<Said> {
    KEEPING
        .lock()
        .expect("nothing panics keeping a line")
        .as_ref()
        .map(|recent| recent.lines().cloned().collect())
        .unwrap_or_default()
}

/// A line of the compositor's tracing as it formats it off the journal,
/// `<time> <LEVEL> <target>: <message>`, said at `at`. A line without a
/// level, such as a panic's, is an error.
pub fn compositor_line(line: &str, at: u64) -> Said {
    let mut words = line.split_whitespace();
    let leveled = words.next().and(words.next()).and_then(|level| {
        let priority = match level {
            "ERROR" => Priority::Error,
            "WARN" => Priority::Warning,
            "INFO" => Priority::Info,
            "DEBUG" | "TRACE" => Priority::Debug,
            _ => return None,
        };
        let after = line.find(level).expect("the level is in the line") + level.len();
        Some((priority, line[after..].trim_start().to_string()))
    });
    let (priority, message) = leveled.unwrap_or((Priority::Error, line.to_string()));
    Said {
        at,
        identifier: crate::component_log::COMPOSITOR.to_string(),
        priority,
        message,
    }
}

/// The parts' names, which `journalctl -t` takes to read a desktop's lines.
pub const IDENTIFIERS: [&str; 5] = [
    "domicile",
    "domicile-compositor",
    "domicile-engine",
    "domicile-shell",
    "domicile-relay",
];

/// One line of `journalctl -o json`.
pub fn from_journal(json: &str) -> Result<Said, String> {
    let entry: serde_json::Value =
        serde_json::from_str(json).map_err(|why| format!("not an entry: {why}"))?;
    let text = |field: &str| entry.get(field).and_then(|value| value.as_str());
    let message = match entry.get("MESSAGE") {
        Some(serde_json::Value::String(message)) => message.clone(),
        // A message that is not UTF-8 is an array of its bytes.
        Some(serde_json::Value::Array(bytes)) => String::from_utf8_lossy(
            &bytes
                .iter()
                .filter_map(|byte| byte.as_u64().map(|byte| byte as u8))
                .collect::<Vec<_>>(),
        )
        .into_owned(),
        _ => return Err(format!("an entry without a message: {json}")),
    };
    Ok(Said {
        at: text("__REALTIME_TIMESTAMP")
            .and_then(|at| at.parse().ok())
            .unwrap_or(0),
        identifier: text("SYSLOG_IDENTIFIER").unwrap_or("?").to_string(),
        priority: match text("PRIORITY") {
            Some("0" | "1" | "2") => Priority::Critical,
            Some("3") => Priority::Error,
            Some("4") => Priority::Warning,
            Some("5" | "6") => Priority::Info,
            _ => Priority::Debug,
        },
        message,
    })
}

/// How many seconds east of UTC the local zone is at `at`, microseconds since
/// the epoch.
pub fn local_offset(at: u64) -> i64 {
    let seconds = (at / 1_000_000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are to live values of the right types.
    match unsafe { libc::localtime_r(&seconds, &mut tm) }.is_null() {
        true => 0,
        false => tm.tm_gmtoff,
    }
}

/// How many of the journal's lines an export reads: the newest, about as
/// many as a desktop off the journal keeps, and more at chatty levels.
pub const EXPORTED: usize = 20_000;

/// `journalctl` arguments for this boot's lines from every part.
pub fn journal_args() -> Vec<String> {
    ["--user", "--boot"]
        .into_iter()
        .map(str::to_string)
        .chain(
            IDENTIFIERS
                .iter()
                .map(|identifier| format!("--identifier={identifier}")),
        )
        .collect()
}

/// This boot's newest [`EXPORTED`] lines from the journal, oldest first.
pub fn from_the_journal() -> Result<Vec<Said>, String> {
    let read = std::process::Command::new("journalctl")
        .args(journal_args())
        .args(["--output=json", "--no-pager", "--lines"])
        .arg(EXPORTED.to_string())
        .output()
        .map_err(|why| format!("cannot run journalctl: {why}"))?;
    if !read.status.success() {
        return Err(format!(
            "journalctl {}: {}",
            read.status,
            String::from_utf8_lossy(&read.stderr).trim()
        ));
    }
    String::from_utf8_lossy(&read.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(from_journal)
        .collect()
}
