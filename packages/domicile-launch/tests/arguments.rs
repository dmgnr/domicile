//! Tests for parsing the compositor command line.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use domicile_launch::arguments::{arguments, ArgumentError, Arguments};
use domicile_launch::handshake::Expected;

fn parse<const N: usize>(args: [&str; N]) -> Result<Arguments, ArgumentError> {
    arguments(args.into_iter().map(OsString::from))
}

fn the_required_two() -> [&'static str; 4] {
    [
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
    ]
}

#[test]
fn the_two_paths_the_shell_names_are_read_back() {
    let parsed = parse(the_required_two()).expect("both are there");

    assert_eq!(parsed.chrome_socket, PathBuf::from("/run/chrome.sock"));
    assert_eq!(parsed.session, PathBuf::from("/run/session.json"));
}

/// Nothing is defaulted from the environment.
#[test]
fn without_the_rest_there_is_no_config() {
    let parsed = parse(the_required_two()).expect("both are there");

    assert_eq!(parsed.config, None);
}

#[test]
fn a_config_is_read_when_given() {
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--config",
        "/run/config.json",
    ])
    .expect("all of them are there");

    assert_eq!(parsed.config, Some(PathBuf::from("/run/config.json")));
}

/// `--flag=value` and `--flag value` mean the same.
#[test]
fn a_value_may_be_joined_to_its_flag() {
    let parsed = parse([
        "--chrome-socket=/run/chrome.sock",
        "--session=/run/session.json",
        "--config=/run/config.json",
    ])
    .expect("all of them are there");

    assert_eq!(parsed.chrome_socket, PathBuf::from("/run/chrome.sock"));
    assert_eq!(parsed.session, PathBuf::from("/run/session.json"));
    assert_eq!(parsed.config, Some(PathBuf::from("/run/config.json")));
}

#[test]
fn a_missing_chrome_socket_is_refused() {
    let err = parse(["--session", "/run/session.json"]).expect_err("nothing serves the chrome");

    assert_eq!(
        err,
        ArgumentError::Missing {
            flag: "--chrome-socket"
        }
    );
}

#[test]
fn a_missing_session_is_refused() {
    let err = parse(["--chrome-socket", "/run/chrome.sock"])
        .expect_err("nothing would learn the displays");

    assert_eq!(err, ArgumentError::Missing { flag: "--session" });
}

#[test]
fn a_flag_with_nothing_after_it_is_refused() {
    let err = parse(["--chrome-socket"]).expect_err("there is no path");

    assert_eq!(
        err,
        ArgumentError::NeedsValue {
            flag: "--chrome-socket".into()
        }
    );
}

/// An empty value would fail later and far from the typo, such as binding a
/// socket at `""`.
#[test]
fn an_empty_value_is_refused() {
    let err = parse(["--chrome-socket=", "--session", "/run/session.json"])
        .expect_err("the socket has no name");

    assert_eq!(
        err,
        ArgumentError::EmptyValue {
            flag: "--chrome-socket".into()
        }
    );
}

/// Unknown arguments are refused so a request cannot silently do nothing.
#[test]
fn an_argument_nothing_reads_is_refused() {
    let err = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--shell",
        "manganese",
    ])
    .expect_err("--shell is gone");

    assert_eq!(
        err,
        ArgumentError::Unknown {
            argument: "--shell".into()
        }
    );
}

/// A repeated flag is ambiguous.
#[test]
fn a_flag_given_twice_is_refused() {
    let err = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--config",
        "/run/one.json",
        "--config",
        "/run/two.json",
    ])
    .expect_err("which config was meant?");

    assert_eq!(
        err,
        ArgumentError::Repeated {
            flag: "--config".into()
        }
    );
}

/// `--experiment-augmenter` is an unknown argument.
#[test]
fn the_augmenter_experiment_is_gone() {
    let err = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--experiment-augmenter",
    ])
    .expect_err("the flag no longer exists");

    assert_eq!(
        err,
        ArgumentError::Unknown {
            argument: "--experiment-augmenter".into()
        }
    );
}

/// The engine socket is optional.
#[test]
fn the_engine_socket_is_absent_unless_asked_for() {
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
    ])
    .expect("a command line without the engine parses");

    assert_eq!(parsed.engine_socket, None);
}

