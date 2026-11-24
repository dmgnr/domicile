//! Restart policy for a desktop, engine or compositor that dies: backoff,
//! give-up and stop.
//!
//! A desktop is a closure that reports how it ended, so the policy runs without
//! processes. Only clearing leftovers touches the filesystem, in a temp
//! directory.

use std::cell::Cell;
use std::time::Duration;

use domicile_launch::restart::{
    clear_the_last_compositor, clear_the_last_engine, clear_the_last_one, keep_a_desktop_up,
    keep_the_parts_up, renderer_unavailable, restarts, Attempt, Ending, PartAttempt, Policy,
    Started, CLEANLY, NO_USABLE_GPU,
};
use domicile_launch::spawn::Runtime;
use domicile_launch::supervise::Exit;

#[test]
fn a_desktop_that_ends_cleanly_is_not_started_again() {
    let attempts = Cell::new(0);

    let ending = keep_a_desktop_up(
        &Policy::default(),
        &mut || {
            attempts.set(attempts.get() + 1);
            Attempt::Ended
        },
        &|| false,
        &mut |_| panic!("nothing failed, so nothing is waited for"),
        &mut |_| panic!("nothing failed, so there is nothing to say"),
    );

    assert_eq!(ending, Ending::Over);
    assert_eq!(attempts.get(), 1);
}

#[test]
fn a_desktop_that_dies_is_started_again_until_it_is_given_up_on() {
    let policy = Policy::default();
    let attempts = Cell::new(0);
    let mut waited: Vec<Duration> = Vec::new();
    let mut said: Vec<String> = Vec::new();

    let ending = keep_a_desktop_up(
        &policy,
        &mut || {
            attempts.set(attempts.get() + 1);
            Attempt::Failed {
                lived: Duration::from_millis(3),
            }
        },
        &|| false,
        &mut |wait| waited.push(wait),
        &mut |next| said.push(next.to_string()),
    );

    // Five failures in a row and four restarts: nothing follows the fifth.
    assert_eq!(attempts.get(), policy.give_up_after);
    assert_eq!(
        waited,
        vec![
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(8),
        ]
    );
    // Every failure is reported, including the last, so a run that gives up
    // says why.
    assert_eq!(said.len(), policy.give_up_after as usize);
    assert!(said[1].contains("2s"), "{}", said[1]);
    assert!(said[1].contains("failure 2 of 5"), "{}", said[1]);
    let last = said.last().expect("every failure was said");
    assert!(last.contains("5 desktops in a row"), "{last}");
    assert_eq!(
        ending,
        Ending::GaveUp {
            started: Started::Desktop,
            failures: policy.give_up_after,
        }
    );
}

#[test]
fn the_wait_stops_doubling_at_the_longest_one() {
    // Small numbers keep the cap easy to read. One more attempt than the
    // default leaves waits past the cap.
    let policy = Policy {
        first_wait: Duration::from_secs(1),
        longest_wait: Duration::from_secs(4),
        give_up_after: 6,
        long_enough: Duration::from_secs(60),
    };
    let mut waited: Vec<Duration> = Vec::new();

    keep_a_desktop_up(
        &policy,
        &mut || Attempt::Failed {
            lived: Duration::ZERO,
        },
        &|| false,
        &mut |wait| waited.push(wait),
        &mut |_| {},
    );

    assert_eq!(
        waited,
        vec![
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(4),
            Duration::from_secs(4),
        ]
    );
}

#[test]
fn a_desktop_that_lived_long_enough_starts_the_count_over() {
    // A desktop that ran long enough was in use, so its loss is an incident and
    // not a crash loop. The wait and the failure count reset.
    let policy = Policy::default();
    let attempts = Cell::new(0);
    let mut waited: Vec<Duration> = Vec::new();

    keep_a_desktop_up(
        &policy,
        &mut || {
            attempts.set(attempts.get() + 1);
            Attempt::Failed {
                lived: match attempts.get() {
                    3 => policy.long_enough,
                    _ => Duration::ZERO,
                },
            }
        },
        &|| false,
        &mut |wait| waited.push(wait),
        &mut |_| {},
    );

    assert_eq!(
        waited,
        vec![
            Duration::from_secs(1),
            Duration::from_secs(2),
            // The third desktop lived long enough, so the count starts over.
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(8),
        ]
    );
    assert_eq!(attempts.get(), 7);
}

