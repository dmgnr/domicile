//! Parses the `domicile` command line.
//!
//! `domicile <shell>` runs a desktop. `domicile <verb>` sends a command to a
//! running one. `--config` is optional; [`crate::config_path`] finds the
//! default.

use crate::accessibility::Act;
use crate::commands;
use std::path::PathBuf;

use domicile_protocol::{
    DeskRect, DisplayChange, DisplayTransform, EmulatedInput, LogLevel, PointerButton, Scale,
    Subsystem, WatchTopic, WindowAct,
};

use crate::control::{AppReuse, Request, Switch, ThemeChange};
use crate::power::Power;
use domicile_host::system::DisplayPower;

/// An invalid `domicile` command line.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CliError {
    #[error(
        "which shell? Give one, or name it in your config:\n\n    \
         domicile ./my-desktop/dist/shell.js\n    \
         domicile @domicile-desktop/manganese\n\n\
         A config is ~/.config/domicile/domicile.{{ts,tsx,js,mjs,json}}, or \
         --config <path>: a module's `Shell` export, or a JSON config's \
         \"shell\", is the shell when none is given.\n\
         For a command for the running desktop, see domicile --help.\n"
    )]
    NoShell,
    #[error(
        "too many arguments: {extra}. A desktop is one shell, and which one is \
         the whole command line."
    )]
    TooMany { extra: String },
    #[error("{verb} takes no arguments, and it was given {extra}.")]
    Extra { verb: String, extra: String },
    #[error(
        "load-shell takes the path to the JavaScript module the shell you want \
         is, and was given nothing:\n\n    \
         domicile load-shell ./my-desktop/dist/shell.js\n"
    )]
    NoShellToLoad,
    #[error(
        "load-shell takes one shell, and it was given {extra} as well. A \
         desktop serves one shell at a time, and it read its config when it \
         started — so there is no --config here either."
    )]
    ExtraToLoad { extra: String },
    #[error(
        "dev takes the file your shell's source starts at, and was given \
         nothing:\n\n    \
         domicile dev ./my-desktop/src/shell.tsx\n"
    )]
    NoEntryToServe,
    #[error(
        "dev serves one shell, and it was given {extra} as well. Stop the \
         other domicile dev first, or give the one entry that imports both."
    )]
    ExtraToServe { extra: String },
    #[error(
        "open takes the file, folder or address to open, and was given \
         nothing:\n\n    \
         domicile open ~/notes.org\n    \
         domicile open https://example.com\n\n\
         With --app it takes a site or app module to open as an app:\n\n    \
         domicile open --app https://example.com\n    \
         domicile open --app ./notes/notes.js\n"
    )]
    NothingToOpen,
    #[error(
        "--reuse finds the open window by its app's id, and was given no \
         --id:\n\n    \
         domicile open --app --id mail --reuse focus https://mail.example\n"
    )]
    ReuseWithoutId,
    #[error(
        "--profile picks the browser profile a web address opens in, and \
         {target} is no web address:\n\n    \
         domicile open --profile work https://example.com\n"
    )]
    ProfileForAFile { target: String },
    #[error("--reuse is new, focus or navigate, and was given {given}.")]
    UnknownReuse { given: String },
    #[error("{flag} takes a value, and was given none.")]
    FlagWithoutValue { flag: String },
    #[error(
        "open takes one thing to open, and it was given {extra} as well. One \
         thing is one window."
    )]
    ExtraToOpen { extra: String },
    #[error(
        "install-app takes the address of the site to install, and was given \
         nothing:\n\n    \
         domicile install-app https://example.com\n"
    )]
    NothingToInstall,
    #[error(
        "install-app takes one address, and it was given {extra} as well. One \
         address is one app."
    )]
    ExtraToInstall { extra: String },
    #[error(
        "uninstall-app takes the address the app opens, and was given \
         nothing:\n\n    \
         domicile uninstall-app https://example.com/\n"
    )]
    NothingToUninstall,
    #[error(
        "uninstall-app takes one address, and it was given {extra} as well. One \
         address is one app."
    )]
    ExtraToUninstall { extra: String },
    #[error("screenshot takes one file, and it was given {extra} as well.")]
    ExtraToSave { extra: String },
    #[error(
        "screenshot --fit takes the most pixels the picture may be across or \
         down, maybe --area and an area of the desk, then the file to write:\n\n    \
         domicile screenshot --fit 1280 --area 0,0,1920x1080 desk.png\n"
    )]
    NotAFit,
    #[error(
        "{said} is not a point. pointer takes x,y in logical pixels from the \
         desk's top-left corner, as screenshot --fit places them:\n\n    \
         domicile pointer 640,360 click\n"
    )]
    NotAPoint { said: String },
    #[error(
        "{said} is not something pointer does: click, double-click, \
         right-click or middle-click. To hold the button while moving, use \
         drag."
    )]
    NotAPointerAction { said: String },
    #[error(
        "drag takes two points, x,y in logical pixels from the desk's \
         top-left corner, and was given {said}:\n\n    \
         domicile drag 640,360 800,360\n"
    )]
    NotADrag { said: String },
    #[error("{said} is not a distance like 0,120 to scroll across and down.")]
    NotADistance { said: String },
    #[error(
        "{said} is not an agent's session. stop-agent takes the number \
         list-agents prints:\n\n    \
         domicile stop-agent 12\n"
    )]
    NotASession { said: String },
    #[error("{said} is not a JSON object of a DevTools method's params.")]
    NotParams { said: String },
    #[error(
        "devtools takes a browser window's id, as list-windows prints it, or \
         shell, maybe --view and one of its views, and a DevTools Protocol method \
         such as Accessibility.getFullAXTree."
    )]
    NotDevTools,
    #[error(
        "accessibility-act takes a native window's id, an element's ref from \
         accessibility, and click, focus or set-text <text>."
    )]
    NotAnAct,
    #[error(
        "mcp --http takes the address to listen on, such as 127.0.0.1:7465, \
         and was given {said}."
    )]
    NotAListenAddress { said: String },
    #[error("{verb} takes one {what}, and was given {said}.")]
    NotOne {
        verb: String,
        what: String,
        said: String,
    },
    #[error(
        "send-shell takes the command to send the shell, and was given \
         nothing:\n\n    \
         domicile send-shell focus right\n"
    )]
    NothingToSend,
    #[error(
        "disable-while-typing takes on, off or toggle, or nothing to print \
         the setting, and was given {said}."
    )]
    NotASwitch { said: String },
    #[error(
        "theme takes light, dark or toggle, or nothing to print the theme, \
         and was given {said}."
    )]
    NotATheme { said: String },
    #[error(
        "set-log-level takes error, warn, info, debug or trace, then the \
         subsystems to log at it, or --reset, or nothing to print the levels, \
         and was given {said}."
    )]
    NotALogLevel { said: String },
    #[error(
        "set-log-level was given {said}, which is not a subsystem. The \
         subsystems are {}.",
        subsystem_names()
    )]
    NotASubsystem { said: String },
    #[error(
        "monitor takes a name and a size, and was given less:\n\n    \
         domicile monitor \"Left pane\" 1280x720\n"
    )]
    NoMonitor,
    #[error("{said} is not a size like 1280x720 or 1280x720@30.")]
    NotASize { said: String },
    #[error("{said} is not a scale like 2 or 1.5.")]
    NotAScale { said: String },
    #[error("{said} is not something to subscribe to: windows, displays, inputs or status.")]
    NotATopic { said: String },
    #[error(
        "{verb} takes a window's id, as domicile list-windows prints it, and \
         was given nothing:\n\n    \
         domicile {verb} kD3mQ7nW1zT5yB8vC2xF6hJ9pL4sR0gA\n"
    )]
    NoWindow { verb: String },
    #[error(
        "inhibit-idle takes a command to run, and was given nothing:\n\n    \
         domicile inhibit-idle -- mpv film.mkv\n"
    )]
    NothingToRun,
    #[error(
        "exec takes a program to start and its arguments, and was given \
         nothing:\n\n    \
         domicile exec kitty --hold btop\n"
    )]
    NothingToExec,
    #[error(
        "trace takes the file to write the trace to, and was given \
         nothing:\n\n    \
         domicile trace switch.pftrace\n"
    )]
    NoTraceFile,
    #[error("--seconds takes a whole number of seconds, and was given {said}.")]
    NotSeconds { said: String },
    #[error(
        "configure-display takes a display, as domicile list-displays prints it, \
         and what to change, and was given nothing:\n\n    \
         domicile configure-display DP-1 mode 2560x1440@144 scale 1.25 position 1920,0\n"
    )]
    NoDisplayToConfigure,
    #[error(
        "configure-display {display} takes what to change: mode, scale, position, \
         transform, adaptive-sync, hdr, sdr-white, enable, disable or reset."
    )]
    NothingToConfigure { display: String },
    #[error("configure-display takes {expected} after {setting}, and was given {said}.")]
    NotADisplaySetting {
        setting: String,
        said: String,
        expected: &'static str,
    },
    #[error(
        "{said} is not something configure-display changes: mode, scale, position, \
         transform, adaptive-sync, hdr, sdr-white, enable, disable or reset."
    )]
    NotADisplayChange { said: String },
    #[error(
        "check-config takes the config file to check, and was given \
         nothing:\n\n    \
         domicile check-config ~/.config/domicile/domicile.json\n"
    )]
    NothingToCheck,
    #[error("check-config takes one config, and it was given {extra} as well.")]
    ExtraToCheck { extra: String },
    #[error(
        "--config takes the path to the compositor's config file and was given \
         nothing. Leaving the flag off reads ~/.config/domicile/domicile.{{ts,tsx,js,mjs,json}} \
         and runs the defaults when there is none, which is what an empty one \
         looks like it means."
    )]
    ConfigWithoutPath,
    #[error(
        "--config twice, the second naming {second}. A desktop is one config, \
         and quietly keeping one of the two is how a desk comes up wearing \
         settings nobody chose."
    )]
    TwoConfigs { second: String },
    #[error("{flag} is not a flag domicile takes. domicile --help lists what it takes.")]
    UnknownFlag { flag: String },
    #[error(
        "{said} is not a command.{}",
        meant.map_or_else(String::new, |meant| format!(" Did you mean {meant}?"))
    )]
    UnknownCommand {
        said: String,
        meant: Option<&'static str>,
    },
}

