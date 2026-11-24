//! Tests for parsing builder output and drawing the progress bar.

use std::path::PathBuf;

use domicile_launch::build_progress::{bar, heard, Heard, Step};
use domicile_launch::paint::Paint;
use domicile_launch::shell_path::{Shell, ShellFiles};

#[test]
fn each_step_is_read_off_its_line() {
    assert_eq!(
        heard(r#"{"step":"resolving"}"#),
        Heard::Step(Step::Resolving)
    );
    assert_eq!(
        heard(r#"{"packages":["date-fns","zod"],"step":"installing"}"#),
        Heard::Step(Step::Installing(vec!["date-fns".into(), "zod".into()]))
    );
    assert_eq!(heard(r#"{"step":"bundling"}"#), Heard::Step(Step::Bundling));
}

#[test]
fn a_build_ends_with_the_module_or_why_not() {
    assert_eq!(
        heard(r#"{"cached":true,"module":"shell.js","root":"/c/k","step":"built"}"#),
        Heard::Built(Shell {
            files: ShellFiles::Directory,
            root: PathBuf::from("/c/k"),
            module: PathBuf::from("shell.js"),
        })
    );
    assert_eq!(
        heard(r#"{"cached":false,"config":"/c/configs/k.json","step":"evaluated"}"#),
        Heard::Evaluated(PathBuf::from("/c/configs/k.json"))
    );
    assert_eq!(
        heard(r#"{"step":"failed","why":"no file at /x"}"#),
        Heard::Failed("no file at /x".into())
    );
}

#[test]
fn a_dev_server_says_where_it_listens() {
    // `domicile dev` loads this, so the engine reads the shell's files from
    // the socket rather than from a directory.
    assert_eq!(
        heard(r#"{"module":"domicile-dev-shell.js","socket":"/run/dev.sock","step":"serving"}"#),
        Heard::Serving(Shell {
            files: ShellFiles::DevServer,
            root: PathBuf::from("/run/dev.sock"),
            module: PathBuf::from("domicile-dev-shell.js"),
        })
    );
}

#[test]
fn anything_else_is_the_build_s_log() {
    // Panda logs timings to the same stdout.
    assert_eq!(
        heard("🐼 info [hrtime] Extracted in (2185.91ms)"),
        Heard::Log("🐼 info [hrtime] Extracted in (2185.91ms)".into())
    );
    assert_eq!(
        heard(r#"{"step":"teleporting"}"#),
        Heard::Log(r#"{"step":"teleporting"}"#.into())
    );
}

#[test]
fn the_bar_fills_with_the_steps() {
    assert_eq!(
        bar(Paint::PLAIN, &Step::Resolving),
        "  ⠁ Building shell · reading what it imports"
    );
    assert_eq!(
        bar(Paint::PLAIN, &Step::Installing(vec!["date-fns".into()])),
        "  ⠃ Building shell · installing date-fns"
    );
    assert_eq!(
        bar(Paint::COLOR, &Step::Bundling),
        "  \x1b[36m⠇\x1b[0m Building shell \x1b[2m·\x1b[0m bundling"
    );
}