/// The engine socket is parsed like the other paths.
#[test]
fn the_engine_socket_is_read_as_a_path() {
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--engine-socket",
        "/run/domicile-engine.sock",
    ])
    .expect("an engine socket parses");

    assert_eq!(
        parsed.engine_socket.as_deref(),
        Some(Path::new("/run/domicile-engine.sock"))
    );
}

/// The page watchdog in `domicile_launch::handshake` is on by default.
#[test]
fn a_page_is_expected_unless_the_command_line_says_otherwise() {
    let parsed = parse(the_required_two()).expect("both are there");

    assert_eq!(parsed.expect_a_page, Expected::APage);
}

/// Engine test harnesses run with no control socket, so no page will connect.
#[test]
fn a_harness_with_no_shell_in_it_can_say_no_page_is_coming() {
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--expect-a-page",
        "no",
    ])
    .expect("a command line that says no page is coming parses");

    assert_eq!(parsed.expect_a_page, Expected::NoPage);
}

/// The default can be stated explicitly.
#[test]
fn saying_a_page_is_coming_is_the_same_as_not_saying() {
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--expect-a-page=yes",
    ])
    .expect("a command line that says a page is coming parses");

    assert_eq!(parsed.expect_a_page, Expected::APage);
}

/// Only `yes` and `no` are accepted, so a typo cannot silently leave the
/// watchdog on.
#[test]
fn a_word_that_is_neither_is_refused() {
    let err = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--expect-a-page",
        "maybe",
    ])
    .expect_err("there is no third answer");

    assert_eq!(
        err,
        ArgumentError::NotYesOrNo {
            flag: "--expect-a-page",
            value: "maybe".into()
        }
    );
}

/// Clients stay in the compositor's cgroup unless the launcher says the desk is
/// the session.
#[test]
fn clients_are_not_scoped_unless_the_command_line_says_so() {
    let parsed = parse(the_required_two()).expect("both are there");

    assert!(!parsed.scope_clients);
}

#[test]
fn the_session_scopes_its_clients() {
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--scope-clients",
        "yes",
    ])
    .expect("a command line that scopes clients parses");

    assert!(parsed.scope_clients);
}

/// As with `--expect-a-page`, a typo is refused.
#[test]
fn scoping_takes_yes_or_no() {
    let err = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--scope-clients",
        "on",
    ])
    .expect_err("on is neither yes nor no");

    assert_eq!(
        err,
        ArgumentError::NotYesOrNo {
            flag: "--scope-clients",
            value: "on".to_string(),
        }
    );
}

/// Windows go to the engine as dmabufs unless the launcher says it composites
/// on the CPU.
#[test]
fn windows_are_dmabufs_unless_the_command_line_says_otherwise() {
    let parsed = parse(the_required_two()).expect("both are there");
    assert!(!parsed.software_compositing);

    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--software-compositing",
        "yes",
    ])
    .expect("a command line for software compositing parses");
    assert!(parsed.software_compositing);
}

/// Emulated input goes to the seat unless the launcher says the engine
/// takes it, as a headless desk's does.
#[test]
fn emulated_input_goes_to_the_seat_unless_the_command_line_says_otherwise() {
    let parsed = parse(the_required_two()).expect("both are there");
    assert!(!parsed.engine_takes_input);

    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--engine-takes-input",
        "yes",
    ])
    .expect("a command line for a headless desk parses");
    assert!(parsed.engine_takes_input);
}

/// A real desk reads `/etc/pam.d`, which the compositor names.
#[test]
fn pam_services_come_from_the_machine_unless_the_command_line_says_otherwise() {
    let parsed = parse(the_required_two()).expect("both are there");

    assert_eq!(parsed.pam_confdir, None);
}

/// Tests point the lock at a PAM service of their own.
#[test]
fn a_directory_of_pam_services_is_read_as_a_path() {
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--pam-confdir",
        "/run/pam.d",
    ])
    .expect("a command line with a PAM directory parses");

    assert_eq!(parsed.pam_confdir, Some(PathBuf::from("/run/pam.d")));
}

#[test]
fn electron_entries_are_written_only_where_the_command_line_says() {
    assert_eq!(parse(the_required_two()).unwrap().electron_entries, None);
    let parsed = parse([
        "--chrome-socket",
        "/run/chrome.sock",
        "--session",
        "/run/session.json",
        "--electron-entries",
        "/run/domicile/share",
    ])
    .expect("an entries directory parses");

    assert_eq!(
        parsed.electron_entries.as_deref(),
        Some(Path::new("/run/domicile/share"))
    );
}
