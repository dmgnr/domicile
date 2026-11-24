//! The protocol between `domicile <command>` and a running desktop.
//!
//! One JSON request line in, one response line out, per connection. This uses
//! the same newline-delimited JSON framing as the host protocol. The one
//! exceptions are [`Request::VirtualMonitor`], [`Request::Subscribe`] and
//! [`Request::Agent`], whose connections are held: see
//! [`crate::monitor_lending`], [`crate::subscription`] and
//! [`crate::agent_lending`].
//!
//! Lines come from a socket, so [`answer`] parses them strictly and refuses
//! anything else.

use std::path::{Path, PathBuf};

use domicile_host::system::DisplayPower;
use domicile_protocol::{
    AgentReach, DeskRect, DeskShot, DesktopStatus, DisplayChange, EmulatedInput, HostMessage,
    KnownAgents, ListedDisplay, ListedInput, ListedWindow, LogLevel, LogLevels, MonitorInfo, Scale,
    ShellBinding, ShellCommandHelp, Subsystem, Theme, WatchTopic, WindowAct, WindowKind,
};
use serde::{Deserialize, Serialize};

use crate::browser_profiles::BrowserProfileList;
use crate::extensions::{ExtensionSettings, InstalledExtension};
use crate::history::{BrowsingData, HistoryItem, HistoryQuery};
use crate::log_export::{report, Report};
use crate::log_levels::changed;
use crate::media_devices::{MediaDevices, MediaKind};
use crate::paint::Paint;
use crate::recent_log::{local_offset, Said};
use crate::shell_path::{Shell, ShellFiles};
use crate::site_data::SiteData;
use crate::site_permissions::{SitePermission, SiteSettings};

/// The file a built shell's declared options are written to, beside its
/// module. See `docs/WRITING-A-SHELL.md#options`.
pub const OPTIONS: &str = "options.json";

