//! What `domicile set-log-level` changes: the levels set so far, with one
//! more. See `docs/LOGGING.md`.

use domicile_protocol::{LogLevel, LogLevels, Subsystem};

/// `current` with `level` set for `subsystems`, or for everything when there
/// are none. Levels set for single subsystems stay either way.
pub fn changed(current: &LogLevels, level: LogLevel, subsystems: &[Subsystem]) -> LogLevels {
    let mut levels = current.clone();
    if subsystems.is_empty() {
        levels.all = Some(level);
    }
    for subsystem in subsystems {
        levels.subsystems.insert(*subsystem, level);
    }
    levels
}
