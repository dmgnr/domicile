//! Parses the compositor's command line.
//!
//! Nothing comes from the environment or a default location. A program starts
//! the compositor, and a fallback would hide that program's bugs.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt as _;
use std::path::PathBuf;

use crate::handshake::Expected;

/// The compositor's parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Arguments {
    /// Where the host protocol is served. The shell picks it so it knows where
    /// to connect.
    pub chrome_socket: PathBuf,
    /// Where to publish the session once everything is bound.
    pub session: PathBuf,
    /// The compositor's config file. `None` uses the defaults.
    pub config: Option<PathBuf>,
    /// Socket for submitting client buffers to the forked engine instead of
    /// sending pixels to the chrome.
    ///
    /// When set, failing to load `libdomicile_engine.so` is a startup error,
    /// so the compositor never silently shows nothing. See
    /// `docs/architecture/ENGINE-FORK.md`.
    pub engine_socket: Option<PathBuf>,
    /// Whether a page will connect to [`chrome_socket`](Self::chrome_socket).
    ///
    /// Defaults to [`Expected::APage`] so [`crate::handshake`] can report a
    /// page that never connects. See [`Expected`] for the exceptions.
    pub expect_a_page: Expected,
    /// Whether to start each client in its own systemd scope. Only a desk that
    /// is the login session does; see `docs/RUNNING-A-DESKTOP.md`.
    pub scope_clients: bool,
    /// Whether the engine composites on the CPU, so windows go to it in
    /// shared memory. See [`crate::software_compositing`].
    pub software_compositing: bool,
    /// Whether emulated input (EIS) goes to the engine, which hands it to
    /// the shell's window, instead of the seat. A desk the engine drives
    /// does; see [`crate::spawn::the_engine_takes_input`].
    pub engine_takes_input: bool,
    /// Where PAM services are read from. `None` is the machine's
    /// `/etc/pam.d`; tests name a directory holding a service of their own.
    pub pam_confdir: Option<PathBuf>,
    /// Where the clients this desktop launched are kept, for the compositor
    /// that replaces this one after a crash. `None` keeps no record.
    pub launches: Option<PathBuf>,
    /// The data directory, first on the clients' `XDG_DATA_DIRS`, where the
    /// config's `electron.apps` get the desktop entries that run them on the
    /// engine. `None` writes none. See `domicile_host::electron_entries`.
    pub electron_entries: Option<PathBuf>,
}