/// A parsed `domicile` command line.
#[derive(Debug, Clone, PartialEq)]
pub enum Invocation {
    /// Run a desktop on this shell, with the compositor reading `config`.
    ///
    /// A `None` config means none was given; `config_path` resolves it.
    Run {
        /// The shell, or `None` for the one the config names.
        shell: Option<String>,
        config: Option<PathBuf>,
    },
    /// Send this request to the running desktop as it is.
    Ask { request: Request },
    /// Tell the running desktop to serve this shell instead.
    ///
    /// Kept as typed; `shell_path` resolves it against the filesystem.
    Load { shell: String },
    /// Serve the shell whose source starts at this entry from a dev server,
    /// with hot module replacement, until stopped; then load the shell it
    /// replaced again.
    ///
    /// Kept as typed; it is relative to the working directory.
    Dev { entry: String },
    /// Open this file, folder or address with what opens its type; see
    /// [`crate::open`]. A web address opens in a new browser window.
    ///
    /// Kept as typed; it is relative to the working directory. A web address
    /// opens in browser profile `profile`, or the one its site opens in.
    Open {
        target: String,
        profile: Option<String>,
    },
    /// Tell the running desktop to open this as an app: an existing file as
    /// an app module ([`crate::app_entry`]), anything else as a site in a
    /// browser window without an address bar ([`crate::address`]).
    ///
    /// Kept as typed, like [`Invocation::Open`]'s. A site may be app `id`'s,
    /// whose open window `reuse` reuses.
    OpenAsApp {
        target: String,
        id: Option<String>,
        reuse: AppReuse,
        /// The browser profile a new window opens in, or with none its
        /// site's.
        profile: Option<String>,
    },
    /// Print the desktop file id of the application [`Invocation::Open`]
    /// would run for this, or nothing for a web address. The launcher lists
    /// it first under "Open with".
    Opener { target: String },
    /// Run the installed Electron app `target`, a desktop entry id or a
    /// path, on the engine ([`crate::electron_app`]). `command`, when given,
    /// is the app's own command line, as its entry's `Exec` gave it.
    OpenElectron {
        target: String,
        command: Vec<String>,
    },
    /// Write a desktop entry that opens the site at `url` as an app. Needs no
    /// running desktop.
    InstallApp { url: String },
    /// Remove the desktop entry and icon `install-app` wrote for `url`, the
    /// address it was given or the start URL. Needs no running desktop.
    UninstallApp { url: String },
    /// Tell the running desktop to write a PNG of the desk to this file, or,
    /// with none, to take the shell's interactive screenshot.
    ///
    /// Kept as typed; the client makes it absolute.
    Screenshot { file: Option<String> },
    /// Tell the running desktop to write a PNG of the desk to this file, its
    /// longer side at most `fit` pixels, and print what it shows.
    ///
    /// Kept as typed; the client makes it absolute.
    ShootDesk {
        file: String,
        fit: u32,
        area: Option<DeskRect>,
    },
    /// Check that the compositor takes this config, without running a desktop.
    Check { config: PathBuf },
    /// Power off or reboot the computer, or log out, after a yes in the
    /// desktop's Access dialog.
    Power { power: Power },
    /// Add a virtual monitor until stdin ends, resizing it to each size read.
    Monitor { name: String, mode: MonitorMode },
    /// Run `command`, keeping the screens on and the desktop unlocked until
    /// it exits.
    InhibitIdle { command: Vec<String> },
    /// Print the desktop's answer for each of `topics`, every topic when
    /// empty, as a JSON line, then again whenever one changes.
    Subscribe { topics: Vec<WatchTopic> },
    /// Ask the running desktop for a listing and print it as a table, or
    /// with `json` as the JSON array it answered with.
    List { listing: Listing, json: bool },
    /// Serve the Model Context Protocol on stdio until it ends, or with
    /// `http` over HTTP; see [`crate::mcp`].
    Mcp { http: Option<McpHttp> },
    /// `domicile mcp --relay [<relay>]`: served over HTTP to agents on the
    /// web, through the relay at `relay`, or Domicile's when `None`.
    McpRelay { relay: Option<String> },
    /// Ask the user to let agent `name` in, print what they allowed, then
    /// list each line of stdin as what it did, until either side ends it;
    /// see [`crate::agent_lending`].
    Agent { name: String },
    /// Print native window `window`'s accessibility tree; see
    /// [`crate::accessibility`].
    Accessibility { window: String },
    /// Act on an element of native window `window`'s accessibility tree.
    AccessibilityAct {
        window: String,
        element: String,
        act: Act,
    },
    /// Record the engine's trace events for `seconds` to `file`; see
    /// [`crate::trace`].
    ///
    /// Kept as typed; the client makes it absolute.
    Trace { file: String, seconds: u64 },
    /// Print the desktop's logs, and keep printing them if `follow`.
    Logs { follow: bool },
    /// Write the desktop's logs to `file`, or a file named for the time, with
    /// URLs and window titles hidden if `redact`.
    ///
    /// Kept as typed; the client makes it absolute.
    ExportLogs { file: Option<String>, redact: bool },
    /// Print the list of commands, or `command`'s help; see [`crate::help`].
    Help { command: Option<String> },
    /// Write the man pages into `dir`; see [`crate::man`].
    Manuals { dir: PathBuf },
    /// Print the version, the commit it was built from, and the engine's.
    Version,
}

