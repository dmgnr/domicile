//! The launcher's own messages: leveled like every part's, quiet but for
//! errors unless `domicile set-log-level` turns the session up. On the
//! journal each line carries its priority as a `<N>` prefix, which journald
//! reads off the stream. See `docs/LOGGING.md`.

use std::io::Write;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use domicile_protocol::{LogLevel, LogLevels, Subsystem};

use crate::journal::stderr_is_the_journal;

/// `said` as written to stderr: with its priority on the journal.
pub fn line(level: LogLevel, said: &str, journal: bool) -> String {
    match journal {
        true => format!("<{}>domicile: {said}", priority(level)),
        false => format!("domicile: {said}"),
    }
}

/// The syslog priority of `level`.
fn priority(level: LogLevel) -> u8 {
    match level {
        LogLevel::Error => 3,
        LogLevel::Warn => 4,
        LogLevel::Info => 6,
        LogLevel::Debug | LogLevel::Trace => 7,
    }
}

/// Whether a message at `level` shows under `threshold`.
pub fn shown(level: LogLevel, threshold: LogLevel) -> bool {
    level <= threshold
}

/// The most verbose level the launcher shows under `levels`: the session's,
/// else everything's, else errors.
pub fn threshold(levels: &LogLevels) -> LogLevel {
    levels
        .subsystems
        .get(&Subsystem::Session)
        .copied()
        .or(levels.all)
        .unwrap_or(LogLevel::Error)
}

/// The running launcher's threshold, as [`LogLevel`]'s position.
static THRESHOLD: AtomicU8 = AtomicU8::new(0);

/// Shows the launcher's messages at `levels` from now on.
pub fn set(levels: &LogLevels) {
    THRESHOLD.store(threshold(levels) as u8, Ordering::Relaxed);
}

/// Writes `said` at `level` to stderr, if it shows.
pub fn say(level: LogLevel, said: &str) {
    let threshold = LEVELS[usize::from(THRESHOLD.load(Ordering::Relaxed))];
    if !shown(level, threshold) {
        return;
    }
    static JOURNAL: OnceLock<bool> = OnceLock::new();
    let journal = *JOURNAL.get_or_init(stderr_is_the_journal);
    // Nowhere is left to say a failed write.
    let _ = writeln!(std::io::stderr(), "{}", line(level, said, journal));
    crate::recent_log::keep(crate::recent_log::Said {
        at: crate::recent_log::now(),
        identifier: "domicile".to_string(),
        priority: match level {
            LogLevel::Error => crate::journal::Priority::Error,
            LogLevel::Warn => crate::journal::Priority::Warning,
            LogLevel::Info => crate::journal::Priority::Info,
            LogLevel::Debug | LogLevel::Trace => crate::journal::Priority::Debug,
        },
        message: said.to_string(),
    });
}

/// Every level, in [`LogLevel`]'s order.
const LEVELS: [LogLevel; 5] = [
    LogLevel::Error,
    LogLevel::Warn,
    LogLevel::Info,
    LogLevel::Debug,
    LogLevel::Trace,
];

/// [`say`] at [`LogLevel::Error`].
pub fn error(said: &str) {
    say(LogLevel::Error, said);
}

/// [`say`] at [`LogLevel::Warn`].
pub fn warn(said: &str) {
    say(LogLevel::Warn, said);
}

/// [`say`] at [`LogLevel::Info`].
pub fn info(said: &str) {
    say(LogLevel::Info, said);
}

/// [`say`] at [`LogLevel::Debug`].
pub fn debug(said: &str) {
    say(LogLevel::Debug, said);
}

/// Whether a message at `level` would show now, so a costly one is built
/// only when it will be said.
pub fn showing(level: LogLevel) -> bool {
    shown(
        level,
        LEVELS[usize::from(THRESHOLD.load(Ordering::Relaxed))],
    )
}
