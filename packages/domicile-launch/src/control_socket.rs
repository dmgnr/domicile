//! The control socket a running desktop serves, and the client for it.
//!
//! The path is `$XDG_RUNTIME_DIR/domicile-ipc.<pid>.sock`, exported to child
//! processes as [`VARIABLE`]. As with sway's `SWAYSOCK`, a per-instance name
//! lets several desktops run in one session.
//!
//! The protocol is in [`crate::control`]; this module handles the filesystem
//! and sockets.

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::fs::{FileTypeExt as _, PermissionsExt as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cli::MonitorMode;
use crate::control::{parse_response, to_line, Admission, Lent, Request, Response, Subscription};

/// How long either end waits for the other.
///
/// A silent client holds a thread of the desktop's until this elapses. Neither
/// side does real work, so a timeout means a stopped process.
pub const PATIENCE: Duration = Duration::from_secs(5);

/// The environment variable holding the control socket path, like
/// `SWAYSOCK`.
pub const VARIABLE: &str = "DOMICILE_SOCK";

/// The control socket path for the desktop supervised by `pid`.
///
/// Keyed on the pid because the socket is bound before the compositor exists,
/// so there is no Wayland display name yet. Without a runtime directory it
/// uses the temp directory, as the run directory does.
pub fn address(runtime_dir: Option<&str>, pid: u32) -> PathBuf {
    let base = runtime_dir.map_or_else(std::env::temp_dir, PathBuf::from);
    base.join(format!("domicile-ipc.{pid}.sock"))
}

/// [`VARIABLE`] is not set.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "{VARIABLE} is not set, so there is no desktop here to ask. A desktop \
     puts it in the environment of everything it starts — run this from a \
     terminal inside the desktop you mean, or set {VARIABLE} to its socket."
)]
pub struct NotInADesktop;

/// The control socket path from [`VARIABLE`].
///
/// There is no search fallback: a session can run several desktops, and
/// guessing could send a command to the wrong one. `swaymsg` requires
/// `SWAYSOCK` for the same reason.
pub fn advertised(said: Option<&str>) -> Result<PathBuf, NotInADesktop> {
    said.map(PathBuf::from).ok_or(NotInADesktop)
}

/// A bound control socket, unlinked on drop so it does not go stale.
#[derive(Debug)]
pub struct Control {
    path: PathBuf,
    listener: UnixListener,
}

impl Control {
    /// A cloned listener for the serving thread.
    ///
    /// The run keeps the [`Control`] so the socket is unlinked when the desktop
    /// ends.
    pub fn listener(&self) -> std::io::Result<UnixListener> {
        self.listener.try_clone()
    }
}

impl Drop for Control {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Why the control socket could not be bound.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TakeError {
    #[error(
        "something is already answering at {path}, and that name belongs to \
         this process. Nothing here will take a socket away from whatever is \
         serving on it; find out what that is."
    )]
    AlreadyRunning { path: String },

    #[error(
        "{path} is not a socket, and it is where a desktop's control socket \
         goes. Nothing here will delete it; move it out of the way."
    )]
    InTheWay { path: String },

    #[error("could not take the control socket at {path}: {kind:?}")]
    Failed {
        path: String,
        kind: std::io::ErrorKind,
    },
}

/// Binds the control socket at `path`. The desktop does not start without it.
///
/// A socket file can outlive its process, so this connects to test it:
/// - Something answers: fail.
/// - A socket that does not answer: stale, so replace it.
/// - Not a socket: fail without deleting it.
pub fn take(path: &Path) -> Result<Control, TakeError> {
    clear(path)?;
    let listener = UnixListener::bind(path).map_err(|why| failed(path, &why))?;
    // The temp-directory fallback in `address` is world-readable, so restrict
    // the socket itself. `bind` creates it under the umask, leaving a brief
    // window before this. Binding to a temp name and renaming (as
    // `session::publish` does) would close it, if the socket ever carries
    // anything sensitive.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|why| failed(path, &why))?;
    Ok(Control {
        listener,
        path: path.to_path_buf(),
    })
}

/// Reads one request from `stream` and writes the answer.
///
/// `answer` is [`crate::control::answer`] in a desktop; a closure in tests.
pub fn answer_one(
    stream: UnixStream,
    patience: Duration,
    answer: &dyn Fn(&str) -> String,
) -> std::io::Result<()> {
    serve(stream, patience, answer, None)
}

