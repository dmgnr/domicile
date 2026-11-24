//! The desktop's `xdg-email`: `domicile open` on the `mailto:` link its
//! command line makes, so an email link opens where the desktop's do.
//!
//! `domicile_launch::spawn` puts this first on every app's `PATH`, and the
//! engine's. The logic is in `domicile_launch::email`.

use std::os::unix::process::CommandExt as _;
use std::process::{Command, ExitCode};

use domicile_launch::email::link_for;

fn main() -> ExitCode {
    let me = match std::env::current_exe() {
        Ok(me) => me,
        Err(why) => {
            eprintln!("xdg-email: cannot find myself: {why}");
            return ExitCode::FAILURE;
        }
    };
    let args: Result<Vec<String>, _> = std::env::args_os()
        .skip(1)
        .map(std::ffi::OsString::into_string)
        .collect();
    let args = match args {
        Ok(args) => args,
        Err(word) => {
            eprintln!("xdg-email: {} is not UTF-8", word.display());
            return ExitCode::FAILURE;
        }
    };
    let link = match link_for(&args) {
        Ok(link) => link,
        Err(why) => {
            eprintln!("xdg-email: {why}");
            return ExitCode::FAILURE;
        }
    };
    let domicile = me.with_file_name("domicile");
    let why = Command::new(&domicile).arg("open").arg(&link).exec();
    eprintln!("xdg-email: could not run {}: {why}", domicile.display());
    ExitCode::FAILURE
}
