//! Styles what `domicile` prints for a person: ANSI colors on a terminal,
//! plain text anywhere else. `--json` output is never painted.
//!
//! Only the 16 basic colors are used, so the terminal's theme picks the
//! shades. See `docs/CLI.md#output`.

/// Whether to paint, decided once per stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Paint {
    color: bool,
}

/// What a piece of text is, which decides how it looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    Plain,
    /// A section title, such as `Usage`.
    Heading,
    /// A command or flag a person types as it is.
    Command,
    /// What a command takes, such as `<display>`.
    Placeholder,
    /// Detail a person reads past: ids, labels, hints.
    Dim,
    /// A name or value that stands out.
    Bold,
    /// A healthy state: lit, unlocked, in.
    Good,
    /// A state worth noticing: urgent, held awake.
    Warn,
    /// A failure, or something recording the desktop.
    Bad,
    /// A mark of its own, such as a private window.
    Accent,
    /// The `error:` label.
    Error,
}

impl Paint {
    pub const PLAIN: Paint = Paint { color: false };
    pub const COLOR: Paint = Paint { color: true };

    /// Color for a stream that is a terminal, unless `NO_COLOR` is set and
    /// not empty (<https://no-color.org>) or `TERM` is `dumb`.
    pub fn for_stream(terminal: bool, env: &dyn Fn(&str) -> Option<String>) -> Paint {
        let refused = env("NO_COLOR").is_some_and(|said| !said.is_empty())
            || env("TERM").is_some_and(|term| term == "dumb");
        Paint {
            color: terminal && !refused,
        }
    }

    /// `text` in `style`.
    pub fn style(self, style: Style, text: &str) -> String {
        let codes = match style {
            Style::Plain => return text.to_string(),
            Style::Heading => "1;32",
            Style::Command => "1;36",
            Style::Placeholder => "36",
            Style::Dim => "2",
            Style::Bold => "1",
            Style::Good => "32",
            Style::Warn => "33",
            Style::Bad => "31",
            Style::Accent => "35",
            Style::Error => "1;31",
        };
        match self.color && !text.is_empty() {
            true => format!("\x1b[{codes}m{text}\x1b[0m"),
            false => text.to_string(),
        }
    }

    /// Prose whose `` `code` `` spans are bold, with the backticks dropped.
    pub fn inline(self, text: &str) -> String {
        text.split('`')
            .enumerate()
            .map(|(index, part)| match index % 2 {
                1 => self.style(Style::Bold, part),
                _ => part.to_string(),
            })
            .collect()
    }

    /// A usage such as `configure-display <display> <change>...`: its leading
    /// words, typed as they are, as commands, and the rest as what it takes.
    pub fn usage(self, usage: &str) -> String {
        let (command, takes) = split_usage(usage);
        let gap = if command.is_empty() || takes.is_empty() {
            ""
        } else {
            " "
        };
        format!(
            "{}{gap}{}",
            self.style(Style::Command, command),
            self.style(Style::Placeholder, takes)
        )
    }
}

/// A usage's leading literal words, and the rest: what it takes. A word is
/// literal unless it starts with `<` or `[` or offers choices with `|`.
pub fn split_usage(usage: &str) -> (&str, &str) {
    let literal = |word: &str| !word.starts_with(['<', '[']) && !word.contains('|');
    let mut end = 0;
    for word in usage.split(' ') {
        if !literal(word) {
            break;
        }
        end += word.len() + 1;
    }
    let end = end.min(usage.len());
    let (command, takes) = usage.split_at(end);
    (command.trim_end(), takes)
}

/// `text` broken between words into lines of at most `width` characters,
/// not counting backticks. A `` `code` `` span stays on one line, and a word
/// or span longer than `width` is a line of its own.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let shown = |line: &str| line.chars().filter(|&c| c != '`').count();
    let mut words: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        match words.last_mut() {
            Some(open) if open.matches('`').count() % 2 == 1 => {
                open.push(' ');
                open.push_str(word);
            }
            _ => words.push(word.to_string()),
        }
    }
    let mut lines: Vec<String> = Vec::new();
    for word in &words {
        match lines.last_mut() {
            Some(line) if shown(line) + 1 + shown(word) <= width => {
                line.push(' ');
                line.push_str(word);
            }
            _ => lines.push(word.clone()),
        }
    }
    lines
}