/// A request to a running desktop.
///
/// Each variant needs a matching CLI verb in [`crate::cli`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Report the shell this desktop is running.
    WhichShell,
    /// Serve this shell instead.
    ///
    /// The client resolves the paths (see [`crate::shell_path::Shell`])
    /// because the desktop does not share its working directory. With
    /// `dev_server`, `root` is `domicile dev`'s socket.
    LoadShell {
        root: PathBuf,
        module: PathBuf,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        dev_server: bool,
    },
    /// Open this URL in a browser window: in browser profile `profile`, or
    /// with none in the one its site opens in. The client converts paths
    /// with [`crate::address`].
    OpenUrl {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
    },
    /// Open this URL in an app window: a browser window the shell draws
    /// without an address bar. See `docs/architecture/WEB-APPS.md`.
    ///
    /// With an `id`, `reuse` says what to do when an app window with that id
    /// is open.
    OpenApp {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default)]
        reuse: AppReuse,
        /// The browser profile a new window opens in, or with none the one
        /// its site opens in.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
    },
    /// Run the app module `module` under `root` in an app window. The client
    /// resolves both ([`crate::app_entry`]). See
    /// `docs/architecture/APP-MODULES.md`.
    RunApp { root: PathBuf, module: PathBuf },
    /// Start `command` as the compositor starts an app from the launcher,
    /// with the desktop's environment, in its own scope. `domicile open`
    /// asks this for the handler it picks, so a link the engine opens starts
    /// its app as one the user started.
    Launch { command: Vec<String> },
    /// Hand `url` to the shell page that claims its scheme, such as
    /// `mailto`. Answered [`Response::Opened`], or [`Response::Unclaimed`]
    /// when no page claims it. `domicile open` asks this before it picks
    /// an application. See `SystemRequest::OpenLink`.
    OpenLink { url: String },
    /// Write a PNG of the whole desk to this absolute path, or, with no
    /// `file`, take the shell's interactive screenshot.
    ///
    /// The client makes the path absolute, as for `LoadShell`. See
    /// `SystemRequest::Screenshot` for where the interactive one is saved.
    Screenshot { file: Option<PathBuf> },
    /// Record the screen: the shell's picker, then until the user stops the
    /// recording. See `SystemRequest::ScreenRecord`.
    ScreenRecord,
    /// Send this command to the shell, as a `send-shell` keybinding would.
    SendShell { command: Vec<String> },
    /// Report the files the Settings app edits. Asked by
    /// `domicile-app-host`, which reads and writes them itself.
    SettingsFiles,
    /// Report every permission's default and every site's own setting. The
    /// engine keeps them.
    SitePermissions,
    /// Store one site's setting in the engine.
    SetSitePermission { site: SitePermission },
    /// Load the unpacked extension in this absolute directory into the
    /// engine's profile. It stays until uninstalled.
    LoadUnpacked { directory: PathBuf },
    /// Uninstall an extension the config did not install.
    UninstallExtension { id: String },
    /// Report the ids of the extensions the config installed, which only the
    /// config uninstalls.
    ConfigExtensions,
    /// Report the engine's cameras and microphones, most preferred first.
    MediaDevices,
    /// Give this device to sites that ask for a `kind` without naming one.
    SetMediaDevice { kind: MediaKind, id: String },
    /// Report every extension installed in the engine's profile.
    Extensions,
    /// Enable or disable an extension, in browser profile `profile` or the
    /// shell's own.
    SetExtensionEnabled {
        id: String,
        enabled: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
    },
    /// Report the desk's browser profiles and the sites that open outside the
    /// default one.
    BrowserProfiles,
    /// Open `site` in browser profile `profile` from now on. The default
    /// profile unpins it.
    PinBrowserSite { site: String, profile: String },
    /// Change each of `settings` that is set on an extension.
    ConfigureExtension {
        id: String,
        settings: ExtensionSettings,
    },
    /// Search the engine's history.
    History(HistoryQuery),
    /// Report when a page was visited.
    Visits { url: String },
    /// Delete the visits made at these times.
    DeleteHistory { visits: Vec<f64> },
    /// Clear the engine's browsing data.
    ClearBrowsingData(BrowsingData),
    /// Report every host that stores data in the engine's profile.
    SiteData,
    /// Clear everything one host stores.
    ClearSiteData { host: String },
    /// Turn the touchpads' disable-while-typing on, off or over, or with no
    /// `to`, report it. See `docs/RUNNING-A-DESKTOP.md#disable-while-typing`.
    DisableWhileTyping {
        #[serde(default)]
        to: Option<Switch>,
    },
    /// Set the desktop's light or dark theme, or with no `to`, report it. The
    /// compositor owns the theme, so this works with any shell.
    Theme {
        #[serde(default)]
        to: Option<ThemeChange>,
    },
    /// Report each lit monitor under the names a display profile can call it
    /// by. Asked by `domicile-app-host`, so Settings offers HDR only where a
    /// monitor takes it.
    Monitors,
    /// Report every display: its names, mode, layout and whether it is lit.
    /// The compositor owns the displays, so this works with any shell.
    Displays,
    /// Report every window, native and browser.
    Windows,
    /// Report the shell, the theme, the lock, the keymap, whether the screens
    /// are off, and what holds them on or captures the desktop.
    Status,
    /// Report the commands the shell runs for [`Request::SendShell`], as its
    /// pages described them.
    ShellCommands,
    /// Report the keys and gestures the shell binds, in each binding mode.
    ShellBindings,
    /// Report the keyboards, pointers and touch devices the engine reads.
    Inputs,
    /// Report how long nobody has used the desktop, in whole seconds. Asked
    /// by Electron apps' `powerMonitor.getSystemIdleTime`.
    IdleTime,
    /// Report the agents let in now and those remembered. Asked by
    /// `domicile-app-host` for Settings › Agents.
    Agents,
    /// End agent session `session`, as the bar's Stop does.
    StopAgent { session: u32 },
    /// Make the remembered agent `agent` ask again next time.
    ForgetAgent { agent: String },
    /// Turn every monitor off until input or [`Request::WakeDisplays`], or
    /// only `display`, by any name a profile matches it by, until it is woken. The
    /// compositor owns the monitors, so this works with any shell. See
    /// `docs/IDLE.md#sleeping-on-demand`.
    SleepDisplays {
        #[serde(default)]
        display: Option<String>,
    },
    /// Light the monitors again, after [`Request::SleepDisplays`] or idle
    /// blanking, or only `display`.
    WakeDisplays {
        #[serde(default)]
        display: Option<String>,
    },
    /// Add a virtual monitor for as long as the connection is open. Answered
    /// with [`Response::VirtualMonitor`]; each later line is a
    /// [`Request::ResizeVirtualMonitor`]. See `domicile monitor`.
    VirtualMonitor {
        name: String,
        width: u32,
        height: u32,
        refresh_mhz: u32,
        #[serde(default)]
        scale: Scale,
    },
    /// Lock the desktop. The compositor owns the lock, so this works with
    /// any shell that draws a lock screen.
    Lock,
    /// Focus, close or kill the native window `id`, as `domicile
    /// list-windows` prints it.
    ActOnWindow { id: String, act: WindowAct },
    /// Write a PNG of the desk, or of its `area`, to `file`, its longer
    /// side at most `fit` pixels. See `domicile screenshot --fit`.
    ShootDesk {
        file: PathBuf,
        fit: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        area: Option<DeskRect>,
    },
    /// Send `input` to the desk. See `domicile pointer`, `key` and `type`.
    Emulate { input: Vec<EmulatedInput> },
    /// Send DevTools Protocol `method` with `params` to browser window
    /// `window`, as `domicile list-windows` prints it, or to its view
    /// `view`. See `domicile devtools`.
    #[serde(rename = "devtools")]
    DevTools {
        window: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        view: Option<String>,
        method: String,
        params: serde_json::Value,
    },
    /// Change how the monitor `display` is set up until the desktop
    /// restarts. See `domicile configure-display`.
    ConfigureDisplay {
        display: String,
        change: DisplayChange,
    },
    /// Log at `level`, for `subsystems` or, with none, for everything, until
    /// the desktop restarts. Answered with [`Response::LogLevels`]. See
    /// `domicile set-log-level`.
    SetLogLevel {
        level: LogLevel,
        #[serde(default)]
        subsystems: Vec<Subsystem>,
    },
    /// Go back to the levels the desktop started at. Answered with
    /// [`Response::LogLevels`].
    ResetLogLevels,
    /// The levels set since the desktop started.
    LogLevels,
    /// The lines the desktop kept, when they did not go to the journal.
    /// Answered with [`Response::RecentLogs`]. See `domicile logs`.
    RecentLogs,
    /// Write the desktop's logs, and what it is running on, to `file`, with
    /// URLs and window titles hidden if `redact`. Answered with
    /// [`Response::ExportedLogs`]. See `domicile export-logs`.
    ExportLogs { file: PathBuf, redact: bool },
    /// Hear about `topics` for as long as the connection is open: each
    /// topic's answer at once, then again whenever it changes, each as a
    /// [`Response::Heard`]. See `domicile subscribe`.
    Subscribe { topics: Vec<WatchTopic> },
    /// Let agent `agent` see and use the desk for as long as the connection
    /// is open, as the user allows in the shell's dialog. Answered with
    /// [`Response::Agent`]; each later line is a [`Request::AgentDid`]. The
    /// desktop hangs up when the shell stops it. See `domicile agent`.
    Agent { agent: String },
    /// Note what the agent this connection holds did, for the shell to list.
    /// Not answered.
    AgentDid { said: String },
    /// Resize the monitor this connection holds. Not answered.
    ResizeVirtualMonitor {
        width: u32,
        height: u32,
        refresh_mhz: u32,
        #[serde(default)]
        scale: Scale,
    },
}

/// What [`Request::OpenApp`] does when an app window with its id is open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppReuse {
    /// Open another window.
    #[default]
    New,
    /// Bring the open one to the front.
    Focus,
    /// Load the address in the open one and bring it to the front.
    Navigate,
}

/// How [`Request::DisableWhileTyping`] changes the setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Switch {
    On,
    Off,
    Toggle,
}

/// How [`Request::Theme`] changes the theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeChange {
    Light,
    Dark,
    Toggle,
}

/// The files the Settings app edits, as the desktop found them at startup.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsFiles {
    /// The config file, or none when the desktop runs the defaults.
    pub config: Option<PathBuf>,
    /// The JSON a module config evaluated to, which the compositor reads.
    pub evaluated: Option<PathBuf>,
    /// The shell's source file: an entry the desktop builds, or a module it
    /// serves as is. None for a package, which has no file to edit.
    pub shell: Option<PathBuf>,
    /// Where the served shell's declared options are: `options.json` beside
    /// its module. The file is missing for a shell that declares none.
    pub options: Option<PathBuf>,
}

