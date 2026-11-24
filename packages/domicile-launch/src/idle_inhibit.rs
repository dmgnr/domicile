//! `domicile inhibit-idle -- <command>`: run a command and keep the screens
//! on until it exits, like `systemd-inhibit --what=idle`.
//!
//! The hold is an `org.freedesktop.ScreenSaver` `Inhibit`, which the
//! compositor serves for browsers and video players. It names the command, so
//! a shell's list of what holds the desktop awake shows it, and it ends when
//! this process leaves the bus, however it ends.

use std::process::{Command, ExitStatus};

use crate::notification::session_bus;

const SCREEN_SAVER: &str = "org.freedesktop.ScreenSaver";
const PATH: &str = "/org/freedesktop/ScreenSaver";

/// What a hold for `command` is called: its program's file name, as a shell
/// lists it among what holds the desktop awake.
pub fn holder(command: &[String]) -> String {
    command
        .first()
        .map(|program| {
            std::path::Path::new(program).file_name().map_or_else(
                || program.clone(),
                |name| name.to_string_lossy().into_owned(),
            )
        })
        .unwrap_or_default()
}

/// The exit code a shell gives a command that ended with `status`: its own
/// code, or 128 plus the signal that killed it.
pub fn exit_code(status: ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt as _;
    match (status.code(), status.signal()) {
        (Some(code), _) => code as u8,
        (None, Some(signal)) => (128 + signal) as u8,
        (None, None) => 1,
    }
}

/// Holds the desktop awake, runs `command` until it exits, and returns how
/// it ended. Errs, before running anything, when no desktop holds the
/// screen saver's name on the session bus.
pub fn inhibit_idle(command: &[String]) -> Result<ExitStatus, String> {
    let (program, arguments) = command
        .split_first()
        .ok_or_else(|| "there is no command to run".to_string())?;
    let bus = session_bus().map_err(|why| format!("could not reach the session bus: {why}"))?;
    let holder = holder(command);
    let reason = format!("domicile inhibit-idle is running {holder}");
    let reply = bus
        .call_method(
            Some(SCREEN_SAVER),
            PATH,
            Some(SCREEN_SAVER),
            "Inhibit",
            &(holder.as_str(), reason.as_str()),
        )
        .map_err(|why| {
            format!("the desktop did not hold the screens on, so {holder} was not run: {why}")
        })?;
    let cookie: u32 = reply
        .body()
        .deserialize()
        .map_err(|why| format!("the desktop's hold made no sense: {why}"))?;
    let ran = Command::new(program)
        .args(arguments)
        .status()
        .map_err(|why| format!("could not run {program}: {why}"));
    // Leaving the bus ends the hold anyway; this says so at once.
    let _ = bus.call_method(
        Some(SCREEN_SAVER),
        PATH,
        Some(SCREEN_SAVER),
        "UnInhibit",
        &(cookie,),
    );
    ran
}