/// What a `list-*` verb, `status` or `idle-time` prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listing {
    Displays,
    Windows,
    Status,
    ShellCommands,
    Bindings,
    Inputs,
    IdleTime,
    Agents,
}

impl Listing {
    /// The request that asks for it.
    pub fn request(self) -> Request {
        match self {
            Self::Displays => Request::Displays,
            Self::Windows => Request::Windows,
            Self::Status => Request::Status,
            Self::ShellCommands => Request::ShellCommands,
            Self::Bindings => Request::ShellBindings,
            Self::Inputs => Request::Inputs,
            Self::IdleTime => Request::IdleTime,
            Self::Agents => Request::Agents,
        }
    }
}

/// Parses the command line.
///
/// - A bare `domicile` runs the shell the config names. Extra arguments are
///   rejected rather than dropped.
/// - Verbs take precedence over a shell of the same name, because
///   `shell_path` treats a bare word as a path when such a file exists. Use
///   `./which-shell` to run a shell with a verb's name.
/// - Each verb has a closed argument list and takes no flags but `open`'s
///   `--app`, `--id` and `--reuse`, and `--which`. The running desktop already read its config, so a `--config`
///   would be silently ignored.
/// - `--config` may come before or after the shell. Any other flag in a run is
///   refused, rather than taken as the shell.
pub fn invocation(args: impl IntoIterator<Item = String>) -> Result<Invocation, CliError> {
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return Ok(Invocation::Run {
            shell: None,
            config: None,
        });
    };
    let mut args = args.peekable();
    if first == VERSION {
        return match args.next() {
            None => Ok(Invocation::Version),
            Some(extra) => Err(CliError::Extra { verb: first, extra }),
        };
    }
    if HELP.contains(&first.as_str())
        || (verb(&first).is_some()
            && args
                .peek()
                .is_some_and(|next| HELP.contains(&next.as_str())))
    {
        return match (first.as_str(), args.next()) {
            ("help", Some(flag)) if flag == MAN => match (args.next(), args.next()) {
                (Some(dir), None) => Ok(Invocation::Manuals {
                    dir: PathBuf::from(dir),
                }),
                (None, _) => Err(CliError::FlagWithoutValue { flag }),
                (Some(dir), Some(extra)) => Err(CliError::Extra {
                    verb: format!("help {flag} {dir}"),
                    extra,
                }),
            },
            ("help", Some(command)) => match (commands::command(&command), args.next()) {
                (None, _) => Err(CliError::UnknownCommand {
                    meant: commands::meant(&command),
                    said: command,
                }),
                (Some(_), Some(extra)) => Err(CliError::Extra {
                    verb: format!("help {command}"),
                    extra,
                }),
                (Some(_), None) => Ok(Invocation::Help {
                    command: Some(command),
                }),
            },
            // What `send-shell` takes is up to the shell, so ask it.
            ("send-shell", _) => Ok(Invocation::List {
                listing: Listing::ShellCommands,
                json: false,
            }),
            (verb, _) if HELP.contains(&verb) => Ok(Invocation::Help { command: None }),
            _ => Ok(Invocation::Help {
                command: Some(first),
            }),
        };
    }
    if let Some(verb) = verb(&first) {
        return match verb {
            Verb::Asking(request) => match args.next() {
                None => Ok(Invocation::Ask { request }),
                Some(extra) => Err(CliError::Extra { extra, verb: first }),
            },
            Verb::Powering(power) => match args.next() {
                None => Ok(Invocation::Power { power }),
                Some(extra) => Err(CliError::Extra { extra, verb: first }),
            },
            Verb::Loading => match (args.next(), args.next()) {
                (None, _) => Err(CliError::NoShellToLoad),
                (Some(shell), None) => Ok(Invocation::Load { shell }),
                (Some(_), Some(extra)) => Err(CliError::ExtraToLoad { extra }),
            },
            Verb::Developing => match (args.next(), args.next()) {
                (None, _) => Err(CliError::NoEntryToServe),
                (Some(entry), None) => Ok(Invocation::Dev { entry }),
                (Some(_), Some(extra)) => Err(CliError::ExtraToServe { extra }),
            },
            Verb::Opening if args.peek().is_some_and(|word| word == ELECTRON) => {
                args.next();
                let target = args.next().ok_or(CliError::NothingToOpen)?;
                match args.next() {
                    None => Ok(Invocation::OpenElectron {
                        target,
                        command: Vec::new(),
                    }),
                    Some(dashes) if dashes == "--" => Ok(Invocation::OpenElectron {
                        target,
                        command: args.collect(),
                    }),
                    Some(extra) => Err(CliError::ExtraToOpen { extra }),
                }
            }
            Verb::Opening if args.peek().is_some_and(|word| word == PROFILE) => {
                args.next();
                let profile = args.next().ok_or_else(|| CliError::FlagWithoutValue {
                    flag: PROFILE.to_string(),
                })?;
                match (args.next(), args.next()) {
                    (None, _) => Err(CliError::NothingToOpen),
                    (Some(_), Some(extra)) => Err(CliError::ExtraToOpen { extra }),
                    (Some(target), None) => Ok(Invocation::Open {
                        target,
                        profile: Some(profile),
                    }),
                }
            }
            Verb::Opening => {
                let first = args.next();
                let flag = first.clone().filter(|word| word == APP || word == WHICH);
                let (id, reuse, profile) = match flag.as_deref() {
                    Some(APP) => app_flags(&mut args)?,
                    _ => (None, AppReuse::New, None),
                };
                let target = if flag.is_some() { args.next() } else { first };
                match (target, args.next()) {
                    (None, _) => Err(CliError::NothingToOpen),
                    (Some(_), Some(extra)) => Err(CliError::ExtraToOpen { extra }),
                    (Some(target), None) => Ok(match flag.as_deref() {
                        Some(APP) => Invocation::OpenAsApp {
                            target,
                            id,
                            reuse,
                            profile,
                        },
                        Some(_) => Invocation::Opener { target },
                        None => Invocation::Open {
                            target,
                            profile: None,
                        },
                    }),
                }
            }
            Verb::Installing => match (args.next(), args.next()) {
                (None, _) => Err(CliError::NothingToInstall),
                (Some(url), None) => Ok(Invocation::InstallApp { url }),
                (Some(_), Some(extra)) => Err(CliError::ExtraToInstall { extra }),
            },
            Verb::Uninstalling => match (args.next(), args.next()) {
                (None, _) => Err(CliError::NothingToUninstall),
                (Some(url), None) => Ok(Invocation::UninstallApp { url }),
                (Some(_), Some(extra)) => Err(CliError::ExtraToUninstall { extra }),
            },
            Verb::Sending => {
                let command: Vec<String> = args.collect();
                match command.is_empty() {
                    true => Err(CliError::NothingToSend),
                    false => Ok(Invocation::Ask {
                        request: Request::SendShell { command },
                    }),
                }
            }
            Verb::Switching => match (args.next(), args.next()) {
                (None, _) => Ok(Invocation::Ask {
                    request: Request::DisableWhileTyping { to: None },
                }),
                (Some(said), extra) => match (switch(&said), extra) {
                    (None, _) => Err(CliError::NotASwitch { said }),
                    (Some(_), Some(extra)) => Err(CliError::Extra {
                        verb: format!("{first} {said}"),
                        extra,
                    }),
                    (Some(to), None) => Ok(Invocation::Ask {
                        request: Request::DisableWhileTyping { to: Some(to) },
                    }),
                },
            },
            Verb::Sleeping(power) => match (args.next(), args.next()) {
                (Some(display), Some(extra)) => Err(CliError::Extra {
                    verb: format!("{first} {display}"),
                    extra,
                }),
                (display, _) => Ok(Invocation::Ask {
                    request: match power {
                        DisplayPower::Asleep => Request::SleepDisplays { display },
                        DisplayPower::Awake => Request::WakeDisplays { display },
                    },
                }),
            },
            Verb::Theming => match (args.next(), args.next()) {
                (None, _) => Ok(Invocation::Ask {
                    request: Request::Theme { to: None },
                }),
                (Some(said), extra) => match (theme_change(&said), extra) {
                    (None, _) => Err(CliError::NotATheme { said }),
                    (Some(_), Some(extra)) => Err(CliError::Extra {
                        verb: format!("{first} {said}"),
                        extra,
                    }),
                    (Some(to), None) => Ok(Invocation::Ask {
                        request: Request::Theme { to: Some(to) },
                    }),
                },
            },
            Verb::Leveling => match args.next() {
                None => Ok(Invocation::Ask {
                    request: Request::LogLevels,
                }),
                Some(flag) if flag == "--reset" => match args.next() {
                    Some(extra) => Err(CliError::Extra {
                        verb: format!("{first} {flag}"),
                        extra,
                    }),
                    None => Ok(Invocation::Ask {
                        request: Request::ResetLogLevels,
                    }),
                },
                Some(said) => {
                    let level = log_level(&said).ok_or(CliError::NotALogLevel { said })?;
                    let subsystems = args
                        .map(|said| subsystem(&said).ok_or(CliError::NotASubsystem { said }))
                        .collect::<Result<_, _>>()?;
                    Ok(Invocation::Ask {
                        request: Request::SetLogLevel { level, subsystems },
                    })
                }
            },
            Verb::Capturing => match (args.next(), args.next()) {
                (Some(flag), fit) if flag == "--fit" => {
                    let mut args = args.peekable();
                    let area = match args.next_if(|said| said == "--area") {
                        Some(_) => Some(
                            args.next()
                                .as_deref()
                                .and_then(desk_area)
                                .ok_or(CliError::NotAFit)?,
                        ),
                        None => None,
                    };
                    match (
                        fit.and_then(|fit| fit.parse().ok()),
                        args.next(),
                        args.next(),
                    ) {
                        (Some(fit), Some(file), None) => {
                            Ok(Invocation::ShootDesk { file, fit, area })
                        }
                        _ => Err(CliError::NotAFit),
                    }
                }
                (Some(_), Some(extra)) => Err(CliError::ExtraToSave { extra }),
                (file, _) => Ok(Invocation::Screenshot { file }),
            },
            Verb::Monitoring => match (args.next(), args.next(), args.next(), args.next()) {
                (Some(name), Some(size), scale, None) => {
                    let (size, refresh_mhz) =
                        monitor_size(&size).ok_or(CliError::NotASize { said: size })?;
                    let scale = match scale {
                        None => Scale::ONE,
                        Some(said) => scale_of(&said).ok_or(CliError::NotAScale { said })?,
                    };
                    Ok(Invocation::Monitor {
                        name,
                        mode: MonitorMode {
                            size,
                            refresh_mhz,
                            scale,
                        },
                    })
                }
                (Some(name), Some(size), Some(scale), Some(extra)) => Err(CliError::Extra {
                    verb: format!("{first} {name} {size} {scale}"),
                    extra,
                }),
                _ => Err(CliError::NoMonitor),
            },
            Verb::Listing(listing) => match (args.next(), args.next()) {
                (None, _) => Ok(Invocation::List {
                    listing,
                    json: false,
                }),
                (Some(flag), None) if flag == JSON => Ok(Invocation::List {
                    listing,
                    json: true,
                }),
                (Some(flag), Some(extra)) if flag == JSON => Err(CliError::Extra {
                    verb: format!("{first} {flag}"),
                    extra,
                }),
                (Some(extra), _) => Err(CliError::Extra { verb: first, extra }),
            },
            Verb::Acting(act) => match (args.next(), args.next()) {
                (None, _) => Err(CliError::NoWindow { verb: first }),
                (Some(id), None) => Ok(Invocation::Ask {
                    request: Request::ActOnWindow { id, act },
                }),
                (Some(id), Some(extra)) => Err(CliError::Extra {
                    verb: format!("{first} {id}"),
                    extra,
                }),
            },
            Verb::Configuring => {
                let display = args.next().ok_or(CliError::NoDisplayToConfigure)?;
                let change = display_change(args)?;
                if change == DisplayChange::default() {
                    return Err(CliError::NothingToConfigure { display });
                }
                Ok(Invocation::Ask {
                    request: Request::ConfigureDisplay { display, change },
                })
            }
            Verb::Pointing => {
                let point = args.next().ok_or(CliError::NotAPoint {
                    said: "nothing".to_string(),
                })?;
                let (x, y) = pair(&point).ok_or_else(|| CliError::NotAPoint {
                    said: point.clone(),
                })?;
                let then = match (args.next(), args.next()) {
                    (None, _) => Vec::new(),
                    (Some(action), None) => pointer_action(&action)
                        .ok_or(CliError::NotAPointerAction { said: action })?,
                    (Some(action), Some(extra)) => {
                        return Err(CliError::Extra {
                            verb: format!("{first} {point} {action}"),
                            extra,
                        })
                    }
                };
                emulated([vec![EmulatedInput::PointTo { x, y }], then].concat())
            }
            Verb::Dragging => {
                let said: Vec<String> = args.collect();
                match said.as_slice() {
                    [from, to] => match (pair(from), pair(to)) {
                        (Some(from), Some(to)) => emulated(drag(from, to)),
                        _ => Err(CliError::NotADrag {
                            said: said.join(" "),
                        }),
                    },
                    _ => Err(CliError::NotADrag {
                        said: match said.is_empty() {
                            true => "nothing".to_string(),
                            false => said.join(" "),
                        },
                    }),
                }
            }
            Verb::Scrolling => match (args.next(), args.next()) {
                (Some(said), None) => match pair(&said) {
                    Some((dx, dy)) => emulated(vec![EmulatedInput::Scroll { dx, dy }]),
                    None => Err(CliError::NotADistance { said }),
                },
                (said, _) => Err(one(&first, "distance", said)),
            },
            Verb::Keying => match (args.next(), args.next()) {
                (Some(chord), None) => emulated(chord_input(&chord)),
                (said, _) => Err(one(&first, "chord", said)),
            },
            Verb::Typing => match (args.next(), args.next()) {
                (Some(text), None) => emulated(vec![EmulatedInput::Text { text }]),
                (said, _) => Err(one(&first, "text, quoted", said)),
            },
            Verb::DevTooling => {
                let mut args = args.peekable();
                let view = match args.next_if(|said| said == "--view") {
                    Some(_) => Some(args.next().ok_or(CliError::NotDevTools)?),
                    None => None,
                };
                match (args.next(), args.next(), args.next(), args.next()) {
                    (Some(window), Some(method), params, None) => {
                        let params = match params {
                            None => serde_json::json!({}),
                            Some(params) => match serde_json::from_str(&params) {
                                Ok(params @ serde_json::Value::Object(_)) => params,
                                _ => return Err(CliError::NotParams { said: params }),
                            },
                        };
                        Ok(Invocation::Ask {
                            request: Request::DevTools {
                                window,
                                view,
                                method,
                                params,
                            },
                        })
                    }
                    (_, _, _, Some(extra)) => Err(CliError::Extra { extra, verb: first }),
                    _ => Err(CliError::NotDevTools),
                }
            }
            Verb::Reading => match (args.next(), args.next()) {
                (Some(window), None) => Ok(Invocation::Accessibility { window }),
                (said, _) => Err(one(&first, "window id", said)),
            },
            Verb::Accessing => {
                let (Some(window), Some(element), Some(act)) =
                    (args.next(), args.next(), args.next())
                else {
                    return Err(CliError::NotAnAct);
                };
                let act = match (act.as_str(), args.next()) {
                    ("click", None) => Act::Click,
                    ("focus", None) => Act::Focus,
                    ("set-text", Some(text)) => Act::SetText(text),
                    _ => return Err(CliError::NotAnAct),
                };
                match args.next() {
                    None => Ok(Invocation::AccessibilityAct {
                        window,
                        element,
                        act,
                    }),
                    Some(extra) => Err(CliError::Extra { extra, verb: first }),
                }
            }
            Verb::Admitting => match (args.next(), args.next()) {
                (Some(name), None) if !name.trim().is_empty() => Ok(Invocation::Agent { name }),
                (Some(_), None) | (None, _) => Err(one(&first, "agent name", None)),
                (said, Some(_)) => Err(one(&first, "agent name", said)),
            },
            Verb::StoppingAgent => match (args.next(), args.next()) {
                (Some(session), None) => match session.parse() {
                    Ok(session) => Ok(Invocation::Ask {
                        request: Request::StopAgent { session },
                    }),
                    Err(_) => Err(CliError::NotASession { said: session }),
                },
                (None, _) => Err(one(&first, "agent session", None)),
                (said, Some(_)) => Err(one(&first, "agent session", said)),
            },
            Verb::Forgetting => match (args.next(), args.next()) {
                (Some(agent), None) if !agent.trim().is_empty() => Ok(Invocation::Ask {
                    request: Request::ForgetAgent { agent },
                }),
                (Some(_), None) | (None, _) => Err(one(&first, "agent name", None)),
                (said, Some(_)) => Err(one(&first, "agent name", said)),
            },
            Verb::Serving => match args.next().as_deref() {
                None => Ok(Invocation::Mcp { http: None }),
                Some("--relay") => match (args.next(), args.next()) {
                    (relay, None) => Ok(Invocation::McpRelay { relay }),
                    (_, Some(extra)) => Err(CliError::Extra { extra, verb: first }),
                },
                Some("--http") => {
                    let said = args.next();
                    let listen = said
                        .as_deref()
                        .and_then(|address| address.parse().ok())
                        .ok_or_else(|| CliError::NotAListenAddress {
                            said: said.unwrap_or_else(|| "nothing".to_string()),
                        })?;
                    let url = match (args.next().as_deref(), args.next()) {
                        (None, _) => None,
                        (Some("--url"), Some(url)) => Some(url.trim_end_matches('/').to_string()),
                        (Some(extra), _) => {
                            return Err(CliError::Extra {
                                extra: extra.to_string(),
                                verb: first,
                            })
                        }
                    };
                    match args.next() {
                        None => Ok(Invocation::Mcp {
                            http: Some(McpHttp { listen, url }),
                        }),
                        Some(extra) => Err(CliError::Extra { extra, verb: first }),
                    }
                }
                Some(extra) => Err(CliError::Extra {
                    extra: extra.to_string(),
                    verb: first,
                }),
            },
            Verb::Inhibiting => {
                let mut command: Vec<String> = args.collect();
                // `--` ends the options, which this takes none of.
                if command.first().is_some_and(|word| word == "--") {
                    command.remove(0);
                }
                if command.is_empty() {
                    Err(CliError::NothingToRun)
                } else {
                    Ok(Invocation::InhibitIdle { command })
                }
            }
            Verb::Tracing => {
                let seconds = match args.peek().map(String::as_str) {
                    Some("--seconds") => {
                        args.next();
                        let said = args.next().unwrap_or_else(|| "nothing".to_string());
                        said.parse().map_err(|_| CliError::NotSeconds { said })?
                    }
                    _ => 20,
                };
                match (args.next(), args.next()) {
                    (None, _) => Err(CliError::NoTraceFile),
                    (Some(file), None) => Ok(Invocation::Trace { file, seconds }),
                    (Some(_), Some(extra)) => Err(CliError::Extra { extra, verb: first }),
                }
            }
            Verb::Logging => match (args.next(), args.next()) {
                (None, _) => Ok(Invocation::Logs { follow: false }),
                (Some(flag), None) if flag == "--follow" || flag == "-f" => {
                    Ok(Invocation::Logs { follow: true })
                }
                (Some(flag), _) if flag.starts_with('-') => Err(CliError::UnknownFlag { flag }),
                (Some(said), _) => Err(CliError::Extra {
                    verb: first,
                    extra: said,
                }),
            },
            Verb::Exporting => {
                let redact = args.next_if(|said| said == "--show-everything").is_none();
                match (args.next(), args.next()) {
                    (Some(flag), _) if flag.starts_with('-') => Err(CliError::UnknownFlag { flag }),
                    (Some(_), Some(extra)) => Err(CliError::Extra { verb: first, extra }),
                    (file, _) => Ok(Invocation::ExportLogs { file, redact }),
                }
            }
            Verb::Executing => {
                let command: Vec<String> = args.collect();
                match command.is_empty() {
                    true => Err(CliError::NothingToExec),
                    false => Ok(Invocation::Ask {
                        request: Request::Launch { command },
                    }),
                }
            }
            Verb::Subscribing => {
                let mut topics = Vec::new();
                for said in args {
                    let topic = topic(&said).ok_or(CliError::NotATopic { said })?;
                    if !topics.contains(&topic) {
                        topics.push(topic);
                    }
                }
                if topics.is_empty() {
                    topics = vec![
                        WatchTopic::Windows,
                        WatchTopic::Displays,
                        WatchTopic::Inputs,
                        WatchTopic::Status,
                    ];
                }
                Ok(Invocation::Subscribe { topics })
            }
            Verb::Checking => match (args.next(), args.next()) {
                (None, _) => Err(CliError::NothingToCheck),
                (Some(config), None) => Ok(Invocation::Check {
                    config: PathBuf::from(config),
                }),
                (Some(_), Some(extra)) => Err(CliError::ExtraToCheck { extra }),
            },
        };
    }
    let mut shell: Option<String> = None;
    let mut config: Option<PathBuf> = None;
    let mut word = Some(first);
    while let Some(said) = word {
        if said == CONFIG {
            // Read the path before checking for a duplicate, because the
            // error names it. `--config a --config` reports a missing path.
            if let Some(second) = args.next() {
                if config.is_some() {
                    return Err(CliError::TwoConfigs { second });
                }
                config = Some(PathBuf::from(second));
            } else {
                return Err(CliError::ConfigWithoutPath);
            }
        } else if said.starts_with('-') {
            return Err(CliError::UnknownFlag { flag: said });
        } else if shell.is_none() {
            shell = Some(said);
        } else {
            return Err(CliError::TooMany { extra: said });
        }
        word = args.next();
    }
    Ok(Invocation::Run { shell, config })
}