/// A desktop's response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    /// The absolute path of the module the desktop is serving, the directory
    /// it is served from, and whether that is `domicile dev`'s socket instead.
    ///
    /// Answers both `which-shell` and a successful `load-shell`. `domicile
    /// dev` loads the shell it replaced again from `root` and `dev_server`.
    Shell {
        module: PathBuf,
        root: PathBuf,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        dev_server: bool,
    },

    /// The engine passed the address to the shell.
    ///
    /// The shell decides whether and where to open it, and does not report
    /// back.
    Opened,

    /// The compositor wrote the screenshot or the recording to this file.
    Captured { file: PathBuf },

    /// Answers `shoot_desk`: what the PNG shows.
    DeskShot { shot: DeskShot },

    /// Answers `devtools`: the method's result.
    #[serde(rename = "devtools")]
    DevTools { result: serde_json::Value },

    /// The user dismissed the shell's screenshot or recording dialog, or
    /// discarded the recording.
    Canceled,

    /// The user copied the screenshot to the clipboard from the shell's
    /// dialog, so no file was saved.
    Copied,

    /// No page of the shell claims the link's scheme.
    Unclaimed,

    /// A page of the shell ran the command, and printed `output` if it said
    /// anything, such as a query's JSON.
    Sent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },

    /// Answers `settings_files`.
    SettingsFiles { files: SettingsFiles },

    /// Answers `site_permissions`.
    SitePermissions(SiteSettings),

    /// The engine stored the site's setting, the preferred media device or
    /// whether the extension is enabled.
    Stored,

    /// The engine loaded the unpacked extension, which has this id.
    LoadedUnpacked { id: String },

    /// The engine uninstalled the extension.
    Uninstalled,

    /// Answers `config_extensions`.
    ConfigExtensions { ids: Vec<String> },

    /// Answers `media_devices`.
    MediaDevices(MediaDevices),

    /// Answers `extensions`.
    Extensions { extensions: Vec<InstalledExtension> },

    /// Answers `browser_profiles`.
    BrowserProfiles(BrowserProfileList),

    /// Answers `history`.
    History { items: Vec<HistoryItem> },

    /// Answers `visits`.
    Visits { times: Vec<f64> },

    /// The engine deleted the visits.
    Deleted,

    /// The engine cleared the browsing data or the host's site data.
    Cleared,

    /// Answers `site_data`.
    SiteData { sites: Vec<SiteData> },

    /// Whether the touchpads rest while a keyboard types, after the request.
    DisableWhileTyping { enabled: bool },

    /// The desktop's theme, after the request.
    Theme { theme: Theme },
    /// The levels set since the desktop started.
    LogLevels { levels: LogLevels },
    /// Answers `recent_logs`: on the journal, nothing, since `journalctl`
    /// reads them; else the lines kept, oldest first.
    RecentLogs { journal: bool, lines: Vec<String> },
    /// The logs were written to `file`. `unhidden` says what redaction could
    /// not hide, and why.
    ExportedLogs {
        file: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unhidden: Option<String>,
    },

    /// Answers `monitors`.
    Monitors { monitors: Vec<MonitorInfo> },

    /// Answers `displays`.
    Displays { displays: Vec<ListedDisplay> },

    /// Answers `windows`.
    Windows { windows: Vec<ListedWindow> },

    /// Answers `status`: the module being served, and what the compositor
    /// said.
    Status {
        shell: PathBuf,
        status: DesktopStatus,
    },

    /// Answers `shell_commands`.
    ShellCommands { commands: Vec<ShellCommandHelp> },

    /// Answers `shell_bindings`.
    ShellBindings { bindings: Vec<ShellBinding> },

    /// Answers `inputs`.
    Inputs { inputs: Vec<ListedInput> },

    /// Answers `idle_time`.
    IdleTime { seconds: u64 },

    /// Answers `agents`.
    Agents { agents: KnownAgents },

    /// The compositor turned the monitors off or on.
    Powered,

    /// The compositor did what was asked: locked the desktop, acted on a
    /// window, or stopped or forgot an agent.
    Done,

    /// What a [`Request::Subscribe`] heard: the compositor's answer for one
    /// of its topics, such as a `window_list`.
    Heard { message: HostMessage },

    /// The compositor added the virtual monitor, on this output.
    VirtualMonitor { output: String },

    /// The user let the agent reach this.
    Agent { reach: AgentReach },

    /// The request was unknown or could not be carried out.
    ///
    /// The protocol has no version number. A client from a different build
    /// gets this refusal, naming the request. For engine failures, `why` is the
    /// engine's message, shown in the user's terminal.
    Refused { why: String },
}

/// Encodes a message as one newline-terminated JSON line.
pub fn to_line<T: Serialize>(message: &T) -> String {
    let mut line = serde_json::to_string(message).expect("control messages always serialize");
    line.push('\n');
    line
}

/// Parses one response line, without its trailing newline.
pub fn parse_response(line: &str) -> Result<Response, serde_json::Error> {
    serde_json::from_str(line)
}

/// Tells the engine to serve a shell.
///
/// [`crate::command_socket::load_shell`] in a desktop; a closure in tests.
pub type LoadShell<'a> = &'a dyn Fn(&Shell) -> Result<(), String>;

/// Tells the engine to open an address in the shell, in a browser profile or
/// with none in the one its site opens in.
///
/// [`crate::command_socket::open_url`] in a desktop; a closure in tests.
pub type OpenUrl<'a> = &'a dyn Fn(&str, Option<&str>) -> Result<(), String>;

/// Tells the engine to open an address in an app window with an id, or to
/// reuse the open one as [`AppReuse`] says, a new one in a browser profile or
/// with none in the one its site opens in.
///
/// [`crate::command_socket::open_app`] in a desktop; a closure in tests.
pub type OpenApp<'a> = &'a dyn Fn(&str, Option<&str>, AppReuse, Option<&str>) -> Result<(), String>;

/// Tells the engine to run an app module.
///
/// [`crate::command_socket::run_app`] in a desktop; a closure in tests.
pub type RunApp<'a> = &'a dyn Fn(&Path, &Path) -> Result<(), String>;

/// Tells the compositor to start a program as an app.
///
/// [`crate::compositor_socket::launch`] in a desktop; a closure in tests.
pub type Launch<'a> = &'a dyn Fn(&[String]) -> Result<(), String>;