/// A command line the compositor will not run.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArgumentError {
    #[error("{flag} is required")]
    Missing { flag: &'static str },

    #[error("{flag} needs a value after it")]
    NeedsValue { flag: String },

    #[error("{flag} was given an empty value")]
    EmptyValue { flag: String },

    #[error("{flag} was given more than once")]
    Repeated { flag: String },

    #[error("unknown argument {argument}")]
    Unknown { argument: String },

    #[error("{flag} takes yes or no, and was given {value}")]
    NotYesOrNo { flag: &'static str, value: String },
}

/// Parses a compositor command line.
pub fn arguments(args: impl IntoIterator<Item = OsString>) -> Result<Arguments, ArgumentError> {
    let mut chrome_socket = None;
    let mut session = None;
    let mut config = None;
    let mut engine_socket = None;
    let mut expect_a_page = None;
    let mut scope_clients = None;
    let mut software_compositing = None;
    let mut engine_takes_input = None;
    let mut pam_confdir = None;
    let mut launches = None;
    let mut electron_entries = None;

    let mut args = args.into_iter();
    let mut seen = Vec::new();
    while let Some(argument) = args.next() {
        let (flag, joined) = split(&argument);
        // A repeated flag is ambiguous, so reject it rather than silently
        // taking the last value.
        if seen.contains(&flag) {
            return Err(ArgumentError::Repeated { flag });
        }
        seen.push(flag.clone());
        // Every flag takes a value. Values stay `OsString` because not all are
        // paths; they are converted below.
        let slot = match flag.as_str() {
            CHROME_SOCKET => &mut chrome_socket,
            SESSION => &mut session,
            CONFIG => &mut config,
            ENGINE_SOCKET => &mut engine_socket,
            EXPECT_A_PAGE => &mut expect_a_page,
            SCOPE_CLIENTS => &mut scope_clients,
            SOFTWARE_COMPOSITING => &mut software_compositing,
            ENGINE_TAKES_INPUT => &mut engine_takes_input,
            PAM_CONFDIR => &mut pam_confdir,
            LAUNCHES => &mut launches,
            ELECTRON_ENTRIES => &mut electron_entries,
            _ => return Err(ArgumentError::Unknown { argument: flag }),
        };
        let value = match joined {
            Some(value) => value,
            None => args
                .next()
                .ok_or(ArgumentError::NeedsValue { flag: flag.clone() })?,
        };
        if value.is_empty() {
            return Err(ArgumentError::EmptyValue { flag });
        }
        *slot = Some(value);
    }

    Ok(Arguments {
        chrome_socket: chrome_socket
            .map(PathBuf::from)
            .ok_or(ArgumentError::Missing {
                flag: CHROME_SOCKET,
            })?,
        session: session
            .map(PathBuf::from)
            .ok_or(ArgumentError::Missing { flag: SESSION })?,
        config: config.map(PathBuf::from),
        engine_socket: engine_socket.map(PathBuf::from),
        expect_a_page: match expect_a_page {
            Some(value) => expected(&value)?,
            None => Expected::APage,
        },
        scope_clients: match scope_clients {
            Some(value) => yes_or_no(SCOPE_CLIENTS, &value)?,
            None => false,
        },
        software_compositing: match software_compositing {
            Some(value) => yes_or_no(SOFTWARE_COMPOSITING, &value)?,
            None => false,
        },
        engine_takes_input: match engine_takes_input {
            Some(value) => yes_or_no(ENGINE_TAKES_INPUT, &value)?,
            None => false,
        },
        pam_confdir: pam_confdir.map(PathBuf::from),
        launches: launches.map(PathBuf::from),
        electron_entries: electron_entries.map(PathBuf::from),
    })
}

const CHROME_SOCKET: &str = "--chrome-socket";
const SESSION: &str = "--session";
const CONFIG: &str = "--config";
const ENGINE_SOCKET: &str = "--engine-socket";
const EXPECT_A_PAGE: &str = "--expect-a-page";
const SCOPE_CLIENTS: &str = "--scope-clients";
const SOFTWARE_COMPOSITING: &str = "--software-compositing";
const ENGINE_TAKES_INPUT: &str = "--engine-takes-input";
const PAM_CONFDIR: &str = "--pam-confdir";
const LAUNCHES: &str = "--launches";
const ELECTRON_ENTRIES: &str = "--electron-entries";

/// Parses the `yes` or `no` given to `--expect-a-page`.
///
/// Other values are rejected because this flag turns off a watchdog, and a
/// typo should not silently leave it on.
fn expected(value: &OsStr) -> Result<Expected, ArgumentError> {
    match yes_or_no(EXPECT_A_PAGE, value)? {
        true => Ok(Expected::APage),
        false => Ok(Expected::NoPage),
    }
}

/// Parses the `yes` or `no` given to `flag`.
fn yes_or_no(flag: &'static str, value: &OsStr) -> Result<bool, ArgumentError> {
    match value.as_bytes() {
        b"yes" => Ok(true),
        b"no" => Ok(false),
        _ => Err(ArgumentError::NotYesOrNo {
            flag,
            value: value.to_string_lossy().into_owned(),
        }),
    }
}

/// Splits an argument at its first `=`.
///
/// The flag is a lossy `String`: known flags are ASCII, and unknown ones only
/// go into error messages.
fn split(argument: &OsStr) -> (String, Option<OsString>) {
    let bytes = argument.as_bytes();
    match bytes.iter().position(|byte| *byte == b'=') {
        Some(at) => (
            String::from_utf8_lossy(&bytes[..at]).into_owned(),
            Some(OsStr::from_bytes(&bytes[at + 1..]).to_os_string()),
        ),
        None => (argument.to_string_lossy().into_owned(), None),
    }
}