#[test]
fn a_desktop_that_was_stopped_is_not_started_again() {
    let attempts = Cell::new(0);

    let ending = keep_a_desktop_up(
        &Policy::default(),
        &mut || {
            attempts.set(attempts.get() + 1);
            Attempt::Failed {
                lived: Duration::from_millis(3),
            }
        },
        &|| true,
        &mut |_| panic!("a stop was asked for, so nothing is waited for"),
        &mut |_| panic!("a stop was asked for, so there is nothing to say"),
    );

    assert_eq!(ending, Ending::Stopped);
    assert_eq!(attempts.get(), 1);
}

#[test]
fn a_stop_asked_for_while_the_next_one_is_waited_for_is_not_started_again() {
    // Ctrl-C between two desktops. No component is running then, so only the
    // wait can notice it.
    let attempts = Cell::new(0);
    let stopped = Cell::new(false);

    let ending = keep_a_desktop_up(
        &Policy::default(),
        &mut || {
            attempts.set(attempts.get() + 1);
            Attempt::Failed {
                lived: Duration::ZERO,
            }
        },
        &|| stopped.get(),
        &mut |_| stopped.set(true),
        &mut |_| {},
    );

    assert_eq!(ending, Ending::Stopped);
    assert_eq!(attempts.get(), 1);
}

#[test]
fn nothing_the_last_desktop_bound_or_published_outlives_it() {
    let directory = tempfile::tempdir().expect("a temp directory");
    let runtime = runtime(directory.path());
    for path in [
        &runtime.broker,
        &runtime.chrome_socket,
        &runtime.command,
        &runtime.session,
        &runtime.launches,
    ] {
        std::fs::write(path, "the last desktop's").expect("it is written");
    }
    std::fs::create_dir(&runtime.profile).expect("it is created");
    std::fs::write(runtime.profile.join("Cookies"), "a sign-in").expect("it is written");
    std::fs::write(&runtime.control, "this process's own").expect("it is written");

    clear_the_last_one(&runtime).expect("it clears");

    // A new desktop launches none of the last one's clients again.
    assert!(
        !runtime.launches.exists(),
        "the last desktop's launched clients are still there"
    );

    assert!(!runtime.broker.exists(), "the broker socket is still there");
    assert!(
        !runtime.chrome_socket.exists(),
        "the chrome socket is still there"
    );
    // If this path exists, the engine fails a `CHECK` in the browser process
    // instead of starting without a command socket.
    assert!(
        !runtime.command.exists(),
        "the engine's command socket is still there"
    );
    // Most important: the launcher waits for this file to appear, so a stale
    // one reports a desktop up before its compositor has bound anything.
    assert!(
        !runtime.session.exists(),
        "the session document is still there"
    );
    // The profile is the person's and kept between desktops. A failed desktop
    // must not sign them out.
    assert!(
        runtime.profile.join("Cookies").exists(),
        "the engine's profile was cleared"
    );
    // Not the control socket: this process still binds it, and `DOMICILE_SOCK`
    // names it.
    assert!(runtime.control.exists(), "the control socket was cleared");
}

#[test]
fn a_desktop_that_left_nothing_behind_is_nothing_to_clear() {
    let directory = tempfile::tempdir().expect("a temp directory");

    clear_the_last_one(&runtime(directory.path())).expect("there was nothing to clear");
}

#[test]
fn what_cannot_be_cleared_is_said_rather_than_started_over() {
    let directory = tempfile::tempdir().expect("a temp directory");
    let runtime = runtime(directory.path());
    // A directory where the session document goes. `remove_file` refuses it,
    // like any leftover this process cannot remove.
    std::fs::create_dir(&runtime.session).expect("it is created");

    let leftover = clear_the_last_one(&runtime).expect_err("it cannot be cleared");

    let said = leftover.to_string();
    assert!(said.contains("session.json"), "{said}");
}

#[test]
fn an_engine_that_dies_is_started_again_under_the_compositor_that_did_not() {
    // Same policy, counted separately, with messages that name the engine. Only
    // the engine restarts; the desktop and its windows survive.
    let policy = Policy::default();
    let attempts = Cell::new(0);
    let mut waited: Vec<Duration> = Vec::new();
    let mut said: Vec<String> = Vec::new();

    let ending = keep_the_parts_up(
        &policy,
        &mut || {
            attempts.set(attempts.get() + 1);
            PartAttempt::Failed {
                part: Started::Engine,
                lived: Duration::from_millis(3),
            }
        },
        &|| false,
        &mut |wait| waited.push(wait),
        &mut |next| said.push(next.to_string()),
    );

    assert_eq!(attempts.get(), policy.give_up_after);
    assert_eq!(
        waited,
        vec![
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4),
            Duration::from_secs(8),
        ]
    );
    assert!(
        said[0].contains("starting the engine again in 1s"),
        "{}",
        said[0]
    );
    let last = said.last().expect("every failure was said");
    assert!(last.contains("5 engines in a row have failed"), "{last}");
    assert_eq!(
        ending,
        Ending::GaveUp {
            started: Started::Engine,
            failures: policy.give_up_after,
        }
    );
}

