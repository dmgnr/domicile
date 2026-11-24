//! Tests for `domicile inhibit-idle`'s naming and exit codes. The hold itself
//! needs a session bus.

use std::os::unix::process::ExitStatusExt as _;
use std::process::ExitStatus;

use domicile_launch::idle_inhibit::{exit_code, holder};

#[test]
fn a_hold_is_named_by_its_programs_file_name() {
    assert_eq!(
        holder(&["/usr/bin/mpv".to_string(), "film.mkv".to_string()]),
        "mpv"
    );
    assert_eq!(holder(&["make".to_string()]), "make");
}

#[test]
fn the_command_exits_as_a_shell_would_say() {
    assert_eq!(exit_code(ExitStatus::from_raw(3 << 8)), 3);
    // Killed by SIGTERM.
    assert_eq!(exit_code(ExitStatus::from_raw(15)), 128 + 15);
}
