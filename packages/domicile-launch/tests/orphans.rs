//! Checks that no process outlives a desktop.
//!
//! Chromium forks GPU, zygote and other processes, and `Child::kill` reaches
//! only one. A surviving GPU process can keep DRM master and leave the console
//! unrecoverable. So each component runs in its own process group, which is
//! killed once the component has stopped.
//!
//! These tests are the only check: std has no getter for a `Command`'s process
//! group, so only a real grandchild can show it.

use std::path::Path;
use std::time::{Duration, Instant};

use domicile_launch::spawn::Spawn;
use domicile_launch::supervise::Running;

/// Whether the pid still exists. Signal 0 checks without delivering anything.
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// A shell that starts a long sleep, writes the sleeper's pid to `pidfile`,
/// then waits. The supervisor holds the shell, so only the group signal can
/// reach the sleeper.
fn parent_of_a_sleeper(pidfile: &Path) -> Spawn {
    Spawn {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            format!(
                "sleep 300 & printf '%s' \"$!\" > {} ; wait",
                pidfile.display()
            )
            .into(),
        ],
        env: Vec::new(),
    }
}

/// The pid the shell wrote, once it has written it.
fn sleeper(pidfile: &Path) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(pidfile) {
            if let Ok(pid) = text.trim().parse::<i32>() {
                if pid > 0 && alive(pid) {
                    return pid;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the test child never reported a grandchild; it did not start");
}

/// Polls until `pid` is gone. The kernel does not free a pid the instant it is
/// signaled, so a single check would be flaky.
fn gone_within(pid: i32, patience: Duration) -> bool {
    let deadline = Instant::now() + patience;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !alive(pid)
}

#[test]
fn a_grandchild_does_not_outlive_the_run() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let pidfile = dir.path().join("sleeper.pid");

    let mut running = Running::new();
    running
        .start("test component", &parent_of_a_sleeper(&pidfile))
        .expect("the test component starts");
    let grandchild = sleeper(&pidfile);

    drop(running);

    assert!(
        gone_within(grandchild, Duration::from_secs(10)),
        "pid {grandchild} is still running after the run ended: a component's \
         own children outlived it, which on a tty is a GPU process still \
         holding DRM master"
    );
}

#[test]
fn a_component_that_goes_quietly_is_not_waited_out() {
    // The `LAST_WORDS` grace period must only be spent on a component that
    // ignores SIGTERM. Otherwise every run, including Ctrl-C, ends three
    // seconds late.
    let dir = tempfile::tempdir().expect("a temp dir");
    let pidfile = dir.path().join("sleeper.pid");

    let mut running = Running::new();
    running
        .start("test component", &parent_of_a_sleeper(&pidfile))
        .expect("the test component starts");
    sleeper(&pidfile);

    let started = Instant::now();
    drop(running);
    let took = started.elapsed();

    assert!(
        took < Duration::from_secs(2),
        "tearing down a component that answers SIGTERM took {took:?}, so the \
         grace period is being spent rather than offered"
    );
}

/// A component that, on `SIGTERM`, takes `stopping` to stop, then writes to
/// `said` whether its child was still alive, as Chromium needs its GPU and
/// network processes until it has saved its profile. It touches `ready` once it
/// handles `SIGTERM`.
fn slow_to_stop(ready: &Path, said: &Path, stopping: &str) -> Spawn {
    Spawn {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            format!(
                "sleep 300 & child=$!; \
                 trap 'sleep {stopping}; \
                   if kill -0 $child; then echo alive; else echo dead; fi > {said}; \
                   exit 0' TERM; \
                 touch {ready}; wait",
                said = said.display(),
                ready = ready.display(),
            )
            .into(),
        ],
        env: Vec::new(),
    }
}

/// Waits for `path` to exist.
fn appears(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_component_keeps_its_children_until_it_has_stopped() {
    // A session end signaled the engine's whole group, so its GPU and network
    // processes died under it while it saved its profile.
    let dir = tempfile::tempdir().expect("a temp dir");
    let ready = dir.path().join("ready");
    let said = dir.path().join("said");

    let mut running = Running::new();
    running
        .start("test component", &slow_to_stop(&ready, &said, "0.3"))
        .expect("the test component starts");
    appears(&ready);

    drop(running);

    assert_eq!(
        std::fs::read_to_string(&said)
            .expect("the component said")
            .trim(),
        "alive",
        "the component's child was signaled before the component had stopped"
    );
}

#[test]
fn a_component_that_takes_its_time_to_stop_is_waited_for() {
    // Chromium waits up to 10 s for its profile and clean-exit writes. Killing
    // it after 3 s made every start count a crash.
    let dir = tempfile::tempdir().expect("a temp dir");
    let ready = dir.path().join("ready");
    let said = dir.path().join("said");

    let mut running = Running::new();
    running
        .start("test component", &slow_to_stop(&ready, &said, "4"))
        .expect("the test component starts");
    appears(&ready);

    drop(running);

    assert!(
        said.exists(),
        "the component was killed while it was still stopping"
    );
}
