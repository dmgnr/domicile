//! Asks the compositor for a screenshot, to start an app, to send the shell a
//! command, for its theme, to turn the monitors off or on, for a virtual
//! monitor, or to change its log levels, over its chrome socket.
//!
//! Each request is the message a page sends for it (`SystemRequest::Screenshot`,
//! `SystemRequest::SendShell`, `ChromeMessage::SetTheme`), so the compositor
//! has one path for each. The connection never says `hello`, so it is not a
//! chrome: it hears only the reply.

use std::io::{BufRead, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use domicile_host::system::DisplayPower;
use domicile_protocol::{
    AgentReach, ChromeMessage, DeskRect, DeskShot, DesktopStatus, DisplayChange, EmulatedInput,
    HostMessage, KnownAgents, ListedDisplay, ListedInput, ListedWindow, LogLevels, MonitorInfo,
    ShellBinding, ShellCommandHelp, SystemError, SystemErrorKind, SystemEvent, SystemReply,
    SystemRequest, Theme, WatchTopic, WindowAct,
};

use crate::cli::MonitorMode;
use crate::control::Shot;

/// The id the one call goes under.
const CALL: u32 = 1;

/// Why the compositor did not do what it was asked.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CompositorError {
    #[error(
        "the compositor of this desktop is not answering at {path}. Either it \
         has died and the supervisor is about to replace it, or it has not \
         finished starting."
    )]
    NoCompositor { path: String },

    #[error(
        "the compositor took the request and did not answer at {path}, so \
         whether it carried it out is not something this can say."
    )]
    NoAnswer { path: String },

    #[error("the compositor at {path} answered something that is not a reply: {said}.")]
    Unreadable { path: String, said: String },

    #[error("the compositor did not do it: {why}")]
    Refused { why: String },

    #[error("could not reach the compositor at {path}: {kind:?}")]
    Failed {
        path: String,
        kind: std::io::ErrorKind,
    },
}

/// Tells the compositor at `socket` to write a PNG of the whole desk to the
/// absolute path `file`, or, with no `file`, to take the shell's interactive
/// screenshot.
///
/// With no `patience`, waits until the compositor answers or hangs up, as the
/// interactive one needs while the user picks.
pub fn screenshot(
    socket: &Path,
    file: Option<&Path>,
    patience: Option<Duration>,
) -> Result<Shot, CompositorError> {
    let request = SystemRequest::Screenshot {
        file: file.map(|file| file.display().to_string()),
    };
    let answer = called(socket, request, patience)?;
    match answer.reply {
        SystemReply::Saved { path } => Ok(Shot::Saved(PathBuf::from(path))),
        SystemReply::Copied => Ok(Shot::Copied),
        SystemReply::Failed {
            error:
                SystemError {
                    kind: SystemErrorKind::Canceled,
                    ..
                },
        } => Ok(Shot::Canceled),
        reply => Err(not_done(socket, reply, answer.said)),
    }
}

/// Tells the compositor at `socket` to record the screen, and waits until the
/// user stops the recording, however long that takes. `None` when the user
/// dismissed the picker or discarded the recording.
pub fn screen_record(socket: &Path) -> Result<Option<PathBuf>, CompositorError> {
    let answer = called(socket, SystemRequest::ScreenRecord, None)?;
    match answer.reply {
        SystemReply::Saved { path } => Ok(Some(PathBuf::from(path))),
        SystemReply::Failed {
            error:
                SystemError {
                    kind: SystemErrorKind::Canceled,
                    ..
                },
        } => Ok(None),
        reply => Err(not_done(socket, reply, answer.said)),
    }
}

/// Tells the compositor at `socket` to send `command` to every page listening
/// for shell commands. Returns what the page that ran it printed, if anything.
pub fn send_shell(
    socket: &Path,
    command: &[String],
    patience: Option<Duration>,
) -> Result<Option<String>, CompositorError> {
    let request = SystemRequest::SendShell {
        command: command.to_vec(),
    };
    let answer = called(socket, request, patience)?;
    match answer.reply {
        SystemReply::Sent { output } => Ok(output),
        reply => Err(not_done(socket, reply, answer.said)),
    }
}