/// Hands a link to the shell page that claims its scheme: true when one took
/// it, false when none claims it.
///
/// [`crate::compositor_socket::open_link`] in a desktop; a closure in tests.
pub type OpenLink<'a> = &'a dyn Fn(&str) -> Result<bool, String>;

/// Tells the compositor to take a screenshot, into the file if one is given.
///
/// [`crate::compositor_socket::screenshot`] in a desktop; a closure in tests.
pub type Screenshot<'a> = &'a dyn Fn(Option<&Path>) -> Result<Shot, String>;

/// Tells the compositor to record the screen, and waits for the file, or
/// `None` when the user dismissed the picker or discarded the recording.
///
/// [`crate::compositor_socket::screen_record`] in a desktop; a closure in
/// tests.
pub type ScreenRecord<'a> = &'a dyn Fn() -> Result<Option<PathBuf>, String>;

/// Tells the compositor to send the shell a command.
///
/// [`crate::compositor_socket::send_shell`] in a desktop; a closure in tests.
pub type SendShell<'a> = &'a dyn Fn(&[String]) -> Result<Option<String>, String>;

/// Asks the engine for every permission's default and every site's own
/// setting.
///
/// [`crate::command_socket::site_permissions`] in a desktop; a closure in
/// tests.
pub type SitePermissions<'a> = &'a dyn Fn() -> Result<SiteSettings, String>;

/// Tells the engine to store a site's setting.
///
/// [`crate::command_socket::set_site_permission`] in a desktop; a closure in
/// tests.
pub type SetSitePermission<'a> = &'a dyn Fn(&SitePermission) -> Result<(), String>;

/// Tells the engine to load an unpacked extension, returning its id.
///
/// [`crate::command_socket::load_unpacked`] in a desktop; a closure in tests.
pub type LoadUnpacked<'a> = &'a dyn Fn(&Path) -> Result<String, String>;

/// Tells the engine to uninstall an extension.
///
/// [`crate::command_socket::uninstall_extension`] in a desktop; a closure in
/// tests.
pub type UninstallExtension<'a> = &'a dyn Fn(&str) -> Result<(), String>;

/// Asks the engine for the ids of the extensions the config installed.
///
/// [`crate::command_socket::config_extensions`] in a desktop; a closure in
/// tests.
pub type ConfigExtensions<'a> = &'a dyn Fn() -> Result<Vec<String>, String>;

/// Asks the engine for its cameras and microphones.
///
/// [`crate::command_socket::media_devices`] in a desktop; a closure in tests.
pub type ListMediaDevices<'a> = &'a dyn Fn() -> Result<MediaDevices, String>;

/// Tells the engine which device sites get when they name none.
///
/// [`crate::command_socket::set_media_device`] in a desktop; a closure in
/// tests.
pub type SetMediaDevice<'a> = &'a dyn Fn(MediaKind, &str) -> Result<(), String>;

/// Asks the engine for every extension installed in its profile.
///
/// [`crate::command_socket::extensions`] in a desktop; a closure in tests.
pub type ListExtensions<'a> = &'a dyn Fn() -> Result<Vec<InstalledExtension>, String>;

/// Tells the engine to enable or disable an extension.
///
/// [`crate::command_socket::set_extension_enabled`] in a desktop; a closure in
/// tests.
pub type SetExtensionEnabled<'a> = &'a dyn Fn(&str, bool, Option<&str>) -> Result<(), String>;

/// Asks the engine for the desk's browser profiles.
///
/// [`crate::command_socket::browser_profiles`] in a desktop; a closure in
/// tests.
pub type ListBrowserProfiles<'a> = &'a dyn Fn() -> Result<BrowserProfileList, String>;

/// Tells the engine to open a site in a browser profile from now on.
///
/// [`crate::command_socket::pin_browser_site`] in a desktop; a closure in
/// tests.
pub type PinBrowserSite<'a> = &'a dyn Fn(&str, &str) -> Result<(), String>;

/// Tells the engine to change an extension's settings.
///
/// [`crate::command_socket::configure_extension`] in a desktop; a closure in
/// tests.
pub type ConfigureExtension<'a> = &'a dyn Fn(&str, &ExtensionSettings) -> Result<(), String>;

/// Asks the engine for the history rows a search finds.
///
/// [`crate::command_socket::history`] in a desktop; a closure in tests.
pub type SearchHistory<'a> = &'a dyn Fn(&HistoryQuery) -> Result<Vec<HistoryItem>, String>;

/// Asks the engine when a page was visited.
///
/// [`crate::command_socket::visits`] in a desktop; a closure in tests.
pub type ListVisits<'a> = &'a dyn Fn(&str) -> Result<Vec<f64>, String>;

/// Tells the engine to delete visits.
///
/// [`crate::command_socket::delete_history`] in a desktop; a closure in tests.
pub type DeleteHistory<'a> = &'a dyn Fn(&[f64]) -> Result<(), String>;

/// Tells the engine to clear browsing data.
///
/// [`crate::command_socket::clear_browsing_data`] in a desktop; a closure in
/// tests.
pub type ClearBrowsingData<'a> = &'a dyn Fn(&BrowsingData) -> Result<(), String>;

/// Asks the engine for every host that stores data.
///
/// [`crate::command_socket::site_data`] in a desktop; a closure in tests.
pub type ListSiteData<'a> = &'a dyn Fn() -> Result<Vec<SiteData>, String>;

/// Tells the engine to clear everything a host stores.
///
/// [`crate::command_socket::clear_site_data`] in a desktop; a closure in tests.
pub type ClearSiteData<'a> = &'a dyn Fn(&str) -> Result<(), String>;

/// Tells the engine whether the touchpads rest while a keyboard types, or with
/// none only asks, and returns whether they do.
///
/// [`crate::command_socket::disable_while_typing`] in a desktop; a closure in
/// tests.
pub type DisableWhileTyping<'a> = &'a dyn Fn(Option<bool>) -> Result<bool, String>;

/// Tells the compositor the theme, or with none only asks, and returns the
/// theme.
///
/// [`crate::compositor_socket::theme`] in a desktop; a closure in tests.
pub type Theming<'a> = &'a dyn Fn(Option<Theme>) -> Result<Theme, String>;

