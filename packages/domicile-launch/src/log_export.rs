//! The file `domicile export-logs` writes: what the desktop was, then what it
//! said, with URLs and window titles hidden unless asked. One plain text file,
//! so it attaches to a bug and reads anywhere. See `docs/LOGGING.md`.

use domicile_protocol::LogLevels;

use crate::recent_log::Said;
use crate::redact::redacted;

/// How long an export may take: it asks the compositor three things and
/// reads the journal.
pub const EXPORT_WITHIN: std::time::Duration = std::time::Duration::from_secs(30);

/// The name an export takes at `now`, microseconds since the epoch:
/// `domicile-logs-2026-11-27-091203.txt`, in local time.
pub fn file_name(now: u64) -> String {
    let at = (now / 1_000_000) as i64 + crate::recent_log::local_offset(now);
    format!(
        "domicile-logs-{}.txt",
        crate::recent_log::civil(at, "-", "")
    )
}

/// What goes into an export.
pub struct Report<'a> {
    /// When it was exported, in local time.
    pub at: &'a str,
    /// The line the desktop said when it came up.
    pub up: &'a str,
    pub levels: LogLevels,
    /// The displays, as `domicile list-displays` prints them, or why they
    /// were not read.
    pub displays: Result<String, String>,
    /// The inputs, as `domicile list-inputs` prints them, or why not.
    pub inputs: Result<String, String>,
    /// Where the lines came from: `the journal`, or `the desktop`.
    pub from: &'a str,
    pub logs: &'a [Said],
    /// Seconds east of UTC to show times in.
    pub offset: i64,
    /// The open windows' titles, hidden when `redact` is.
    pub titles: &'a [String],
    pub redact: bool,
}

/// The export's text.
pub fn report(parts: &Report) -> String {
    let hidden = |text: &str| match parts.redact {
        true => redacted(text, parts.titles),
        false => text.to_string(),
    };
    let read = |listed: &Result<String, String>| match listed {
        Ok(listed) => hidden(listed.trim_end()),
        Err(why) => format!("not read: {why}"),
    };
    let lines = match parts.logs.is_empty() {
        true => "Nothing was logged.".to_string(),
        false => parts
            .logs
            .iter()
            .map(|said| hidden(&said.line(parts.offset)))
            .collect::<Vec<_>>()
            .join("\n"),
    };
    format!(
        "Domicile logs\n\
         \n\
         Exported {at}. {privacy}\n\
         \n\
         {up}\n\
         Log levels: {levels}\n\
         \n\
         ## Displays\n\
         \n\
         {displays}\n\
         \n\
         ## Inputs\n\
         \n\
         {inputs}\n\
         \n\
         ## Logs, from {from}\n\
         \n\
         {lines}\n",
        at = parts.at,
        privacy = match parts.redact {
            true => "URLs and window titles are hidden.",
            false => "Asked to show everything, so nothing is hidden.",
        },
        up = hidden(parts.up),
        levels = levels(&parts.levels),
        displays = read(&parts.displays),
        inputs = read(&parts.inputs),
        from = parts.from,
    )
}

/// `all debug, input trace`, or `as started`.
fn levels(levels: &LogLevels) -> String {
    let all = levels.all.map(|level| format!("all {}", level.name()));
    let some = levels
        .subsystems
        .iter()
        .map(|(subsystem, level)| format!("{} {}", subsystem.name(), level.name()));
    let said: Vec<String> = all.into_iter().chain(some).collect();
    match said.is_empty() {
        true => "as started".to_string(),
        false => said.join(", "),
    }
}
