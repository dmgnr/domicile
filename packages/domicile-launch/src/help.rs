//! `domicile --help` and `domicile help <command>`, made from
//! [`crate::commands`].

use crate::commands::{Command, Group, COMMANDS, RUN};
use crate::paint::{wrap, Paint, Style};

/// How wide help is, in columns.
const WIDTH: usize = 80;

/// Every command, grouped, each with its summary in one column.
pub fn overview(paint: Paint) -> String {
    let options = &RUN
        .sections
        .iter()
        .find(|section| section.title == "Options")
        .expect("running a desktop has options")
        .entries;
    let terms = COMMANDS
        .iter()
        .map(term)
        .chain(options.iter().map(|(term, _)| term.to_string()));
    let column = terms
        .map(|term| term.chars().count())
        .max()
        .expect("there are commands");
    let row = |term: &str, text: &str| {
        format!(
            "  {}{}  {}\n",
            paint.usage(term),
            " ".repeat(column - term.chars().count()),
            paint.inline(text)
        )
    };
    let groups: String = Group::ALL
        .iter()
        .map(|&group| {
            let rows: String = COMMANDS
                .iter()
                .filter(|command| command.group == group)
                .map(|command| row(&term(command), command.summary))
                .collect();
            format!("\n{}\n{rows}", paint.style(Style::Heading, group.title()))
        })
        .collect();
    let options: String = options.iter().map(|(term, text)| row(term, text)).collect();
    format!(
        "{}{groups}\n{}\n{options}\n{} {} {} {}{}\n",
        usage_lines(paint, &RUN),
        paint.style(Style::Heading, "Options"),
        paint.style(Style::Dim, "Run"),
        paint.style(Style::Bold, "domicile help <command>"),
        paint.style(Style::Dim, "for details, or"),
        paint.style(Style::Bold, "man domicile"),
        paint.style(Style::Dim, "."),
    )
}

/// One command's help: usage, what it does, what it takes, examples and the
/// commands it goes with.
pub fn command_help(paint: Paint, command: &Command) -> String {
    let about: String = command
        .about
        .iter()
        .map(|paragraph| format!("\n{}", block(paint, paragraph, 2)))
        .collect();
    let sections: String = command
        .sections
        .iter()
        .map(|section| {
            let column = section
                .entries
                .iter()
                .map(|(term, _)| term.chars().count())
                .max()
                .expect("a section has entries");
            let entries: String = section
                .entries
                .iter()
                .map(|(term, text)| entry(paint, term, text, column))
                .collect();
            format!(
                "\n{}\n{entries}",
                paint.style(Style::Heading, section.title)
            )
        })
        .collect();
    let examples = match command.examples {
        [] => String::new(),
        examples => format!(
            "\n{}\n{}",
            paint.style(Style::Heading, "Examples"),
            examples
                .iter()
                .map(|example| format!("  {} {example}\n", paint.style(Style::Dim, "$")))
                .collect::<String>()
        ),
    };
    let kin = command
        .see_also
        .iter()
        .map(|kin| kin.to_string())
        // In backticks, which `wrap` keeps on one line.
        .chain(std::iter::once(format!("`man domicile-{}`", command.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let see_also = wrap(&kin, WIDTH - 10)
        .iter()
        .map(|line| {
            line.split(", ")
                .map(|kin| paint.style(Style::Bold, kin.trim_end_matches(',').trim_matches('`')))
                .collect::<Vec<_>>()
                .join(&paint.style(Style::Dim, ", "))
                + &match line.ends_with(',') {
                    true => paint.style(Style::Dim, ","),
                    false => String::new(),
                }
        })
        .collect::<Vec<_>>()
        .join(&format!("\n{}", " ".repeat(10)));
    format!(
        "{}  {}\n\n{}{about}{sections}{examples}\n{}  {see_also}\n",
        paint.style(Style::Bold, &format!("domicile {}", command.name)),
        command.summary,
        usage_lines(paint, command),
        paint.style(Style::Dim, "See also"),
    )
}

/// What `domicile --version` prints, each line's label set apart.
pub fn version_lines(paint: Paint, said: &str) -> String {
    said.lines()
        .map(|line| {
            let (label, rest) = line.split_at(line.find(' ').unwrap_or(line.len()));
            let style = match label {
                "domicile" => Style::Bold,
                _ => Style::Dim,
            };
            format!("{}{rest}\n", paint.style(style, label))
        })
        .collect()
}

/// `said` as an error, for stderr.
pub fn error(paint: Paint, said: &str) -> String {
    format!("{} {said}\n", paint.style(Style::Error, "error:"))
}

/// `said`, a command line `command` refused, followed by how to call it.
pub fn with_usage(paint: Paint, said: &str, command: &Command) -> String {
    let usages: String = usage_lines(paint, command)
        .lines()
        .map(|line| format!("\n  {line}"))
        .collect();
    format!(
        "{said}\n{usages}\n  {} {}{}",
        paint.style(Style::Dim, "See"),
        paint.style(Style::Bold, &format!("domicile help {}", command.name)),
        paint.style(Style::Dim, "."),
    )
}

/// What the overview lists for `command`: its name and what it takes.
fn term(command: &Command) -> String {
    format!("{} {}", command.name, command.takes)
        .trim_end()
        .to_string()
}

/// `Usage` and each way to call `command`, lined up under the first.
fn usage_lines(paint: Paint, command: &Command) -> String {
    command
        .usages()
        .iter()
        .enumerate()
        .map(|(index, usage)| {
            let label = match index {
                0 => paint.style(Style::Heading, "Usage"),
                _ => "     ".to_string(),
            };
            format!(
                "{label}  {} {}\n",
                paint.style(Style::Bold, "domicile"),
                paint.usage(usage)
            )
        })
        .collect()
}

/// A section's entry: its term in a column of `column` characters, then what
/// it is, wrapped under itself.
fn entry(paint: Paint, term: &str, text: &str, column: usize) -> String {
    let indent = 2 + column + 2;
    let painted_term = match term.starts_with('<') || term.chars().all(|c| c.is_ascii_digit()) {
        true => paint.style(Style::Placeholder, term),
        false => paint.usage(term),
    };
    let lines = wrap(text, WIDTH.saturating_sub(indent).max(30));
    let (first, rest) = lines.split_first().expect("an entry says something");
    let rest: String = rest
        .iter()
        .map(|line| format!("{}{}\n", " ".repeat(indent), paint.inline(line)))
        .collect();
    format!(
        "  {painted_term}{}  {}\n{rest}",
        " ".repeat(column - term.chars().count()),
        paint.inline(first)
    )
}

/// A paragraph wrapped to the help's width, each line indented by `indent`.
fn block(paint: Paint, paragraph: &str, indent: usize) -> String {
    wrap(paragraph, WIDTH - indent)
        .iter()
        .map(|line| format!("{}{}\n", " ".repeat(indent), paint.inline(line)))
        .collect()
}