/// The words that ask for help, first or right after a verb.
const HELP: [&str; 3] = ["help", "--help", "-h"];

/// `help`'s flag for writing the man pages.
const MAN: &str = "--man";

/// The flag that asks for [`Invocation::Version`].
const VERSION: &str = "--version";

/// `open`'s flag for opening as an app.
const APP: &str = "--app";

/// `open`'s flag for running an installed Electron app on the engine.
const ELECTRON: &str = "--electron";

/// `open`'s flag naming the browser profile a web address opens in.
const PROFILE: &str = "--profile";

/// `open --app`'s flag naming the app a site's window belongs to.
const ID: &str = "--id";

/// `open --app`'s flag saying what to do when the app's window is open.
const REUSE: &str = "--reuse";

/// `open --app`'s `--id`, `--reuse` and `--profile`, in any order, before the
/// target.
fn app_flags(
    args: &mut std::iter::Peekable<impl Iterator<Item = String>>,
) -> Result<(Option<String>, AppReuse, Option<String>), CliError> {
    let mut id = None;
    let mut reuse = AppReuse::New;
    let mut profile = None;
    while let Some(flag) = args.next_if(|word| word == ID || word == REUSE || word == PROFILE) {
        let value = args
            .next()
            .ok_or_else(|| CliError::FlagWithoutValue { flag: flag.clone() })?;
        if flag == ID {
            id = Some(value);
        } else if flag == PROFILE {
            profile = Some(value);
        } else {
            reuse = match value.as_str() {
                "new" => AppReuse::New,
                "focus" => AppReuse::Focus,
                "navigate" => AppReuse::Navigate,
                _ => return Err(CliError::UnknownReuse { given: value }),
            };
        }
    }
    if reuse != AppReuse::New && id.is_none() {
        return Err(CliError::ReuseWithoutId);
    }
    Ok((id, reuse, profile))
}

