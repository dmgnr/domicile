//! How `domicile list-*` prints what the desktop said, for a person. `--json`
//! prints the desktop's answer instead, for scripts.

use std::path::Path;

use domicile_protocol::{
    AgentReach, DesktopStatus, KnownAgents, ListedDisplay, ListedInput, ListedWindow, LogLevels,
    ShellBinding, ShellCommandHelp,
};
use serde::Serialize;

use crate::paint::{Paint, Style};

/// Some text in one style, part of a cell.
type Span = (String, Style);

/// Each display as a block: its names, mode, layout and color.
pub fn displays_table(paint: Paint, displays: &[ListedDisplay]) -> String {
    let label = |label: &str| paint.style(Style::Dim, &format!("{label:<6}"));
    let switch = |word: String| match word.as_str() {
        "on" => paint.style(Style::Good, &word),
        _ => word,
    };
    let dot = paint.style(Style::Dim, "·");
    displays
        .iter()
        .map(|listed| {
            let display = &listed.display;
            let refresh = match display.refresh_mhz {
                0 => String::new(),
                mhz => format!(" @ {}.{:03} Hz", mhz / 1000, mhz % 1000),
            };
            let state = match listed.lit {
                true => paint.style(Style::Good, "● lit"),
                false => paint.style(Style::Dim, "○ off"),
            };
            format!(
                "{}  {state}\n  {}  {}\n  {}  {}x{}{refresh}\n  \
                 {}  {}x{} at {},{} {dot} scale {} {dot} {}\n  \
                 {}  HDR {} {dot} adaptive sync {}\n",
                paint.style(Style::Bold, &display.name),
                label("names"),
                listed.names.join(", "),
                label("mode"),
                display.mode[0],
                display.mode[1],
                label("layout"),
                display.size[0],
                display.size[1],
                display.position[0],
                display.position[1],
                display.scale,
                wire_word(display.transform),
                label("color"),
                switch(wire_word(display.hdr)),
                switch(wire_word(display.adaptive_sync)),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every window as one row of an aligned table.
pub fn windows_table(paint: Paint, windows: &[ListedWindow]) -> String {
    let rows = windows.iter().map(|window| {
        let title = match window.title.as_str() {
            "" => none(),
            title => plain(title),
        };
        let marks = [
            (window.focused, "● focused", Style::Good),
            (!window.focused && window.urgent, "▲ urgent", Style::Warn),
            (window.private, "private", Style::Accent),
        ]
        .into_iter()
        .filter(|(shown, _, _)| *shown)
        .flat_map(|(_, mark, style)| [(" ".to_string(), Style::Plain), (mark.to_string(), style)]);
        vec![
            vec![(window.id.clone(), Style::Dim)],
            plain(&wire_word(window.kind)),
            window.app.as_deref().map_or_else(none, plain),
            window.pid.map_or_else(none, |pid| plain(&pid.to_string())),
            window.size.map_or_else(none, |[width, height]| {
                plain(&format!("{}x{}", width.round(), height.round()))
            }),
            title.into_iter().chain(marks).collect(),
        ]
    });
    table(paint, &["ID", "KIND", "APP", "PID", "SIZE", "TITLE"], rows)
}

/// How the desktop is, one line per question, with `-` for none.
pub fn status_table(paint: Paint, shell: &Path, status: &DesktopStatus) -> String {
    let list = |spans: Vec<Vec<Span>>| match spans.is_empty() {
        true => none(),
        false => spans.join(&(", ".to_string(), Style::Plain)),
    };
    let lines: [(&str, Vec<Span>); 7] = [
        ("shell", plain(&shell.display().to_string())),
        ("theme", plain(&wire_word(status.theme))),
        (
            "keymap",
            match status.keymap.as_deref() {
                None | Some("") => none(),
                Some(keymap) => plain(keymap),
            },
        ),
        (
            "locked",
            match status.locked {
                true => vec![("yes".to_string(), Style::Warn)],
                false => vec![("no".to_string(), Style::Good)],
            },
        ),
        (
            "screens",
            match status.screens_off {
                true => vec![("off".to_string(), Style::Dim)],
                false => vec![("lit".to_string(), Style::Good)],
            },
        ),
        (
            "held awake",
            list(
                status
                    .held_awake_by
                    .iter()
                    .map(|holder| vec![(holder.clone(), Style::Warn)])
                    .collect(),
            ),
        ),
        (
            "capturing",
            list(
                status
                    .capturing
                    .iter()
                    .map(|capturing| {
                        let kind = serde_json::to_value(&capturing.kind)
                            .expect("a capture always serializes");
                        let kind = kind["kind"].as_str().expect("a capture's kind is a word");
                        vec![
                            (capturing.app_id.clone(), Style::Bad),
                            (format!(" ({kind})"), Style::Dim),
                        ]
                    })
                    .collect(),
            ),
        ),
    ];
    lines
        .iter()
        .map(|(question, answer)| {
            format!(
                "{}  {}\n",
                paint.style(Style::Dim, &format!("{question:<10}")),
                painted(paint, answer)
            )
        })
        .collect()
}

/// Each command the shell runs, its usage lined up before what it does.
pub fn shell_commands_table(paint: Paint, commands: &[ShellCommandHelp]) -> String {
    if commands.is_empty() {
        return "The shell describes no commands.\n".to_string();
    }
    let width = commands
        .iter()
        .map(|command| command.usage.chars().count())
        .max()
        .expect("there are commands");
    commands
        .iter()
        .map(|command| {
            format!(
                "{}{}  {}\n",
                paint.usage(&command.usage),
                " ".repeat(width - command.usage.chars().count()),
                command.description
            )
        })
        .collect()
}

/// The level everything logs at, then each subsystem set apart from it.
pub fn log_levels_table(paint: Paint, levels: &LogLevels) -> String {
    let all = match levels.all {
        Some(level) => vec![(level.name().to_string(), Style::Bold)],
        None => vec![("as it started".to_string(), Style::Dim)],
    };
    let lines: Vec<(&str, Vec<Span>)> = std::iter::once(("everything", all))
        .chain(levels.subsystems.iter().map(|(subsystem, level)| {
            (
                subsystem.name(),
                vec![(level.name().to_string(), Style::Bold)],
            )
        }))
        .collect();
    let width = lines
        .iter()
        .map(|(name, _)| name.chars().count())
        .max()
        .expect("everything is a line");
    lines
        .iter()
        .map(|(name, level)| {
            format!(
                "{}  {}\n",
                paint.style(Style::Dim, &format!("{name:<width$}")),
                painted(paint, level)
            )
        })
        .collect()
}

/// Each binding, mode by mode, its chord lined up before what it runs.
pub fn bindings_table(paint: Paint, bindings: &[ShellBinding]) -> String {
    if bindings.is_empty() {
        return "The shell binds no keys.\n".to_string();
    }
    let width = bindings
        .iter()
        .map(|binding| binding.chord.chars().count())
        .max()
        .expect("there are bindings");
    let mut modes: Vec<&str> = Vec::new();
    for binding in bindings {
        if !modes.contains(&binding.mode.as_str()) {
            modes.push(&binding.mode);
        }
    }
    modes
        .iter()
        .map(|mode| {
            let rows: String = bindings
                .iter()
                .filter(|binding| binding.mode == *mode)
                .map(|binding| {
                    format!(
                        "  {}{}  {}\n",
                        paint.style(Style::Command, &binding.chord),
                        " ".repeat(width - binding.chord.chars().count()),
                        binding.action
                    )
                })
                .collect();
            format!("{}\n{rows}", paint.style(Style::Heading, mode))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every input device as one row of an aligned table, its USB or Bluetooth ids
/// as `lsusb` prints them.
pub fn inputs_table(paint: Paint, inputs: &[ListedInput]) -> String {
    let rows = inputs.iter().map(|input| {
        vec![
            vec![(input.id.to_string(), Style::Dim)],
            plain(&wire_word(input.kind)),
            plain(&wire_word(input.connection)),
            match (input.vendor, input.product) {
                (0, 0) => none(),
                (vendor, product) => vec![(format!("{vendor:04x}:{product:04x}"), Style::Dim)],
            },
            plain(&input.name),
        ]
    });
    table(
        paint,
        &["ID", "KIND", "CONNECTION", "VENDOR:PRODUCT", "NAME"],
        rows,
    )
}

/// The agents let in now, then those remembered: each one's session (`-`
/// for a remembered one not in now), whether it is in or remembered, what
/// it reaches, and its name.
pub fn agents_table(paint: Paint, agents: &KnownAgents) -> String {
    let reach = |reach: &AgentReach| match reach {
        AgentReach::Desk => "desk".to_string(),
        AgentReach::Windows { windows } => windows
            .iter()
            .map(|window| window.id.as_str())
            .collect::<Vec<_>>()
            .join(","),
    };
    let connected = agents.connected.iter().map(|agent| {
        vec![
            plain(&agent.session.to_string()),
            vec![("● in".to_string(), Style::Good)],
            plain(&reach(&agent.reach)),
            plain(&agent.agent),
        ]
    });
    let remembered = agents.remembered.iter().map(|agent| {
        vec![
            none(),
            vec![("remembered".to_string(), Style::Dim)],
            vec![("desk".to_string(), Style::Dim)],
            plain(&agent.agent),
        ]
    });
    table(
        paint,
        &["SESSION", "STATE", "REACH", "AGENT"],
        connected.chain(remembered),
    )
}

/// `rows` under a bold `header`, each column as wide as its widest cell. The
/// last column is not padded.
fn table(paint: Paint, header: &[&str], rows: impl Iterator<Item = Vec<Vec<Span>>>) -> String {
    let header: Vec<Vec<Span>> = header
        .iter()
        .map(|title| vec![(title.to_string(), Style::Bold)])
        .collect();
    let rows: Vec<Vec<Vec<Span>>> = std::iter::once(header).chain(rows).collect();
    let shown =
        |cell: &[Span]| -> usize { cell.iter().map(|(text, _)| text.chars().count()).sum() };
    let last = rows[0].len() - 1;
    let widths: Vec<usize> = (0..last)
        .map(|column| {
            rows.iter()
                .map(|row| shown(&row[column]))
                .max()
                .expect("the header is a row")
        })
        .collect();
    rows.iter()
        .map(|row| {
            let padded: String = widths
                .iter()
                .zip(row)
                .map(|(width, cell)| {
                    format!(
                        "{}{}  ",
                        painted(paint, cell),
                        " ".repeat(width - shown(cell))
                    )
                })
                .collect();
            format!("{padded}{}\n", painted(paint, &row[last]))
        })
        .collect()
}

fn painted(paint: Paint, cell: &[Span]) -> String {
    cell.iter()
        .map(|(text, style)| paint.style(*style, text))
        .collect()
}

fn plain(text: &str) -> Vec<Span> {
    vec![(text.to_string(), Style::Plain)]
}

/// A dim `-` for a value there is none of.
fn none() -> Vec<Span> {
    vec![("-".to_string(), Style::Dim)]
}

/// How the wire spells `value`, such as `rotate-90` or `native`.
fn wire_word(value: impl Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(word)) => word,
        other => panic!("a listed enum is a word on the wire, not {other:?}"),
    }
}
