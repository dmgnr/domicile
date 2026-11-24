//! Files, watches, processes, D-Bus, screenshots, shell commands, links, idle
//! watches and holds, the lock's refusals, window states and keymaps for one
//! chrome connection.
//! The compositor takes the screenshots ([`System::screenshotting_with`]),
//! sets window states ([`System::setting_window_states_with`]), adds virtual
//! monitors ([`System::adding_virtual_monitors_with`]), shares the
//! shell commands ([`System::sharing_shell_commands`]), the pages that open
//! links ([`System::sharing_links`]), idle watches
//! ([`System::sharing_idle_watches`]), idle holds
//! ([`System::sharing_idle_holds`]) and window requests
//! ([`System::sharing_window_requests`]) between connections, sends the
//! refusals ([`System::sharing_unlock_refusals`]), lists the keymaps
//! ([`System::sharing_keymaps`]) and switches them
//! ([`System::selecting_keymaps_with`]).
//!
//! [`System::handle`] runs a `ChromeMessage::SystemRequest` and sends every
//! answer through the callback it was built with. Nothing here blocks the
//! caller: file calls run on a thread each, and a process has threads for its
//! output and its exit. The lock is the compositor's to check before calling;
//! [`reach`] tells it what a request touches. See
//! `docs/SHELL-SYSTEM-ACCESS.md`.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

use domicile_protocol::{
    AgentReach, Bus, DirEntry, FileType, HostMessage, InhibitorAction, KeymapChoice, KnownAgents,
    PreviewedWindow, Scale, Signal, Stream, SystemEnd, SystemError, SystemErrorKind, SystemEvent,
    SystemReply, SystemRequest, WindowState,
};
use notify::{EventKindMask, RecursiveMode, Watcher};
use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::{Signature, Structure, StructureBuilder};

use crate::base64::{decoded, encoded};
use crate::bells::Bells;
use crate::dbus_json::{self, NotABody};
use crate::fanout::Listener;
use crate::idle_holds::{self, IdleHolds};
use crate::idle_watches::{IdleWatches, Mark};
use crate::keymaps::Keymaps;
use crate::links::Links;
use crate::lock_screen_readouts::is_a_readout;
use crate::priority;
use crate::shell_commands::ShellCommands;
use crate::unlock_refusals::UnlockRefusals;
use crate::white_point::{white_point, WhitePoint, NEUTRAL, WARMEST};
use crate::window_requests::WindowRequests;
use crate::AppId;

/// How much of a process's output one event carries at most.
const CHUNK: usize = 64 * 1024;

/// Where answers go.
type Tell = Arc<dyn Fn(HostMessage) + Send + Sync>;

/// Variables to set, or with `None` to remove, in every process's environment.
pub type Environment = Vec<(OsString, Option<OsString>)>;

/// Variables read anew for each process, after the fixed [`Environment`]: a
/// setting a config reload can change.
type LiveEnvironment = Arc<dyn Fn() -> Environment + Send + Sync>;

/// The calls one chrome connection has running.
///
/// Dropping it kills its processes and ends its watches, so a page that goes
/// away leaves nothing behind.
pub struct System {
    home: PathBuf,
    environment: Environment,
    /// See [`System::with_live_environment`].
    live_environment: Option<LiveEnvironment>,
    /// What processes start at, rather than the spawning thread's nice
    /// value; see [`crate::priority::starting_at`].
    nice: i32,
    tell: Tell,
    running: Arc<Mutex<HashMap<u32, Running>>>,
    connect: Connect,
    /// The connection each bus's calls share, once one was made.
    buses: Arc<Mutex<HashMap<Bus, Connection>>>,
    /// Takes screenshots; `None` on a system that takes none.
    screenshot: Option<Screenshot>,
    /// Records the screen; `None` on a system that records nothing.
    screen_record: Option<ScreenRecord>,
    /// Draws window previews; `None` on a system that draws none.
    preview: Option<Preview>,
    /// The pages that hear a `SystemRequest::SendShell`.
    shell_commands: ShellCommands,
    /// The pages that open links, by scheme.
    links: Links,
    /// The pages watching for the desk to go idle.
    idle_watches: IdleWatches,
    /// What holds the desktop awake, and the pages that hear it change.
    idle_holds: IdleHolds,
    /// The pages that hear the lock refuse a passphrase.
    unlock_refusals: UnlockRefusals,
    /// Sets a window's states; `None` on a system that sets none.
    set_window_states: Option<SetWindowStates>,
    /// The pages that hear a client's window requests.
    window_requests: WindowRequests,
    bells: Bells,
    /// The keymaps, and the pages that hear them change.
    keymaps: Keymaps,
    /// Switches the keymap; `None` on a system that switches none.
    select_keymap: Option<SelectKeymap>,
    /// Acts on the keyboard window's shortcuts inhibitor; `None` on a system
    /// that has none.
    shortcuts_inhibitor: Option<ShortcutsInhibitor>,
    /// Adds virtual monitors; `None` on a system that adds none.
    add_virtual_monitor: Option<AddVirtualMonitor>,
    /// Lets agents in; `None` on a system that lets none in.
    agents: Option<Arc<dyn Agents>>,
    /// Sets every monitor's white point; `None` on a system that sets none.
    set_white_point: Option<SetWhitePoint>,
    /// Turns the monitors off and on; `None` on a system that powers none.
    power_displays: Option<PowerDisplays>,
}

/// Adds a virtual monitor. See [`SystemRequest::VirtualMonitor`].
pub type AddVirtualMonitor =
    Arc<dyn Fn(VirtualMonitor) -> Result<AddedMonitor, SystemError> + Send + Sync>;

/// A virtual monitor a page asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualMonitor {
    pub name: String,
    /// Its mode, in pixels.
    pub size: (u32, u32),
    pub refresh_mhz: u32,
    pub scale: Scale,
}

/// A virtual monitor that was added.
pub struct AddedMonitor {
    /// Its `wl_output` name.
    pub output: String,
    /// Removes the monitor when dropped.
    pub lease: Box<dyn MonitorLease>,
}

/// A page's hold on its virtual monitor, which removes it when dropped.
pub trait MonitorLease: Send {
    /// Gives the monitor a new mode. See
    /// [`SystemRequest::ResizeVirtualMonitor`].
    fn resize(&self, size: (u32, u32), refresh_mhz: u32, scale: Scale);
}

/// Why a system with no [`Agents`] refuses one.
fn no_agents() -> SystemError {
    SystemError {
        kind: SystemErrorKind::Other,
        message: "this desktop lets in no agents".into(),
    }
}

/// The agents the desk lets in. See `docs/AGENTS.md`.
pub trait Agents: Send + Sync {
    /// Asks the user whether agent `agent` may see and use the desk, unless
    /// it is remembered, and lists it while it may. Blocks while the user
    /// decides. See [`SystemRequest::Agent`].
    fn let_in(&self, agent: String, told: AgentTold) -> Result<LetIn, SystemError>;
    /// The agents let in now and those remembered. See
    /// [`SystemRequest::Agents`].
    fn known(&self) -> KnownAgents;
    /// Ends agent session `session`, as the shell's stop does.
    fn stop(&self, session: u32) -> Result<(), SystemError>;
    /// Makes the remembered agent `agent` ask again next time.
    fn forget(&self, agent: &str) -> Result<(), SystemError>;
}

/// How an agent let in hears what the user does to it.
pub struct AgentTold {
    /// Runs once when the user stops it.
    pub stopped: AgentStopped,
    /// Runs each time the user changes what it may reach.
    pub changed: AgentChanged,
}

/// Runs once when the user stops an agent.
pub type AgentStopped = Box<dyn FnOnce() + Send>;

/// Runs each time the user changes what an agent may reach.
pub type AgentChanged = Box<dyn Fn(AgentReach) + Send + Sync>;

/// An agent the user let in.
pub struct LetIn {
    pub reach: AgentReach,
    pub lease: Box<dyn AgentLease>,
}

/// A page's hold on the agent it let in, which takes it off the shell's list
/// when dropped.
pub trait AgentLease: Send {
    /// Lists `said` as what the agent did last. See
    /// [`SystemRequest::AgentDid`].
    fn did(&self, said: String);
}

/// Switches every keyboard to the keymap a page chose.
pub type SelectKeymap = Arc<dyn Fn(KeymapChoice) -> Result<(), SystemError> + Send + Sync>;

