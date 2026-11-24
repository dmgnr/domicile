//! Tests for `domicile --help` and `domicile help <command>`.

use domicile_launch::commands::{meant, COMMANDS};
use domicile_launch::help::{command_help, overview};
use domicile_launch::paint::Paint;

#[test]
fn the_overview_lists_every_command_with_its_summary_in_one_column() {
    let help = overview(Paint::PLAIN);
    let columns: Vec<usize> = COMMANDS
        .iter()
        .map(|command| {
            let line = help
                .lines()
                .find(|line| {
                    line.trim_start().starts_with(&format!("{} ", command.name))
                        || line.trim() == command.name
                })
                .unwrap_or_else(|| panic!("--help does not list {}", command.name));
            line.find(command.summary)
                .unwrap_or_else(|| panic!("{line:?} lacks {}'s summary", command.name))
        })
        .collect();
    assert!(
        columns.iter().all(|column| *column == columns[0]),
        "summaries start at columns {columns:?}"
    );
}

#[test]
fn the_overview_groups_commands_under_headings_and_ends_pointing_at_more() {
    let help = overview(Paint::PLAIN);
    assert!(
        help.starts_with("Usage  domicile [shell] [--config <file>]\n"),
        "{help}"
    );
    for heading in ["\nShell\n", "\nDisplays\n", "\nOptions\n"] {
        assert!(help.contains(heading), "no {heading:?} in {help}");
    }
    assert!(
        help.ends_with("Run domicile help <command> for details, or man domicile.\n"),
        "{help}"
    );
}

#[test]
fn plain_help_has_no_escapes_and_colored_help_paints_its_headings() {
    assert!(!overview(Paint::PLAIN).contains('\x1b'));
    assert!(overview(Paint::COLOR).contains("\x1b[1;32mDisplays\x1b[0m"));
}

#[test]
fn a_commands_help_has_its_usage_sections_examples_and_kin() {
    let configure = COMMANDS
        .iter()
        .find(|command| command.name == "configure-display")
        .expect("configure-display is a command");
    let help = command_help(Paint::PLAIN, configure);
    for part in [
        "domicile configure-display  Change a monitor until restart\n",
        "\nUsage  domicile configure-display <display> <change>...\n",
        "\nChanges\n  mode <W>x<H>[@Hz]  ",
        "\nExamples\n  $ domicile configure-display DP-1 mode 2560x1440@144 scale 1.25\n",
        "\nSee also  list-displays, man domicile-configure-display\n",
    ] {
        assert!(help.contains(part), "no {part:?} in\n{help}");
    }
    assert!(!help.contains('`'), "{help}");
}

#[test]
fn every_commands_help_fits_80_columns() {
    for command in COMMANDS {
        for line in command_help(Paint::PLAIN, command).lines() {
            assert!(line.chars().count() <= 80, "{}: {line:?}", command.name);
        }
    }
}

#[test]
fn a_command_with_several_forms_lists_each_under_usage() {
    let open = COMMANDS
        .iter()
        .find(|command| command.name == "open")
        .expect("open");
    let help = command_help(Paint::PLAIN, open);
    assert!(
        help.contains(
            "\nUsage  domicile open <file|folder|url>\n       domicile open --profile <id> <url>\n"
        ),
        "{help}"
    );
}

#[test]
fn a_near_miss_suggests_the_command_it_likely_meant() {
    assert_eq!(meant("lsit-windows"), Some("list-windows"));
    assert_eq!(meant("wndows"), Some("list-windows"));
    assert_eq!(meant("screnshot"), Some("screenshot"));
    assert_eq!(meant("./dist/shell.js"), None);
    assert_eq!(meant("manganese"), None);
}

#[test]
fn the_overview_fits_80_columns_and_no_summary_ends_in_a_period() {
    let help = overview(Paint::PLAIN);
    for line in help.lines() {
        assert!(line.chars().count() <= 80, "{line:?} is too wide");
    }
    for command in COMMANDS {
        assert!(!command.summary.ends_with('.'), "{}", command.name);
    }
}

#[test]
fn an_error_is_labeled_and_a_commands_error_ends_with_its_usage() {
    use domicile_launch::commands::command;
    use domicile_launch::help::{error, with_usage};
    assert_eq!(error(Paint::PLAIN, "no desktop."), "error: no desktop.\n");
    assert_eq!(
        error(Paint::COLOR, "no desktop."),
        "\x1b[1;31merror:\x1b[0m no desktop.\n"
    );
    assert_eq!(
        with_usage(
            Paint::PLAIN,
            "lock takes no arguments.",
            command("lock").expect("lock is a command")
        ),
        "lock takes no arguments.\n\n  Usage  domicile lock\n  See domicile help lock.",
    );
}

#[test]
fn the_version_labels_each_line() {
    use domicile_launch::help::version_lines;
    let said = "domicile 1.2.0\ncommit   144a93c\nengine   s2ffe1826ced0, checked build\n";
    assert_eq!(version_lines(Paint::PLAIN, said), said);
    assert_eq!(
        version_lines(Paint::COLOR, said),
        "\x1b[1mdomicile\x1b[0m 1.2.0\n\x1b[2mcommit\x1b[0m   144a93c\n\x1b[2mengine\x1b[0m   s2ffe1826ced0, checked build\n"
    );
}