#[test]
fn a_compositor_that_dies_is_started_again_under_the_engine_that_did_not() {
    // The engine keeps every browser window, and the shell reloads to meet the
    // next compositor.
    let mut said: Vec<String> = Vec::new();

    keep_the_parts_up(
        &Policy::default(),
        &mut || PartAttempt::Failed {
            part: Started::Compositor,
            lived: Duration::ZERO,
        },
        &|| false,
        &mut |_| {},
        &mut |next| said.push(next.to_string()),
    );

    assert!(
        said[0].contains("starting the compositor again in 1s"),
        "{}",
        said[0]
    );
}

#[test]
fn the_engine_and_the_compositor_count_their_failures_apart() {
    // A compositor that fails between two engine failures does not move the
    // engine's count, so its wait does not double.
    let parts = [Started::Engine, Started::Compositor, Started::Engine];
    let attempts = Cell::new(0);
    let mut waited: Vec<Duration> = Vec::new();

    keep_the_parts_up(
        &Policy::default(),
        &mut || {
            let attempt = attempts.get();
            attempts.set(attempt + 1);
            match parts.get(attempt) {
                Some(part) => PartAttempt::Failed {
                    part: *part,
                    lived: Duration::ZERO,
                },
                None => PartAttempt::Ended,
            }
        },
        &|| false,
        &mut |wait| waited.push(wait),
        &mut |_| {},
    );

    assert_eq!(
        waited,
        vec![
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_secs(2),
        ]
    );
}

#[test]
fn a_desktop_whose_part_ends_cleanly_is_over() {
    // `PartAttempt::Ended` means a part exited cleanly, so the desktop is over.
    let attempts = Cell::new(0);

    let ending = keep_the_parts_up(
        &Policy::default(),
        &mut || {
            attempts.set(attempts.get() + 1);
            PartAttempt::Ended
        },
        &|| false,
        &mut |_| panic!("nothing failed, so nothing is waited for"),
        &mut |_| panic!("nothing failed, so there is nothing to say"),
    );

    assert_eq!(ending, Ending::Over);
    assert_eq!(attempts.get(), 1);
}

#[test]
fn an_engine_on_a_tty_that_exits_0_is_started_again() {
    // Chromium exits 0 on `SIGTERM`, and a TTY engine has no window to close.
    let exit = exited("engine", CLEANLY);

    assert_eq!(restarts(&exit, "drm"), Some(Started::Engine));
}

#[test]
fn a_nested_engine_that_exits_0_ends_the_run() {
    // Closing the window exits 0, and that is how a nested desktop is closed.
    let exit = exited("engine", CLEANLY);

    assert_eq!(restarts(&exit, "wayland"), None);
    assert_eq!(restarts(&exit, "headless"), None);
}

#[test]
fn an_engine_that_fails_is_started_again_on_any_platform() {
    let exit = exited("engine", "exit status: 3");

    assert_eq!(restarts(&exit, "drm"), Some(Started::Engine));
    assert_eq!(restarts(&exit, "wayland"), Some(Started::Engine));
}

#[test]
fn a_compositor_that_fails_is_started_again_alone() {
    assert_eq!(
        restarts(&exited("compositor", "signal: 11 (SIGSEGV)"), "drm"),
        Some(Started::Compositor)
    );
    assert_eq!(
        restarts(&exited("compositor", "exit status: 4"), "wayland"),
        Some(Started::Compositor)
    );
}

#[test]
fn an_engine_with_no_usable_gpu_is_a_renderer_unavailable() {
    // Patch 0178: the engine exits 69 once every GPU mode has failed.
    let policy = Policy::default();
    let soon = Duration::from_secs(2);
    assert!(renderer_unavailable(
        &exited("engine", NO_USABLE_GPU),
        soon,
        &policy
    ));
    assert!(!renderer_unavailable(
        &exited("engine", "exit status: 3"),
        soon,
        &policy
    ));
    assert!(!renderer_unavailable(
        &exited("compositor", NO_USABLE_GPU),
        soon,
        &policy
    ));
}

#[test]
fn an_engine_that_drew_for_a_while_before_losing_its_gpu_is_started_again() {
    // A cluster of GPU crashes late in a session uses up Chromium's fallbacks,
    // but a new engine starts on the GPU again.
    let policy = Policy::default();
    assert!(!renderer_unavailable(
        &exited("engine", NO_USABLE_GPU),
        policy.long_enough,
        &policy
    ));
}

