//! `SIGHUP` ends the wait for an exit, as a stop request does, and points
//! stdout and stderr at `/dev/null`: a logout sends it to every process in the
//! login session.
//!
//! Its own test binary, since the interrupt is process-wide and would end
//! every other test's wait too.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use domicile_launch::spawn::Spawn;
use domicile_launch::supervise::{catch_interrupts, Running};

#[test]
fn a_hangup_ends_the_wait_and_drops_the_terminal() {
    catch_interrupts();
    let mut running = Running::new();
    running
        .start(
            "engine",
            &Spawn {
                program: PathBuf::from("/bin/sh"),
                args: vec![OsString::from("-c"), OsString::from("sleep 30")],
                env: Vec::new(),
            },
        )
        .expect("it starts");
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(200));
        // SAFETY: signals this process, whose handler only notes it.
        unsafe { libc::kill(libc::getpid(), libc::SIGHUP) };
    });
    let asked = Instant::now();

    let exit = running.until_one_exits();

    assert_eq!((exit.what, exit.how.as_str()), ("desktop", "interrupted"));
    assert!(asked.elapsed() < Duration::from_secs(10));
    for fd in [1, 2] {
        assert_eq!(
            std::fs::read_link(format!("/proc/self/fd/{fd}")).expect("the fd is open"),
            PathBuf::from("/dev/null"),
            "fd {fd} still writes to the terminal"
        );
    }
}