/// Activates, deactivates or toggles the shortcuts inhibitor of the window
/// with the keyboard.
pub type ShortcutsInhibitor = Arc<dyn Fn(InhibitorAction) -> Result<(), SystemError> + Send + Sync>;

/// Replaces the states the shell set on a window.
pub type SetWindowStates =
    Arc<dyn Fn(AppId, Vec<WindowState>) -> Result<(), SystemError> + Send + Sync>;

/// Sets the white point one display draws with, by name, or every display
/// with `None`.
pub type SetWhitePoint =
    Arc<dyn Fn(Option<String>, WhitePoint) -> Result<(), SystemError> + Send + Sync>;

/// Whether the monitors sleep or light. See [`SystemRequest::SleepDisplays`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayPower {
    Asleep,
    Awake,
}

/// Turns one monitor, by name, or every monitor with `None`, off or on.
pub type PowerDisplays =
    Arc<dyn Fn(DisplayPower, Option<String>) -> Result<(), SystemError> + Send + Sync>;

/// Takes a screenshot, into the file if one is given, and returns where it
/// went. Blocks until it is kept, the dialog included.
pub type Screenshot = Arc<dyn Fn(Option<PathBuf>) -> Result<Kept, SystemError> + Send + Sync>;

/// Records what the user picks until they stop it, and returns the file.
/// Blocks until then, the picker included.
pub type ScreenRecord = Arc<dyn Fn() -> Result<PathBuf, SystemError> + Send + Sync>;

/// Draws a window as it last drew itself, as a `data:` URL of a PNG. Blocks
/// until it is drawn.
pub type Preview = Arc<dyn Fn(PreviewedWindow) -> Result<String, SystemError> + Send + Sync>;

/// Where a screenshot went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kept {
    /// Saved as this file.
    Saved(PathBuf),
    /// Put on the clipboard (Ctrl+C in the dialog) and not saved.
    Copied,
}

/// How a [`System`] reaches a D-Bus bus.
type Connect = Arc<dyn Fn(Bus) -> zbus::Result<Connection> + Send + Sync>;

/// A call that outlives its reply.
enum Running {
    Process {
        /// The process group, which is the process's own pid.
        group: libc::pid_t,
        /// `None` when the process has no stdin or it was closed.
        stdin: Option<Sender<Vec<u8>>>,
    },
    Watch(notify::RecommendedWatcher),
    /// A D-Bus match, on a connection of its own so closing it ends the match.
    Match(Connection),
    /// The page hears shell commands, the lock's refusals, window requests,
    /// the keymaps, what holds the desktop awake or whether it is idle.
    Listening(Listener),
    /// The page's virtual monitor, removed when this drops.
    VirtualMonitor(Box<dyn MonitorLease>),
    /// The agent the page let in, taken off the shell's list when this drops.
    Agent(Box<dyn AgentLease>),
}

/// What [`System::handle`] did with a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handled {
    /// Started, answered or applied.
    Done,
    /// It drives an id with nothing running under it: the call already ended,
    /// or never started. Usually a race with an exit, so nothing is sent.
    NothingRunning,
    /// It drives a running id but is malformed: bad base64, or stdin for a
    /// process started without it. Nothing is sent, since only events and the
    /// end may follow a start.
    Malformed,
}

/// What a request touches, for the lock to judge. See `docs/LOCK.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// It ends or quiets something already running.
    Stops,
    /// It only reads the kernel's state under `/sys`.
    ReadsTheKernel,
    /// A lock screen's battery, brightness, volume or Bluetooth readout. See
    /// `crate::lock_screen_readouts`.
    Readout,
    /// It only hears what the desktop sends it later.
    Listens,
    /// It arranges windows, as `setAppBounds` does.
    Arranges,
    /// It switches the keymap, as a lock screen's keymap item does.
    Retypes,
    /// It changes the colors every monitor draws, as a night light does.
    Tints,
    /// It turns the monitors off or on.
    Powers,
    /// Anything else.
    Acts,
}

/// What `request` touches.
///
/// A read reaches only the kernel when its path is absolute, under `/sys` and
/// free of `..`. Nothing under `/sys` can be changed by the user, so no symlink
/// can be swapped between this judgment and the read. Any other spelling, such
/// as a symlink in the home that points into `/sys`, is judged
/// [`Reach::Acts`].
///
/// A spawn or D-Bus call is a [`Reach::Readout`] only when it is one of the
/// calls `crate::lock_screen_readouts` lists.
pub fn reach(request: &SystemRequest) -> Reach {
    match request {
        SystemRequest::Unwatch
        | SystemRequest::CloseStdin
        | SystemRequest::Kill { .. }
        | SystemRequest::StopAgent { .. } => Reach::Stops,
        SystemRequest::ReadFile { path, .. }
        | SystemRequest::ReadDir { path }
        | SystemRequest::Stat { path }
        | SystemRequest::Watch { path } => {
            let path = Path::new(path);
            let kernel = path.starts_with("/sys")
                && path
                    .components()
                    .all(|part| !matches!(part, Component::ParentDir));
            match kernel {
                true => Reach::ReadsTheKernel,
                false => Reach::Acts,
            }
        }
        SystemRequest::Spawn { .. }
        | SystemRequest::DbusCall { .. }
        | SystemRequest::DbusMatch { .. } => match is_a_readout(request) {
            true => Reach::Readout,
            false => Reach::Acts,
        },
        // Answering a command is part of listening for it.
        SystemRequest::ShellCommands { .. }
        | SystemRequest::AnswerShellCommand { .. }
        | SystemRequest::ClaimLinks { .. }
        | SystemRequest::IdleAfter { .. }
        | SystemRequest::IdleBeforeBlanking { .. }
        | SystemRequest::IdleHolds
        | SystemRequest::UnlockRefusals
        | SystemRequest::WindowRequests
        | SystemRequest::Bells
        | SystemRequest::Keymaps => Reach::Listens,
        SystemRequest::SetWindowStates { .. } | SystemRequest::ResizeVirtualMonitor { .. } => {
            Reach::Arranges
        }
        SystemRequest::SelectKeymap { .. } => Reach::Retypes,
        // Where keys go, as a focus change is.
        SystemRequest::ShortcutsInhibitor { .. } => Reach::Arranges,
        SystemRequest::SetColorTemperature { .. } => Reach::Tints,
        SystemRequest::SleepDisplays { .. } | SystemRequest::WakeDisplays { .. } => Reach::Powers,
        SystemRequest::WriteFile { .. }
        | SystemRequest::CreateDir { .. }
        | SystemRequest::Stdin { .. }
        | SystemRequest::Screenshot { .. }
        | SystemRequest::ScreenRecord
        | SystemRequest::PreviewWindow { .. }
        | SystemRequest::SendShell { .. }
        | SystemRequest::OpenLink { .. }
        | SystemRequest::VirtualMonitor { .. }
        | SystemRequest::Agent { .. }
        | SystemRequest::AgentDid { .. }
        | SystemRequest::Agents
        | SystemRequest::ForgetAgent { .. } => Reach::Acts,
    }
}