/// Where `domicile mcp --http` serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpHttp {
    pub listen: std::net::SocketAddr,
    /// The address clients reach it at, when not `http://` and `listen`,
    /// with no trailing slash.
    pub url: Option<String>,
}

/// A listing's flag for printing JSON rather than a table.
const JSON: &str = "--json";

/// `open`'s flag for printing what would open it, without opening it.
const WHICH: &str = "--which";

/// The config file flag. Matches the compositor's flag in `arguments.rs`,
/// which receives it.
const CONFIG: &str = "--config";

/// A verb, and what it takes.
///
/// Only argument-free verbs carry a [`Request`]. [`Request::LoadShell`] needs
/// a resolved shell, which needs the filesystem.
enum Verb {
    /// A query that takes no arguments.
    Asking(Request),
    /// `load-shell`, which takes a shell.
    Loading,
    /// `dev`, which takes an entry.
    Developing,
    /// `open`, which takes `--app` or nothing, then a target.
    Opening,
    /// `install-app`, which takes an address.
    Installing,
    /// `uninstall-app`, which takes an address.
    Uninstalling,
    /// `screenshot`, which takes a file or nothing.
    Capturing,
    /// `send-shell`, which takes one or more words.
    Sending,
    /// `check-config`, which takes a config file.
    Checking,
    /// `disable-while-typing`, which takes a [`Switch`] or nothing.
    Switching,
    /// `theme`, which takes a [`ThemeChange`] or nothing.
    Theming,
    /// `power-off`, `reboot` or `log-out`, which take no arguments.
    Powering(Power),
    /// `mcp`, which takes no arguments.
    Serving,
    /// `pointer`, which takes a point and maybe what to do there.
    Pointing,
    /// `drag`, which takes two points.
    Dragging,
    /// `scroll`, which takes a distance.
    Scrolling,
    /// `key`, which takes a chord.
    Keying,
    /// `type`, which takes text.
    Typing,
    /// `devtools`, which takes a window, a method and maybe its params.
    DevTooling,
    /// `agent`, which takes a name.
    Admitting,
    /// `stop-agent`, which takes a session.
    StoppingAgent,
    /// `forget-agent`, which takes a name.
    Forgetting,
    /// `accessibility`, which takes a window.
    Reading,
    /// `accessibility-act`, which takes a window, an element and an act.
    Accessing,
    /// `monitor`, which takes a name, a size and maybe a scale.
    Monitoring,
    /// `subscribe`, which takes topics or nothing.
    Subscribing,
    /// `focus-window`, `close-window` or `kill-window`, which take a window's
    /// id.
    Acting(WindowAct),
    /// `inhibit-idle`, which takes a command.
    Inhibiting,
    /// `set-log-level`, which takes a level and subsystems, `--reset` or
    /// nothing.
    Leveling,
    /// `logs`, which takes `--follow` or nothing.
    Logging,
    /// `export-logs`, which takes `--show-everything` and a file, or neither.
    Exporting,
    /// `exec`, which takes a program and its arguments.
    Executing,
    /// `trace`, which takes a file and maybe `--seconds`.
    Tracing,
    /// `configure-display`, which takes a display and what to change.
    Configuring,
    /// `sleep-displays` or `wake-displays`, which take a display or nothing.
    Sleeping(DisplayPower),
    /// `list-displays`, `list-windows` or `status`, which take `--json` or
    /// nothing.
    Listing(Listing),
}