/// Hands `url` to the shell page at `socket` that claims its scheme. Returns
/// false when no page claims it.
pub fn open_link(
    socket: &Path,
    url: &str,
    patience: Option<Duration>,
) -> Result<bool, CompositorError> {
    let request = SystemRequest::OpenLink {
        url: url.to_string(),
        app_id: None,
    };
    let answer = called(socket, request, patience)?;
    match answer.reply {
        SystemReply::Sent { .. } => Ok(true),
        SystemReply::Failed {
            error:
                SystemError {
                    kind: SystemErrorKind::NotFound,
                    ..
                },
        } => Ok(false),
        reply => Err(not_done(socket, reply, answer.said)),
    }
}

/// Tells the compositor at `socket` to start `command` as an app, as the
/// launcher does, and waits to hear it started or why not.
pub fn launch(
    socket: &Path,
    command: &[String],
    patience: Option<Duration>,
) -> Result<(), CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::Exec {
            command: command.to_vec(),
        }],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::Executed { refused: None }) => Ok(()),
        Ok(HostMessage::Executed { refused: Some(why) }) => Err(CompositorError::Refused { why }),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Tells the compositor at `socket` to turn the monitor named `display`, or
/// every monitor, `power`.
pub fn power_displays(
    socket: &Path,
    power: DisplayPower,
    display: Option<&str>,
    patience: Option<Duration>,
) -> Result<(), CompositorError> {
    let display = display.map(str::to_owned);
    let request = match power {
        DisplayPower::Asleep => SystemRequest::SleepDisplays { display },
        DisplayPower::Awake => SystemRequest::WakeDisplays { display },
    };
    let answer = called(socket, request, patience)?;
    match answer.reply {
        SystemReply::Set => Ok(()),
        reply => Err(not_done(socket, reply, answer.said)),
    }
}

/// Tells the compositor at `socket` to lock the desktop.
///
/// The lock has no answer of its own, so a `which_status` follows it: the
/// compositor answers a connection's messages in order, so its answer means
/// the lock was taken.
pub fn lock(socket: &Path, patience: Option<Duration>) -> Result<(), CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::Lock, ChromeMessage::WhichStatus],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::Status(_)) => Ok(()),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Tells the compositor at `socket` to do `act` to the native window `id`.
/// The outer error is the compositor's; the inner, why it refused.
pub fn act_on_window(
    socket: &Path,
    id: &str,
    act: WindowAct,
    patience: Option<Duration>,
) -> Result<Result<(), String>, CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::ActOnWindow {
            id: id.to_owned(),
            act,
        }],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::WindowActed { refused }) => Ok(refused.map_or(Ok(()), Err)),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Tells the compositor at `socket` to write a PNG of the desk to the
/// absolute path `file`, its longer side at most `fit` pixels. The outer error
/// is the compositor's; the inner, why it refused.
pub fn shoot_desk(
    socket: &Path,
    file: &Path,
    fit: u32,
    area: Option<DeskRect>,
    patience: Option<Duration>,
) -> Result<Result<DeskShot, String>, CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::ShootDesk {
            file: file.display().to_string(),
            fit,
            area,
        }],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::DeskShot {
            shot: Some(shot),
            refused: None,
        }) => Ok(Ok(shot)),
        Ok(HostMessage::DeskShot {
            shot: None,
            refused: Some(why),
        }) => Ok(Err(why)),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Tells the compositor at `socket` to send `input` to the desk. The outer
/// error is the compositor's; the inner, why it refused.
pub fn emulate(
    socket: &Path,
    input: &[EmulatedInput],
    patience: Option<Duration>,
) -> Result<Result<(), String>, CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::Emulate {
            input: input.to_vec(),
        }],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::Emulated { refused }) => Ok(refused.map_or(Ok(()), Err)),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Tells the compositor at `socket` to make `change` to the monitor