#[test]
fn a_renderer_unavailable_ends_the_run_without_a_restart() {
    // No restart brings a GPU back, so the desktop is not started again.
    let attempts = Cell::new(0);

    let ending = keep_the_parts_up(
        &Policy::default(),
        &mut || {
            attempts.set(attempts.get() + 1);
            PartAttempt::RendererUnavailable
        },
        &|| false,
        &mut |_| panic!("nothing is started again, so nothing is waited for"),
        &mut |_| panic!("nothing is started again"),
    );
    assert_eq!(ending, Ending::RendererUnavailable);
    assert_eq!(attempts.get(), 1);

    let ending = keep_a_desktop_up(
        &Policy::default(),
        &mut || {
            attempts.set(attempts.get() + 1);
            Attempt::RendererUnavailable
        },
        &|| false,
        &mut |_| panic!("nothing is started again, so nothing is waited for"),
        &mut |_| panic!("nothing is started again"),
    );
    assert_eq!(ending, Ending::RendererUnavailable);
    assert_eq!(attempts.get(), 2);
}

#[test]
fn a_compositor_that_exits_0_ends_the_run() {
    assert_eq!(restarts(&exited("compositor", CLEANLY), "drm"), None);
}

#[test]
fn what_the_last_engine_left_goes_and_what_the_compositor_bound_stays() {
    // The engine restarts under a compositor that is still serving. The
    // engine's paths go so the next engine can bind them. The compositor's
    // socket and session document are still live and stay.
    let directory = tempfile::tempdir().expect("a temp directory");
    let runtime = runtime(directory.path());
    for path in [
        &runtime.broker,
        &runtime.chrome_socket,
        &runtime.command,
        &runtime.session,
        &runtime.launches,
    ] {
        std::fs::write(path, "the desktop's").expect("it is written");
    }
    std::fs::create_dir(&runtime.profile).expect("it is created");
    std::fs::write(runtime.profile.join("Cookies"), "a sign-in").expect("it is written");

    clear_the_last_engine(&runtime).expect("it clears");

    assert!(!runtime.broker.exists(), "the broker socket is still there");
    assert!(
        !runtime.command.exists(),
        "the engine's command socket is still there"
    );
    assert!(
        runtime.profile.join("Cookies").exists(),
        "the engine's profile was cleared"
    );
    assert!(
        runtime.chrome_socket.exists(),
        "the compositor is still listening on the chrome socket and this took it away"
    );
    assert!(
        runtime.session.exists(),
        "the compositor is still serving and this took away the document that says so"
    );
}

#[test]
fn what_the_last_compositor_left_goes_and_what_the_engine_bound_stays() {
    // The compositor restarts under an engine that is still serving. Its
    // socket and session document go, so the next compositor binds the socket
    // and the launcher waits for its own document. The engine's stay live.
    let directory = tempfile::tempdir().expect("a temp directory");
    let runtime = runtime(directory.path());
    for path in [
        &runtime.broker,
        &runtime.chrome_socket,
        &runtime.command,
        &runtime.session,
        &runtime.launches,
    ] {
        std::fs::write(path, "the desktop's").expect("it is written");
    }

    clear_the_last_compositor(&runtime).expect("it clears");

    // The next compositor launches again the clients the crash took.
    assert!(
        runtime.launches.exists(),
        "the next compositor needs the clients this one launched"
    );

    assert!(
        !runtime.chrome_socket.exists(),
        "the chrome socket is still there"
    );
    assert!(
        !runtime.session.exists(),
        "the session document is still there"
    );
    assert!(
        runtime.broker.exists(),
        "the engine is still brokering frame sinks and this took its socket away"
    );
    assert!(
        runtime.command.exists(),
        "the engine is still taking commands and this took its socket away"
    );
}

fn runtime(directory: &std::path::Path) -> Runtime {
    Runtime {
        broker: directory.join("broker"),
        chrome_socket: directory.join("chrome.sock"),
        command: directory.join("command.sock"),
        electron: directory.join("electron.sock"),
        control: directory.join("domicile-ipc.1.sock"),
        profile: directory.join("profile"),
        shims: directory.join("bin"),
        session: directory.join("session.json"),
        electron_entries: directory.join("share"),
        launches: directory.join("launches.json"),
    }
}

fn exited(what: &'static str, how: &str) -> Exit {
    Exit {
        what,
        how: how.to_string(),
    }
}
