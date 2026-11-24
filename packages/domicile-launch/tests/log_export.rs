//! The file `domicile export-logs` writes: what someone attaches to a bug.

use domicile_launch::journal::Priority;
use domicile_launch::log_export::{report, Report};
use domicile_launch::recent_log::Said;
use domicile_protocol::{LogLevel, LogLevels};

fn said(message: &str) -> Said {
    Said {
        at: 1_795_799_523_000_000,
        identifier: "domicile-engine".to_string(),
        priority: Priority::Error,
        message: message.to_string(),
    }
}

fn parts<'a>(logs: &'a [Said], titles: &'a [String], redact: bool) -> Report<'a> {
    Report {
        at: "2026-11-27 09:12:03",
        up: "domicile is up. domicile 1.3.0 · shell /desk/shell.js",
        levels: LogLevels {
            all: Some(LogLevel::Debug),
            ..LogLevels::default()
        },
        displays: Ok("DP-1 2560x1440".to_string()),
        inputs: Err("the compositor did not answer".to_string()),
        from: "the journal",
        logs,
        offset: 0,
        titles,
        redact,
    }
}

#[test]
fn it_says_what_the_desktop_was_then_what_it_said() {
    let logs = [said("the bus is gone")];
    let text = report(&parts(&logs, &[], true));
    let up = text.find("domicile is up. domicile 1.3.0").unwrap();
    let displays = text.find("DP-1 2560x1440").unwrap();
    let line = text
        .find("2026-11-27 17:12:03.000 domicile-engine err: the bus is gone")
        .unwrap();
    assert!(up < displays && displays < line, "{text}");
    assert!(text.contains("Exported 2026-11-27 09:12:03"), "{text}");
    assert!(text.contains("all debug"), "{text}");
    assert!(text.contains("from the journal"), "{text}");
}

#[test]
fn a_part_that_did_not_answer_says_why() {
    let text = report(&parts(&[], &[], true));
    assert!(
        text.contains("Inputs\n\nnot read: the compositor did not answer"),
        "{text}"
    );
}

#[test]
fn it_hides_urls_and_titles_unless_asked_not_to() {
    let logs = [said("Inbox - Gmail at https://mail.google.com/")];
    let titles = ["Inbox - Gmail".to_string()];
    let hidden = report(&parts(&logs, &titles, true));
    assert!(hidden.contains("err: <window title> at <url>"), "{hidden}");
    assert!(
        hidden.contains("URLs and window titles are hidden"),
        "{hidden}"
    );
    let shown = report(&parts(&logs, &titles, false));
    assert!(
        shown.contains("err: Inbox - Gmail at https://mail.google.com/"),
        "{shown}"
    );
    assert!(shown.contains("nothing is hidden"), "{shown}");
}

#[test]
fn no_lines_says_so() {
    let text = report(&parts(&[], &[], true));
    assert!(text.contains("Nothing was logged."), "{text}");
}