/// `display`. The outer error is the compositor's; the inner, why it refused.
pub fn configure_display(
    socket: &Path,
    display: &str,
    change: &DisplayChange,
    patience: Option<Duration>,
) -> Result<Result<(), String>, CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::ConfigureDisplay {
            display: display.to_owned(),
            change: change.clone(),
        }],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::DisplayConfigured { refused }) => Ok(refused.map_or(Ok(()), Err)),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Tells the compositor at `socket` to log at `levels`. The outer error is
/// the compositor's; the inner, why it refused.
pub fn set_log_levels(
    socket: &Path,
    levels: &LogLevels,
    patience: Option<Duration>,
) -> Result<Result<(), String>, CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::SetLogLevels {
            levels: levels.clone(),
        }],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::LogLevelsSet { refused }) => Ok(refused.map_or(Ok(()), Err)),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Tells the compositor at `socket` to set the theme `to`, if given, and
/// returns the desk's theme.
///
/// The compositor answers a connection's messages in order, so the
/// `which_theme` sent after `set_theme` reports the new theme.
pub fn theme(
    socket: &Path,
    to: Option<Theme>,
    patience: Option<Duration>,
) -> Result<Theme, CompositorError> {
    let messages: Vec<ChromeMessage> = to
        .map(|theme| ChromeMessage::SetTheme { theme })
        .into_iter()
        .chain([ChromeMessage::WhichTheme])
        .collect();
    let said = exchanged(socket, &messages, patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::Theme { theme }) => Ok(theme),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` for the lit monitors, under the names a
/// display profile can call them by.
pub fn monitors(
    socket: &Path,
    patience: Option<Duration>,
) -> Result<Vec<MonitorInfo>, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichMonitors], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::Monitors { monitors }) => Ok(monitors),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` for every display, with the names it
/// answers to and whether it is lit.
pub fn displays(
    socket: &Path,
    patience: Option<Duration>,
) -> Result<Vec<ListedDisplay>, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichDisplays], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::DisplayList { displays }) => Ok(displays),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` for every window, native and browser.
pub fn windows(
    socket: &Path,
    patience: Option<Duration>,
) -> Result<Vec<ListedWindow>, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichWindows], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::WindowList { windows }) => Ok(windows),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` how the desktop is.
pub fn status(socket: &Path, patience: Option<Duration>) -> Result<DesktopStatus, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichStatus], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::Status(status)) => Ok(status),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` which commands the shell runs.
pub fn shell_commands(
    socket: &Path,
    patience: Option<Duration>,
) -> Result<Vec<ShellCommandHelp>, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichShellCommands], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::ShellCommandList { commands }) => Ok(commands),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` which input devices the engine reads.
pub fn inputs(
    socket: &Path,
    patience: Option<Duration>,
) -> Result<Vec<ListedInput>, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichInputs], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::InputList { inputs }) => Ok(inputs),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` how many whole seconds nobody has used the
/// desktop.
pub fn idle_time(socket: &Path, patience: Option<Duration>) -> Result<u64, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichIdleTime], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::IdleTime { seconds }) => Ok(seconds),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` which keys and gestures the shell binds.
pub fn shell_bindings(
    socket: &Path,
    patience: Option<Duration>,
) -> Result<Vec<ShellBinding>, CompositorError> {
    let said = exchanged(socket, &[ChromeMessage::WhichShellBindings], patience)?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::ShellBindingList { bindings }) => Ok(bindings),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Asks the compositor at `socket` for the agents let in now and those
/// remembered.
pub fn agents(socket: &Path, patience: Option<Duration>) -> Result<KnownAgents, CompositorError> {
    match called(socket, SystemRequest::Agents, patience)? {
        Answer {
            reply: SystemReply::Agents(agents),
            ..
        } => Ok(agents),
        Answer { reply, said } => Err(not_done(socket, reply, said)),
    }
}