/// Tells the compositor to turn the monitors off or on.
///
/// [`crate::compositor_socket::power_displays`] in a desktop; a closure in
/// tests.
pub type PowerDisplays<'a> = &'a dyn Fn(DisplayPower, Option<&str>) -> Result<(), String>;

/// Asks the compositor to lock the desktop.
///
/// [`crate::compositor_socket::lock`] in a desktop; a closure in tests.
pub type Locking<'a> = &'a dyn Fn() -> Result<(), String>;

/// Asks the compositor to focus, close or kill a native window, by its
/// `ext-foreign-toplevel-list-v1` identifier.
///
/// [`crate::compositor_socket::act_on_window`] in a desktop; a closure in
/// tests.
pub type ActingOnWindows<'a> = &'a dyn Fn(&str, WindowAct) -> Result<(), String>;

/// Asks the compositor for a PNG of the desk, or an area of it, shrunk to
/// fit.
///
/// [`crate::compositor_socket::shoot_desk`] in a desktop; a closure in tests.
pub type ShootingTheDesk<'a> = &'a dyn Fn(&Path, u32, Option<DeskRect>) -> Result<DeskShot, String>;

/// Asks the compositor to send input to the desk.
///
/// [`crate::compositor_socket::emulate`] in a desktop; a closure in tests.
pub type Emulating<'a> = &'a dyn Fn(&[EmulatedInput]) -> Result<(), String>;

/// Sends a DevTools Protocol method to a browser window, by its id in the
/// engine, and returns its result.
///
/// [`crate::command_socket::devtools`] in a desktop; a closure in tests.
pub type SendDevTools<'a> =
    &'a dyn Fn(&str, &str, &serde_json::Value) -> Result<serde_json::Value, String>;

/// Asks the compositor to change how a monitor is set up.
///
/// [`crate::compositor_socket::configure_display`] in a desktop; a closure in
/// tests.
pub type ConfiguringDisplays<'a> = &'a dyn Fn(&str, &DisplayChange) -> Result<(), String>;

/// The log levels set since the desktop started.
pub type ReadingLogLevels<'a> = &'a dyn Fn() -> LogLevels;

/// Sets the desktop's log levels, replacing those set before.
pub type SettingLogLevels<'a> = &'a dyn Fn(&LogLevels) -> Result<(), String>;

/// The desktop's lines this boot, oldest first: from the journal, or those
/// [`crate::recent_log`] kept.
pub type ReadingLogs<'a> = &'a dyn Fn() -> Result<Vec<Said>, String>;

/// Asks the compositor for the lit monitors.
///
/// [`crate::compositor_socket::monitors`] in a desktop; a closure in tests.
pub type ListMonitors<'a> = &'a dyn Fn() -> Result<Vec<MonitorInfo>, String>;

/// Asks the compositor for every display.
///
/// [`crate::compositor_socket::displays`] in a desktop; a closure in tests.
pub type ListDisplays<'a> = &'a dyn Fn() -> Result<Vec<ListedDisplay>, String>;

/// Asks the compositor for every window.
///
/// [`crate::compositor_socket::windows`] in a desktop; a closure in tests.
pub type ListWindows<'a> = &'a dyn Fn() -> Result<Vec<ListedWindow>, String>;

/// Asks the compositor how the desktop is.
///
/// [`crate::compositor_socket::status`] in a desktop; a closure in tests.
pub type AskStatus<'a> = &'a dyn Fn() -> Result<DesktopStatus, String>;

/// Asks the compositor which commands the shell runs.
///
/// [`crate::compositor_socket::shell_commands`] in a desktop; a closure in
/// tests.
pub type ListShellCommands<'a> = &'a dyn Fn() -> Result<Vec<ShellCommandHelp>, String>;

/// Asks the compositor which keys and gestures the shell binds.
///
/// [`crate::compositor_socket::shell_bindings`] in a desktop; a closure in
/// tests.
pub type ListShellBindings<'a> = &'a dyn Fn() -> Result<Vec<ShellBinding>, String>;

/// Asks the compositor which input devices the engine reads.
///
/// [`crate::compositor_socket::inputs`] in a desktop; a closure in tests.
pub type ListInputs<'a> = &'a dyn Fn() -> Result<Vec<ListedInput>, String>;

/// Asks the compositor how many whole seconds nobody has used the desktop.
///
/// [`crate::compositor_socket::idle_time`] in a desktop; a closure in tests.
pub type AskIdleTime<'a> = &'a dyn Fn() -> Result<u64, String>;

/// Asks the compositor for the agents it knows.
///
/// [`crate::compositor_socket::agents`] in a desktop; a closure in tests.
pub type ListAgents<'a> = &'a dyn Fn() -> Result<KnownAgents, String>;

/// Asks the compositor to end an agent's session.
///
/// [`crate::compositor_socket::stop_agent`] in a desktop; a closure in tests.
pub type StoppingAgents<'a> = &'a dyn Fn(u32) -> Result<(), String>;

/// Asks the compositor to forget a remembered agent.
///
/// [`crate::compositor_socket::forget_agent`] in a desktop; a closure in
/// tests.
pub type ForgettingAgents<'a> = &'a dyn Fn(&str) -> Result<(), String>;