/// What the page is told when the lock refuses `request`.
///
/// A call that would start something fails with
/// [`SystemErrorKind::Locked`], so the page's promise settles. A call that
/// drives something running gets nothing, since only events and the end may
/// follow a start.
pub fn locked_out(id: u32, request: &SystemRequest) -> Option<HostMessage> {
    match request {
        SystemRequest::ReadFile { .. }
        | SystemRequest::WriteFile { .. }
        | SystemRequest::CreateDir { .. }
        | SystemRequest::ReadDir { .. }
        | SystemRequest::Stat { .. }
        | SystemRequest::Watch { .. }
        | SystemRequest::Spawn { .. }
        | SystemRequest::DbusCall { .. }
        | SystemRequest::DbusMatch { .. }
        | SystemRequest::Screenshot { .. }
        | SystemRequest::ScreenRecord
        | SystemRequest::PreviewWindow { .. }
        | SystemRequest::ShellCommands { .. }
        | SystemRequest::AnswerShellCommand { .. }
        | SystemRequest::ClaimLinks { .. }
        | SystemRequest::OpenLink { .. }
        | SystemRequest::IdleAfter { .. }
        | SystemRequest::IdleBeforeBlanking { .. }
        | SystemRequest::IdleHolds
        | SystemRequest::UnlockRefusals
        | SystemRequest::SendShell { .. }
        | SystemRequest::SetWindowStates { .. }
        | SystemRequest::SetColorTemperature { .. }
        | SystemRequest::SleepDisplays { .. }
        | SystemRequest::WakeDisplays { .. }
        | SystemRequest::WindowRequests
        | SystemRequest::Bells
        | SystemRequest::VirtualMonitor { .. }
        | SystemRequest::Agent { .. }
        | SystemRequest::Agents
        | SystemRequest::StopAgent { .. }
        | SystemRequest::ForgetAgent { .. }
        | SystemRequest::Keymaps
        | SystemRequest::SelectKeymap { .. }
        | SystemRequest::ShortcutsInhibitor { .. } => Some(HostMessage::SystemReply {
            id,
            reply: SystemReply::Failed {
                error: SystemError {
                    kind: SystemErrorKind::Locked,
                    message: "the desktop is locked".into(),
                },
            },
        }),
        SystemRequest::Unwatch
        | SystemRequest::Stdin { .. }
        | SystemRequest::CloseStdin
        | SystemRequest::Kill { .. }
        | SystemRequest::ResizeVirtualMonitor { .. }
        | SystemRequest::AgentDid { .. } => None,
    }
}

/// What an app connection is told when it asks for more than files,
/// processes and D-Bus, or nothing when it may ask.
///
/// The rest belongs to the window manager, which a Wayland client cannot reach
/// either. See `docs/architecture/APP-MODULES.md`.
pub fn refused_to_an_app(id: u32, request: &SystemRequest) -> Option<HostMessage> {
    match request {
        SystemRequest::ReadFile { .. }
        | SystemRequest::WriteFile { .. }
        | SystemRequest::CreateDir { .. }
        | SystemRequest::ReadDir { .. }
        | SystemRequest::Stat { .. }
        | SystemRequest::Watch { .. }
        | SystemRequest::Unwatch
        | SystemRequest::Spawn { .. }
        | SystemRequest::Stdin { .. }
        | SystemRequest::CloseStdin
        | SystemRequest::Kill { .. }
        | SystemRequest::DbusCall { .. }
        | SystemRequest::DbusMatch { .. } => None,
        SystemRequest::Screenshot { .. }
        | SystemRequest::ScreenRecord
        | SystemRequest::PreviewWindow { .. }
        | SystemRequest::ShellCommands { .. }
        | SystemRequest::AnswerShellCommand { .. }
        | SystemRequest::SendShell { .. }
        | SystemRequest::ClaimLinks { .. }
        | SystemRequest::OpenLink { .. }
        | SystemRequest::IdleAfter { .. }
        | SystemRequest::IdleBeforeBlanking { .. }
        | SystemRequest::IdleHolds
        | SystemRequest::UnlockRefusals
        | SystemRequest::SetWindowStates { .. }
        | SystemRequest::SetColorTemperature { .. }
        | SystemRequest::SleepDisplays { .. }
        | SystemRequest::WakeDisplays { .. }
        | SystemRequest::WindowRequests
        | SystemRequest::Bells
        | SystemRequest::VirtualMonitor { .. }
        | SystemRequest::ResizeVirtualMonitor { .. }
        | SystemRequest::Agent { .. }
        | SystemRequest::AgentDid { .. }
        | SystemRequest::Agents
        | SystemRequest::StopAgent { .. }
        | SystemRequest::ForgetAgent { .. }
        | SystemRequest::Keymaps
        | SystemRequest::SelectKeymap { .. }
        | SystemRequest::ShortcutsInhibitor { .. } => Some(HostMessage::SystemReply {
            id,
            reply: SystemReply::Failed {
                error: SystemError {
                    kind: SystemErrorKind::PermissionDenied,
                    message: "an app may use files, processes and D-Bus only".into(),
                },
            },
        }),
    }
}

impl System {
    /// A system for one connection. Relative paths and processes start from
    /// `home`. Processes inherit this process's environment changed by
    /// `environment`, then the page's `env`, at nice value `nice`. Answers go
    /// to `tell`, from any thread.
    pub fn new(
        home: PathBuf,
        environment: Environment,
        nice: i32,
        tell: impl Fn(HostMessage) + Send + Sync + 'static,
    ) -> System {
        System {
            home,
            environment,
            live_environment: None,
            nice,
            tell: Arc::new(tell),
            running: Arc::new(Mutex::new(HashMap::new())),
            connect: Arc::new(|bus| match bus {
                Bus::Session => Connection::session(),
                Bus::System => Connection::system(),
            }),
            buses: Arc::default(),
            screenshot: None,
            screen_record: None,
            preview: None,
            shell_commands: ShellCommands::default(),
            links: Links::default(),
            idle_watches: IdleWatches::new(|| {}),
            idle_holds: IdleHolds::default(),
            unlock_refusals: UnlockRefusals::default(),
            set_window_states: None,
            window_requests: WindowRequests::default(),
            bells: Bells::default(),
            add_virtual_monitor: None,
            agents: None,
            keymaps: Keymaps::default(),
            select_keymap: None,
            shortcuts_inhibitor: None,
            set_white_point: None,
            power_displays: None,
        }
    }

    /// This system, reaching D-Bus through `connect` instead of the session
    /// and system buses.
    pub fn connecting_with(
        mut self,
        connect: impl Fn(Bus) -> zbus::Result<Connection> + Send + Sync + 'static,
    ) -> System {
        self.connect = Arc::new(connect);
        self
    }

    /// This system, taking screenshots through `screenshot`.
    pub fn screenshotting_with(
        mut self,
        screenshot: impl Fn(Option<PathBuf>) -> Result<Kept, SystemError> + Send + Sync + 'static,
    ) -> System {
        self.screenshot = Some(Arc::new(screenshot));
        self
    }

    /// This system, recording the screen through `screen_record`.
    pub fn recording_with(
        mut self,
        screen_record: impl Fn() -> Result<PathBuf, SystemError> + Send + Sync + 'static,
    ) -> System {
        self.screen_record = Some(Arc::new(screen_record));
        self
    }

    /// This system, drawing window previews through `preview`.
    pub fn previewing_with(
        mut self,
        preview: impl Fn(PreviewedWindow) -> Result<String, SystemError> + Send + Sync + 'static,
    ) -> System {
        self.preview = Some(Arc::new(preview));
        self
    }

    /// This system, setting `live`'s variables, read as each process starts,
    /// after its fixed environment. The desk's terminal is one; see
    /// [`crate::desk_terminal`].
    pub fn with_live_environment(
        mut self,
        live: impl Fn() -> Environment + Send + Sync + 'static,
    ) -> System {
        self.live_environment = Some(Arc::new(live));
        self
    }

    /// This system, sending and hearing shell commands through `commands`
    /// instead of only its own.
    pub fn sharing_shell_commands(mut self, commands: ShellCommands) -> System {
        self.shell_commands = commands;
        self
    }

    /// This system, claiming and handing over links through `links` instead
    /// of only its own.
    pub fn sharing_links(mut self, links: Links) -> System {
        self.links = links;
        self
    }

    /// This system, watching for idle through `watches` instead of its own,
    /// which no clock settles.
    pub fn sharing_idle_watches(mut self, watches: IdleWatches) -> System {
        self.idle_watches = watches;
        self
    }

    /// This system, telling a page that listens each refusal sent through
    /// `refusals`.
    pub fn sharing_unlock_refusals(mut self, refusals: UnlockRefusals) -> System {
        self.unlock_refusals = refusals;
        self
    }

    /// This system, setting window states through `set`.
    pub fn setting_window_states_with(
        mut self,
        set: impl Fn(AppId, Vec<WindowState>) -> Result<(), SystemError> + Send + Sync + 'static,
    ) -> System {
        self.set_window_states = Some(Arc::new(set));
        self
    }

    /// This system, telling a page that listens each window request sent
    /// through `requests`.
    pub fn sharing_window_requests(mut self, requests: WindowRequests) -> System {
        self.window_requests = requests;
        self
    }

    /// This system, telling a page that listens each bell `bells` hears.
    pub fn sharing_bells(mut self, bells: Bells) -> System {
        self.bells = bells;
        self
    }