/// [`answer_one`], lending the connection of a [`Request::VirtualMonitor`],
/// a [`Request::Subscribe`] or a [`Request::Agent`] to `lenders`, which hold
/// it as long as the client keeps it open.
pub fn serve_one(
    stream: UnixStream,
    patience: Duration,
    answer: &dyn Fn(&str) -> String,
    lenders: Lenders,
) -> std::io::Result<()> {
    serve(stream, patience, answer, Some(lenders))
}

/// What [`serve_one`] lends held connections to. In a desktop, `monitor` is
/// [`crate::monitor_lending::lend`], `subscribe`
/// [`crate::subscription::follow`] and `agent`
/// [`crate::agent_lending::admit`].
#[derive(Clone, Copy)]
pub struct Lenders<'a> {
    pub monitor: &'a dyn Fn(Lent),
    pub subscribe: &'a dyn Fn(Subscription),
    pub agent: &'a dyn Fn(Admission),
}

/// [`serve_one`]; with no lenders, `answer` refuses a monitor, a
/// subscription and an agent.
fn serve(
    stream: UnixStream,
    patience: Duration,
    answer: &dyn Fn(&str) -> String,
    lenders: Option<Lenders>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(patience))?;
    stream.set_write_timeout(Some(patience))?;
    let mut asking = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    asking.read_line(&mut line)?;
    crate::launcher_log::debug(&format!("a command: {}", command_type(&line)));
    let Some(lenders) = lenders else {
        let mut answering = stream;
        return answering.write_all(answer(&line).as_bytes());
    };
    match serde_json::from_str(line.trim()) {
        Ok(Request::Subscribe { topics }) => {
            // The client listens for as long as it likes.
            stream.set_read_timeout(None)?;
            stream.set_write_timeout(None)?;
            (lenders.subscribe)(Subscription {
                topics,
                client: stream,
            });
            Ok(())
        }
        Ok(Request::VirtualMonitor {
            name,
            width,
            height,
            refresh_mhz,
            scale,
        }) => {
            // The client resizes it whenever it likes.
            stream.set_read_timeout(None)?;
            (lenders.monitor)(Lent {
                name,
                mode: MonitorMode {
                    size: (width, height),
                    refresh_mhz,
                    scale,
                },
                lines: asking,
                client: stream,
            });
            Ok(())
        }
        Ok(Request::Agent { agent }) => {
            // The client says what the agent did whenever it likes.
            stream.set_read_timeout(None)?;
            (lenders.agent)(Admission {
                agent,
                lines: asking,
                client: stream,
            });
            Ok(())
        }
        _ => {
            let mut answering = stream;
            answering.write_all(answer(&line).as_bytes())
        }
    }
}

/// The type of the request on `line`, without what it carries: an `exec`'s
/// command line or a file path stays out of the log.
fn command_type(line: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(line.trim()) {
        Ok(serde_json::Value::Object(request)) => match request.get("type") {
            Some(serde_json::Value::String(kind)) => kind.clone(),
            _ => "one with no type".to_string(),
        },
        _ => "one that is not JSON".to_string(),
    }
}

/// Why a request to a desktop failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AskError {
    #[error(
        "no desktop is running here — nothing is answering at {path}. A \
         desktop that was killed outright leaves its socket behind and leaves \
         {VARIABLE} pointing at it, so this is also what the terminals that \
         outlived one see."
    )]
    NoDesktop { path: String },

    #[error(
        "the desktop answering at {path} took the command and did not answer. \
         It is running and it is not serving its control socket."
    )]
    NoAnswer { path: String },

    #[error("the desktop at {path} answered something that is not a response: {said}")]
    Unreadable { path: String, said: String },

    #[error("could not reach the desktop at {path}: {kind:?}")]
    Failed {
        path: String,
        kind: std::io::ErrorKind,
    },
}

/// Sends one request to the desktop at `path` and reads its response.
///
/// With no `patience`, waits until the desktop answers or hangs up.
pub fn ask(
    path: &Path,
    request: &Request,
    patience: Option<Duration>,
) -> Result<Response, AskError> {
    exchanged(path, request, patience, true).map(|(response, _)| response)
}

/// [`ask`], keeping the connection open after the response, as a
/// [`Request::VirtualMonitor`] needs. Closing it ends what it holds.
pub fn hold(
    path: &Path,
    request: &Request,
    patience: Option<Duration>,
) -> Result<(Response, UnixStream), AskError> {
    exchanged(path, request, patience, false)
}

