//! Tests for the man pages `domicile help --man` writes.

use domicile_launch::commands::COMMANDS;
use domicile_launch::man::pages;

fn page(name: &str) -> String {
    pages()
        .into_iter()
        .find(|(file, _)| file == name)
        .unwrap_or_else(|| panic!("no {name}"))
        .1
}

#[test]
fn there_is_a_page_for_domicile_and_one_for_each_command() {
    let files: Vec<String> = pages().into_iter().map(|(file, _)| file).collect();
    assert_eq!(files[0], "domicile.1");
    for command in COMMANDS {
        assert!(
            files.contains(&format!("domicile-{}.1", command.name)),
            "no page for {}",
            command.name
        );
    }
    assert_eq!(files.len(), COMMANDS.len() + 1);
}

#[test]
fn a_commands_page_has_its_name_synopsis_description_sections_and_kin() {
    let page = page("domicile-configure-display.1");
    for part in [
        ".TH DOMICILE\\-CONFIGURE\\-DISPLAY 1 \"\" \"Domicile\" \"Domicile Manual\"\n.nh\n.ad l\n.ds AD l\n",
        ".SH NAME\ndomicile\\-configure\\-display \\- change a monitor until restart\n",
        ".SH SYNOPSIS\n\\fBdomicile configure\\-display\\fR \\fIdisplay\\fR \\fIchange\\fR...\n",
        ".SH DESCRIPTION\n",
        "\\fBoutput.displays\\fR",
        ".SH CHANGES\n.TP\n\\fBmode\\fR \\fIW\\fRx\\fIH\\fR[@Hz]\nA mode the monitor offers\n",
        ".SH EXAMPLES\n.nf\n.RS\n",
        "\ndomicile configure\\-display DP\\-1 reset\n",
        ".SH SEE ALSO\n\\fBdomicile\\fR(1), \\fBdomicile\\-list\\-displays\\fR(1)\n",
    ] {
        assert!(page.contains(part), "no {part:?} in\n{page}");
    }
    assert!(!page.contains('`'), "{page}");
}

#[test]
fn the_domicile_page_lists_every_command_and_points_at_its_page() {
    let page = page("domicile.1");
    assert!(page.contains(".SH COMMANDS\n.SS Shell\n"), "{page}");
    for command in COMMANDS {
        let name = command.name.replace('-', "\\-");
        assert!(
            page.contains(&format!(".TP\n\\fB{name}")),
            "no {} in\n{page}",
            command.name
        );
        assert!(page.contains(&format!("\\fBdomicile\\-{name}\\fR(1)")));
    }
    assert!(page.contains(".SH ENVIRONMENT\n"), "{page}");
}

#[test]
fn every_line_that_starts_with_a_period_is_a_request() {
    let requests = [
        ".TH ", ".nh", ".ad l", ".ds AD l", ".SH ", ".SS ", ".TP", ".PP", ".br", ".nf", ".fi",
        ".RS", ".RE",
    ];
    for (file, page) in pages() {
        for line in page.lines() {
            assert!(
                !line.starts_with('\'')
                    && (!line.starts_with('.')
                        || requests.iter().any(|request| line.starts_with(request))),
                "{file}: {line:?}"
            );
        }
    }
}