    /// This system, adding virtual monitors through `add`.
    pub fn adding_virtual_monitors_with(
        mut self,
        add: impl Fn(VirtualMonitor) -> Result<AddedMonitor, SystemError> + Send + Sync + 'static,
    ) -> System {
        self.add_virtual_monitor = Some(Arc::new(add));
        self
    }

    /// This system, letting agents in through `agents`.
    pub fn letting_agents_in(mut self, agents: impl Agents + 'static) -> System {
        self.agents = Some(Arc::new(agents));
        self
    }

    /// This system, telling a page that listens what `holds` lists as holding
    /// the desktop awake.
    pub fn sharing_idle_holds(mut self, holds: IdleHolds) -> System {
        self.idle_holds = holds;
        self
    }

    /// This system, telling a page that listens the keymaps `keymaps` lists.
    pub fn sharing_keymaps(mut self, keymaps: Keymaps) -> System {
        self.keymaps = keymaps;
        self
    }

    /// This system, switching the keymap through `select`.
    pub fn switching_shortcuts_inhibitors_with(
        mut self,
        switch: impl Fn(InhibitorAction) -> Result<(), SystemError> + Send + Sync + 'static,
    ) -> System {
        self.shortcuts_inhibitor = Some(Arc::new(switch));
        self
    }

    pub fn selecting_keymaps_with(
        mut self,
        select: impl Fn(KeymapChoice) -> Result<(), SystemError> + Send + Sync + 'static,
    ) -> System {
        self.select_keymap = Some(Arc::new(select));
        self
    }

    /// This system, setting a display's white point, or every display's,
    /// through `set`.
    pub fn setting_white_points_with(
        mut self,
        set: impl Fn(Option<String>, WhitePoint) -> Result<(), SystemError> + Send + Sync + 'static,
    ) -> System {
        self.set_white_point = Some(Arc::new(set));
        self
    }

    /// This system, turning the monitors off and on through `power`.
    pub fn powering_displays_with(
        mut self,
        power: impl Fn(DisplayPower, Option<String>) -> Result<(), SystemError> + Send + Sync + 'static,
    ) -> System {
        self.power_displays = Some(Arc::new(power));
        self
    }