/// Asks the compositor at `socket` to end agent session `session`.
pub fn stop_agent(
    socket: &Path,
    session: u32,
    patience: Option<Duration>,
) -> Result<(), CompositorError> {
    set(socket, SystemRequest::StopAgent { session }, patience)
}

/// Asks the compositor at `socket` to make agent `agent` ask again.
pub fn forget_agent(
    socket: &Path,
    agent: &str,
    patience: Option<Duration>,
) -> Result<(), CompositorError> {
    set(
        socket,
        SystemRequest::ForgetAgent {
            agent: agent.to_owned(),
        },
        patience,
    )
}

/// Makes the one call `request`, which the compositor answers with
/// [`SystemReply::Set`].
fn set(
    socket: &Path,
    request: SystemRequest,
    patience: Option<Duration>,
) -> Result<(), CompositorError> {
    match called(socket, request, patience)? {
        Answer {
            reply: SystemReply::Set,
            ..
        } => Ok(()),
        Answer { reply, said } => Err(not_done(socket, reply, said)),
    }
}

/// A virtual monitor the compositor keeps while this connection is open.
pub struct HeldMonitor {
    output: String,
    stream: UnixStream,
    path: PathBuf,
}

impl HeldMonitor {
    /// Its `wl_output`, as `domicile.displays` names it.
    pub fn output(&self) -> &str {
        &self.output
    }

    /// Resizes it in place.
    pub fn resize(&self, mode: MonitorMode) -> Result<(), CompositorError> {
        let message = ChromeMessage::SystemRequest {
            id: CALL,
            request: SystemRequest::ResizeVirtualMonitor {
                width: mode.size.0,
                height: mode.size.1,
                refresh_mhz: mode.refresh_mhz,
                scale: mode.scale,
            },
        };
        let mut line = serde_json::to_string(&message).expect("a chrome message always serializes");
        line.push('\n');
        (&self.stream)
            .write_all(line.as_bytes())
            .map_err(|why| CompositorError::Failed {
                path: self.path.display().to_string(),
                kind: why.kind(),
            })
    }

    /// Blocks until the compositor ends it: it exited, or ended the call.
    pub fn until_it_ends(&self) {
        // Whatever comes, an end or a hang-up, ends it.
        let _ = BufReader::new(&self.stream).read_line(&mut String::new());
    }

    /// Hangs up, which removes it, and wakes [`HeldMonitor::until_it_ends`].
    pub fn give_back(&self) {
        // Already gone if the compositor hung up first.
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Asks the compositor at `socket` for a virtual monitor named `name`, and
/// holds it until [`HeldMonitor::give_back`] or the drop.
pub fn virtual_monitor(
    socket: &Path,
    name: &str,
    mode: MonitorMode,
    patience: Option<Duration>,
) -> Result<HeldMonitor, CompositorError> {
    let request = SystemRequest::VirtualMonitor {
        name: name.to_owned(),
        width: mode.size.0,
        height: mode.size.1,
        refresh_mhz: mode.refresh_mhz,
        scale: mode.scale,
    };
    let stream = connected(socket, patience)?;
    let said = said_over(
        socket,
        &stream,
        &[ChromeMessage::SystemRequest { id: CALL, request }],
    )?;
    let reply = match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::SystemReply { id: CALL, reply }) => reply,
        _ => {
            return Err(CompositorError::Unreadable {
                path: socket.display().to_string(),
                said,
            })
        }
    };
    match reply {
        SystemReply::VirtualMonitor { output } => {
            // It lasts until the compositor goes, however long that is.
            stream
                .set_read_timeout(None)
                .map_err(|why| CompositorError::Failed {
                    path: socket.display().to_string(),
                    kind: why.kind(),
                })?;
            Ok(HeldMonitor {
                output,
                stream,
                path: socket.to_path_buf(),
            })
        }
        reply => Err(not_done(socket, reply, said)),
    }
}

/// An agent the compositor lets in while this connection is open.
pub struct HeldAgent {
    reach: AgentReach,
    stream: UnixStream,
    /// What the compositor says after letting it in.
    told: Mutex<BufReader<UnixStream>>,
    path: PathBuf,
}

