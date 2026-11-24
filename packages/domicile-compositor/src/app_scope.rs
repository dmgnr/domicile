//! The command that runs a client in its own systemd scope, as GNOME and KDE do.
//!
//! Only a desk that is the login session does this (`--scope-clients yes`).
//! Why: `docs/RUNNING-A-DESKTOP.md#each-app-gets-its-own-scope`.

use std::ffi::OsStr;
use std::path::Path;

/// The most bytes of a program's name a unit name keeps.
///
/// Escaping writes a byte as up to 4 characters, and the rest of the name is
/// 36, so this stays under systemd's limit of 255.
const NAME_BYTES: usize = 48;

/// `program` and `args` run by `systemd-run` in a new scope named by
/// [`unit`].
///
/// `random` keeps the name unique, as the convention's last part.
pub fn scoped(program: &str, args: &[String], random: u64) -> Vec<String> {
    [
        "systemd-run",
        "--user",
        "--scope",
        "--slice=app.slice",
        "--collect",
        "--quiet",
        "--property=PartOf=graphical-session.target",
    ]
    .into_iter()
    .map(str::to_string)
    .chain([
        format!("--unit={}", unit(program, random)),
        "--".to_string(),
        program.to_string(),
    ])
    .chain(args.iter().cloned())
    .collect()
}

/// A random suffix for [`scoped`], from the kernel's generator.
pub fn random() -> u64 {
    let mut bytes = [0u8; 8];
    // SAFETY: `bytes` is valid for writes of its length.
    let read = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
    assert_eq!(
        read,
        8,
        "getrandom fills 8 bytes: {}",
        std::io::Error::last_os_error()
    );
    u64::from_ne_bytes(bytes)
}

/// `app-domicile-<program>-<random>.scope`, the XDG convention for an
/// application's scope.
fn unit(program: &str, random: u64) -> String {
    let name = Path::new(program)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(program)
        .as_bytes();
    let kept = &name[..name.len().min(NAME_BYTES)];
    format!("app-domicile-{}-{random:016x}.scope", escaped(kept))
}

/// `name` with every byte but ASCII letters, digits, `:`, `_` and `.` written
/// as `\xNN`, as `systemd-escape` writes it.
fn escaped(name: &[u8]) -> String {
    name.iter()
        .map(|&byte| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b':' | b'_' | b'.' => {
                char::from(byte).to_string()
            }
            _ => format!("\\x{byte:02x}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(command: &[&str]) -> Vec<String> {
        command.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn a_client_runs_under_systemd_run_in_its_own_scope_in_the_app_slice() {
        // `--scope` makes systemd-run exec the client itself once the scope
        // exists, so the pid the compositor logs is the client's and nothing
        // the client starts escapes the scope. `PartOf=` stops it when the
        // desk's session ends, daemons it left behind included.
        assert_eq!(
            scoped("kitty", &words(&["--single-instance"]), 0xabc),
            words(&[
                "systemd-run",
                "--user",
                "--scope",
                "--slice=app.slice",
                "--collect",
                "--quiet",
                "--property=PartOf=graphical-session.target",
                "--unit=app-domicile-kitty-0000000000000abc.scope",
                "--",
                "kitty",
                "--single-instance",
            ])
        );
    }

    #[test]
    fn a_scope_is_named_after_the_program_not_its_path() {
        assert_eq!(
            unit("/run/current-system/sw/bin/foot", 1),
            "app-domicile-foot-0000000000000001.scope"
        );
    }

    #[test]
    fn a_program_name_is_escaped_as_systemd_escape_does() {
        // A dash separates the parts of the name, so the program's own are
        // escaped, as the XDG application scope convention asks.
        assert_eq!(
            unit("gnome-text editor", 1),
            r"app-domicile-gnome\x2dtext\x20editor-0000000000000001.scope"
        );
    }

    #[test]
    fn a_long_program_name_still_makes_a_unit_systemd_accepts() {
        // systemd refuses a unit name over 255 characters, and the client would
        // not start.
        let name = unit(&"-".repeat(300), 1);
        assert!(name.len() <= 255, "{} characters", name.len());
        assert!(name.ends_with("-0000000000000001.scope"), "{name}");
    }
}