/// The verb `word` names, if any.
///
/// Every [`Request`] variant needs a verb here, or nobody can send it.
/// Asks the running desktop to send `input`.
fn emulated(input: Vec<EmulatedInput>) -> Result<Invocation, CliError> {
    Ok(Invocation::Ask {
        request: Request::Emulate { input },
    })
}

/// A [`CliError::NotOne`] for `verb`, given nothing or `said` and more.
fn one(verb: &str, what: &str, said: Option<String>) -> CliError {
    CliError::NotOne {
        verb: verb.to_string(),
        what: what.to_string(),
        said: said.map_or("nothing".to_string(), |said| format!("{said} and more")),
    }
}

/// Two numbers written `a,b`.
fn pair(said: &str) -> Option<(f64, f64)> {
    let (a, b) = said.split_once(',')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// What `pointer` does after moving, by the word for it.
fn pointer_action(word: &str) -> Option<Vec<EmulatedInput>> {
    let button = |button, pressed| EmulatedInput::Button { button, pressed };
    let click = |pointer| vec![button(pointer, true), button(pointer, false)];
    match word {
        "click" => Some(click(PointerButton::Left)),
        "double-click" => Some([click(PointerButton::Left), click(PointerButton::Left)].concat()),
        "right-click" => Some(click(PointerButton::Right)),
        "middle-click" => Some(click(PointerButton::Middle)),
        _ => None,
    }
}

/// How many moves a [`drag`] makes on its way, and how long it waits before
/// each: about a sixth of a second in all, as a hand drags. A page that reads
/// the press, the moves and the release as one burst sees a click.
const DRAG_STEPS: u32 = 10;
const DRAG_STEP_WAIT_MS: u32 = 16;

/// Press the left button at `from`, move to `to` holding it, and let go.
fn drag(from: (f64, f64), to: (f64, f64)) -> Vec<EmulatedInput> {
    let button = |pressed| EmulatedInput::Button {
        button: PointerButton::Left,
        pressed,
    };
    let on_the_way = (1..=DRAG_STEPS).flat_map(|step| {
        let part = f64::from(step) / f64::from(DRAG_STEPS);
        [
            EmulatedInput::Wait {
                ms: DRAG_STEP_WAIT_MS,
            },
            EmulatedInput::PointTo {
                x: from.0 + (to.0 - from.0) * part,
                y: from.1 + (to.1 - from.1) * part,
            },
        ]
    });
    [
        vec![
            EmulatedInput::PointTo {
                x: from.0,
                y: from.1,
            },
            button(true),
        ],
        on_the_way.collect(),
        vec![button(false)],
    ]
    .concat()
}

/// Presses each key of `chord`, such as `ctrl+shift+Tab`, in order, then
/// releases them in reverse. The compositor refuses a key no keysym names.
fn chord_input(chord: &str) -> Vec<EmulatedInput> {
    let keys: Vec<&str> = chord
        .split('+')
        .map(|key| match key {
            "ctrl" | "control" => "Control_L",
            "shift" => "Shift_L",
            "alt" => "Alt_L",
            "super" | "meta" => "Super_L",
            key => key,
        })
        .collect();
    let key = |key: &&str, pressed| EmulatedInput::Key {
        key: (*key).to_string(),
        pressed,
    };
    keys.iter()
        .map(|name| key(name, true))
        .chain(keys.iter().rev().map(|name| key(name, false)))
        .collect()
}

fn verb(word: &str) -> Option<Verb> {
    match word {
        "which-shell" => Some(Verb::Asking(Request::WhichShell)),
        "load-shell" => Some(Verb::Loading),
        "dev" => Some(Verb::Developing),
        "open" => Some(Verb::Opening),
        "install-app" => Some(Verb::Installing),
        "uninstall-app" => Some(Verb::Uninstalling),
        "screenshot" => Some(Verb::Capturing),
        "screen-record" => Some(Verb::Asking(Request::ScreenRecord)),
        "send-shell" => Some(Verb::Sending),
        "check-config" => Some(Verb::Checking),
        "disable-while-typing" => Some(Verb::Switching),
        "theme" => Some(Verb::Theming),
        "set-log-level" => Some(Verb::Leveling),
        "logs" => Some(Verb::Logging),
        "export-logs" => Some(Verb::Exporting),
        "sleep-displays" => Some(Verb::Sleeping(DisplayPower::Asleep)),
        "wake-displays" => Some(Verb::Sleeping(DisplayPower::Awake)),
        "power-off" => Some(Verb::Powering(Power::Off)),
        "reboot" => Some(Verb::Powering(Power::Reboot)),
        "log-out" => Some(Verb::Powering(Power::LogOut)),
        "monitor" => Some(Verb::Monitoring),
        "subscribe" => Some(Verb::Subscribing),
        "lock" => Some(Verb::Asking(Request::Lock)),
        "focus-window" => Some(Verb::Acting(WindowAct::Focus)),
        "close-window" => Some(Verb::Acting(WindowAct::Close)),
        "kill-window" => Some(Verb::Acting(WindowAct::Kill)),
        "inhibit-idle" => Some(Verb::Inhibiting),
        "exec" => Some(Verb::Executing),
        "trace" => Some(Verb::Tracing),
        "configure-display" => Some(Verb::Configuring),
        "list-displays" => Some(Verb::Listing(Listing::Displays)),
        "list-windows" => Some(Verb::Listing(Listing::Windows)),
        "status" => Some(Verb::Listing(Listing::Status)),
        "list-shell-commands" => Some(Verb::Listing(Listing::ShellCommands)),
        "list-bindings" => Some(Verb::Listing(Listing::Bindings)),
        "list-inputs" => Some(Verb::Listing(Listing::Inputs)),
        "idle-time" => Some(Verb::Listing(Listing::IdleTime)),
        "list-agents" => Some(Verb::Listing(Listing::Agents)),
        "stop-agent" => Some(Verb::StoppingAgent),
        "forget-agent" => Some(Verb::Forgetting),
        "mcp" => Some(Verb::Serving),
        "agent" => Some(Verb::Admitting),
        "pointer" => Some(Verb::Pointing),
        "drag" => Some(Verb::Dragging),
        "scroll" => Some(Verb::Scrolling),
        "key" => Some(Verb::Keying),
        "type" => Some(Verb::Typing),
        "devtools" => Some(Verb::DevTooling),
        "accessibility" => Some(Verb::Reading),
        "accessibility-act" => Some(Verb::Accessing),
        _ => None,
    }
}

/// The [`WatchTopic`] `word` names, if any.
fn topic(word: &str) -> Option<WatchTopic> {
    match word {
        "windows" => Some(WatchTopic::Windows),
        "displays" => Some(WatchTopic::Displays),
        "inputs" => Some(WatchTopic::Inputs),
        "status" => Some(WatchTopic::Status),
        _ => None,
    }
}

/// The [`LogLevel`] `word` names, if any.
fn log_level(word: &str) -> Option<LogLevel> {
    [
        LogLevel::Error,
        LogLevel::Warn,
        LogLevel::Info,
        LogLevel::Debug,
        LogLevel::Trace,
    ]
    .into_iter()
    .find(|level| level.name() == word)
}

/// The [`Subsystem`] `word` names, if any.
fn subsystem(word: &str) -> Option<Subsystem> {
    Subsystem::ALL
        .into_iter()
        .find(|subsystem| subsystem.name() == word)
}

/// Every subsystem's name, for an error.
fn subsystem_names() -> String {
    Subsystem::ALL.map(Subsystem::name).join(", ")
}

/// The [`Switch`] `word` names, if any.
fn switch(word: &str) -> Option<Switch> {
    match word {
        "on" => Some(Switch::On),
        "off" => Some(Switch::Off),
        "toggle" => Some(Switch::Toggle),
        _ => None,
    }
}

/// The [`ThemeChange`] `word` names, if any.
fn theme_change(word: &str) -> Option<ThemeChange> {
    match word {
        "light" => Some(ThemeChange::Light),
        "dark" => Some(ThemeChange::Dark),
        "toggle" => Some(ThemeChange::Toggle),
        _ => None,
    }
}

/// What a virtual monitor is asked to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorMode {
    pub size: (u32, u32),
    /// In millihertz.
    pub refresh_mhz: u32,
    pub scale: Scale,
}

