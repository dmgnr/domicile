//! Starting a run's components and reporting which one exited.
//!
//! These use real `/bin/sh` processes, because the behavior under test is which
//! child `wait` reports on.

use std::ffi::OsString;
use std::path::PathBuf;

use domicile_launch::spawn::Spawn;
use domicile_launch::supervise::Running;

fn sh(script: &str) -> Spawn {
    Spawn {
        program: PathBuf::from("/bin/sh"),
        args: vec![OsString::from("-c"), OsString::from(script)],
        env: Vec::new(),
    }
}

#[test]
fn a_component_that_will_not_start_says_which_one_and_where_it_looked() {
    let mut running = Running::new();

    let failed = running
        .start(
            "engine",
            &Spawn {
                program: PathBuf::from("/nowhere/chrome"),
                args: Vec::new(),
                env: Vec::new(),
            },
        )
        .expect_err("there is no such program");

    let said = failed.to_string();
    assert!(said.contains("engine"), "{said}");
    assert!(said.contains("/nowhere/chrome"), "{said}");
}

#[test]
fn nothing_has_exited_while_everything_is_running() {
    let mut running = Running::new();
    running.start("engine", &sh("sleep 30")).expect("it starts");

    assert_eq!(running.exited(), None);
}

#[test]
fn the_component_that_exited_is_named_however_late_it_was_started() {
    // The engine exits while the compositor keeps running. Both start orders
    // are tested so "the first in the list" cannot pass for "the one that
    // exited".
    let mut running = Running::new();
    running.start("engine", &sh("exit 4")).expect("it starts");
    running
        .start("compositor", &sh("sleep 30"))
        .expect("it starts");

    let exit = running.until_one_exits();
    assert_eq!(exit.what, "engine");
    assert!(exit.how.contains('4'), "{}", exit.how);
    // The message states only the exit. `domicile_launch::restart` decides what
    // follows.
    assert_eq!(exit.to_string(), "the engine exited (exit status: 4)");
}

#[test]
fn one_component_is_let_go_of_without_the_run_letting_go_of_the_other() {
    // An engine restarts under a compositor that is still serving. The dead
    // engine must leave the list, or `wait` would report it on every poll and
    // miss its replacement. The compositor stays untouched so its clients are
    // unaffected.
    let mut running = Running::new();
    running.start("engine", &sh("exit 4")).expect("it starts");
    running
        .start("compositor", &sh("sleep 30"))
        .expect("it starts");
    assert_eq!(running.until_one_exits().what, "engine");

    running.let_go_of("engine");

    assert_eq!(
        running.exited(),
        None,
        "the compositor is still running and the engine is no longer this run's to report"
    );
    running.start("engine", &sh("exit 7")).expect("it starts");
    let exit = running.until_one_exits();
    assert_eq!(exit.what, "engine");
    assert!(exit.how.contains('7'), "{}", exit.how);
}

#[test]
fn the_component_that_exited_is_named_however_early_it_was_started() {
    let mut running = Running::new();
    running.start("engine", &sh("sleep 30")).expect("it starts");
    running
        .start("compositor", &sh("exit 5"))
        .expect("it starts");

    let exit = running.until_one_exits();
    assert_eq!(exit.what, "compositor");
    assert!(exit.how.contains('5'), "{}", exit.how);
}

#[test]
fn waiting_for_an_exit_does_not_wake_until_one_comes() {
    // Polling every 100 ms would block and wake about ten times in a second.
    let mut running = Running::new();
    running.start("engine", &sh("sleep 1")).expect("it starts");

    let woken = std::thread::spawn(move || {
        let before = voluntary_switches();
        assert_eq!(running.until_one_exits().what, "engine");
        voluntary_switches() - before
    })
    .join()
    .expect("the wait returns");

    assert!(woken < 5, "woke {woken} times");
}

/// How often this thread has blocked.
fn voluntary_switches() -> u64 {
    std::fs::read_to_string("/proc/thread-self/status")
        .expect("Linux reports on its threads")
        .lines()
        .find_map(|line| line.strip_prefix("voluntary_ctxt_switches:"))
        .expect("the status counts switches")
        .trim()
        .parse()
        .expect("a count")
}

#[test]
fn a_heard_components_stderr_reaches_its_listener_line_by_line() {
    // The engine's lines become journal entries one at a time, and the last
    // ones, which say why it died, must not be lost when the run ends.
    let said = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let listening = std::sync::Arc::clone(&said);
    let mut running = Running::new();
    running
        .start_heard(
            "engine",
            &sh("printf 'first\\nsecond\\n' >&2"),
            Box::new(move |line: &str| listening.lock().unwrap().push(line.to_string())),
        )
        .expect("it starts");

    while running.exited().is_none() {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    drop(running);

    assert_eq!(*said.lock().unwrap(), ["first", "second"]);
}

#[test]
fn a_heard_component_ends_even_when_something_it_started_keeps_its_stderr() {
    // An app the engine starts can leave its group, as `setsid` does here,
    // and still hold the engine's stderr. Ending the run must not wait for
    // it.
    let said = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let listening = std::sync::Arc::clone(&said);
    let mut running = Running::new();
    running
        .start_heard(
            "engine",
            &sh("setsid sleep 30 & echo \"$!\" >&2; echo last >&2"),
            Box::new(move |line: &str| listening.lock().unwrap().push(line.to_string())),
        )
        .expect("it starts");
    while running.exited().is_none() {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let ending = std::time::Instant::now();
    drop(running);
    let took = ending.elapsed();

    let said = said.lock().unwrap().clone();
    let _ = std::process::Command::new("kill").arg(&said[0]).status();
    assert!(
        took < std::time::Duration::from_secs(10),
        "ending took {took:?}"
    );
    assert_eq!(said[1], "last");
}