/// What a request can learn about or do to the running desktop.
///
/// The dials reach the engine and the compositor; they are injected so
/// [`answer`] can be tested without sockets.
pub struct Desktop<'a> {
    /// The shell being served.
    pub shell: &'a Shell,
    pub files: &'a SettingsFiles,
    pub load: LoadShell<'a>,
    pub open: OpenUrl<'a>,
    pub open_app: OpenApp<'a>,
    pub run_app: RunApp<'a>,
    pub launch: Launch<'a>,
    pub open_link: OpenLink<'a>,
    pub capture: Screenshot<'a>,
    pub record: ScreenRecord<'a>,
    pub send: SendShell<'a>,
    pub permissions: SitePermissions<'a>,
    pub set_permission: SetSitePermission<'a>,
    pub load_unpacked: LoadUnpacked<'a>,
    pub uninstall_extension: UninstallExtension<'a>,
    pub config_extensions: ConfigExtensions<'a>,
    pub media_devices: ListMediaDevices<'a>,
    pub set_media_device: SetMediaDevice<'a>,
    pub extensions: ListExtensions<'a>,
    pub set_extension_enabled: SetExtensionEnabled<'a>,
    pub configure_extension: ConfigureExtension<'a>,
    pub browser_profiles: ListBrowserProfiles<'a>,
    pub pin_browser_site: PinBrowserSite<'a>,
    pub history: SearchHistory<'a>,
    pub visits: ListVisits<'a>,
    pub delete_history: DeleteHistory<'a>,
    pub clear_browsing_data: ClearBrowsingData<'a>,
    pub site_data: ListSiteData<'a>,
    pub clear_site_data: ClearSiteData<'a>,
    pub disable_while_typing: DisableWhileTyping<'a>,
    pub theme: Theming<'a>,
    pub power_displays: PowerDisplays<'a>,
    pub lock: Locking<'a>,
    pub act_on_window: ActingOnWindows<'a>,
    pub shoot_desk: ShootingTheDesk<'a>,
    pub emulate: Emulating<'a>,
    pub devtools: SendDevTools<'a>,
    pub configure_display: ConfiguringDisplays<'a>,
    pub log_levels: ReadingLogLevels<'a>,
    pub set_log_levels: SettingLogLevels<'a>,
    /// The line the desktop said when it came up.
    pub up: &'a str,
    /// Whether the desktop's lines go to the journal.
    pub logs_in_the_journal: bool,
    pub logs: ReadingLogs<'a>,
    pub monitors: ListMonitors<'a>,
    pub displays: ListDisplays<'a>,
    pub windows: ListWindows<'a>,
    pub status: AskStatus<'a>,
    pub shell_commands: ListShellCommands<'a>,
    pub shell_bindings: ListShellBindings<'a>,
    pub inputs: ListInputs<'a>,
    pub idle_time: AskIdleTime<'a>,
    pub agents: ListAgents<'a>,
    pub stop_agent: StoppingAgents<'a>,
    pub forget_agent: ForgettingAgents<'a>,
}

/// A [`Request::VirtualMonitor`] and the connection it came on, which
/// [`crate::control_socket::serve_one`] lends to
/// [`crate::monitor_lending::lend`].
pub struct Lent {
    pub name: String,
    pub mode: crate::cli::MonitorMode,
    /// The client's lines after the request.
    pub lines: std::io::BufReader<std::os::unix::net::UnixStream>,
    /// Where the client hears back.
    pub client: std::os::unix::net::UnixStream,
}

/// A [`Request::Agent`] and the connection it came on, which
/// [`crate::control_socket::serve_one`] lends to
/// [`crate::agent_lending::admit`].
pub struct Admission {
    pub agent: String,
    /// The client's lines after the request.
    pub lines: std::io::BufReader<std::os::unix::net::UnixStream>,
    /// Where the client hears back.
    pub client: std::os::unix::net::UnixStream,
}

/// A [`Request::Subscribe`] and the connection it came on, which
/// [`crate::control_socket::serve_one`] lends to
/// [`crate::subscription::follow`].
pub struct Subscription {
    pub topics: Vec<WatchTopic>,
    /// Where the client hears back. Its end is the subscription's.
    pub client: std::os::unix::net::UnixStream,
}

/// How a screenshot the compositor took ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shot {
    /// Saved as this file.
    Saved(PathBuf),
    /// Put on the clipboard from the shell's dialog, and not saved.
    Copied,
    /// The user dismissed the shell's screenshot dialog.
    Canceled,
}

/// The answer naming `shell` as the one served.
fn serving(shell: &Shell) -> Response {
    Response::Shell {
        module: shell.root.join(&shell.module),
        root: shell.root.clone(),
        dev_server: shell.files == ShellFiles::DevServer,
    }
}

