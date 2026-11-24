//! What an act changed in a window: its tree as read after the act, against
//! the tree the agent last read of it. Answering it with the act saves the
//! agent a turn to look again.

use std::collections::HashMap;
use std::time::Duration;

/// How long a window is given to answer an act before it is read again.
pub(super) const SETTLE: Duration = Duration::from_millis(250);

/// What `after`, a window's outline, says about it since `before`, the one
/// last read: the lines gone and new, or all of it when it wasn't read or
/// changed more than it kept.
pub(super) fn changed(before: Option<&str>, after: &str) -> String {
    let Some(before) = before else {
        return format!("The window now:\n{after}");
    };
    let mut kept: HashMap<&str, usize> = HashMap::new();
    for line in before.lines() {
        *kept.entry(element(line)).or_default() += 1;
    }
    let mut new = Vec::new();
    for line in after.lines() {
        match kept.get_mut(element(line)) {
            Some(count) if *count > 0 => *count -= 1,
            _ => new.push(element(line)),
        }
    }
    let mut gone = Vec::new();
    for line in before.lines() {
        if let Some(count) = kept.get_mut(element(line)).filter(|count| **count > 0) {
            *count -= 1;
            gone.push(element(line));
        }
    }
    if gone.is_empty() && new.is_empty() {
        return "Nothing in the window changed.\n".to_string();
    }
    if gone.len() + new.len() > after.lines().count() {
        return format!("The window now:\n{after}");
    }
    let lines: String = gone
        .iter()
        .map(|line| format!("gone: {line}\n"))
        .chain(new.iter().map(|line| format!("new: {line}\n")))
        .collect();
    format!("What changed in the window since it was last read:\n{lines}")
}

/// An outline's line without its indent and bullet.
fn element(line: &str) -> &str {
    let line = line.trim_start();
    line.strip_prefix("- ").unwrap_or(line)
}