/// The mode `said` names: a size as [`monitor_size`] reads it, then
/// optionally a scale, like `3840x2160@30 2`. None for anything else.
pub fn monitor_mode(said: &str) -> Option<MonitorMode> {
    let mut words = said.split_whitespace();
    let (size, refresh_mhz) = monitor_size(words.next()?)?;
    let scale = match words.next() {
        None => Scale::ONE,
        Some(word) => scale_of(word)?,
    };
    words.next().is_none().then_some(MonitorMode {
        size,
        refresh_mhz,
        scale,
    })
}

/// Reads one `configure-display` setting's value into a change, or `None`
/// when it is not one.
type ReadSetting = fn(&str, &mut DisplayChange) -> Option<()>;

/// What `configure-display <display>`'s other words change, like `mode
/// 2560x1440@144 scale 1.25`. A later word for the same setting wins.
fn display_change(mut words: impl Iterator<Item = String>) -> Result<DisplayChange, CliError> {
    let mut change = DisplayChange::default();
    while let Some(setting) = words.next() {
        match setting.as_str() {
            "reset" => change.reset = true,
            "enable" => change.enabled = Some(true),
            "disable" => change.enabled = Some(false),
            _ => {
                let (expected, read): (&'static str, ReadSetting) = match setting.as_str() {
                    "mode" => ("a mode like 2560x1440 or 2560x1440@144", |said, change| {
                        let ((width, height), refresh_mhz) = monitor_size(said)?;
                        change.mode = Some((width, height));
                        change.refresh =
                            said.contains('@').then(|| f64::from(refresh_mhz) / 1000.0);
                        Some(())
                    }),
                    "scale" => ("a scale like 2 or 1.25", |said, change| {
                        change.scale = Some(scale_of(said)?.get());
                        Some(())
                    }),
                    "position" => ("a position like 1920,0", |said, change| {
                        let (x, y) = said.split_once(',')?;
                        change.position = Some((x.parse().ok()?, y.parse().ok()?));
                        Some(())
                    }),
                    "transform" => ("normal, 90, 180 or 270", |said, change| {
                        change.transform = Some(match said {
                            "normal" | "0" => DisplayTransform::Normal,
                            "90" => DisplayTransform::Rotate90,
                            "180" => DisplayTransform::Rotate180,
                            "270" => DisplayTransform::Rotate270,
                            _ => return None,
                        });
                        Some(())
                    }),
                    "adaptive-sync" => ("on or off", |said, change| {
                        change.adaptive_sync = Some(on_or_off(said)?);
                        Some(())
                    }),
                    "hdr" => ("on or off", |said, change| {
                        change.hdr = Some(on_or_off(said)?);
                        Some(())
                    }),
                    "sdr-white" => ("a brightness in nits like 203", |said, change| {
                        change.sdr_white = Some(said.parse().ok().filter(|nits| *nits > 0)?);
                        Some(())
                    }),
                    _ => return Err(CliError::NotADisplayChange { said: setting }),
                };
                let said = words.next().unwrap_or_default();
                if said.is_empty() || read(&said, &mut change).is_none() {
                    return Err(CliError::NotADisplaySetting {
                        setting,
                        said: if said.is_empty() {
                            "nothing".to_string()
                        } else {
                            said
                        },
                        expected,
                    });
                }
            }
        }
    }
    Ok(change)
}