impl HeldAgent {
    /// What the user let it reach.
    pub fn reach(&self) -> &AgentReach {
        &self.reach
    }

    /// Lists `said` as what it did last.
    pub fn did(&self, said: String) -> Result<(), CompositorError> {
        let message = ChromeMessage::SystemRequest {
            id: CALL,
            request: SystemRequest::AgentDid { said },
        };
        let mut line = serde_json::to_string(&message).expect("a chrome message always serializes");
        line.push('\n');
        (&self.stream)
            .write_all(line.as_bytes())
            .map_err(|why| CompositorError::Failed {
                path: self.path.display().to_string(),
                kind: why.kind(),
            })
    }

    /// Blocks until the user changes what it may reach, and returns that;
    /// `None` once the compositor ends it: the shell stopped it, or the
    /// compositor exited.
    pub fn changed(&self) -> Option<AgentReach> {
        let mut line = String::new();
        // Whatever else comes, an end or a hang-up, ends it.
        if self.told.lock().unwrap().read_line(&mut line).unwrap_or(0) == 0 {
            return None;
        }
        match serde_json::from_str::<HostMessage>(&line) {
            Ok(HostMessage::SystemEvent {
                id: CALL,
                event: SystemEvent::AgentReach { reach },
            }) => Some(reach),
            _ => None,
        }
    }

    /// Blocks until the compositor ends it, past any change.
    pub fn until_it_ends(&self) {
        while self.changed().is_some() {}
    }

    /// Hangs up, which takes it off the shell's list, and wakes
    /// [`HeldAgent::changed`].
    pub fn give_back(&self) {
        // Already gone if the compositor hung up first.
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Asks the compositor at `socket` to let agent `agent` in, which asks the
/// user, and holds it until [`HeldAgent::give_back`] or the drop. `patience`
/// covers the user deciding.
pub fn agent(
    socket: &Path,
    agent: &str,
    patience: Option<Duration>,
) -> Result<HeldAgent, CompositorError> {
    let request = SystemRequest::Agent {
        agent: agent.to_owned(),
    };
    let stream = connected(socket, patience)?;
    sent(
        socket,
        &stream,
        &[ChromeMessage::SystemRequest { id: CALL, request }],
    )?;
    // Kept past the reply: a change can follow it at once.
    let mut told = BufReader::new(stream.try_clone().map_err(|why| CompositorError::Failed {
        path: socket.display().to_string(),
        kind: why.kind(),
    })?);
    let said = said(socket, &mut told)?;
    let reply = match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::SystemReply { id: CALL, reply }) => reply,
        _ => {
            return Err(CompositorError::Unreadable {
                path: socket.display().to_string(),
                said,
            })
        }
    };
    match reply {
        SystemReply::Agent { reach } => {
            // It lasts until the shell stops it, however long that is.
            stream
                .set_read_timeout(None)
                .map_err(|why| CompositorError::Failed {
                    path: socket.display().to_string(),
                    kind: why.kind(),
                })?;
            Ok(HeldAgent {
                reach,
                stream,
                told: Mutex::new(told),
                path: socket.to_path_buf(),
            })
        }
        reply => Err(not_done(socket, reply, said)),
    }
}

/// Asks the compositor at `socket` to tell `topics` over a new connection,
/// at once and on every change, and returns that connection. Each line it
/// carries is a [`HostMessage`]; it ends when the compositor does.
pub fn watch(socket: &Path, topics: &[WatchTopic]) -> Result<UnixStream, CompositorError> {
    let mut stream = connected(socket, None)?;
    let mut line = serde_json::to_string(&ChromeMessage::Watch {
        topics: topics.to_vec(),
    })
    .expect("a chrome message always serializes");
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|why| unreachable(socket, &why))?;
    Ok(stream)
}

/// The compositor's reply to a call, and the line it came in.
struct Answer {
    reply: SystemReply,
    said: String,
}