/// Answers one request line to `desktop`.
pub fn answer(line: &str, desktop: &Desktop) -> String {
    match parse_request(line.trim()) {
        Ok(Request::WhichShell) => to_line(&serving(desktop.shell)),
        // Reply with the resolved path so the user can see which file was
        // loaded.
        Ok(Request::LoadShell {
            root,
            module,
            dev_server,
        }) => {
            let shell = Shell {
                files: if dev_server {
                    ShellFiles::DevServer
                } else {
                    ShellFiles::Directory
                },
                module,
                root,
            };
            to_line(&match (desktop.load)(&shell) {
                Ok(()) => serving(&shell),
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::OpenUrl { url, profile }) => {
            to_line(&match (desktop.open)(&url, profile.as_deref()) {
                Ok(()) => Response::Opened,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::OpenApp {
            url,
            id,
            reuse,
            profile,
        }) => to_line(
            &match (desktop.open_app)(&url, id.as_deref(), reuse, profile.as_deref()) {
                Ok(()) => Response::Opened,
                Err(why) => Response::Refused { why },
            },
        ),
        Ok(Request::RunApp { root, module }) => to_line(&match (desktop.run_app)(&root, &module) {
            Ok(()) => Response::Opened,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Launch { command }) => to_line(&match (desktop.launch)(&command) {
            Ok(()) => Response::Opened,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::OpenLink { url }) => to_line(&match (desktop.open_link)(&url) {
            Ok(true) => Response::Opened,
            Ok(false) => Response::Unclaimed,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Screenshot { file }) => to_line(&match (desktop.capture)(file.as_deref()) {
            Ok(Shot::Saved(file)) => Response::Captured { file },
            Ok(Shot::Copied) => Response::Copied,
            Ok(Shot::Canceled) => Response::Canceled,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::ScreenRecord) => to_line(&match (desktop.record)() {
            Ok(Some(file)) => Response::Captured { file },
            Ok(None) => Response::Canceled,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::SendShell { command }) => to_line(&match (desktop.send)(&command) {
            Ok(output) => Response::Sent { output },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::SettingsFiles) => to_line(&Response::SettingsFiles {
            files: SettingsFiles {
                options: Some(
                    desktop
                        .shell
                        .root
                        .join(&desktop.shell.module)
                        .with_file_name(OPTIONS),
                ),
                ..desktop.files.clone()
            },
        }),
        Ok(Request::SitePermissions) => to_line(&match (desktop.permissions)() {
            Ok(settings) => Response::SitePermissions(settings),
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::SetSitePermission { site }) => {
            to_line(&match (desktop.set_permission)(&site) {
                Ok(()) => Response::Stored,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::LoadUnpacked { directory }) => {
            to_line(&match (desktop.load_unpacked)(&directory) {
                Ok(id) => Response::LoadedUnpacked { id },
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::UninstallExtension { id }) => {
            to_line(&match (desktop.uninstall_extension)(&id) {
                Ok(()) => Response::Uninstalled,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::ConfigExtensions) => to_line(&match (desktop.config_extensions)() {
            Ok(ids) => Response::ConfigExtensions { ids },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::MediaDevices) => to_line(&match (desktop.media_devices)() {
            Ok(devices) => Response::MediaDevices(devices),
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::SetMediaDevice { kind, id }) => {
            to_line(&match (desktop.set_media_device)(kind, &id) {
                Ok(()) => Response::Stored,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::Extensions) => to_line(&match (desktop.extensions)() {
            Ok(extensions) => Response::Extensions { extensions },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::SetExtensionEnabled {
            id,
            enabled,
            profile,
        }) => to_line(
            &match (desktop.set_extension_enabled)(&id, enabled, profile.as_deref()) {
                Ok(()) => Response::Stored,
                Err(why) => Response::Refused { why },
            },
        ),
        Ok(Request::BrowserProfiles) => to_line(&match (desktop.browser_profiles)() {
            Ok(list) => Response::BrowserProfiles(list),
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::PinBrowserSite { site, profile }) => {
            to_line(&match (desktop.pin_browser_site)(&site, &profile) {
                Ok(()) => Response::Stored,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::ConfigureExtension { id, settings }) => {
            to_line(&match (desktop.configure_extension)(&id, &settings) {
                Ok(()) => Response::Stored,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::History(query)) => to_line(&match (desktop.history)(&query) {
            Ok(items) => Response::History { items },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Visits { url }) => to_line(&match (desktop.visits)(&url) {
            Ok(times) => Response::Visits { times },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::DeleteHistory { visits }) => {
            to_line(&match (desktop.delete_history)(&visits) {
                Ok(()) => Response::Deleted,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::ClearBrowsingData(data)) => {
            to_line(&match (desktop.clear_browsing_data)(&data) {
                Ok(()) => Response::Cleared,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::SiteData) => to_line(&match (desktop.site_data)() {
            Ok(sites) => Response::SiteData { sites },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::ClearSiteData { host }) => to_line(&match (desktop.clear_site_data)(&host) {
            Ok(()) => Response::Cleared,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::DisableWhileTyping { to }) => {
            to_line(&match switched(to, desktop.disable_while_typing) {
                Ok(enabled) => Response::DisableWhileTyping { enabled },
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::Theme { to }) => to_line(&match themed(to, desktop.theme) {
            Ok(theme) => Response::Theme { theme },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Monitors) => to_line(&match (desktop.monitors)() {
            Ok(monitors) => Response::Monitors { monitors },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Displays) => to_line(&match (desktop.displays)() {
            Ok(displays) => Response::Displays { displays },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Windows) => to_line(&match (desktop.windows)() {
            Ok(windows) => Response::Windows { windows },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Status) => to_line(&match (desktop.status)() {
            Ok(status) => Response::Status {
                shell: desktop.shell.root.join(&desktop.shell.module),
                status,
            },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::ShellCommands) => to_line(&match (desktop.shell_commands)() {
            Ok(commands) => Response::ShellCommands { commands },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::ShellBindings) => to_line(&match (desktop.shell_bindings)() {
            Ok(bindings) => Response::ShellBindings { bindings },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Inputs) => to_line(&match (desktop.inputs)() {
            Ok(inputs) => Response::Inputs { inputs },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::IdleTime) => to_line(&match (desktop.idle_time)() {
            Ok(seconds) => Response::IdleTime { seconds },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Agents) => to_line(&match (desktop.agents)() {
            Ok(agents) => Response::Agents { agents },
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::StopAgent { session }) => to_line(&match (desktop.stop_agent)(session) {
            Ok(()) => Response::Done,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::ForgetAgent { agent }) => to_line(&match (desktop.forget_agent)(&agent) {
            Ok(()) => Response::Done,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::Lock) => to_line(&match (desktop.lock)() {
            Ok(()) => Response::Done,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::ActOnWindow { id, act }) => to_line(&match (desktop.act_on_window)(&id, act) {
            Ok(()) => Response::Done,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::ShootDesk { file, fit, area }) => {
            to_line(&match (desktop.shoot_desk)(&file, fit, area) {
                Ok(shot) => Response::DeskShot { shot },
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::Emulate { input }) => to_line(&match (desktop.emulate)(&input) {
            Ok(()) => Response::Done,
            Err(why) => Response::Refused { why },
        }),
        Ok(Request::DevTools {
            window,
            view,
            method,
            params,
        }) => to_line(
            &match driven(desktop, &window, view.as_deref(), &method, &params) {
                Ok(result) => Response::DevTools { result },
                Err(why) => Response::Refused { why },
            },
        ),
        Ok(Request::ConfigureDisplay { display, change }) => {
            to_line(&match (desktop.configure_display)(&display, &change) {
                Ok(()) => Response::Done,
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::SetLogLevel { level, subsystems }) => leveled(
            changed(&(desktop.log_levels)(), level, &subsystems),
            desktop.set_log_levels,
        ),
        Ok(Request::ResetLogLevels) => leveled(LogLevels::default(), desktop.set_log_levels),
        Ok(Request::LogLevels) => to_line(&Response::LogLevels {
            levels: (desktop.log_levels)(),
        }),
        Ok(Request::RecentLogs) => to_line(&match desktop.logs_in_the_journal {
            true => Response::RecentLogs {
                journal: true,
                lines: Vec::new(),
            },
            false => match (desktop.logs)() {
                Ok(logs) => Response::RecentLogs {
                    journal: false,
                    lines: logs
                        .iter()
                        .map(|said| said.line(local_offset(said.at)))
                        .collect(),
                },
                Err(why) => Response::Refused { why },
            },
        }),
        Ok(Request::ExportLogs { file, redact }) => {
            to_line(&match exported(desktop, &file, redact) {
                Ok(unhidden) => Response::ExportedLogs { file, unhidden },
                Err(why) => Response::Refused { why },
            })
        }
        Ok(Request::SleepDisplays { display }) => {
            powered(DisplayPower::Asleep, display, desktop.power_displays)
        }
        Ok(Request::WakeDisplays { display }) => {
            powered(DisplayPower::Awake, display, desktop.power_displays)
        }
        // Lent the connection by `serve_one` instead; a lone line would
        // remove the monitor as it answered.
        Ok(Request::VirtualMonitor { .. }) => to_line(&Response::Refused {
            why: "a virtual monitor lasts as long as its connection, which this \
                  desktop was not lent"
                .to_string(),
        }),
        // Lent the connection by `serve_one` too.
        Ok(Request::Subscribe { .. }) => to_line(&Response::Refused {
            why: "a subscription lasts as long as its connection, which this desktop \
                  was not lent"
                .to_string(),
        }),
        // Lent the connection by `serve_one` too.
        Ok(Request::Agent { .. }) => to_line(&Response::Refused {
            why: "an agent is let in for as long as its connection lasts, which this \
                  desktop was not lent"
                .to_string(),
        }),
        Ok(Request::AgentDid { .. }) => to_line(&Response::Refused {
            why: "this connection holds no agent".to_string(),
        }),
        Ok(Request::ResizeVirtualMonitor { .. }) => to_line(&Response::Refused {
            why: "this connection holds no virtual monitor to resize".to_string(),
        }),
        Err(why) => to_line(&Response::Refused {
            why: format!(
                "'{}' is not a request this desktop knows: {why}",
                line.trim()
            ),
        }),
    }
}

/// Writes the desktop's logs to `file` for `Request::ExportLogs`, answering
/// what redaction could not hide. Read failures besides the logs' own are
/// said in the file: the logs matter most when part of the desktop is down.
fn exported(desktop: &Desktop, file: &Path, redact: bool) -> Result<Option<String>, String> {
    let logs = (desktop.logs)().map_err(|why| format!("cannot read the logs: {why}"))?;
    let (titles, unhidden) = match redact {
        false => (Vec::new(), None),
        true => match (desktop.windows)() {
            Ok(windows) => (
                windows.into_iter().map(|window| window.title).collect(),
                None,
            ),
            Err(why) => (
                Vec::new(),
                Some(format!(
                    "the window titles were not read, so they may show: {why}"
                )),
            ),
        },
    };
    let now = crate::recent_log::now();
    let offset = local_offset(now);
    let text = report(&Report {
        at: &crate::recent_log::civil((now / 1_000_000) as i64 + offset, " ", ":"),
        up: desktop.up,
        levels: (desktop.log_levels)(),
        displays: (desktop.displays)()
            .map(|displays| crate::listing::displays_table(Paint::PLAIN, &displays)),
        inputs: (desktop.inputs)()
            .map(|inputs| crate::listing::inputs_table(Paint::PLAIN, &inputs)),
        from: match desktop.logs_in_the_journal {
            true => "the journal",
            false => "the desktop's last lines",
        },
        logs: &logs,
        offset,
        titles: &titles,
        redact,
    });
    std::fs::write(file, text).map_err(|why| format!("cannot write {}: {why}", file.display()))?;
    Ok(unhidden)
}

/// Sets the desktop's log levels to `levels` with `set`, answering them, or
/// why the desktop refused, as a response line.
fn leveled(levels: LogLevels, set: SettingLogLevels) -> String {
    match set(&levels) {
        Ok(()) => to_line(&Response::LogLevels { levels }),
        Err(why) => to_line(&Response::Refused { why }),
    }
}

/// Turns the monitor named `display`, or every one, `power` with `set`, as a
/// response line.
fn powered(power: DisplayPower, display: Option<String>, set: PowerDisplays) -> String {
    to_line(&match set(power, display.as_deref()) {
        Ok(()) => Response::Powered,
        Err(why) => Response::Refused { why },
    })
}

/// The window `devtools` names for the shell's own page.
pub const SHELL_WINDOW: &str = "shell";

/// Sends `method` to the browser window `domicile list-windows` lists as
/// `window`, or to its view `view`, or to the shell's own page as window
/// [`SHELL_WINDOW`], while the desktop is unlocked. A listed window must be
/// neither native nor private.
fn driven(
    desktop: &Desktop,
    window: &str,
    view: Option<&str>,
    method: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if (desktop.status)()?.locked {
        return Err("the desktop is locked".to_string());
    }
    // Not a window list-windows lists: the engine answers it with the shell's
    // own page.
    if window == SHELL_WINDOW {
        return match view {
            None => (desktop.devtools)(SHELL_WINDOW, method, params),
            Some(_) => Err(
                "the shell holds no views; list-windows lists browser windows' views".to_string(),
            ),
        };
    }
    let windows = (desktop.windows)()?;
    let listed = windows
        .iter()
        .find(|listed| listed.id == window)
        .ok_or_else(|| format!("there is no window {window}; list-windows lists them"))?;
    if listed.private {
        return Err(format!(
            "window {window} is private, and agents do not drive private windows"
        ));
    }
    match (&listed.kind, &listed.engine_id) {
        (WindowKind::Browser, Some(engine_id)) => match view {
            None => (desktop.devtools)(engine_id, method, params),
            Some(view) if listed.views.iter().any(|held| held.id == view) => {
                (desktop.devtools)(view, method, params)
            }
            Some(view) => Err(format!(
                "window {window} holds no view {view}; list-windows lists its views"
            )),
        },
        (WindowKind::Browser, None) => Err(format!(
            "the compositor listed browser window {window} without its id in the engine"
        )),
        (WindowKind::Native, _) => Err(format!(
            "window {window} is a native window; devtools drives browser windows"
        )),
    }
}

/// Carries out `to` with `set`. A toggle asks first, since the engine keeps the
/// setting.
fn switched(to: Option<Switch>, set: DisableWhileTyping) -> Result<bool, String> {
    match to {
        None => set(None),
        Some(Switch::On) => set(Some(true)),
        Some(Switch::Off) => set(Some(false)),
        Some(Switch::Toggle) => set(Some(!set(None)?)),
    }
}

/// Carries out `to` with `set`. A toggle asks first, since the compositor keeps
/// the theme.
fn themed(to: Option<ThemeChange>, set: Theming) -> Result<Theme, String> {
    match to {
        None => set(None),
        Some(ThemeChange::Light) => set(Some(Theme::Light)),
        Some(ThemeChange::Dark) => set(Some(Theme::Dark)),
        Some(ThemeChange::Toggle) => set(Some(match set(None)? {
            Theme::Light => Theme::Dark,
            Theme::Dark => Theme::Light,
        })),
    }
}

/// Parses one request line, without its trailing newline.
fn parse_request(line: &str) -> Result<Request, serde_json::Error> {
    serde_json::from_str(line)
}