/// `on` or `off`, as true or false.
fn on_or_off(said: &str) -> Option<bool> {
    match said {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

/// The scale `said` names, a number above zero like `2` or `1.5`.
fn scale_of(said: &str) -> Option<Scale> {
    Scale::try_from(said.parse::<f64>().ok()?).ok()
}

/// The refresh rate of a size that names none, in millihertz.
const REFRESH_MHZ: u32 = 60_000;

/// The size `said` names, `<width>x<height>` with an optional `@<hertz>`, and
/// its refresh rate in millihertz. None for anything else, or a zero.
/// `<x>,<y>,<width>x<height>`, an area of the desk in logical pixels.
fn desk_area(said: &str) -> Option<DeskRect> {
    let (x, rest) = said.split_once(',')?;
    let (y, size) = rest.split_once(',')?;
    let (width, height) = size.split_once('x')?;
    Some(DeskRect {
        position: (x.parse().ok()?, y.parse().ok()?),
        size: (width.parse().ok()?, height.parse().ok()?),
    })
}

pub fn monitor_size(said: &str) -> Option<((u32, u32), u32)> {
    let (size, hertz) = match said.split_once('@') {
        Some((size, hertz)) => (size, Some(hertz)),
        None => (said, None),
    };
    let (width, height) = size.split_once('x')?;
    let (width, height) = (width.parse::<u32>().ok()?, height.parse::<u32>().ok()?);
    let refresh_mhz = match hertz {
        None => REFRESH_MHZ,
        Some(hertz) => {
            let hertz = hertz
                .parse::<f64>()
                .ok()
                .filter(|hertz| hertz.is_finite())?;
            // Rounded, so 59.94 is 59940 rather than 59939.
            let millihertz = (hertz * 1000.0).round();
            (millihertz >= 1.0 && millihertz <= f64::from(u32::MAX)).then_some(millihertz as u32)?
        }
    };
    (width > 0 && height > 0).then_some(((width, height), refresh_mhz))
}