/// Makes the one call `request` and reads its answer.
fn called(
    socket: &Path,
    request: SystemRequest,
    patience: Option<Duration>,
) -> Result<Answer, CompositorError> {
    let said = exchanged(
        socket,
        &[ChromeMessage::SystemRequest { id: CALL, request }],
        patience,
    )?;
    match serde_json::from_str::<HostMessage>(&said) {
        Ok(HostMessage::SystemReply { id: CALL, reply }) => Ok(Answer { reply, said }),
        _ => Err(CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        }),
    }
}

/// Sends `messages` and reads the one line the compositor answers with.
fn exchanged(
    socket: &Path,
    messages: &[ChromeMessage],
    patience: Option<Duration>,
) -> Result<String, CompositorError> {
    said_over(socket, &connected(socket, patience)?, messages)
}

/// A connection to the compositor at `socket`, waiting at most `patience`.
fn connected(socket: &Path, patience: Option<Duration>) -> Result<UnixStream, CompositorError> {
    let path = || socket.display().to_string();
    let stream = UnixStream::connect(socket).map_err(|why| match why.kind() {
        // A missing socket, or a stale one left by a dead compositor.
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => {
            CompositorError::NoCompositor { path: path() }
        }
        kind => CompositorError::Failed { path: path(), kind },
    })?;
    stream
        .set_read_timeout(patience)
        .map_err(|why| unreachable(socket, &why))?;
    stream
        .set_write_timeout(patience)
        .map_err(|why| unreachable(socket, &why))?;
    Ok(stream)
}

/// Sends `messages` over `stream` and reads the one line the compositor
/// answers with. Nothing follows that line but a hang-up or, for a held
/// call, its end, so the reader buffers nothing the caller misses.
fn said_over(
    socket: &Path,
    stream: &UnixStream,
    messages: &[ChromeMessage],
) -> Result<String, CompositorError> {
    sent(socket, stream, messages)?;
    said(socket, &mut BufReader::new(stream))
}

/// Sends `messages` over `stream`.
fn sent(
    socket: &Path,
    mut stream: &UnixStream,
    messages: &[ChromeMessage],
) -> Result<(), CompositorError> {
    let lines: String = messages
        .iter()
        .map(|message| {
            let mut line =
                serde_json::to_string(message).expect("a chrome message always serializes");
            line.push('\n');
            line
        })
        .collect();
    stream
        .write_all(lines.as_bytes())
        .map_err(|why| unreachable(socket, &why))
}

/// Reads the one line the compositor answers with from `reader`, which
/// keeps any line after it.
fn said(socket: &Path, reader: &mut impl BufRead) -> Result<String, CompositorError> {
    let mut said = String::new();
    reader
        .read_line(&mut said)
        .map_err(|why| unreachable(socket, &why))?;
    let said = said.trim();
    if said.is_empty() {
        // The compositor closed without replying.
        Err(CompositorError::NoAnswer {
            path: socket.display().to_string(),
        })
    } else {
        Ok(said.to_string())
    }
}

/// The error for a connection that failed after it was made.
fn unreachable(socket: &Path, why: &std::io::Error) -> CompositorError {
    let path = socket.display().to_string();
    match why.kind() {
        // A timeout is `WouldBlock` or `TimedOut` depending on the platform,
        // and a hang-up `ConnectionReset` or `BrokenPipe` depending on timing.
        std::io::ErrorKind::WouldBlock
        | std::io::ErrorKind::TimedOut
        | std::io::ErrorKind::BrokenPipe
        | std::io::ErrorKind::ConnectionReset => CompositorError::NoAnswer { path },
        kind => CompositorError::Failed { path, kind },
    }
}

/// The error for a `reply` that is not the success the call wanted.
fn not_done(socket: &Path, reply: SystemReply, said: String) -> CompositorError {
    match reply {
        SystemReply::Failed { error } => CompositorError::Refused { why: error.message },
        _ => CompositorError::Unreadable {
            path: socket.display().to_string(),
            said,
        },
    }
}
