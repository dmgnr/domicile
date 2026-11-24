//! The man pages `domicile help --man <dir>` writes: `domicile(1)`, and a
//! `domicile-<command>(1)` for each command, made from [`crate::commands`].

use crate::commands::{Command, Group, Section, COMMANDS, RUN};
use crate::paint::split_usage;

/// Each page's file name and its roff.
pub fn pages() -> Vec<(String, String)> {
    std::iter::once(("domicile.1".to_string(), main_page()))
        .chain(COMMANDS.iter().map(|command| {
            (
                format!("domicile-{}.1", command.name),
                command_page(command),
            )
        }))
        .collect()
}

/// `domicile(1)`: running a desktop, then every command.
fn main_page() -> String {
    let commands: String = Group::ALL
        .iter()
        .map(|&group| {
            let entries: String = COMMANDS
                .iter()
                .filter(|command| command.group == group)
                .map(|command| {
                    format!(
                        ".TP\n{}\n{}. See \\fBdomicile\\-{}\\fR(1).\n",
                        usage(&format!("{} {}", command.name, command.takes)),
                        text(command.summary),
                        escape(command.name)
                    )
                })
                .collect();
            format!(".SS {}\n{entries}", group.title())
        })
        .collect();
    let (before, after) = RUN.sections.split_at(1);
    format!(
        "{}.SH NAME\ndomicile \\- run and control a desktop\n{}{}{}.SH COMMANDS\n{commands}{}{}",
        heading("domicile"),
        synopsis(&RUN),
        description(&RUN),
        sections(before),
        sections(after),
        examples(&RUN),
    )
}

/// `domicile-<command>(1)`.
fn command_page(command: &Command) -> String {
    let see_also = std::iter::once("domicile".to_string())
        .chain(command.see_also.iter().map(|kin| format!("domicile-{kin}")))
        .map(|page| format!("\\fB{}\\fR(1)", escape(&page)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{}.SH NAME\ndomicile\\-{} \\- {}\n{}{}{}{}.SH SEE ALSO\n{see_also}\n",
        heading(&format!("domicile-{}", command.name)),
        escape(command.name),
        text(&lowercase_first(command.summary)),
        synopsis(command),
        description(command),
        sections(command.sections),
        examples(command),
    )
}

fn heading(page: &str) -> String {
    format!(
        // Ragged right, without hyphenation: commands and flags stay whole.
        ".TH {} 1 \"\" \"Domicile\" \"Domicile Manual\"\n.nh\n.ad l\n.ds AD l\n",
        escape(&page.to_uppercase())
    )
}

fn synopsis(command: &Command) -> String {
    let lines = command
        .usages()
        .iter()
        .map(|form| usage(&format!("domicile {form}")))
        .collect::<Vec<_>>()
        .join("\n.br\n");
    format!(".SH SYNOPSIS\n{lines}\n")
}

fn description(command: &Command) -> String {
    let paragraphs = command
        .about
        .iter()
        .map(|paragraph| text(paragraph))
        .collect::<Vec<_>>()
        .join("\n.PP\n");
    format!(".SH DESCRIPTION\n{paragraphs}\n")
}

fn sections(sections: &[Section]) -> String {
    sections
        .iter()
        .map(|section| {
            let entries: String = section
                .entries
                .iter()
                .map(|(term, said)| format!(".TP\n{}\n{}\n", usage(term), text(said)))
                .collect();
            format!(".SH {}\n{entries}", section.title.to_uppercase())
        })
        .collect()
}

fn examples(command: &Command) -> String {
    match command.examples {
        [] => String::new(),
        examples => format!(
            ".SH EXAMPLES\n.nf\n.RS\n{}\n.RE\n.fi\n",
            examples
                .iter()
                .map(|example| line_safe(&escape(example)))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    }
}

/// A usage in roff: its literal words bold, `<value>`s italic without their
/// brackets.
fn usage(usage: &str) -> String {
    let (command, takes) = split_usage(usage.trim_end());
    let bold = match command {
        "" => String::new(),
        command => format!("\\fB{}\\fR", escape(command)),
    };
    let gap = if bold.is_empty() || takes.is_empty() {
        ""
    } else {
        " "
    };
    let mut takes_roff = String::new();
    let mut rest = takes;
    while let Some(open) = rest.find('<') {
        let close = rest[open..].find('>').expect("a <value> closes") + open;
        takes_roff.push_str(&escape(&rest[..open]));
        takes_roff.push_str(&format!("\\fI{}\\fR", escape(&rest[open + 1..close])));
        rest = &rest[close + 1..];
    }
    takes_roff.push_str(&escape(rest));
    line_safe(&format!("{bold}{gap}{takes_roff}"))
}

/// Prose in roff, its `` `code` `` bold.
fn text(prose: &str) -> String {
    let roff: String = prose
        .split('`')
        .enumerate()
        .map(|(index, part)| match index % 2 {
            1 => format!("\\fB{}\\fR", escape(part)),
            _ => escape(part),
        })
        .collect();
    line_safe(&roff)
}

/// `text` with roff's special characters escaped.
fn escape(text: &str) -> String {
    text.replace('\\', "\\e").replace('-', "\\-")
}

/// A line roff will not take as a request.
fn line_safe(line: &str) -> String {
    match line.starts_with(['.', '\'']) {
        true => format!("\\&{line}"),
        false => line.to_string(),
    }
}

fn lowercase_first(summary: &str) -> String {
    let mut chars = summary.chars();
    let first = chars.next().expect("a summary says something");
    first.to_lowercase().chain(chars).collect()
}