    /// Run `request` under the page's `id`.
    pub fn handle(&self, id: u32, request: SystemRequest) -> Handled {
        match request {
            SystemRequest::ReadFile {
                path,
                offset,
                length,
            } => self.on_a_thread(id, move |home| {
                read_range(&home.join(path), offset, length).map(|bytes| SystemReply::Read {
                    data: encoded(&bytes),
                })
            }),
            SystemRequest::WriteFile { path, data, atomic } => self.on_a_thread(id, move |home| {
                let bytes = decoded(&data)
                    .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
                let path = home.join(path);
                match atomic {
                    true => written_atomically(&path, &bytes, id),
                    false => std::fs::write(&path, &bytes),
                }
                .map(|()| SystemReply::Written)
            }),
            SystemRequest::CreateDir { path } => self.on_a_thread(id, move |home| {
                std::fs::create_dir(home.join(path)).map(|()| SystemReply::Created)
            }),
            SystemRequest::ReadDir { path } => self.on_a_thread(id, move |home| {
                std::fs::read_dir(home.join(path))?
                    .map(|entry| {
                        let entry = entry?;
                        Ok(DirEntry {
                            name: entry.file_name().to_string_lossy().into_owned(),
                            file_type: file_type(entry.file_type()?),
                        })
                    })
                    .collect::<io::Result<_>>()
                    .map(|entries| SystemReply::Entries { entries })
            }),
            SystemRequest::Stat { path } => self.on_a_thread(id, move |home| -> io::Result<_> {
                let path = home.join(path);
                let metadata = std::fs::metadata(&path)?;
                Ok(SystemReply::Stat {
                    file_type: file_type(metadata.file_type()),
                    size: metadata.len(),
                    modified_ms: metadata
                        .modified()
                        .ok()
                        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
                        .map(|since| since.as_millis() as u64),
                    real_path: std::fs::canonicalize(&path)
                        .ok()
                        .map(|real| real.to_string_lossy().into_owned()),
                })
            }),
            SystemRequest::Watch { path } => {
                self.starting(id, |system| Ok(system.watched(id, &path)?))
            }
            SystemRequest::Spawn {
                argv,
                cwd,
                env,
                stdin,
            } => self.starting(id, |system| {
                let (program, args) = argv
                    .split_first()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "an empty argv"))?;
                let mut command = Command::new(program);
                let live = system
                    .live_environment
                    .as_ref()
                    .map(|live| live())
                    .unwrap_or_default();
                for (name, value) in system.environment.iter().chain(&live) {
                    match value {
                        Some(value) => command.env(name, value),
                        None => command.env_remove(name),
                    };
                }
                command
                    .args(args)
                    .current_dir(system.home.join(cwd.unwrap_or_default()))
                    .envs(env)
                    .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    // Its own group, so a kill reaches what it started too.
                    .process_group(0);
                priority::starting_at(&mut command, system.nice);
                Ok(system.spawned(id, command.spawn()?)?)
            }),
            SystemRequest::DbusCall {
                bus,
                destination,
                path,
                interface,
                member,
                signature,
                body,
            } => {
                let (connect, buses) = (self.connect.clone(), self.buses.clone());
                self.on_a_thread(id, move |_| -> Result<SystemReply, Failure> {
                    let values = dbus_json::read(&signature, &body)?;
                    let connection = shared(&connect, &buses, bus)?;
                    let returned = if values.is_empty() {
                        connection.call_method(
                            Some(destination.as_str()),
                            path.as_str(),
                            Some(interface.as_str()),
                            member.as_str(),
                            &(),
                        )
                    } else {
                        let arguments = values
                            .into_iter()
                            .fold(StructureBuilder::new(), StructureBuilder::append_field)
                            .build()?;
                        connection.call_method(
                            Some(destination.as_str()),
                            path.as_str(),
                            Some(interface.as_str()),
                            member.as_str(),
                            &arguments,
                        )
                    }?;
                    let (signature, body) = body_of(&returned)?;
                    Ok(SystemReply::Returned { signature, body })
                })
            }
            SystemRequest::DbusMatch {
                bus,
                sender,
                path,
                interface,
                member,
            } => self.starting(id, |system| {
                let rule = [
                    ("sender", sender),
                    ("path", path),
                    ("interface", interface),
                    ("member", member),
                ]
                .into_iter()
                .filter_map(|(field, value)| value.map(|value| format!(",{field}='{value}'")))
                .fold("type='signal'".to_string(), |rule, field| rule + &field);
                let connection = (system.connect)(bus)?;
                let signals = MessageIterator::for_match_rule(rule.as_str(), &connection, None)?;
                let (tell, running) = (system.tell.clone(), system.running.clone());
                let go = move || {
                    thread::spawn(move || matched(id, signals, &tell, &running));
                };
                Ok((Running::Match(connection), Box::new(go)))
            }),
            SystemRequest::Unwatch => {
                let mut running = self.running.lock().unwrap();
                match running.remove(&id) {
                    Some(Running::Watch(watcher)) => {
                        // Under the lock, so no change is told after the end.
                        (self.tell)(HostMessage::SystemEnd {
                            id,
                            end: SystemEnd::Stopped,
                        });
                        // Dropped outside the lock: dropping joins the
                        // watcher's thread, which may be waiting for the lock.
                        drop(running);
                        drop(watcher);
                        Handled::Done
                    }
                    Some(Running::Match(connection)) => {
                        (self.tell)(HostMessage::SystemEnd {
                            id,
                            end: SystemEnd::Stopped,
                        });
                        drop(running);
                        // Ends the match's iterator, and so its thread. An
                        // error here is a connection already gone.
                        let _ = connection.close();
                        Handled::Done
                    }
                    Some(Running::Listening(listener)) => {
                        (self.tell)(HostMessage::SystemEnd {
                            id,
                            end: SystemEnd::Stopped,
                        });
                        // Dropped outside the lock, which a command being
                        // heard waits for.
                        drop(running);
                        drop(listener);
                        Handled::Done
                    }
                    Some(Running::VirtualMonitor(lease)) => {
                        (self.tell)(HostMessage::SystemEnd {
                            id,
                            end: SystemEnd::Stopped,
                        });
                        drop(running);
                        drop(lease);
                        Handled::Done
                    }
                    Some(Running::Agent(lease)) => {
                        (self.tell)(HostMessage::SystemEnd {
                            id,
                            end: SystemEnd::Stopped,
                        });
                        drop(running);
                        drop(lease);
                        Handled::Done
                    }
                    Some(process) => {
                        running.insert(id, process);
                        Handled::Malformed
                    }
                    None => Handled::NothingRunning,
                }
            }
            SystemRequest::ResizeVirtualMonitor {
                width,
                height,
                refresh_mhz,
                scale,
            } => match self.running.lock().unwrap().get(&id) {
                Some(Running::VirtualMonitor(lease)) => {
                    lease.resize((width, height), refresh_mhz, scale);
                    Handled::Done
                }
                Some(_) => Handled::Malformed,
                None => Handled::NothingRunning,
            },
            SystemRequest::Stdin { data } => match self.running.lock().unwrap().get(&id) {
                Some(Running::Process {
                    stdin: Some(stdin), ..
                }) => match decoded(&data) {
                    // The writer stops only after the process closed its end,
                    // and then nobody is reading.
                    Ok(bytes) => {
                        let _ = stdin.send(bytes);
                        Handled::Done
                    }
                    Err(_) => Handled::Malformed,
                },
                Some(_) => Handled::Malformed,
                None => Handled::NothingRunning,
            },
            SystemRequest::CloseStdin => match self.running.lock().unwrap().get_mut(&id) {
                Some(Running::Process { stdin, .. }) => {
                    // Dropping the sender ends the writer, which closes the pipe.
                    stdin.take();
                    Handled::Done
                }
                Some(
                    Running::Watch(_)
                    | Running::Match(_)
                    | Running::Listening(_)
                    | Running::VirtualMonitor(_)
                    | Running::Agent(_),
                ) => Handled::Malformed,
                None => Handled::NothingRunning,
            },
            SystemRequest::Kill { signal } => match self.running.lock().unwrap().get(&id) {
                Some(Running::Process { group, .. }) => {
                    // SAFETY: `kill` takes plain integers. The group is
                    // registered only until it exits, before it is reaped, so
                    // its pid has not been reused.
                    unsafe { libc::kill(-group, number(signal)) };
                    Handled::Done
                }
                Some(
                    Running::Watch(_)
                    | Running::Match(_)
                    | Running::Listening(_)
                    | Running::VirtualMonitor(_)
                    | Running::Agent(_),
                ) => Handled::Malformed,
                None => Handled::NothingRunning,
            },
            SystemRequest::Screenshot { file } => {
                let screenshot = self.screenshot.clone();
                self.on_a_thread(id, move |home| -> Result<SystemReply, SystemError> {
                    let screenshot = screenshot.ok_or_else(|| SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop takes no screenshots".into(),
                    })?;
                    Ok(match screenshot(file.map(|file| home.join(file)))? {
                        Kept::Saved(path) => SystemReply::Saved {
                            path: path.display().to_string(),
                        },
                        Kept::Copied => SystemReply::Copied,
                    })
                })
            }
            SystemRequest::ScreenRecord => {
                let screen_record = self.screen_record.clone();
                self.on_a_thread(id, move |_| -> Result<SystemReply, SystemError> {
                    let screen_record = screen_record.ok_or_else(|| SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop records no screens".into(),
                    })?;
                    Ok(SystemReply::Saved {
                        path: screen_record()?.display().to_string(),
                    })
                })
            }
            SystemRequest::PreviewWindow { window } => {
                let preview = self.preview.clone();
                self.on_a_thread(id, move |_| -> Result<SystemReply, SystemError> {
                    let preview = preview.ok_or_else(|| SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop draws no previews".into(),
                    })?;
                    Ok(SystemReply::Preview {
                        frame: preview(window)?,
                    })
                })
            }
            SystemRequest::ShellCommands { commands, bindings } => self.starting(id, |system| {
                let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
                let listener = system.shell_commands.listen(
                    commands,
                    bindings,
                    Arc::new(move |(command, sent): &(Vec<String>, u64)| {
                        let Some(running) = running.upgrade() else {
                            return;
                        };
                        // Under the lock, so no command is told before the reply
                        // or after `Unwatch` ends it.
                        let running = running.lock().unwrap();
                        if matches!(running.get(&id), Some(Running::Listening(_))) {
                            tell(HostMessage::SystemEvent {
                                id,
                                event: SystemEvent::ShellCommand {
                                    command: command.clone(),
                                    sent: *sent,
                                },
                            });
                        }
                    }),
                );
                Ok((Running::Listening(listener), Box::new(|| {})))
            }),
            SystemRequest::AnswerShellCommand {
                sent,
                refused,
                output,
            } => {
                self.shell_commands.answer(sent, refused, output);
                (self.tell)(HostMessage::SystemReply {
                    id,
                    reply: SystemReply::Set,
                });
                Handled::Done
            }
            SystemRequest::ClaimLinks { schemes } => self.starting(id, |system| {
                let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
                let listener = system.links.listen(
                    schemes,
                    Arc::new(move |(url, app_id): &(String, Option<String>)| {
                        let Some(running) = running.upgrade() else {
                            return;
                        };
                        // Under the lock, as for shell commands.
                        let running = running.lock().unwrap();
                        if matches!(running.get(&id), Some(Running::Listening(_))) {
                            tell(HostMessage::SystemEvent {
                                id,
                                event: SystemEvent::Link {
                                    url: url.clone(),
                                    app_id: app_id.clone(),
                                },
                            });
                        }
                    }),
                );
                Ok((Running::Listening(listener), Box::new(|| {})))
            }),
            SystemRequest::OpenLink { url, app_id } => {
                let reply = match self.links.open(&url, app_id.as_deref()) {
                    true => SystemReply::Sent { output: None },
                    false => failed(SystemError {
                        kind: SystemErrorKind::NotFound,
                        message: format!("no page of this desktop opens {url}"),
                    }),
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::UnlockRefusals => self.starting(id, |system| {
                let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
                let listener = system.unlock_refusals.listen(Arc::new(move |refused| {
                    let Some(running) = running.upgrade() else {
                        return;
                    };
                    // Under the lock, as for shell commands.
                    let running = running.lock().unwrap();
                    if matches!(running.get(&id), Some(Running::Listening(_))) {
                        tell(HostMessage::SystemEvent {
                            id,
                            event: refused.event(),
                        });
                    }
                }));
                Ok((Running::Listening(listener), Box::new(|| {})))
            }),
            SystemRequest::IdleAfter { seconds } => {
                self.idle_watch(id, seconds, Mark::After(Duration::from_secs(seconds)))
            }
            SystemRequest::IdleBeforeBlanking { seconds } => self.idle_watch(
                id,
                seconds,
                Mark::BeforeBlanking(Duration::from_secs(seconds)),
            ),
            SystemRequest::SendShell { command } => {
                let tell = self.tell.clone();
                let sent = self.shell_commands.send(
                    &command,
                    Box::new(move |outcome| {
                        let reply = match outcome {
                            Ok(output) => SystemReply::Sent { output },
                            Err(message) => failed(SystemError {
                                kind: SystemErrorKind::Other,
                                message,
                            }),
                        };
                        tell(HostMessage::SystemReply { id, reply });
                    }),
                );
                if !sent {
                    (self.tell)(HostMessage::SystemReply {
                        id,
                        reply: failed(SystemError {
                            kind: SystemErrorKind::Other,
                            message: "no page of this desktop listens for commands; a shell \
                                      hears them through bindKeys"
                                .into(),
                        }),
                    });
                }
                Handled::Done
            }
            SystemRequest::SetWindowStates { app_id, states } => {
                let reply = match &self.set_window_states {
                    Some(set) => match set(app_id, states) {
                        Ok(()) => SystemReply::Set,
                        Err(error) => failed(error),
                    },
                    None => failed(SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop sets no window states".into(),
                    }),
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::VirtualMonitor {
                name,
                width,
                height,
                refresh_mhz,
                scale,
            } => {
                let mut running = self.running.lock().unwrap();
                let reply = match (running.entry(id), &self.add_virtual_monitor) {
                    (Entry::Occupied(_), _) => failed(error_of(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("{id} is already running"),
                    ))),
                    (Entry::Vacant(_), _) if name.contains('\0') => failed(SystemError {
                        kind: SystemErrorKind::InvalidInput,
                        message: "a monitor's name holds a NUL".into(),
                    }),
                    (Entry::Vacant(_), None) => failed(SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop adds no virtual monitors".into(),
                    }),
                    (Entry::Vacant(vacant), Some(add)) => match add(VirtualMonitor {
                        name,
                        size: (width, height),
                        refresh_mhz,
                        scale,
                    }) {
                        Ok(added) => {
                            vacant.insert(Running::VirtualMonitor(added.lease));
                            SystemReply::VirtualMonitor {
                                output: added.output,
                            }
                        }
                        Err(error) => failed(error),
                    },
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::Agent { agent } => self.letting_in(id, agent),
            SystemRequest::Agents => {
                let reply = match &self.agents {
                    Some(agents) => SystemReply::Agents(agents.known()),
                    None => SystemReply::Agents(KnownAgents::default()),
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::StopAgent { session } => {
                let reply = match &self.agents {
                    Some(agents) => agents
                        .stop(session)
                        .map_or_else(failed, |()| SystemReply::Set),
                    None => failed(no_agents()),
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::ForgetAgent { agent } => {
                let reply = match &self.agents {
                    Some(agents) => agents
                        .forget(&agent)
                        .map_or_else(failed, |()| SystemReply::Set),
                    // Nothing is remembered where nothing is let in.
                    None => SystemReply::Set,
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::AgentDid { said } => match self.running.lock().unwrap().get(&id) {
                Some(Running::Agent(lease)) => {
                    lease.did(said);
                    Handled::Done
                }
                Some(_) => Handled::Malformed,
                None => Handled::NothingRunning,
            },
            SystemRequest::SetColorTemperature { kelvin, display } => {
                let reply = match (&self.set_white_point, (WARMEST..=NEUTRAL).contains(&kelvin)) {
                    (_, false) => failed(SystemError {
                        kind: SystemErrorKind::InvalidInput,
                        message: format!(
                            "a color temperature is {WARMEST} to {NEUTRAL} kelvin, not {kelvin}"
                        ),
                    }),
                    (None, true) => failed(SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop sets no color temperature".into(),
                    }),
                    (Some(set), true) => match set(display, white_point(kelvin)) {
                        Ok(()) => SystemReply::Set,
                        Err(error) => failed(error),
                    },
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::SleepDisplays { display } => {
                self.powering(id, DisplayPower::Asleep, display)
            }
            SystemRequest::WakeDisplays { display } => {
                self.powering(id, DisplayPower::Awake, display)
            }
            SystemRequest::Bells => self.starting(id, |system| {
                let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
                let listener = system.bells.listen(Arc::new(move |app_id| {
                    let Some(running) = running.upgrade() else {
                        return;
                    };
                    // Under the lock, as for shell commands.
                    let running = running.lock().unwrap();
                    if matches!(running.get(&id), Some(Running::Listening(_))) {
                        tell(HostMessage::SystemEvent {
                            id,
                            event: SystemEvent::Bell {
                                app_id: app_id.clone(),
                            },
                        });
                    }
                }));
                Ok((Running::Listening(listener), Box::new(|| {})))
            }),
            SystemRequest::WindowRequests => self.starting(id, |system| {
                let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
                let listener = system
                    .window_requests
                    .listen(Arc::new(move |(app_id, request)| {
                        let Some(running) = running.upgrade() else {
                            return;
                        };
                        // Under the lock, as for shell commands.
                        let running = running.lock().unwrap();
                        if matches!(running.get(&id), Some(Running::Listening(_))) {
                            tell(HostMessage::SystemEvent {
                                id,
                                event: SystemEvent::WindowRequest {
                                    app_id: app_id.clone(),
                                    request: request.clone(),
                                },
                            });
                        }
                    }));
                Ok((Running::Listening(listener), Box::new(|| {})))
            }),
            SystemRequest::Keymaps => self.starting(id, |system| {
                let hear = {
                    let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
                    move |listed: &crate::keymaps::Listed| {
                        let Some(running) = running.upgrade() else {
                            return;
                        };
                        // Under the lock, as for shell commands.
                        let running = running.lock().unwrap();
                        if matches!(running.get(&id), Some(Running::Listening(_))) {
                            tell(HostMessage::SystemEvent {
                                id,
                                event: listed.event(),
                            });
                        }
                    }
                };
                let listener = system.keymaps.listen(Arc::new(hear.clone()));
                // A page hears the keymaps at once, so it need not wait for a
                // switch.
                let keymaps = system.keymaps.clone();
                let already = move || {
                    if let Some(listed) = keymaps.listed() {
                        hear(&listed);
                    }
                };
                Ok((Running::Listening(listener), Box::new(already)))
            }),
            SystemRequest::IdleHolds => self.starting(id, |system| {
                let hear = {
                    let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
                    move |holders: &Vec<String>| {
                        let Some(running) = running.upgrade() else {
                            return;
                        };
                        // Under the lock, as for shell commands.
                        let running = running.lock().unwrap();
                        if matches!(running.get(&id), Some(Running::Listening(_))) {
                            tell(HostMessage::SystemEvent {
                                id,
                                event: idle_holds::event(holders),
                            });
                        }
                    }
                };
                let listener = system.idle_holds.listen(Arc::new(hear.clone()));
                // A page hears the holders at once, even none, so it need not
                // wait for a change.
                let holds = system.idle_holds.clone();
                let already = move || hear(&holds.holders());
                Ok((Running::Listening(listener), Box::new(already)))
            }),
            SystemRequest::SelectKeymap { keymap } => {
                let reply = match &self.select_keymap {
                    Some(select) => match select(keymap) {
                        Ok(()) => SystemReply::Set,
                        Err(error) => failed(error),
                    },
                    None => failed(SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop switches no keymaps".into(),
                    }),
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
            SystemRequest::ShortcutsInhibitor { action } => {
                let reply = match &self.shortcuts_inhibitor {
                    Some(switch) => match switch(action) {
                        Ok(()) => SystemReply::Set,
                        Err(error) => failed(error),
                    },
                    None => failed(SystemError {
                        kind: SystemErrorKind::Other,
                        message: "this desktop has no shortcuts inhibitors".into(),
                    }),
                };
                (self.tell)(HostMessage::SystemReply { id, reply });
                Handled::Done
            }
        }
    }

    /// Answer a one-shot call from its own thread, so a slow disk does not hold
    /// the connection.
    fn on_a_thread<E>(
        &self,
        id: u32,
        call: impl FnOnce(&Path) -> Result<SystemReply, E> + Send + 'static,
    ) -> Handled
    where
        Failure: From<E>,
    {
        let home = self.home.clone();
        let tell = self.tell.clone();
        thread::spawn(move || {
            tell(HostMessage::SystemReply {
                id,
                reply: call(&home).unwrap_or_else(|failure| failed(Failure::from(failure).into())),
            })
        });
        Handled::Done
    }

    /// Turn the monitor named `display`, or every one, `power`, and reply
    /// under `id`.
    fn powering(&self, id: u32, power: DisplayPower, display: Option<String>) -> Handled {
        let reply = match &self.power_displays {
            None => failed(SystemError {
                kind: SystemErrorKind::Other,
                message: "this desktop turns no monitors off".into(),
            }),
            Some(set) => match set(power, display) {
                Ok(()) => SystemReply::Set,
                Err(error) => failed(error),
            },
        };
        (self.tell)(HostMessage::SystemReply { id, reply });
        Handled::Done
    }

    /// Start a watch or process under `id`, unless one is already running
    /// there, and reply.
    ///
    /// `start` returns what to register and what to run once the reply is out.
    /// The lock is held from the start until the reply is sent, so a watch's
    /// first change, which takes the lock, cannot come before it.
    /// Starts the page's `id` watching for the desk to go idle at `mark`.
    /// See [`IdleWatches`].
    fn idle_watch(&self, id: u32, seconds: u64, mark: Mark) -> Handled {
        self.starting(id, |system| {
            if seconds == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "an idle watch needs at least 1 second",
                )
                .into());
            }
            let (tell, running) = (system.tell.clone(), Arc::downgrade(&system.running));
            let listener = system.idle_watches.watch(
                mark,
                Arc::new(move |idle| {
                    let Some(running) = running.upgrade() else {
                        return;
                    };
                    // Under the lock, so nothing is told before the reply or
                    // after `Unwatch` ends it.
                    let running = running.lock().unwrap();
                    if matches!(running.get(&id), Some(Running::Listening(_))) {
                        tell(HostMessage::SystemEvent {
                            id,
                            event: SystemEvent::Idle { idle },
                        });
                    }
                }),
            );
            // The desk may already have been still that long.
            let watches = system.idle_watches.clone();
            Ok((
                Running::Listening(listener),
                Box::new(move || watches.wake()),
            ))
        })
    }

    /// Ask the user to let agent `agent` in, on a thread, and hold it under
    /// `id` while it is in.
    fn letting_in(&self, id: u32, agent: String) -> Handled {
        let fail = |message: String, kind| {
            (self.tell)(HostMessage::SystemReply {
                id,
                reply: failed(SystemError { kind, message }),
            });
            Handled::Done
        };
        let Some(agents) = self.agents.clone() else {
            let error = no_agents();
            return fail(error.message, error.kind);
        };
        if self.running.lock().unwrap().contains_key(&id) {
            return fail(
                format!("{id} is already running"),
                SystemErrorKind::InvalidInput,
            );
        }
        let (tell, running) = (self.tell.clone(), Arc::downgrade(&self.running));
        thread::spawn(move || {
            // Set before the stop looks for the lease, so a stop that comes
            // before the lease is held still ends it.
            let stopped = Arc::new(AtomicBool::new(false));
            let stop: AgentStopped = {
                let (tell, running, stopped) = (tell.clone(), running.clone(), stopped.clone());
                Box::new(move || {
                    stopped.store(true, Ordering::SeqCst);
                    let Some(running) = running.upgrade() else {
                        return;
                    };
                    let mut running = running.lock().unwrap();
                    if let Some(Running::Agent(lease)) = running.remove(&id) {
                        tell(HostMessage::SystemEnd {
                            id,
                            end: SystemEnd::Stopped,
                        });
                        drop(running);
                        drop(lease);
                    }
                })
            };
            let changed: AgentChanged = {
                let (tell, running) = (tell.clone(), running.clone());
                Box::new(move |reach| {
                    let Some(running) = running.upgrade() else {
                        return;
                    };
                    // Held under the lock, so it comes after the reply.
                    let running = running.lock().unwrap();
                    if matches!(running.get(&id), Some(Running::Agent(_))) {
                        tell(HostMessage::SystemEvent {
                            id,
                            event: SystemEvent::AgentReach { reach },
                        });
                    }
                })
            };
            let let_in = match agents.let_in(
                agent,
                AgentTold {
                    stopped: stop,
                    changed,
                },
            ) {
                Ok(let_in) => let_in,
                Err(error) => {
                    tell(HostMessage::SystemReply {
                        id,
                        reply: failed(error),
                    });
                    return;
                }
            };
            // The page went away while the user decided; dropping the lease
            // takes the agent off the list.
            let Some(running) = running.upgrade() else {
                return;
            };
            let mut running = running.lock().unwrap();
            tell(HostMessage::SystemReply {
                id,
                reply: SystemReply::Agent {
                    reach: let_in.reach,
                },
            });
            if stopped.load(Ordering::SeqCst) {
                tell(HostMessage::SystemEnd {
                    id,
                    end: SystemEnd::Stopped,
                });
                drop(running);
                drop(let_in.lease);
            } else {
                running.insert(id, Running::Agent(let_in.lease));
            }
        });
        Handled::Done
    }

    fn starting(
        &self,
        id: u32,
        start: impl FnOnce(&System) -> Result<(Running, Box<dyn FnOnce()>), Failure>,
    ) -> Handled {
        let mut running = self.running.lock().unwrap();
        let (reply, then) = match running.entry(id) {
            Entry::Occupied(_) => (
                failed(error_of(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{id} is already running"),
                ))),
                None,
            ),
            Entry::Vacant(vacant) => match start(self) {
                Ok((started, then)) => {
                    vacant.insert(started);
                    (SystemReply::Started, Some(then))
                }
                Err(failure) => (failed(failure.into()), None),
            },
        };
        (self.tell)(HostMessage::SystemReply { id, reply });
        drop(running);
        if let Some(then) = then {
            then();
        }
        Handled::Done
    }

    fn watched(&self, id: u32, path: &str) -> io::Result<(Running, Box<dyn FnOnce()>)> {
        let tell = self.tell.clone();
        let running = Arc::downgrade(&self.running);
        let mut watcher = notify::RecommendedWatcher::new(
            move |heard: notify::Result<notify::Event>| {
                let Some(running) = running.upgrade() else {
                    return;
                };
                // Under the lock, so nothing is told after `Unwatch` ends it.
                let mut running = running.lock().unwrap();
                if !matches!(running.get(&id), Some(Running::Watch(_))) {
                    return;
                }
                match heard {
                    Ok(event) => event.paths.into_iter().for_each(|path| {
                        tell(HostMessage::SystemEvent {
                            id,
                            event: SystemEvent::Changed {
                                path: path.display().to_string(),
                            },
                        })
                    }),
                    Err(err) => {
                        // Dropped on another thread: this is the watcher's own
                        // thread, which dropping joins.
                        if let Some(watch) = running.remove(&id) {
                            thread::spawn(move || drop(watch));
                        }
                        tell(HostMessage::SystemEnd {
                            id,
                            end: SystemEnd::Failed {
                                error: SystemError {
                                    kind: SystemErrorKind::Other,
                                    message: err.to_string(),
                                },
                            },
                        });
                    }
                }
            },
            // Opens and closes are left out: a page that reads a file it
            // watches would hear its own reads.
            notify::Config::default().with_event_kinds(EventKindMask::CORE),
        )
        .map_err(io::Error::other)?;
        watcher
            .watch(&self.home.join(path), RecursiveMode::NonRecursive)
            .map_err(|err| match err.kind {
                notify::ErrorKind::PathNotFound => io::Error::from(io::ErrorKind::NotFound),
                notify::ErrorKind::Io(err) => err,
                _ => io::Error::other(err),
            })?;
        Ok((Running::Watch(watcher), Box::new(|| {})))
    }

    /// Register `child`, and return what starts its output and its waiter.
    fn spawned(&self, id: u32, mut child: Child) -> io::Result<(Running, Box<dyn FnOnce()>)> {
        let group = libc::pid_t::try_from(child.id()).expect("a pid fits a pid_t");
        let stdin = child.stdin.take().map(writer);
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let tell = self.tell.clone();
        let running = self.running.clone();
        let go = move || {
            let readers = [
                stdout.map(|out| reader(tell.clone(), id, Stream::Stdout, out)),
                stderr.map(|err| reader(tell.clone(), id, Stream::Stderr, err)),
            ];
            thread::spawn(move || {
                // All output goes out before the end.
                readers.into_iter().flatten().for_each(|reader| {
                    reader.join().expect("a reader does not panic");
                });
                // Wait without reaping, and stop `Kill` from reaching the
                // group before reaping it, so a signal never reaches a reused
                // pid.
                //
                // SAFETY: `siginfo_t` is plain data, `exited` is valid to
                // write to, and the pid is this process's own child.
                unsafe {
                    let mut exited: libc::siginfo_t = std::mem::zeroed();
                    libc::waitid(
                        libc::P_PID,
                        group as libc::id_t,
                        &mut exited,
                        libc::WEXITED | libc::WNOWAIT,
                    )
                };
                running.lock().unwrap().remove(&id);
                let end = match child.wait() {
                    Ok(status) => SystemEnd::Exited {
                        code: status.code(),
                        signal: status.signal(),
                    },
                    Err(err) => SystemEnd::Failed {
                        error: error_of(err),
                    },
                };
                tell(HostMessage::SystemEnd { id, end });
            });
        };
        Ok((Running::Process { group, stdin }, Box::new(go)))
    }
}

impl Drop for System {
    /// Kill every process and end every watch and match. Each process's waiter
    /// still reaps it.
    fn drop(&mut self) {
        // Taken out first, so the watches drop outside the lock; see `Unwatch`.
        let ended: Vec<Running> = self
            .running
            .lock()
            .unwrap()
            .drain()
            .map(|(_, running)| running)
            .collect();
        for running in ended {
            match running {
                Running::Process { group, .. } => {
                    // SAFETY: as in `handle`'s `Kill`.
                    unsafe { libc::kill(-group, libc::SIGKILL) };
                }
                Running::Watch(watcher) => drop(watcher),
                // The match's iterator holds the connection too, so it must be
                // closed rather than dropped. An error is a connection already
                // gone.
                Running::Match(connection) => {
                    let _ = connection.close();
                }
                Running::Listening(listener) => drop(listener),
                Running::VirtualMonitor(lease) => drop(lease),
                Running::Agent(lease) => drop(lease),
            }
        }
    }
}

/// A thread that writes what it is sent to `stdin`, so a process that is not
/// reading cannot block the connection.
fn writer(mut stdin: ChildStdin) -> Sender<Vec<u8>> {
    let (send, received) = channel::<Vec<u8>>();
    thread::spawn(move || {
        // Ends when the sender is dropped, which closes the pipe, or when the
        // process closes its end.
        for bytes in received {
            if stdin.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    send
}

/// A thread that sends what `from` produces as `stream` output of `id`.
fn reader(
    tell: Tell,
    id: u32,
    stream: Stream,
    mut from: impl Read + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = vec![0; CHUNK];
        // A read error ends the stream like an EOF; the exit status says what
        // happened to the process.
        while let Ok(read @ 1..) = from.read(&mut buffer) {
            tell(HostMessage::SystemEvent {
                id,
                event: SystemEvent::Output {
                    stream,
                    data: encoded(&buffer[..read]),
                },
            });
        }
    })
}

/// Up to `length` bytes of `path` from `offset`, or the rest of it.
fn read_range(path: &Path, offset: u64, length: Option<u64>) -> io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    match length {
        Some(length) => file.take(length).read_to_end(&mut bytes),
        None => file.read_to_end(&mut bytes),
    }?;
    Ok(bytes)
}

/// Write through a temporary file beside `path`, renamed over it.
fn written_atomically(path: &Path, bytes: &[u8], id: u32) -> io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    let mut temporary = name.to_owned();
    temporary.push(format!(".domicile-{}-{id}", std::process::id()));
    let temporary = path.with_file_name(temporary);
    std::fs::write(&temporary, bytes)
        .and_then(|()| std::fs::rename(&temporary, path))
        .inspect_err(|_| {
            // The write failed already; a leftover temporary is the lesser
            // problem, and the error reported is the write's.
            let _ = std::fs::remove_file(&temporary);
        })
}

fn file_type(of: std::fs::FileType) -> FileType {
    if of.is_symlink() {
        FileType::Symlink
    } else if of.is_dir() {
        FileType::Directory
    } else if of.is_file() {
        FileType::File
    } else {
        FileType::Other
    }
}

fn number(signal: Signal) -> libc::c_int {
    match signal {
        Signal::Hup => libc::SIGHUP,
        Signal::Int => libc::SIGINT,
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
        Signal::Usr1 => libc::SIGUSR1,
        Signal::Usr2 => libc::SIGUSR2,
    }
}

fn failed(error: SystemError) -> SystemReply {
    SystemReply::Failed { error }
}

/// Why a call failed, before it is told to the page.
enum Failure {
    Io(io::Error),
    Dbus(zbus::Error),
    Body(NotABody),
    /// Already told as the page will be.
    Said(SystemError),
}

impl From<SystemError> for Failure {
    fn from(err: SystemError) -> Failure {
        Failure::Said(err)
    }
}

impl From<io::Error> for Failure {
    fn from(err: io::Error) -> Failure {
        Failure::Io(err)
    }
}

impl From<zbus::Error> for Failure {
    fn from(err: zbus::Error) -> Failure {
        Failure::Dbus(err)
    }
}

impl From<zbus::zvariant::Error> for Failure {
    fn from(err: zbus::zvariant::Error) -> Failure {
        Failure::Dbus(err.into())
    }
}

impl From<NotABody> for Failure {
    fn from(err: NotABody) -> Failure {
        Failure::Body(err)
    }
}

impl From<Failure> for SystemError {
    fn from(failure: Failure) -> SystemError {
        match failure {
            Failure::Io(err) => error_of(err),
            Failure::Dbus(zbus::Error::MethodError(name, text, _)) => SystemError {
                kind: SystemErrorKind::Dbus,
                message: match text {
                    Some(text) => format!("{name}: {text}"),
                    None => name.to_string(),
                },
            },
            // A name that is not a bus, object or member name.
            Failure::Dbus(err @ (zbus::Error::Names(_) | zbus::Error::Variant(_))) => SystemError {
                kind: SystemErrorKind::InvalidInput,
                message: err.to_string(),
            },
            Failure::Dbus(err) => SystemError {
                kind: SystemErrorKind::Other,
                message: err.to_string(),
            },
            Failure::Body(err) => SystemError {
                kind: SystemErrorKind::InvalidInput,
                message: err.to_string(),
            },
            Failure::Said(err) => err,
        }
    }
}

/// The connection `bus`'s calls share, made on the first call.
fn shared(
    connect: &Connect,
    buses: &Mutex<HashMap<Bus, Connection>>,
    bus: Bus,
) -> zbus::Result<Connection> {
    let mut buses = buses.lock().unwrap();
    match buses.get(&bus) {
        Some(connection) => Ok(connection.clone()),
        None => {
            let connection = connect(bus)?;
            buses.insert(bus, connection.clone());
            Ok(connection)
        }
    }
}

/// A message's body as JSON text, and the signature it is read by.
///
/// A body of one structure has the same signature as a body of its fields, so
/// it is written as its fields.
fn body_of(message: &zbus::Message) -> zbus::Result<(String, String)> {
    let body = message.body();
    let signature = body.signature();
    let values = match signature {
        Signature::Unit => Vec::new(),
        _ => body.deserialize::<Structure>()?.into_fields(),
    };
    Ok((signature.to_string_no_parens(), dbus_json::written(&values)))
}

/// Tell each signal `signals` yields as an event of match `id`, until the
/// match is stopped or its connection breaks.
fn matched(id: u32, signals: MessageIterator, tell: &Tell, running: &Mutex<HashMap<u32, Running>>) {
    for signal in signals {
        let told = signal.map_err(Failure::from).and_then(|signal| {
            let header = signal.header();
            let (signature, body) = body_of(&signal)?;
            Ok(SystemEvent::Signal {
                sender: header
                    .sender()
                    .map(|name| name.to_string())
                    .unwrap_or_default(),
                path: header
                    .path()
                    .map(|path| path.to_string())
                    .unwrap_or_default(),
                interface: header
                    .interface()
                    .map(|name| name.to_string())
                    .unwrap_or_default(),
                member: header
                    .member()
                    .map(|name| name.to_string())
                    .unwrap_or_default(),
                signature,
                body,
            })
        });
        // Under the lock, so nothing is told after `Unwatch` ends it.
        let mut running = running.lock().unwrap();
        if !matches!(running.get(&id), Some(Running::Match(_))) {
            return;
        }
        match told {
            Ok(event) => tell(HostMessage::SystemEvent { id, event }),
            Err(failure) => {
                running.remove(&id);
                tell(HostMessage::SystemEnd {
                    id,
                    end: SystemEnd::Failed {
                        error: failure.into(),
                    },
                });
                return;
            }
        }
    }
    // The connection closed without `Unwatch`.
    if running.lock().unwrap().remove(&id).is_some() {
        tell(HostMessage::SystemEnd {
            id,
            end: SystemEnd::Failed {
                error: SystemError {
                    kind: SystemErrorKind::Other,
                    message: "the bus connection closed".into(),
                },
            },
        });
    }
}

fn error_of(err: io::Error) -> SystemError {
    let kind = match err.kind() {
        io::ErrorKind::NotFound => SystemErrorKind::NotFound,
        io::ErrorKind::PermissionDenied => SystemErrorKind::PermissionDenied,
        io::ErrorKind::AlreadyExists => SystemErrorKind::AlreadyExists,
        io::ErrorKind::NotADirectory => SystemErrorKind::NotADirectory,
        io::ErrorKind::IsADirectory => SystemErrorKind::IsADirectory,
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => SystemErrorKind::InvalidInput,
        _ => SystemErrorKind::Other,
    };
    SystemError {
        kind,
        message: err.to_string(),
    }
}