/// Sends `request`, as for a [`Request::Subscribe`], and hands `heard` each
/// response until it returns false or the desktop hangs up. Waits as long as
/// the desktop says nothing.
pub fn listen(
    path: &Path,
    request: &Request,
    mut heard: impl FnMut(Response) -> bool,
) -> Result<(), AskError> {
    let mut stream = connected(path)?;
    stream
        .write_all(to_line(request).as_bytes())
        .map_err(|why| unreachable_desktop(path, &why))?;
    for line in BufReader::new(&stream).lines() {
        let line = line.map_err(|why| unreachable_desktop(path, &why))?;
        let response = parse_response(line.trim()).map_err(|_| AskError::Unreadable {
            path: path.display().to_string(),
            said: line.clone(),
        })?;
        if !heard(response) {
            break;
        }
    }
    Ok(())
}

/// A connection to the desktop at `path`.
fn connected(path: &Path) -> Result<UnixStream, AskError> {
    UnixStream::connect(path).map_err(|why| match why.kind() {
        // A missing socket, or a stale one left by a dead desktop.
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
            AskError::NoDesktop {
                path: path.display().to_string(),
            }
        }
        kind => AskError::Failed {
            kind,
            path: path.display().to_string(),
        },
    })
}

/// Sends `request` and reads the response. `finished` half-closes the
/// connection after the request, so the desktop sees its end.
fn exchanged(
    path: &Path,
    request: &Request,
    patience: Option<Duration>,
    finished: bool,
) -> Result<(Response, UnixStream), AskError> {
    let mut stream = connected(path)?;
    stream
        .set_read_timeout(patience)
        .map_err(|why| unreachable_desktop(path, &why))?;
    stream
        .set_write_timeout(patience)
        .map_err(|why| unreachable_desktop(path, &why))?;
    stream
        .write_all(to_line(request).as_bytes())
        .map_err(|why| unreachable_desktop(path, &why))?;
    if finished {
        stream
            .shutdown(std::net::Shutdown::Write)
            .map_err(|why| unreachable_desktop(path, &why))?;
    }
    // Nothing follows the response but a hang-up, so the reader buffers
    // nothing the caller misses.
    let mut said = String::new();
    BufReader::new(&stream)
        .read_line(&mut said)
        .map_err(|why| unreachable_desktop(path, &why))?;
    match said.trim() {
        // The desktop closed without replying.
        "" => Err(AskError::NoAnswer {
            path: path.display().to_string(),
        }),
        line => parse_response(line)
            .map(|response| (response, stream))
            .map_err(|_| AskError::Unreadable {
                path: path.display().to_string(),
                said: line.to_string(),
            }),
    }
}

/// Clears `path` for binding, or says why it cannot be.
fn clear(path: &Path) -> Result<(), TakeError> {
    match UnixStream::connect(path) {
        Ok(_) => Err(TakeError::AlreadyRunning {
            path: path.display().to_string(),
        }),
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => Ok(()),
        // Either a stale socket or a regular file; only a socket is deleted.
        Err(_) => discard(path),
    }
}

/// Deletes a stale socket at `path`, and nothing else.
fn discard(path: &Path) -> Result<(), TakeError> {
    let kind = std::fs::symlink_metadata(path)
        .map_err(|why| failed(path, &why))?
        .file_type();
    if kind.is_socket() {
        std::fs::remove_file(path).map_err(|why| failed(path, &why))
    } else {
        Err(TakeError::InTheWay {
            path: path.display().to_string(),
        })
    }
}

fn failed(path: &Path, why: &std::io::Error) -> TakeError {
    TakeError::Failed {
        kind: why.kind(),
        path: path.display().to_string(),
    }
}

/// Classifies an I/O error talking to a connected desktop.
///
/// A desktop that accepted but does not answer is reported separately: its
/// serving thread has stopped. That shows up as `WouldBlock` or `TimedOut`
/// (by platform) or `ConnectionReset` or `BrokenPipe` (by timing). [`ask`]
/// handles an empty read.
fn unreachable_desktop(path: &Path, why: &std::io::Error) -> AskError {
    match why.kind() {
        std::io::ErrorKind::WouldBlock
        | std::io::ErrorKind::TimedOut
        | std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::ConnectionReset => AskError::NoAnswer {
            path: path.display().to_string(),
        },
        kind => AskError::Failed {
            kind,
            path: path.display().to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_logged_by_its_type_alone() {
        assert_eq!(
            command_type(r#"{"type":"exec","command":"rm -rf ~/secret"}"#),
            "exec"
        );
    }

    #[test]
    fn a_line_that_is_not_a_command_says_so() {
        assert_eq!(command_type("hello"), "one that is not JSON");
    }
}
