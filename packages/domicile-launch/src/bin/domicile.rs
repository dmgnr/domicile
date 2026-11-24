//! The `domicile` binary: runs a desktop, or sends a command to a running one.
//!
//! Logic with decisions lives in `domicile_launch` with unit tests. This file
//! only reads the environment and starts processes, which CI cannot test
//! without a display. These scripts cover the wiring:
//! - `packages/e2e-harness/tests/test-the-control-socket.sh`
//! - `packages/e2e-harness/tests/test-a-desktop-that-fails-says-why.sh` (restart loop with real
//!   processes)
//! - `packages/e2e-harness/tests/test-a-running-desktop-takes-a-new-shell.sh` (`load-shell`
//!   end to end)

use std::io::{BufRead, BufReader, IsTerminal, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use domicile_host::data_dirs::data_dirs;
use domicile_host::desk_terminal;
use domicile_host::mime_apps::lists;
use domicile_launch::accessibility::{self, AtSpi, Element};
use domicile_launch::agent_lending::{admit, forward_actions, DECIDING_WITHIN};
use domicile_launch::app_entry::app_entry;
use domicile_launch::build_progress::{bar, heard, Heard as BuilderHeard, Step};
use domicile_launch::cli::{invocation, CliError, Invocation, Listing, MonitorMode};
use domicile_launch::command_socket::{
    browser_profiles, clear_browsing_data, clear_site_data, config_extensions, configure_extension,
    delete_history, devtools, disable_while_typing, extensions, history, load_shell, load_unpacked,
    media_devices, open_app, open_url, pin_browser_site, run_app, set_extension_enabled,
    set_log_levels as set_engine_log_levels, set_media_device, set_site_permission, site_data,
    site_permissions, uninstall_extension, visits,
};
use domicile_launch::commands;
use domicile_launch::component_log::{self, Sink};
use domicile_launch::components::{
    builder, components, electron_host, engine as engine_path, our_shell,
    perfetto as perfetto_path, version_file, Components,
};
use domicile_launch::compositor_socket::{
    act_on_window, agents, configure_display, displays, emulate, forget_agent, idle_time, inputs,
    launch, lock, monitors, open_link, power_displays, screen_record, screenshot, send_shell,
    set_log_levels, shell_bindings, shell_commands, shoot_desk, status, stop_agent, theme, windows,
};
use domicile_launch::config_check::check;
use domicile_launch::config_path::{config_file, is_module, ConfigFile};
use domicile_launch::config_watch;
use domicile_launch::control::{
    answer, Desktop as ControlDesktop, Request, Response, SettingsFiles,
};
use domicile_launch::control_socket::{
    address, advertised, ask, hold, listen, serve_one, take, Control, Lenders,
    PATIENCE as ANSWER_WITHIN, VARIABLE,
};
use domicile_launch::dev::{dev_socket, going_back, loading};
use domicile_launch::electron_app::{
    app_icon, app_name, electron_app, journal_name, UNSUPPORTED_EXIT,
};
use domicile_launch::electron_schemes::{self, schemes_switch, with_known};
use domicile_launch::electron_wrapper::{record, through_wrappers, WrapperError, RECORD};
use domicile_launch::engine_log::EngineLog;
use domicile_launch::engine_log_levels::{engine_levels, starting_switches};
use domicile_launch::graphical_session;
use domicile_launch::heard::Heard;
use domicile_launch::help::{command_help, error, overview, version_lines, with_usage};
use domicile_launch::history::CLEAR_WITHIN;
use domicile_launch::idle_inhibit::{exit_code, inhibit_idle};
use domicile_launch::install_app::{data_home, install_app, Fetched};
use domicile_launch::journal::{self, stderr_is_the_journal};
use domicile_launch::launcher_log;
use domicile_launch::listing::{
    agents_table, bindings_table, displays_table, inputs_table, log_levels_table,
    shell_commands_table, status_table, windows_table,
};
use domicile_launch::log_export;
use domicile_launch::man;
use domicile_launch::mcp;
use domicile_launch::milestones::{reach, Milestone, Stalled};
use domicile_launch::monitor_lending::{forward_sizes, lend};
use domicile_launch::notification;
use domicile_launch::open::{
    app_opening, claimable, opener, opening, AppOpening, Opening, Places, DESKTOP,
};
use domicile_launch::paint::{Paint, Style};
use domicile_launch::platform::platform;
use domicile_launch::power::{confirmed, Power};
use domicile_launch::profile_claim::claim;
use domicile_launch::profile_path::{profile_directory, state_directory};
use domicile_launch::recent_log::{self, from_the_journal};
use domicile_launch::restart::{
    clear_the_last_compositor, clear_the_last_engine, clear_the_last_one, keep_a_desktop_up,
    keep_the_parts_up, renderer_unavailable, restarts, Attempt, Ending, PartAttempt, Policy,
    Started, CLEANLY,
};
use domicile_launch::serving::serve;
use domicile_launch::session::Session;
use domicile_launch::shell_path::{Shell, ShellFiles};
use domicile_launch::shell_source::{shell_source, ShellSource};
use domicile_launch::software_compositing::{self, on_the_cpu};
use domicile_launch::spawn::{
    composite_on_the_cpu, compositor, engine, let_the_engine_open_links, let_the_engine_take_input,
    send_frames_in_memory, the_engine_takes_input, Runtime,
};
use domicile_launch::splash::{lay_out, tell, the_page_ends, Progress, ENDED};
use domicile_launch::startup::{self, at_home, built_in, done, heading, row, up_line, Chosen};
use domicile_launch::subscription::follow;
use domicile_launch::supervise::{catch_interrupts, interrupted, Listener, Running, ASK_EVERY};
use domicile_launch::trace::{self, producer_socket};
use domicile_launch::uninstall_app::uninstall_app;
use domicile_launch::version::engine as engine_version;
use domicile_protocol::{LogLevels, Theme, WatchTopic, WindowKind};

/// How long each startup milestone may take. A debug build on a loaded
/// machine takes seconds.
const PATIENCE: Duration = Duration::from_secs(30);

/// How long the supervisor waits for the engine to answer `load_shell`. The
/// engine waits for its shell window's first page, then for the new shell to
/// say whether it ran (`kShellRunsWithin` in domicile_command_socket.cc), so
/// a shell that did not run is refused rather than timed out.
const LOAD_WITHIN: Duration = Duration::from_secs(10);

/// How long a screenshot may take: the compositor reads back every monitor
/// and encodes a PNG, which for several 4K monitors takes seconds.
const CAPTURE_WITHIN: Duration = Duration::from_secs(10);

/// How long the engine has to answer `devtools`: past the 10s it gives the
/// page, so its own refusal arrives rather than a timeout.
const DEVTOOLS_WITHIN: Duration = Duration::from_secs(12);

/// How long the supervisor waits for the compositor to lay the desktop out
/// again after `configure-display`. Longer than the compositor's own 5s, so
/// its refusal reaches the terminal rather than a timeout.
const CONFIGURE_WITHIN: Duration = Duration::from_secs(8);

/// How long the compositor may take to send a shell command. Shorter than the
/// client waits for the supervisor, so the compositor's failure reaches the
/// terminal rather than a timeout.
const SEND_WITHIN: Duration = Duration::from_secs(2);

/// How long a first build may take before the splash shows. A cached build
/// answers well within it, so the desk starts on its shell.
const SPLASH_AFTER: Duration = Duration::from_millis(500);

/// Seconds `install-app` gives each fetch.
const FETCH_WITHIN: &str = "30";

/// How many of the compositor's last stderr lines to repeat when a run gives
/// up.
///
/// Fits a typical config error (about six lines) without repeating a whole
/// panic backtrace.
const WORTH_REPEATING: usize = 20;

fn main() -> ExitCode {
    // An Electron app's wrappers reached its program: see `electron_wrapper`.
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|first| first == RECORD) {
        return match record(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(said) => {
                eprintln!("domicile: {said}");
                ExitCode::FAILURE
            }
        };
    }
    match run() {
        Ok(code) => code,
        Err(said) => fail(&said),
    }
}

/// How to paint what goes to stdout.
fn out() -> Paint {
    Paint::for_stream(std::io::stdout().is_terminal(), &|name| {
        std::env::var(name).ok()
    })
}

/// How to paint what goes to stderr.
fn err() -> Paint {
    Paint::for_stream(std::io::stderr().is_terminal(), &|name| {
        std::env::var(name).ok()
    })
}

/// Prints `said` as an error and fails.
fn fail(said: &str) -> ExitCode {
    eprint!("{}", error(err(), said));
    ExitCode::FAILURE
}

/// A refused command line, with the usage of the command it named.
fn refused(why: &CliError) -> String {
    let named = std::env::args()
        .nth(1)
        .and_then(|first| commands::command(&first));
    match (why, named) {
        (CliError::UnknownCommand { .. }, _) | (_, None) => why.to_string(),
        (_, Some(command)) => with_usage(err(), &why.to_string(), command),
    }
}

fn run() -> Result<ExitCode, String> {
    match invocation(std::env::args().skip(1)).map_err(|why| refused(&why))? {
        // A typo of a command, rather than a shell: no path, no package.
        Invocation::Run {
            shell: Some(word), ..
        } if !word.contains(['/', '.', '@', ':'])
            && !Path::new(&word).exists()
            && commands::meant(&word).is_some() =>
        {
            Err(CliError::UnknownCommand {
                meant: commands::meant(&word),
                said: word,
            }
            .to_string())
        }
        Invocation::Run { shell, config } => desktop(shell.as_deref(), config.as_deref()),
        Invocation::Ask { request } => asked(&request),
        Invocation::Load { shell } => asked(&shell_to_load(&shell)?),
        Invocation::Dev { entry } => developed(&entry),
        Invocation::Open { target, profile } => opened(&target, profile),
        Invocation::Opener { target } => {
            let id = opener(&target, &typed_in()?, &places()).map_err(|why| why.to_string())?;
            if let Some(id) = id {
                println!("{id}");
            }
            Ok(ExitCode::SUCCESS)
        }
        Invocation::OpenElectron { target, command } => electron_opened(&target, &command),
        Invocation::OpenAsApp {
            target,
            id,
            reuse,
            profile,
        } => {
            let here = typed_in()?;
            match app_opening(&target, &here).map_err(|why| why.to_string())? {
                AppOpening::Module(_) if id.is_some() => Err(format!(
                    "--id is for a site; {target} is an app module, which opens \
                     a window of its own each time"
                )),
                AppOpening::Module(_) if profile.is_some() => Err(format!(
                    "--profile is for a site; {target} is an app module, whose \
                     page is its app's, in no browser profile"
                )),
                AppOpening::Module(entry) => ran_app(&entry, &here),
                AppOpening::Address(url) => asked(&Request::OpenApp {
                    url,
                    id,
                    reuse,
                    profile,
                }),
            }
        }
        // Absolute here, since the compositor does not share this working
        // directory.
        Invocation::Screenshot { file } => asked(&Request::Screenshot {
            file: file
                .map(|file| {
                    std::path::absolute(&file)
                        .map_err(|why| format!("cannot tell where {file} is: {why}"))
                })
                .transpose()?,
        }),
        // Absolute here, as for `Screenshot`.
        Invocation::ShootDesk { file, fit, area } => asked(&Request::ShootDesk {
            file: std::path::absolute(&file)
                .map_err(|why| format!("cannot tell where {file} is: {why}"))?,
            fit,
            area,
        }),
        Invocation::Check { config } => check(&config).map(|()| ExitCode::SUCCESS),
        Invocation::Power { power } => powered(power),
        Invocation::Monitor { name, mode } => monitored(name, mode),
        Invocation::List { listing, json } => listed(listing, json),
        Invocation::Subscribe { topics } => subscribed(topics),
        Invocation::InhibitIdle { command } => {
            let status = inhibit_idle(&command)?;
            Ok(ExitCode::from(exit_code(status)))
        }
        Invocation::Mcp { http: None } => agents_served(),
        Invocation::Mcp { http: Some(http) } => agents_served_over_http(http),
        Invocation::McpRelay { relay } => agents_served_through_relay(relay),
        Invocation::Agent { name } => admitted(name),
        Invocation::Accessibility { window } => {
            let (pid, title) = native_window(&window)?;
            let mut bus = AtSpi::connected()?;
            let root = accessibility::window(&mut bus, pid, &title)?;
            print!("{}", accessibility::outline(&mut bus, &root)?);
            Ok(ExitCode::SUCCESS)
        }
        Invocation::AccessibilityAct {
            window,
            element,
            act,
        } => {
            let (pid, _) = native_window(&window)?;
            let element = Element::named(&element).ok_or_else(|| {
                format!("{element} is not an element's ref, as accessibility prints them")
            })?;
            accessibility::act_on(&mut AtSpi::connected()?, pid, &element, &act)?;
            Ok(ExitCode::SUCCESS)
        }
        Invocation::Help { command: None } => {
            print!("{}", overview(out()));
            Ok(ExitCode::SUCCESS)
        }
        Invocation::Help {
            command: Some(name),
        } => {
            let command = commands::command(&name).expect("the parser asks only for commands");
            print!("{}", command_help(out(), command));
            Ok(ExitCode::SUCCESS)
        }
        Invocation::Manuals { dir } => {
            std::fs::create_dir_all(&dir)
                .map_err(|why| format!("cannot make {}: {why}", dir.display()))?;
            for (file, page) in man::pages() {
                let path = dir.join(file);
                std::fs::write(&path, page)
                    .map_err(|why| format!("cannot write {}: {why}", path.display()))?;
            }
            Ok(ExitCode::SUCCESS)
        }
        Invocation::Version => versioned(),
        Invocation::Trace { file, seconds } => {
            // Absolute here, since the recorder may not share this working
            // directory.
            let file = std::path::absolute(&file)
                .map_err(|why| format!("cannot tell where {file} is: {why}"))?;
            traced_to(&file, Duration::from_secs(seconds))
        }
        Invocation::Logs { follow } => logs_printed(follow),
        Invocation::ExportLogs { file, redact } => {
            let file = file.unwrap_or_else(|| log_export::file_name(recent_log::now()));
            // Absolute here, since the desktop does not share this working
            // directory.
            asked(&Request::ExportLogs {
                file: std::path::absolute(&file)
                    .map_err(|why| format!("cannot tell where {file} is: {why}"))?,
                redact,
            })
        }
        Invocation::InstallApp { url } => installed(&url),
        Invocation::UninstallApp { url } => uninstalled(&url),
    }
}

/// Prints the desktop's logs: with `journalctl` when they go to the journal,
/// following them if `follow`; else the lines the desktop kept.
fn logs_printed(follow: bool) -> Result<ExitCode, String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    match ask(&socket, &Request::RecentLogs, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())? {
        Response::RecentLogs { journal: true, .. } => {
            let status = Command::new("journalctl")
                .args(recent_log::journal_args())
                .args(follow.then_some("--follow"))
                .status()
                .map_err(|why| format!("cannot run journalctl: {why}"))?;
            Ok(ExitCode::from(exit_code(status)))
        }
        Response::RecentLogs { lines, .. } => {
            for line in lines {
                println!("{line}");
            }
            match follow {
                false => Ok(ExitCode::SUCCESS),
                true => Err("this desktop's logs go to the terminal or file it started \
                     with, not the journal, so follow them there. Above are the newest \
                     lines it kept."
                    .to_string()),
            }
        }
        Response::Refused { why } => Err(why),
        other => Err(format!(
            "the desktop answered recent_logs with {other:?}, which is not its logs"
        )),
    }
}

/// Runs Perfetto's service where this desktop's engine reports, waits for the
/// engine to attach, and records `duration` of trace events to `file`. See
/// `domicile_launch::trace`.
fn traced_to(file: &Path, duration: Duration) -> Result<ExitCode, String> {
    let control =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let env = |name: &str| std::env::var(name).ok();
    let perfetto = perfetto_path(&myself()?, &env, &|path| path.exists())
        .map_err(|missing| missing.to_string())?;
    let producer = producer_socket(&control);
    if producer.exists() {
        return Err(format!(
            "{} exists, so another domicile trace is recording this desktop. \
             If none is, it was left by one that was killed: delete it.",
            producer.display()
        ));
    }
    let consumer = std::env::temp_dir().join(format!("domicile-trace.{}.sock", std::process::id()));
    let service = trace::traced(&perfetto, &producer, &consumer);
    let mut service = Command::new(&service.program)
        .envs(service.env)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|why| format!("cannot run {}: {why}", service.program.display()))?;
    let recorded = recorded_with(&perfetto, &consumer, file, duration, &mut service);
    // `traced` leaves its sockets behind when killed.
    let _ = service.kill();
    let _ = service.wait();
    for socket in [&producer, &consumer] {
        let _ = std::fs::remove_file(socket);
    }
    recorded?;
    let paint = out();
    println!(
        "{} Wrote {}. Open it at {}",
        paint.style(Style::Good, "✓"),
        paint.style(Style::Bold, &file.display().to_string()),
        paint.style(Style::Placeholder, "https://ui.perfetto.dev"),
    );
    Ok(ExitCode::SUCCESS)
}

/// Waits for the engine to attach to `service`, then records `duration` to
/// `file`.
fn recorded_with(
    perfetto: &Path,
    consumer: &Path,
    file: &Path,
    duration: Duration,
    service: &mut std::process::Child,
) -> Result<(), String> {
    let paint = err();
    eprintln!(
        "{} Waiting {} s for the engine to attach",
        paint.style(Style::Dim, "○"),
        trace::ATTACH_WITHIN.as_secs()
    );
    std::thread::sleep(trace::ATTACH_WITHIN);
    if let Some(status) = service.try_wait().map_err(|why| why.to_string())? {
        return Err(format!(
            "Perfetto's traced stopped before recording: {status}"
        ));
    }
    eprintln!(
        "{} Recording for {} s",
        paint.style(Style::Placeholder, "●"),
        duration.as_secs()
    );
    let recorder = trace::record(perfetto, consumer, file);
    let mut recorder = Command::new(&recorder.program)
        .args(&recorder.args)
        .envs(recorder.env)
        .stdin(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|why| format!("cannot run {}: {why}", recorder.program.display()))?;
    recorder
        .stdin
        .take()
        .expect("the recorder's stdin is piped")
        .write_all(trace::config(duration).as_bytes())
        .map_err(|why| format!("cannot give perfetto its config: {why}"))?;
    let status = recorder.wait().map_err(|why| why.to_string())?;
    match status.success() {
        true => Ok(()),
        false => Err(format!("perfetto did not record: {status}")),
    }
}

/// Prints the version file beside the binary, then the engine's provenance.
fn versioned() -> Result<ExitCode, String> {
    let binary = myself()?;
    let read = |path: &Path| {
        std::fs::read_to_string(path)
            .map_err(|why| format!("cannot read {}: {why}", path.display()))
    };
    let env = |name: &str| std::env::var(name).ok();
    let engine =
        engine_path(&binary, &env, &|path| path.exists()).map_err(|missing| missing.to_string())?;
    let built = read(&version_file(&binary))?;
    let provenance = engine.join("PROVENANCE");
    let engine = engine_version(&read(&provenance)?)
        .map_err(|why| format!("{why}, at {}", provenance.display()))?;
    print!("{}", version_lines(out(), &format!("{built}{engine}\n")));
    Ok(ExitCode::SUCCESS)
}

/// Opens `target` with what opens its type, started by the running desktop's
/// compositor, or in a browser window of the running desktop, in browser profile `profile` when
/// given; see `domicile_launch::open`. Only a web address takes a profile.
fn opened(target: &str, profile: Option<String>) -> Result<ExitCode, String> {
    // A shell page that claims the link's scheme, such as manganese's inbox
    // picker for `mailto:`, opens it instead of an application.
    if claimable(target) && profile.is_none() && link_taken(target)? {
        return Ok(ExitCode::SUCCESS);
    }
    match opening(target, &typed_in()?, &places()).map_err(|why| why.to_string())? {
        Opening::Browse(url) => asked(&Request::OpenUrl { url, profile }),
        Opening::Run(_) if profile.is_some() => Err(CliError::ProfileForAFile {
            target: target.to_string(),
        }
        .to_string()),
        // The compositor starts it, as the launcher would: whoever asked,
        // such as the engine's `xdg-open`, may lack the desktop's
        // environment.
        Opening::Run(command) => asked(&Request::Launch { command }),
    }
}

/// Hands `url` to the shell page that claims its scheme: true when one took
/// it, false when none claims it.
fn link_taken(url: &str) -> Result<bool, String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let request = Request::OpenLink {
        url: url.to_string(),
    };
    match ask(&socket, &request, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())? {
        Response::Opened => Ok(true),
        Response::Unclaimed => Ok(false),
        Response::Refused { why } => Err(why),
        other => Err(format!("the desktop answered open_link with {other:?}")),
    }
}

/// Runs the installed Electron app `target` on the engine, through
/// `electron-host`; see `domicile_launch::electron_app`. An app that needs
/// what the engine doesn't do yet runs on its own Electron instead, with a
/// notification saying so, when there is a `command` or entry to run.
/// How long an app's wrappers may take to reach its program.
const WRAPPERS_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

fn electron_opened(target: &str, command: &[String]) -> Result<ExitCode, String> {
    let applications: Vec<PathBuf> = places()
        .data_dirs
        .iter()
        .map(|dir| dir.join("applications"))
        .collect();
    let path = std::env::var_os("PATH");
    let app = electron_app(
        target,
        command,
        &typed_in()?,
        &applications,
        path.as_deref(),
    )
    .map_err(|why| why.to_string())?;
    let env = |name: &str| std::env::var(name).ok();
    let host = electron_host(&myself()?, &env, &|path| path.exists())
        .map_err(|missing| missing.to_string())?;
    let recorder = myself()?;
    let mut run = Command::new(&host);
    run.arg(&app.resources);
    // What the app's wrappers set (a preloaded library, programs on PATH,
    // flags) reaches it on the engine too. An app run straight from its
    // binary has none.
    match app
        .fallback
        .as_deref()
        .map(|command| through_wrappers(command, &app.resources, &recorder, WRAPPERS_WAIT))
    {
        Some(Ok(launch)) => {
            run.args(&launch.args).env_clear().envs(launch.env);
        }
        Some(Err(WrapperError::NotBash { .. })) | None => {
            run.args(&app.args);
        }
        Some(Err(why)) => {
            eprintln!("domicile: {target} runs on the engine without what its wrappers set: {why}");
            run.args(&app.args);
        }
    }
    let journal = journal_name(target, &app.resources);
    own_stream(&mut run, &journal);
    let status = run
        .status()
        .map_err(|why| format!("cannot run {}: {why}", host.display()))?;
    match (status.code(), app.fallback) {
        (Some(UNSUPPORTED_EXIT), Some(fallback)) => {
            // The host said why on stderr, which the desktop's log keeps.
            // The app by its own name: `target` may be a store path.
            let name = app_name(&app.resources).unwrap_or_else(|why| {
                eprintln!("domicile: {target} names itself nothing readable: {why}");
                target.to_string()
            });
            let said = notification::session_bus().and_then(|bus| {
                notification::notify(
                    &bus,
                    &app_icon(target, &app.resources, &applications),
                    &format!("{name} runs on its own Electron"),
                    "It needs something Domicile's engine doesn't do yet, so its \
                     windows aren't the desktop's own this time.",
                )
            });
            if let Err(why) = said {
                eprintln!("domicile: cannot say {target} runs on its own Electron: {why}");
            }
            let (program, args) = fallback
                .split_first()
                .expect("an app's command has a program");
            let mut fallback = Command::new(program);
            fallback.args(args);
            own_stream(&mut fallback, &journal);
            Err(format!("cannot run {program}: {}", fallback.exec()))
        }
        _ => Ok(ExitCode::from(exit_code(status))),
    }
}

/// Gives an Electron app its own journal stream under `name`, when this
/// command's output is the journal, so the app's lines are not the
/// `domicile` command's. Without one, it writes where this command does.
fn own_stream(run: &mut Command, name: &str) {
    if !journal::is_the_journal(std::os::fd::AsFd::as_fd(&std::io::stdout())) {
        return;
    }
    if let Err(why) = journal::give_stream(run, Path::new(journal::STREAM_SOCKET), name) {
        eprintln!("domicile: {name} writes where this command does: no journal stream: {why}");
    }
}

/// Where this desk's types and defaults are, from the XDG environment.
fn places() -> Places {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data_dirs = data_dirs(
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("XDG_DATA_DIRS"),
        home.as_deref(),
    );
    let applications: Vec<PathBuf> = data_dirs
        .iter()
        .map(|dir| dir.join("applications"))
        .collect();
    Places {
        lists: lists(
            std::env::var_os("XDG_CONFIG_HOME"),
            std::env::var_os("XDG_CONFIG_DIRS"),
            &applications,
            home.as_deref(),
            DESKTOP,
        ),
        data_dirs,
        // Set by the compositor from its config; see `desk_terminal`.
        terminal: desk_terminal::from_variable(
            std::env::var(desk_terminal::VARIABLE).ok().as_deref(),
        ),
    }
}

/// Runs the app module `entry`, relative to `here`, in an app window.
fn ran_app(entry: &str, here: &Path) -> Result<ExitCode, String> {
    let app = app_entry(Path::new(entry), here)?;
    asked(&Request::RunApp {
        root: app.root,
        module: app.module,
    })
}

/// Runs the command for `power` once the user says yes in the desktop's
/// Access dialog.
///
/// - The command is resolved first, so one that cannot run never asks.
/// - The session bus has no call timeout: the dialog waits on the user.
fn powered(power: Power) -> Result<ExitCode, String> {
    let session = std::env::var("XDG_SESSION_ID").ok();
    let (program, args) = power.command(session.as_deref())?;
    let bus = zbus::blocking::Connection::session()
        .map_err(|why| format!("cannot reach the session bus: {why}"))?;
    match confirmed(&bus, power)? {
        true => Err(format!(
            "cannot run {program}: {}",
            Command::new(program).args(args).exec()
        )),
        false => Ok(ExitCode::SUCCESS),
    }
}

/// Installs the site at `url` as an app and says where its entry went.
fn installed(url: &str) -> Result<ExitCode, String> {
    let home = data_home(&|name| std::env::var(name).ok())
        .ok_or("nowhere to install apps -- neither XDG_DATA_HOME nor HOME is set")?;
    let entry = install_app(url, &home, &curl).map_err(|why| why.to_string())?;
    println!("{}", entry.display());
    Ok(ExitCode::SUCCESS)
}

/// Removes the app installed from or opening `url` and says which files went.
fn uninstalled(url: &str) -> Result<ExitCode, String> {
    let home = data_home(&|name| std::env::var(name).ok())
        .ok_or("no apps to uninstall -- neither XDG_DATA_HOME nor HOME is set")?;
    for removed in uninstall_app(url, &home).map_err(|why| why.to_string())? {
        println!("removed {}", removed.display());
    }
    Ok(ExitCode::SUCCESS)
}

/// Fetches `url` with the `curl` on `PATH`, following redirects.
fn curl(url: &str) -> Result<Fetched, String> {
    let answer = Command::new("curl")
        .args(["--silent", "--show-error", "--fail", "--location"])
        .args(["--max-time", FETCH_WITHIN])
        // After the body, on its own line: where it landed.
        .args(["--write-out", "\\n%{url_effective}", "--", url])
        .output()
        .map_err(|why| format!("cannot run curl, which fetches the site: {why}"))?;
    if !answer.status.success() {
        return Err(String::from_utf8_lossy(&answer.stderr).trim().to_string());
    }
    let mut body = answer.stdout;
    let landed = body
        .iter()
        .rposition(|&byte| byte == b'\n')
        .ok_or("curl did not say where the site landed")?;
    let url = String::from_utf8_lossy(&body[landed + 1..]).into_owned();
    body.truncate(landed);
    Ok(Fetched { url, body })
}

/// Resolves the shell for `domicile load-shell` on the client side.
///
/// Relative paths and `~` must resolve in the user's terminal, since neither
/// the desktop nor the engine shares its working directory. Builds happen here
/// too, so the user sees errors and progress. `DOMICILE_PAGE` is ignored.
fn shell_to_load(shell: &str) -> Result<Request, String> {
    let page = shell_named(shell, None, None)?;
    Ok(Request::LoadShell {
        dev_server: false,
        module: page.module,
        root: page.root,
    })
}

/// The module `shell` names, built first if it is an entry or a package.
///
/// `from` is the base for relative paths when the shell came from a config
/// file: the config's directory. Otherwise the working directory is used.
fn shell_named(shell: &str, handed_in: Option<&str>, from: Option<&Path>) -> Result<Shell, String> {
    match wanted(shell, handed_in, from)? {
        Wanted::Ready(page) | Wanted::Ours(page) => Ok(page),
        Wanted::Built(asked) => built(&myself()?, &asked, &mut |_| {}).and_then(as_shell),
    }
}

/// A shell to serve as it is, or the builder arguments that make one.
enum Wanted {
    Ready(Shell),
    /// One of Domicile's prebuilt shells, which has no source to edit.
    Ours(Shell),
    Built(Vec<std::ffi::OsString>),
}

impl Wanted {
    /// The shell as asked for: a package by its name, anything else by its
    /// file.
    fn shown(&self) -> String {
        match self {
            Wanted::Ready(page) | Wanted::Ours(page) => {
                page.root.join(&page.module).display().to_string()
            }
            Wanted::Built(asked) => asked
                .last()
                .expect("the builder is asked for something")
                .to_string_lossy()
                .into_owned(),
        }
    }

    /// The file the shell is written in, which the Settings app edits: a
    /// module served as is, or an entry the builder builds. A package has
    /// none.
    fn source(&self) -> Option<PathBuf> {
        match self {
            Wanted::Ready(page) => Some(page.root.join(&page.module)),
            Wanted::Ours(_) => None,
            Wanted::Built(asked) => match asked.as_slice() {
                [flag, entry] if flag == "--entry" => Some(PathBuf::from(entry)),
                _ => None,
            },
        }
    }
}

/// What `shell` needs before it can be served; see [`shell_named`].
fn wanted(shell: &str, handed_in: Option<&str>, from: Option<&Path>) -> Result<Wanted, String> {
    let env = |name: &str| std::env::var(name).ok();
    let here = match from {
        Some(directory) => directory.to_path_buf(),
        None => std::env::current_dir()
            .map_err(|why| format!("cannot tell where this was typed: {why}"))?,
    };
    let home = env("HOME").map(PathBuf::from);
    let source = shell_source(
        shell,
        handed_in,
        &here,
        home.as_deref(),
        &|path| path.metadata().ok().map(|found| found.is_dir()),
        &|path| std::fs::read_to_string(path).ok(),
    )
    .map_err(|why| why.to_string())?;
    match source {
        ShellSource::Module(page) => Ok(Wanted::Ready(page)),
        // Prebuilt in the install, so no build is needed.
        ShellSource::Ours(name) => our_shell(&myself()?, &name, &env, &|path| path.exists())
            .map(|root| {
                Wanted::Ours(Shell {
                    root,
                    module: PathBuf::from("shell.js"),
                    files: ShellFiles::Directory,
                })
            })
            .map_err(|missing| missing.to_string()),
        ShellSource::Entry(entry) => Ok(Wanted::Built(vec![
            "--entry".into(),
            entry.into_os_string(),
        ])),
        ShellSource::Package(spec) => Ok(Wanted::Built(vec!["--package".into(), spec.into()])),
    }
}

/// This binary, which the other components are found beside.
fn myself() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|why| format!("cannot find myself: {why}"))
}

/// Runs the shell builder and returns its final result, showing progress.
///
/// On a terminal the bar redraws in place; otherwise each step is one line.
/// Each step also goes to `stepped`. Build log lines are printed only if the
/// build fails.
fn built(
    binary: &Path,
    asked: &[std::ffi::OsString],
    stepped: &mut dyn FnMut(&Step),
) -> Result<BuilderHeard, String> {
    let env = |name: &str| std::env::var(name).ok();
    let builder =
        builder(binary, &env, &|path| path.exists()).map_err(|missing| missing.to_string())?;
    let mut child = Command::new(&builder)
        .args(asked)
        .arg("--cache")
        .arg(shells_cache()?)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|why| {
            format!(
                "cannot start the shell builder {}: {why}",
                builder.display()
            )
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or("the shell builder has no stdout")?;
    let terminal = std::io::stderr().is_terminal();
    let mut log = Vec::new();
    let mut answer = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|why| format!("cannot read the shell builder: {why}"))?;
        match heard(&line) {
            // Off a terminal, the splash shows the progress; the log stays
            // quiet.
            BuilderHeard::Step(step) => {
                if terminal {
                    eprint!("\r\x1b[K{}", bar(err(), &step));
                    let _ = std::io::stderr().flush();
                }
                stepped(&step);
            }
            BuilderHeard::Log(said) => log.push(said),
            BuilderHeard::Failed(why) => answer = Some(Err(why)),
            done => answer = Some(Ok(done)),
        }
    }
    if terminal {
        eprint!("\r\x1b[K");
    }
    let status = child
        .wait()
        .map_err(|why| format!("cannot wait for the shell builder: {why}"))?;
    match answer {
        Some(Ok(done)) if status.success() => Ok(done),
        Some(Err(why)) => Err(format!(
            "the shell did not build: {why}\n{}",
            log.join("\n")
        )),
        _ => Err(format!(
            "the shell builder stopped ({status}) without saying it built anything\n{}",
            log.join("\n")
        )),
    }
}

/// Where the builder keeps built shells and dev servers' dependencies.
fn shells_cache() -> Result<PathBuf, String> {
    let env = |name: &str| std::env::var(name).ok();
    Ok(env("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| env("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .ok_or("nowhere to keep built shells -- neither XDG_CACHE_HOME nor HOME is set")?
        .join("domicile")
        .join("shells"))
}

/// `domicile dev <entry>`: serves the shell whose source starts at `entry`
/// from the builder's dev server, with hot module replacement, until Ctrl-C;
/// then loads the shell it replaced again and stops the dev server.
///
/// The dev server's log, such as each update it sends, goes to this
/// terminal.
fn developed(entry: &str) -> Result<ExitCode, String> {
    let desktop =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let typed = typed_in()?.join(entry);
    let entry = std::fs::canonicalize(&typed)
        .ok()
        .filter(|found| found.is_file())
        .ok_or_else(|| {
            format!(
                "there is no file at {} to serve. dev takes the file your \
                 shell's source starts at, such as src/shell.tsx.",
                typed.display()
            )
        })?;
    let back = going_back(
        ask(&desktop, &Request::WhichShell, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())?,
    )?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").ok_or(
        "XDG_RUNTIME_DIR is not set, and the dev server's socket goes there so \
         only you can open it",
    )?;
    let socket = dev_socket(Path::new(&runtime), std::process::id());
    let builder = builder(&myself()?, &|name| std::env::var(name).ok(), &|path| {
        path.exists()
    })
    .map_err(|missing| missing.to_string())?;
    // Ctrl-C reaches only this process, which loads the old shell before it
    // stops the dev server, so the page never asks a server that is gone.
    catch_interrupts();
    let mut server = Command::new(&builder)
        .arg("--serve")
        .arg(&entry)
        .arg("--socket")
        .arg(&socket)
        .arg("--cache")
        .arg(shells_cache()?)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .process_group(0)
        .spawn()
        .map_err(|why| {
            format!(
                "cannot start the shell builder {}: {why}",
                builder.display()
            )
        })?;
    let stdout = server
        .stdout
        .take()
        .ok_or("the shell builder has no stdout")?;
    let (said, heard_from) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let heard = match line {
                Ok(line) => heard(&line),
                Err(why) => BuilderHeard::Failed(format!("cannot read the dev server: {why}")),
            };
            // Nobody listens once `domicile dev` is stopping.
            if said.send(heard).is_err() {
                break;
            }
        }
    });
    let mut loaded = false;
    let served = developing(&desktop, &entry, &heard_from, &mut loaded);
    // Also after a failure: the page cannot load from a server that is gone.
    let restored = loaded.then(|| asked_quietly(&desktop, &back));
    let stopped = stop(&mut server);
    if let Some(Err(why)) = restored {
        return Err(format!(
            "the dev server stopped, and the shell it replaced did not load \
             again: {why}. Load it yourself with domicile load-shell."
        ));
    }
    served.and(stopped).map(|()| ExitCode::SUCCESS)
}

/// Stops the dev server, which closes Vite and its socket, and waits for it.
fn stop(server: &mut std::process::Child) -> Result<(), String> {
    // SAFETY: `kill` takes any pid and signal. The child is unreaped, so its
    // pid is still its own.
    if unsafe { libc::kill(server.id() as libc::pid_t, libc::SIGTERM) } != 0 {
        return Err(format!(
            "cannot stop the dev server: {}",
            std::io::Error::last_os_error()
        ));
    }
    match server.wait() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("the dev server did not stop cleanly ({status})")),
        Err(why) => Err(format!("cannot wait for the dev server to stop: {why}")),
    }
}

/// Loads the dev server's shell once it serves, setting `loaded`, and passes
/// on its log, until a stop or why the dev server failed.
fn developing(
    desktop: &Path,
    entry: &Path,
    heard_from: &Receiver<BuilderHeard>,
    loaded: &mut bool,
) -> Result<(), String> {
    let terminal = std::io::stderr().is_terminal();
    while !interrupted() {
        match heard_from.recv_timeout(ASK_EVERY) {
            Ok(BuilderHeard::Step(step)) => {
                if terminal {
                    eprint!("\r\x1b[K{}", bar(err(), &step));
                    let _ = std::io::stderr().flush();
                }
            }
            Ok(BuilderHeard::Serving(shell)) => {
                if terminal {
                    eprint!("\r\x1b[K");
                }
                asked_quietly(desktop, &loading(&shell))?;
                *loaded = true;
                eprintln!(
                    "domicile: serving {} with hot module replacement. Press \
                     Ctrl-C to go back to the shell it replaced.",
                    entry.display()
                );
            }
            Ok(BuilderHeard::Log(said)) => eprintln!("{said}"),
            Ok(BuilderHeard::Failed(why)) => {
                return Err(format!("the dev server failed: {why}"));
            }
            Ok(other) => {
                return Err(format!("the shell builder answered dev with {other:?}"));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("the dev server stopped by itself".into());
            }
        }
    }
    Ok(())
}

/// Sends the `load_shell` `request` to the desktop, and passes on a refusal
/// as an error.
fn asked_quietly(desktop: &Path, request: &Request) -> Result<(), String> {
    match ask(desktop, request, Some(LOAD_WITHIN + ANSWER_WITHIN)).map_err(|why| why.to_string())? {
        Response::Shell { .. } => Ok(()),
        Response::Refused { why } => Err(why),
        other => Err(format!(
            "the desktop answered load-shell with {other:?}, which is not a shell"
        )),
    }
}

/// Extracts the built module from the builder's result.
fn as_shell(heard: BuilderHeard) -> Result<Shell, String> {
    match heard {
        BuilderHeard::Built(page) => Ok(page),
        other => Err(format!("the shell builder answered a build with {other:?}")),
    }
}

/// Evaluates the module config at `config` to JSON with the builder.
fn evaluated_json(binary: &Path, config: &Path) -> Result<PathBuf, String> {
    match built(
        binary,
        &["--evaluate".into(), config.as_os_str().to_os_string()],
        &mut |_| {},
    )? {
        BuilderHeard::Evaluated(json) => Ok(json),
        other => Err(format!(
            "the shell builder answered an evaluation with {other:?}"
        )),
    }
}

/// The `shell` key of a JSON config, if any. The compositor reads the other
/// keys.
fn shell_in(config: &Path) -> Option<String> {
    let json = config
        .extension()
        .is_some_and(|extension| extension == "json");
    json.then(|| std::fs::read_to_string(config).ok())
        .flatten()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("shell")?.as_str().map(str::to_string))
}

/// The directory containing `config`, which a shell it names is relative to.
fn beside(config: &Path) -> PathBuf {
    config
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// Sends one request to the running desktop and prints its response.
/// The directory the command was typed in, which a relative address is
/// relative to.
fn typed_in() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|why| format!("cannot tell where this was typed: {why}"))
}

fn asked(request: &Request) -> Result<ExitCode, String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let patience = match request {
        // Longer than the supervisor waits for the compositor, so the
        // compositor's own failure reaches this terminal rather than a timeout.
        Request::Screenshot { file: Some(_) } => Some(CAPTURE_WITHIN + ANSWER_WITHIN),
        // The user picks the area, however long that takes. A desktop that
        // dies hangs up, which ends the wait.
        Request::Screenshot { file: None } => None,
        // The user stops it, however long that takes.
        Request::ScreenRecord => None,
        // Longer than the supervisor waits for the engine, so why a shell
        // did not run reaches this terminal rather than a timeout.
        Request::LoadShell { .. } => Some(LOAD_WITHIN + ANSWER_WITHIN),
        Request::ConfigureDisplay { .. } => Some(CONFIGURE_WITHIN + ANSWER_WITHIN),
        Request::ShootDesk { .. } => Some(CAPTURE_WITHIN + ANSWER_WITHIN),
        Request::DevTools { .. } => Some(DEVTOOLS_WITHIN + ANSWER_WITHIN),
        Request::ExportLogs { .. } => Some(log_export::EXPORT_WITHIN),
        // Longer than the supervisor waits for the compositor, so its own
        // failure reaches this terminal rather than a timeout.
        Request::Launch { .. } => Some(ANSWER_WITHIN + ANSWER_WITHIN + ANSWER_WITHIN),
        _ => Some(ANSWER_WITHIN),
    };
    let answer = ask(&socket, request, patience).map_err(|why| why.to_string())?;
    match answer {
        Response::Shell { module, .. } => {
            println!("{}", module.display());
            Ok(ExitCode::SUCCESS)
        }
        Response::Sent { output } => {
            // A query's answer, such as Manganese's `get-tree`.
            if let Some(output) = output {
                println!("{}", output.trim_end());
            }
            Ok(ExitCode::SUCCESS)
        }
        Response::Opened | Response::Powered | Response::Done => Ok(ExitCode::SUCCESS),
        Response::DisableWhileTyping { enabled } => {
            println!("{}", if enabled { "on" } else { "off" });
            Ok(ExitCode::SUCCESS)
        }
        Response::DevTools { result } => {
            println!("{result}");
            Ok(ExitCode::SUCCESS)
        }
        Response::LogLevels { levels } => {
            print!("{}", log_levels_table(out(), &levels));
            Ok(ExitCode::SUCCESS)
        }
        // `domicile logs` reads these itself; see `logs_printed`.
        Response::RecentLogs { lines, .. } => {
            for line in lines {
                println!("{line}");
            }
            Ok(ExitCode::SUCCESS)
        }
        Response::ExportedLogs { file, unhidden } => {
            let paint = out();
            println!(
                "{} Wrote {}",
                paint.style(Style::Good, "✓"),
                paint.style(Style::Bold, &file.display().to_string()),
            );
            if let Some(unhidden) = unhidden {
                eprintln!("domicile: {unhidden}");
            }
            Ok(ExitCode::SUCCESS)
        }
        Response::Theme { theme } => {
            println!(
                "{}",
                match theme {
                    Theme::Light => "light",
                    Theme::Dark => "dark",
                }
            );
            Ok(ExitCode::SUCCESS)
        }
        Response::Captured { file } => {
            println!("{}", file.display());
            Ok(ExitCode::SUCCESS)
        }
        Response::DeskShot { shot } => {
            println!(
                "{}",
                serde_json::to_string(&shot).expect("a desk shot serializes")
            );
            Ok(ExitCode::SUCCESS)
        }
        // Nothing on stdout: there is no file.
        Response::Copied => {
            eprintln!(
                "{} Copied the screenshot to the clipboard",
                err().style(Style::Good, "✓")
            );
            Ok(ExitCode::SUCCESS)
        }
        // A failure, so `f=$(domicile screenshot) && …` stops here.
        Response::Canceled => {
            Ok(fail(match request {
                Request::ScreenRecord => "the screen recording was canceled",
                _ => "the screenshot was canceled",
            }))
        }
        // Only `domicile monitor` asks for this, and holds the connection.
        Response::VirtualMonitor { .. }
        // Only `domicile agent` asks for this, and holds the connection.
        | Response::Agent { .. }
        // `subscribed` asks for these.
        | Response::Heard { .. }
        // Only `link_taken` asks for this.
        | Response::Unclaimed
        // Only `domicile-app-host` asks for these.
        | Response::SettingsFiles { .. }
        | Response::SitePermissions(_)
        | Response::Stored
        | Response::LoadedUnpacked { .. }
        | Response::Uninstalled
        | Response::ConfigExtensions { .. }
        | Response::MediaDevices(_)
        | Response::Extensions { .. }
        | Response::BrowserProfiles(_)
        | Response::History { .. }
        | Response::Visits { .. }
        | Response::Deleted
        | Response::Cleared
        | Response::SiteData { .. }
        | Response::Monitors { .. }
        // `listed` asks for these.
        | Response::Displays { .. }
        | Response::Windows { .. }
        | Response::Status { .. }
        | Response::ShellCommands { .. }
        | Response::ShellBindings { .. }
        | Response::Inputs { .. }
        | Response::IdleTime { .. }
        | Response::Agents { .. } => Err(format!(
            "the desktop answered {answer:?}, which no command asks for"
        )),
        // Print the desktop's own reason.
        Response::Refused { why } => Ok(fail(&why)),
    }
}

/// Asks the running desktop for `listing` and prints it as a table, or with
/// `json` as the JSON array it answered with.
/// Serves the Model Context Protocol on stdio, each tool running this
/// binary.
/// The process and title of native window `id`, as `list-windows` lists it,
/// while the desktop is unlocked.
fn native_window(id: &str) -> Result<(u32, String), String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let asked =
        |request| ask(&socket, &request, Some(ANSWER_WITHIN)).map_err(|why| why.to_string());
    match asked(Request::Status)? {
        Response::Status { status, .. } if status.locked => {
            return Err("the desktop is locked".to_string())
        }
        Response::Status { .. } => {}
        other => return Err(format!("the desktop answered status with {other:?}")),
    }
    let Response::Windows { windows } = asked(Request::Windows)? else {
        return Err("the desktop did not answer with its windows".to_string());
    };
    let window = windows
        .into_iter()
        .find(|window| window.id == id)
        .ok_or_else(|| format!("there is no window {id}; list-windows lists them"))?;
    match (window.kind, window.pid) {
        (WindowKind::Native, Some(pid)) => Ok((
            u32::try_from(pid).map_err(|_| format!("window {id} has process id {pid}"))?,
            window.title,
        )),
        (WindowKind::Native, None) => {
            Err(format!("the desktop does not know window {id}'s process"))
        }
        (WindowKind::Browser, _) => Err(format!(
            "window {id} is a browser window; devtools, and an agent's browser_ tools, read and drive those"
        )),
    }
}

fn agents_served() -> Result<ExitCode, String> {
    let binary = myself()?;
    mcp::serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |args| {
            let output = Command::new(&binary).args(args).output()?;
            Ok(mcp::Ran {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            })
        },
        |name| let_in(&binary, name),
    )
    .map_err(|why| format!("mcp: {why}"))?;
    Ok(ExitCode::SUCCESS)
}

/// Serves the Model Context Protocol over HTTP at `http`, each session's
/// tools running this binary, signed in as [`mcp::Web`] describes.
fn agents_served_over_http(http: domicile_launch::cli::McpHttp) -> Result<ExitCode, String> {
    let listener = std::net::TcpListener::bind(http.listen)
        .map_err(|why| format!("mcp: could not listen on {}: {why}", http.listen))?;
    let base = http
        .url
        .unwrap_or_else(|| format!("http://{}", http.listen));
    agents_served_at(listener, base)
}

/// Serves agents on the web through the relay at `relay`, or Domicile's: an
/// HTTP server on this computer, which the relay's connections reach once
/// the desk ends their TLS; see `domicile_launch::mcp::web`.
fn agents_served_through_relay(relay: Option<String>) -> Result<ExitCode, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|why| format!("mcp: could not listen on this computer: {why}"))?;
    let local = listener.local_addr().map_err(|why| format!("mcp: {why}"))?;
    let relay = relay.unwrap_or_else(|| mcp::web::RELAY.to_string());
    let host = mcp::web::reach(mcp::web::Reach {
        relay: relay.clone(),
        state: state_directory(&|name| std::env::var(name).ok())
            .map(|directory| directory.join("relay.json")),
        directory: mcp::web::LETS_ENCRYPT.to_string(),
        local,
        clock: Arc::new(milliseconds_now),
        status: mcp::web::status_file(&|name| std::env::var(name).ok()),
    })
    .map_err(|why| format!("mcp: could not reach the relay at {relay}: {why}"))?;
    agents_served_at(listener, format!("https://{host}"))
}

fn milliseconds_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Serves agents on `listener`, which they reach at `base`.
fn agents_served_at(listener: std::net::TcpListener, base: String) -> Result<ExitCode, String> {
    let binary = myself()?;
    eprintln!("domicile: serving agents at {base}/mcp");
    let web = mcp::Web {
        listener,
        base,
        state: state_directory(&|name| std::env::var(name).ok())
            .map(|directory| directory.join(mcp::SIGNED_IN_FILE)),
        ask: Box::new(
            |client: &str, site: &str, matching: &str, answer: mcp::Answer| {
                let (client, site, matching) =
                    (client.to_string(), site.to_string(), matching.to_string());
                std::thread::spawn(move || {
                    answer.give(sign_in_asked(&client, &site, &matching));
                });
            },
        ),
        clock: Arc::new(milliseconds_now),
        random: Box::new(|| {
            let mut bytes = [0; 32];
            std::fs::File::open("/dev/urandom")
                .and_then(|mut random| std::io::Read::read_exact(&mut random, &mut bytes))
                .expect("/dev/urandom gives secrets");
            bytes
        }),
        sweep_every: std::time::Duration::from_secs(60),
    };
    mcp::serve_http(web, move || {
        let binary = binary.clone();
        let admitting = binary.clone();
        mcp::Agent::new(
            move |args: &[String]| {
                let output = Command::new(&binary).args(args).output()?;
                Ok(mcp::Ran {
                    success: output.status.success(),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                })
            },
            move |name| let_in(&admitting, name),
        )
    })
    .map_err(|why| format!("mcp: {why}"))?;
    Ok(ExitCode::SUCCESS)
}

/// Asks the user, in the shell's dialog, whether `client` may sign in, going
/// back to `site`, if their browser shows `matching`. The dialog is Domicile's own, so it names no application;
/// it goes away after [`mcp::ASK_MS`], when the sign-in no longer waits.
fn sign_in_asked(client: &str, site: &str, matching: &str) -> mcp::Said {
    /// Each ask's `Request` object, which closes the dialog.
    static ASKED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let handle = format!(
        "/org/freedesktop/portal/desktop/request/domicile_mcp_{}/sign_in_{}",
        std::process::id(),
        ASKED.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );
    let asked = sign_in_dialog(client, site, matching, &handle);
    match asked {
        Ok(0) => mcp::Said::Allowed,
        Ok(1) => mcp::Said::Declined,
        Ok(response) => {
            eprintln!(
                "domicile: could not ask whether {client} may sign in: the portal answered {response}"
            );
            mcp::Said::Failed(format!(
                "Your desktop couldn't ask: its dialog ended without an answer ({response})."
            ))
        }
        Err(why) => {
            eprintln!("domicile: could not ask whether {client} may sign in: {why}");
            mcp::Said::Failed(format!("Your desktop couldn't ask: {why}"))
        }
    }
}

/// Puts the sign-in to the shell through Domicile's `Access` portal: the
/// portal's response.
fn sign_in_dialog(
    client: &str,
    site: &str,
    matching: &str,
    handle: &str,
) -> Result<u32, zbus::Error> {
    use zbus::zvariant::{ObjectPath, Value};
    let bus = zbus::blocking::connection::Builder::session()?
        .method_timeout(std::time::Duration::from_millis(mcp::ASK_MS))
        .build()?;
    let options = std::collections::HashMap::from([
        ("grant_label", Value::from("Allow")),
        ("deny_label", Value::from("Cancel")),
    ]);
    let called = bus.call_method(
        Some("org.freedesktop.impl.portal.desktop.domicile"),
        "/org/freedesktop/portal/desktop",
        Some("org.freedesktop.impl.portal.Access"),
        "AccessDialog",
        &(
            ObjectPath::try_from(handle)?,
            domicile_protocol::SHELL_APP_ID,
            "",
            format!("Let {client} sign in to your desktop?"),
            "",
            format!(
                "Only allow this if your browser shows {matching}. \
                 It goes back to {site}, and still asks before it uses anything."
            ),
            options,
        ),
    );
    match called {
        Ok(reply) => {
            let (response, _): (
                u32,
                std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
            ) = reply.body().deserialize()?;
            Ok(response)
        }
        Err(why) => {
            // Unanswered in time, or the call failed: the sign-in no longer
            // waits, so the dialog goes too.
            let closed = bus.call_method(
                Some("org.freedesktop.impl.portal.desktop.domicile"),
                handle,
                Some("org.freedesktop.impl.portal.Request"),
                "Close",
                &(),
            );
            if let Err(closing) = closed {
                eprintln!("domicile: could not close the sign-in dialog: {closing}");
            }
            match why {
                // Unanswered in time counts as declined, as `Cancel` does.
                zbus::Error::InputOutput(io) if io.kind() == std::io::ErrorKind::TimedOut => Ok(1),
                why => Err(why),
            }
        }
    }
}

/// Runs `domicile agent name`, which asks the user to let it in, and holds
/// the agent in for as long as this process runs.
fn let_in(binary: &Path, name: &str) -> Result<mcp::Grant, String> {
    let mut agent = Command::new(binary)
        .args(["agent", name])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|why| format!("domicile agent did not start: {why}"))?;
    let mut said = BufReader::new(agent.stdout.take().expect("stdout is piped"));
    let mut allowed = String::new();
    let _ = said.read_line(&mut allowed);
    let reach = match serde_json::from_str(allowed.trim()) {
        Ok(reach) => reach,
        Err(_) => {
            let mut why = String::new();
            if let Some(mut stderr) = agent.stderr.take() {
                let _ = std::io::Read::read_to_string(&mut stderr, &mut why);
            }
            let _ = agent.wait();
            return Err(why.trim().trim_start_matches("domicile: ").to_string());
        }
    };
    // Each later line is a change the user made; its output ending is the
    // user stopping it.
    let stopped = Arc::new(AtomicBool::new(false));
    let reach = Arc::new(Mutex::new(reach));
    // It runs until the grant is dropped, as this process or its session
    // ends, which closes its stdin and lets the agent go.
    let mut actions = agent.stdin.take().expect("stdin is piped");
    std::thread::spawn({
        let (stopped, reach) = (Arc::clone(&stopped), Arc::clone(&reach));
        move || {
            for line in said.lines() {
                let Ok(changed) = line.map_err(|_| ()).and_then(|line| {
                    serde_json::from_str::<domicile_protocol::AgentReach>(line.trim())
                        .map_err(|_| ())
                }) else {
                    break;
                };
                *reach.lock().unwrap() = changed;
            }
            stopped.store(true, Ordering::SeqCst);
            // `--http` outlives many agents; none is left a zombie.
            let _ = agent.wait();
        }
    });
    Ok(mcp::Grant {
        reach: Box::new(move || reach.lock().unwrap().clone()),
        stopped: Box::new(move || stopped.load(Ordering::SeqCst)),
        did: Box::new(move |said| {
            // Gone once the user stopped it, which the next call says.
            let _ = writeln!(actions, "{}", said.replace('\n', " "));
        }),
    })
}

fn listed(listing: Listing, json: bool) -> Result<ExitCode, String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let answer =
        ask(&socket, &listing.request(), Some(ANSWER_WITHIN)).map_err(|why| why.to_string())?;
    let printed = match (answer, json) {
        (Response::Displays { displays }, false) => displays_table(out(), &displays),
        (Response::Windows { windows }, false) => windows_table(out(), &windows),
        (Response::Displays { displays }, true) => as_json(&displays),
        (Response::Windows { windows }, true) => as_json(&windows),
        (Response::Status { shell, status }, false) => status_table(out(), &shell, &status),
        (Response::Status { shell, status }, true) => {
            as_json(&serde_json::json!({ "shell": shell, "status": status }))
        }
        (Response::ShellCommands { commands }, false) => shell_commands_table(out(), &commands),
        (Response::ShellCommands { commands }, true) => as_json(&commands),
        (Response::ShellBindings { bindings }, false) => bindings_table(out(), &bindings),
        (Response::ShellBindings { bindings }, true) => as_json(&bindings),
        (Response::Inputs { inputs }, false) => inputs_table(out(), &inputs),
        (Response::Inputs { inputs }, true) => as_json(&inputs),
        (Response::IdleTime { seconds }, false) => format!("{seconds}\n"),
        (Response::IdleTime { seconds }, true) => {
            as_json(&serde_json::json!({ "seconds": seconds }))
        }
        (Response::Agents { agents }, false) => agents_table(out(), &agents),
        (Response::Agents { agents }, true) => as_json(&agents),
        (Response::Refused { why }, _) => return Ok(fail(&why)),
        (answer, _) => {
            return Err(format!(
                "the desktop answered {answer:?} to a listing of {listing:?}"
            ))
        }
    };
    print!("{printed}");
    Ok(ExitCode::SUCCESS)
}

/// `listed` as pretty JSON, one line per field.
fn as_json(listed: &impl serde::Serialize) -> String {
    let mut json = serde_json::to_string_pretty(listed).expect("a listing always serializes");
    json.push('\n');
    json
}

/// Adds a virtual monitor and prints its output, then resizes it to each size
/// on stdin. Ends, removing it, when stdin does; fails when the desktop takes
/// it away first.
fn monitored(name: String, mode: MonitorMode) -> Result<ExitCode, String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let request = Request::VirtualMonitor {
        name,
        width: mode.size.0,
        height: mode.size.1,
        refresh_mhz: mode.refresh_mhz,
        scale: mode.scale,
    };
    // As long as the desktop waits for the compositor to add it.
    let (answer, held) = hold(&socket, &request, Some(ANSWER_WITHIN + ANSWER_WITHIN))
        .map_err(|why| why.to_string())?;
    match answer {
        Response::VirtualMonitor { output } => println!("{output}"),
        Response::Refused { why } => return Ok(fail(&why)),
        answer => return Err(format!("the desktop answered {answer:?} to a monitor")),
    }
    held.set_read_timeout(None)
        .map_err(|why| format!("cannot keep the monitor: {why}"))?;
    let gone = held
        .try_clone()
        .map_err(|why| format!("cannot keep the monitor: {why}"))?;
    // The desktop says nothing more: anything it does is a hang-up.
    std::thread::spawn(move || {
        let _ = std::io::Read::read(&mut &gone, &mut [0]);
        eprint!("{}", error(err(), "the desktop took the monitor away"));
        std::process::exit(1);
    });
    forward_sizes(std::io::stdin().lock(), &held, std::io::stderr())
        .map_err(|why| format!("the monitor's sizes did not reach the desktop: {why}"))?;
    Ok(ExitCode::SUCCESS)
}

/// Asks the user to let agent `name` in and prints what they allowed as a
/// JSON line, then lists each line of stdin as what it did. Ends when stdin
/// does, which lets it go; fails when the user refuses, or stops it first.
fn admitted(name: String) -> Result<ExitCode, String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    // As long as the user may take to decide.
    let (answer, held) = hold(
        &socket,
        &Request::Agent { agent: name },
        Some(DECIDING_WITHIN + ANSWER_WITHIN),
    )
    .map_err(|why| why.to_string())?;
    match answer {
        Response::Agent { reach } => {
            let mut stdout = std::io::stdout().lock();
            let _ = writeln!(
                stdout,
                "{}",
                serde_json::to_string(&reach).expect("a reach serializes")
            )
            .and_then(|()| stdout.flush());
        }
        Response::Refused { why } => return Ok(fail(&why)),
        answer => return Err(format!("the desktop answered {answer:?} to an agent")),
    }
    held.set_read_timeout(None)
        .map_err(|why| format!("cannot keep the agent in: {why}"))?;
    let told = held
        .try_clone()
        .map_err(|why| format!("cannot keep the agent in: {why}"))?;
    // Each change the user makes comes as another reach, printed as the
    // first was; anything else, or a hang-up, is the user stopping it.
    std::thread::spawn(move || {
        for line in BufReader::new(told).lines() {
            let Ok(Response::Agent { reach }) = line
                .map_err(|_| ())
                .and_then(|line| serde_json::from_str(&line).map_err(|_| ()))
            else {
                break;
            };
            let mut stdout = std::io::stdout().lock();
            let _ = writeln!(
                stdout,
                "{}",
                serde_json::to_string(&reach).expect("a reach serializes")
            )
            .and_then(|()| stdout.flush());
        }
        eprint!("{}", error(err(), "the agent was stopped from the desktop"));
        std::process::exit(1);
    });
    forward_actions(std::io::stdin().lock(), &held)
        .map_err(|why| format!("the agent's actions did not reach the desktop: {why}"))?;
    Ok(ExitCode::SUCCESS)
}

/// Prints what the running desktop says about `topics`, one JSON line each,
/// until it stops or stdout closes.
fn subscribed(topics: Vec<WatchTopic>) -> Result<ExitCode, String> {
    let socket =
        advertised(std::env::var(VARIABLE).ok().as_deref()).map_err(|why| why.to_string())?;
    let mut code = ExitCode::SUCCESS;
    let mut stdout = std::io::stdout().lock();
    listen(
        &socket,
        &Request::Subscribe { topics },
        |response| match response {
            Response::Heard { message } => {
                // Flushed per line, for a pipe reading as it goes. A closed
                // stdout, as from `| head`, ends it.
                writeln!(
                    stdout,
                    "{}",
                    serde_json::to_string(&message).expect("a message serializes")
                )
                .and_then(|()| stdout.flush())
                .is_ok()
            }
            Response::Refused { why } => {
                code = fail(&why);
                false
            }
            answer => {
                eprintln!("domicile: the desktop answered {answer:?} to a subscription");
                code = ExitCode::FAILURE;
                false
            }
        },
    )
    .map_err(|why| why.to_string())?;
    Ok(code)
}

/// Runs desktops on `shell`, restarting them while [`Policy`] allows.
///
/// The config path is passed to the compositor without being read here, so
/// only one process reports errors in it. A module config is first evaluated
/// to JSON by the builder, since the compositor runs no JavaScript. With no
/// `shell`, the config's `Shell` export or `shell` key is used, relative to
/// the config.
fn desktop(shell: Option<&str>, flag: Option<&Path>) -> Result<ExitCode, String> {
    let env = |name: &str| std::env::var(name).ok();
    let config = config_file(flag, &env, &|path| path.exists());
    if let ConfigFile::Several(_) = config {
        return Err(format!("config: {config}"));
    }

    let binary = std::env::current_exe().map_err(|why| format!("cannot find myself: {why}"))?;
    let (compositor_config, named) = match config.path() {
        Some(path) if is_module(path) => (
            Some(evaluated_json(&binary, path)?),
            Some((path.display().to_string(), beside(path))),
        ),
        Some(path) => (
            Some(path.to_path_buf()),
            shell_in(path).map(|named| (named, beside(path))),
        ),
        None => (None, None),
    };
    let components =
        components(&binary, &env, &|path| path.exists()).map_err(|missing| missing.to_string())?;
    // `BROWSER` for apps in this desktop, installed next to this binary.
    let browser = binary.with_file_name("domicile-open-url");

    // `DOMICILE_PAGE` names the module like the argument does, for packaged
    // desktops.
    let wanted = match (shell, named) {
        (Some(shell), _) => wanted(shell, env("DOMICILE_PAGE").as_deref(), None)?,
        (None, Some((named, from))) => wanted(&named, None, Some(&from))?,
        (None, None) => return Err(CliError::NoShell.to_string()),
    };

    // The profile persists across runs to keep sign-ins. Fail rather than
    // guess a location, so the user can always find and delete it.
    let kept = profile_directory(&env)
        .ok_or("nowhere to keep the engine's profile -- neither XDG_STATE_HOME nor HOME is set")?;
    // Held for the whole run: two engines cannot share a profile.
    let profile = claim(&kept)
        .map_err(|why| format!("cannot claim a profile beside {}: {why}", kept.display()))?;

    // A per-run directory for sockets, so concurrent desktops do not collide.
    let runtime = tempdir().map_err(|why| format!("no runtime directory: {why}"))?;
    let control = address(env("XDG_RUNTIME_DIR").as_deref(), std::process::id());

    let platform = platform(
        env("OZONE").as_deref(),
        env("WAYLAND_DISPLAY").as_deref(),
        env("DISPLAY").as_deref(),
        env("XDG_VTNR").as_deref(),
    )
    .map_err(|why| why.to_string())?;
    let on_the_cpu = on_the_cpu(
        &platform,
        env(software_compositing::VARIABLE).as_deref(),
        Path::new("/sys/class/drm"),
        software_compositing::vmwgfx_has_3d,
    )
    .map_err(|why| why.to_string())?;
    let version = std::fs::read_to_string(version_file(&binary)).ok();
    let version = version.as_deref().and_then(|said| said.lines().next());

    // On a terminal, print the choices before starting anything, so later
    // failures can be read against them. A login session's journal stays
    // quiet.
    let interactive = std::io::stdout().is_terminal();
    if interactive {
        let paint = out();
        let home = env("HOME").map(PathBuf::from);
        let at_home = |said: &str| at_home(said, home.as_deref());
        println!("{}", heading(paint, version));
        // What was asked for, so a wrong shell is visible.
        println!("{}", row(paint, "shell", &at_home(&wanted.shown())));
        // A wrong config is a common cause of a wrong monitor layout.
        println!("{}", row(paint, "config", &at_home(&config.to_string())));
        // The profile decides which sign-ins the desktop has.
        println!(
            "{}",
            row(
                paint,
                "profile",
                &at_home(&profile.path.display().to_string())
            )
        );
        println!("{}", row(paint, "platform", &platform.to_string()));
        if on_the_cpu {
            println!("{}", row(paint, "engine", "composites on the CPU"));
        }
        // What `DOMICILE_SOCK` is in a terminal outside the desktop.
        println!("{}", row(paint, "socket", &control.display().to_string()));
        println!();
    }

    // What the Settings app edits. A module config is evaluated to
    // `config.json` in the runtime directory, below. The shell's options are
    // beside the module served when the app asks.
    let files = SettingsFiles {
        config: config.path().map(Path::to_path_buf),
        evaluated: config
            .path()
            .is_some_and(is_module)
            .then(|| runtime.join("config.json")),
        shell: wanted.source(),
        options: None,
    };

    // A shell that builds quickly is built before anything starts, so a broken
    // one starts nothing. A slower build continues behind the splash.
    let splash = runtime.join("splash");
    let (page, building) = match wanted {
        Wanted::Ready(page) | Wanted::Ours(page) => (page, None),
        Wanted::Built(asked) => first_build(&binary, asked, &splash)?,
    };
    let places = Runtime {
        broker: runtime.join("broker"),
        chrome_socket: runtime.join("chrome.sock"),
        command: runtime.join("command.sock"),
        electron: runtime.join("electron.sock"),
        control,
        profile: profile.path.clone(),
        shims: runtime.join("bin"),
        session: runtime.join("session.json"),
        electron_entries: runtime.join("share"),
        launches: runtime.join("launches.json"),
    };
    shim(
        &places.shims,
        "xdg-open",
        &binary.with_file_name("domicile-xdg-open"),
    )?;
    // Chromium runs `xdg-email` for a page's `mailto:` link.
    shim(
        &places.shims,
        "xdg-email",
        &binary.with_file_name("domicile-xdg-email"),
    )?;
    // This desktop's own `domicile`, whatever is installed: the launcher
    // asks it what `open` would run.
    shim(&places.shims, "domicile", &binary)?;
    // Domicile's apps spawn their host by name.
    shim(
        &places.shims,
        "domicile-app-host",
        &binary.with_file_name("domicile-app-host"),
    )?;

    let module = page.root.join(&page.module);

    // Bind before starting components, which inherit the path. The
    // supervisor owns it because it routes commands to the engine and the
    // compositor, and it is keyed on the pid because no Wayland display exists
    // yet.
    let control = take(&places.control).map_err(|why| why.to_string())?;
    let serving = Arc::new(Mutex::new(page));
    // The levels `domicile set-log-level` set, which a restarted part starts
    // at too. They reset with the run.
    let levels = Arc::new(Mutex::new(LogLevels::default()));
    // The line the desktop says when it is up, for `domicile export-logs`.
    let up_said = Arc::new(OnceLock::new());
    answering(
        &control,
        Arc::clone(&serving),
        Arc::clone(&levels),
        Arc::clone(&up_said),
        files,
        places.command.clone(),
        places.chrome_socket.clone(),
    )?;
    if let Some(building) = building {
        replacing_the_splash(
            building,
            splash,
            Arc::clone(&serving),
            places.command.clone(),
        );
    }

    // Watch a module config's directory. On an edit, re-evaluate it into the
    // JSON the compositor watches, and if the config is also the shell,
    // rebuild and load it. A failure is reported and changes nothing.
    let compositor_config = match (config.path(), compositor_config) {
        (Some(module_config), Some(evaluated)) if is_module(module_config) => {
            let stable = runtime.join("config.json");
            std::fs::copy(&evaluated, &stable)
                .map_err(|why| format!("cannot place the evaluated config: {why}"))?;
            Some(stable)
        }
        (_, other) => other,
    };
    let _watching = match config.path() {
        Some(module_config) if is_module(module_config) => Some(watching_the_config(
            &binary,
            module_config,
            compositor_config
                .clone()
                .expect("a module config was evaluated"),
            shell
                .is_none()
                .then(|| (Arc::clone(&serving), places.command.clone())),
        )?),
        _ => None,
    };

    // Off a terminal, the one line the desktop says when it is up.
    let up = up_line(&Chosen {
        version,
        shell: &module,
        config: &config.to_string(),
        profile: &places.profile,
        platform: &platform.to_string(),
        on_the_cpu,
        socket: &places.control,
    });
    up_said
        .set(up.clone())
        .expect("the desktop comes up once a run");

    // Install before starting components. Each runs in its own process
    // group, so Ctrl-C reaches only this process, whose default action would
    // exit without stopping them.
    catch_interrupts();

    // Everything above runs once, since retrying would give the same result.
    // Below, the engine or the compositor restarts while the other lives, and
    // the whole desktop restarts when one keeps failing. See
    // `domicile_launch::restart`.
    let policy = Policy::default();
    // Held for the whole run. Dropping it ends the graphical session.
    let said = SaidSession::new(&platform);
    let sink = Arc::new(Sink::here());
    let desktop = Desktop {
        browser: &browser,
        components: &components,
        config: compositor_config.as_deref(),
        env: &env,
        places: &places,
        platform: &platform,
        on_the_cpu,
        policy: &policy,
        said: &said,
        serving: &serving,
        levels: &levels,
        sink: &sink,
        up: &up,
    };
    // The last desktop's compositor output, repeated if the run gives up.
    // Only the last, since each attempt usually fails the same way.
    let mut said = None;
    let ending = keep_a_desktop_up(
        &policy,
        &mut || one_desktop(&desktop, &mut said),
        &interrupted,
        &mut wait_or_notice_a_stop,
        &mut |next| launcher_log::error(&next.to_string()),
    );
    Ok(match ending {
        Ending::Over => ExitCode::SUCCESS,
        // An interrupted run did not finish what was asked.
        Ending::Stopped => ExitCode::FAILURE,
        // End on the compositor's own error, since the last line is what users
        // read. If the compositor never ran, point to the output above.
        Ending::GaveUp { .. } => {
            match &said {
                Some(said) => launcher_log::error(&format!("the last compositor said:\n\n{said}")),
                None => launcher_log::error("every one of them said why above."),
            }
            ExitCode::FAILURE
        }
        // The engine's own code, so a session manager can tell it apart.
        Ending::RendererUnavailable => {
            launcher_log::error(
                "renderer unavailable: the engine cannot draw on this \
                 graphics card, even on the CPU, so the desktop is not started again.",
            );
            ExitCode::from(RENDERER_UNAVAILABLE)
        }
    })
}

/// The exit code for [`Ending::RendererUnavailable`]: `EX_UNAVAILABLE`, as
/// the engine exits. See `domicile_launch::restart::NO_USABLE_GPU`.
const RENDERER_UNAVAILABLE: u8 = 69;

/// Why a desktop came down.
enum Down {
    /// A part failed or was stopped, as the message says.
    Failed(String),
    /// See `domicile_launch::restart::renderer_unavailable`.
    RendererUnavailable,
}

impl From<String> for Down {
    fn from(why: String) -> Self {
        Down::Failed(why)
    }
}

/// Inputs shared by every desktop a run starts.
struct Desktop<'a> {
    browser: &'a Path,
    components: &'a Components,
    config: Option<&'a Path>,
    env: &'a dyn Fn(&str) -> Option<String>,
    places: &'a Runtime,
    platform: &'a str,
    /// Whether the engine composites on the CPU. See
    /// `domicile_launch::software_compositing`.
    on_the_cpu: bool,
    /// The restart policy, shared by the engine, compositor and desktop. Each
    /// counts its own failures.
    policy: &'a Policy,
    /// The graphical session registration, renewed by each desktop.
    said: &'a SaidSession,
    /// The shell the engine serves, which a new engine starts on.
    serving: &'a Mutex<Shell>,
    /// The log levels set this run, which a new engine or compositor starts
    /// at.
    levels: &'a Mutex<LogLevels>,
    /// Where the components' stderr goes.
    sink: &'a Arc<Sink>,
    /// What a desktop says when it is up, off a terminal; see
    /// `domicile_launch::startup`.
    up: &'a str,
}

/// Runs one desktop until it ends or one of its parts keeps failing.
///
/// Engine and compositor restarts happen inside [`up`]. Returning drops the
/// [`Running`], which stops every process group.
fn one_desktop(desktop: &Desktop, said: &mut Option<String>) -> Attempt {
    // One per desktop, so the tail holds only this compositor's output.
    let heard = Arc::new(Mutex::new(Heard::new(WORTH_REPEATING)));
    let started = Instant::now();
    let attempt = match up(desktop, &heard) {
        Ok(()) => Attempt::Ended,
        Err(Down::RendererUnavailable) => Attempt::RendererUnavailable,
        Err(Down::Failed(why)) => {
            launcher_log::error(&why);
            Attempt::Failed {
                lived: started.elapsed(),
            }
        }
    };
    // `up` dropped its `Running`, which joins the stderr listener, so all
    // output is captured. See `supervise::Running::drop`.
    *said = heard
        .lock()
        .expect("nothing panics holding what a component said")
        .said();
    attempt
}

/// Starts the engine, then the compositor, and restarts either one that dies
/// under the other.
fn up(desktop: &Desktop, heard: &Arc<Mutex<Heard>>) -> Result<(), Down> {
    // Remove the last desktop's files. A stale session document would make
    // the wait below succeed too early.
    clear_the_last_one(desktop.places).map_err(|leftover| leftover.to_string())?;

    let mut running = Running::new();
    start_an_engine(desktop, &mut running)?;
    start_a_compositor(desktop, &mut running, heard)?;

    // Scripts wait for this line, so it prints as it is off a terminal.
    match std::io::stdout().is_terminal() {
        true => {
            println!();
            println!("{}", startup::running(out()));
        }
        false => println!("{}", desktop.up),
    }

    // Restart each part that dies; see `domicile_launch::restart`. `over`
    // records the exit that ended the desktop, because the loop's own result
    // describes the parts.
    let mut over = None;
    let mut replacing = None;
    let ending = keep_the_parts_up(
        desktop.policy,
        &mut || one_part(desktop, &mut running, heard, &mut replacing, &mut over),
        &interrupted,
        &mut wait_or_notice_a_stop,
        &mut |next| launcher_log::error(&next.to_string()),
    );
    match ending {
        Ending::Over => over
            .expect("the parts' loop ends on an exit it recorded")
            .map_err(Down::Failed),
        Ending::Stopped => Err("a stop was asked for".to_string().into()),
        // The caller restarts the whole desktop.
        Ending::GaveUp { started, failures } => Err(format!(
            "{failures} {started}s in a row have failed in this desktop, so the desktop goes \
             with them"
        )
        .into()),
        Ending::RendererUnavailable => Err(Down::RendererUnavailable),
    }
}

/// Runs the desktop's parts until one exits.
///
/// `replacing` names the part that died last time, which starts here after
/// the backoff, under the part still serving. A part's death returns
/// [`PartAttempt::Failed`] and leaves it in `replacing`. An exit that ends the
/// desktop returns [`PartAttempt::Ended`] and stores the result in `over` for
/// [`up`].
fn one_part(
    desktop: &Desktop,
    running: &mut Running,
    heard: &Arc<Mutex<Heard>>,
    replacing: &mut Option<Started>,
    over: &mut Option<Result<(), String>>,
) -> PartAttempt {
    let started = Instant::now();
    if let Some(part) = replacing.take() {
        // Clear only the dead part's files; the other is still live. See
        // `clear_the_last_engine` and `clear_the_last_compositor`.
        let replaced = match part {
            Started::Engine => clear_the_last_engine(desktop.places)
                .map_err(|leftover| Down::Failed(leftover.to_string()))
                .and_then(|()| start_an_engine(desktop, running)),
            Started::Compositor => clear_the_last_compositor(desktop.places)
                .map_err(|leftover| Down::Failed(leftover.to_string()))
                .and_then(|()| start_a_compositor(desktop, running, heard)),
            Started::Desktop => unreachable!("`restarts` names a part, never the desktop"),
        };
        match replaced {
            Ok(()) => {}
            Err(Down::RendererUnavailable) => return PartAttempt::RendererUnavailable,
            Err(Down::Failed(why)) => {
                launcher_log::error(&why);
                *replacing = Some(part);
                return PartAttempt::Failed {
                    part,
                    lived: started.elapsed(),
                };
            }
        }
    }
    let exit = running.until_one_exits();
    if renderer_unavailable(&exit, started.elapsed(), desktop.policy) {
        launcher_log::error(&exit.to_string());
        return PartAttempt::RendererUnavailable;
    }
    match restarts(&exit, desktop.platform) {
        // The other part keeps serving. A compositor rejoins the next engine
        // (`rejoin_the_engine` in the compositor), and a shell's control
        // channel dials the next compositor (ENGINE-FORK.md, "A compositor
        // restart").
        Some(part) => {
            // Print here: no caller reports a part's exit while the desktop is
            // still up.
            launcher_log::error(&exit.to_string());
            running.let_go_of(exit.what);
            *replacing = Some(part);
            PartAttempt::Failed {
                part,
                lived: started.elapsed(),
            }
        }
        None => {
            *over = Some(match exit.how == CLEANLY {
                // The up line's counterpart: a clean end says why on stdout.
                true => {
                    println!("domicile is down: {exit}");
                    Ok(())
                }
                false => Err(exit.to_string()),
            });
            PartAttempt::Ended
        }
    }
}

/// Starts a compositor under the running engine and waits for its session
/// document, then tells the user manager about it.
///
/// Only the compositor's stderr is captured; see `domicile_launch::heard`.
fn start_a_compositor(
    desktop: &Desktop,
    running: &mut Running,
    heard: &Arc<Mutex<Heard>>,
) -> Result<(), Down> {
    let mut spawn = compositor(
        &desktop.components.compositor,
        &desktop.components.engine,
        desktop.browser,
        &data_of(desktop.browser)?,
        desktop.places,
        desktop.config,
        desktop.said.scope_clients,
        desktop.env,
    );
    if desktop.on_the_cpu {
        send_frames_in_memory(&mut spawn);
    }
    if the_engine_takes_input(desktop.platform) {
        let_the_engine_take_input(&mut spawn);
    }
    let sink = Arc::clone(desktop.sink);
    let journal = sink.is_the_journal();
    let heard = Arc::clone(heard);
    let stderr: Listener = Box::new(move |line| {
        heard
            .lock()
            .expect("nothing panics holding what a component said")
            .line(line);
        sink.say(
            &component_log::compositor(line),
            line,
            &mut std::io::stderr(),
        );
    });
    match journal {
        // Its tracing goes straight to the journal.
        true => running.start_heard("compositor", &spawn, stderr),
        // Its tracing is formatted to stdout, and kept for `domicile logs` on
        // the way through.
        false => running.start_heard_whole(
            "compositor",
            &spawn,
            stderr,
            Box::new(|line| {
                recent_log::keep(recent_log::compositor_line(line, recent_log::now()));
                // Nowhere is left to say a failed write.
                let _ = writeln!(std::io::stdout(), "{line}");
            }),
        ),
    }
    .map_err(|why| why.to_string())?;
    wait_for(
        &session(&desktop.places.session),
        &desktop.places.session,
        running,
        desktop.policy,
    )?;
    // A compositor starts at its starting levels; give it those set since.
    let levels = set_levels(desktop.levels);
    if levels != LogLevels::default() {
        set_log_levels(&desktop.places.chrome_socket, &levels, Some(ANSWER_WITHIN))
            .map_err(|why| why.to_string())
            .and_then(|set| set)
            .map_err(|why| {
                format!("the compositor did not take the log levels set before: {why}")
            })?;
    }
    desktop.said.say(desktop.places);
    if std::io::stdout().is_terminal() {
        let display = format!(
            "WAYLAND_DISPLAY={}",
            published(desktop.places)?.wayland_display
        );
        println!("{}", done(out(), "Compositor up", Some(&display)));
    }
    Ok(())
}

/// The session document the compositor published.
fn published(places: &Runtime) -> Result<Session, String> {
    let at = places.session.display();
    let published = std::fs::read_to_string(&places.session)
        .map_err(|why| format!("cannot read {at}: {why}"))?;
    serde_json::from_str(&published).map_err(|why| format!("{at} is not a session: {why}"))
}

/// The log levels set this run.
fn set_levels(levels: &Mutex<LogLevels>) -> LogLevels {
    levels
        .lock()
        .expect("nothing panics holding the log levels")
        .clone()
}

/// Starts an engine and waits for its broker socket.
///
/// The wait also watches for exits, so a crash is reported at once.
fn start_an_engine(desktop: &Desktop, running: &mut Running) -> Result<(), Down> {
    let mut spawn = engine(
        &desktop.components.engine,
        &served(desktop.serving),
        desktop.platform,
        desktop.places,
        (desktop.env)("DOMICILE_ENGINE_ARGS").as_deref(),
    );
    if desktop.on_the_cpu {
        composite_on_the_cpu(&mut spawn);
    }
    let_the_engine_open_links(
        &mut spawn,
        &data_of(desktop.browser)?,
        desktop.places,
        desktop.env,
    );
    if let Some(schemes) = electron_schemes(desktop.env) {
        spawn.args.push(schemes.into());
    }
    spawn.args.extend(
        starting_switches(&set_levels(desktop.levels))
            .into_iter()
            .map(Into::into),
    );
    let sink = Arc::clone(desktop.sink);
    // A restarted engine keeps the levels `domicile set-log-level` set.
    let levels = set_levels(desktop.levels);
    match levels == LogLevels::default() {
        true => {
            domicile_launch::engine_log::start((desktop.env)("DOMICILE_ENGINE_ARGS").as_deref())
        }
        false => domicile_launch::engine_log::set(&levels),
    }
    let mut log = EngineLog::new();
    running
        .start_heard(
            "engine",
            &spawn,
            Box::new(move |line| {
                if let Some(entry) = log.heard(line) {
                    sink.say(&entry, line, &mut std::io::stderr());
                }
            }),
        )
        .map_err(|why| why.to_string())?;
    wait_for(
        &broker(&desktop.places.broker, &desktop.components.engine),
        &desktop.places.broker,
        running,
        desktop.policy,
    )?;
    if std::io::stdout().is_terminal() {
        println!("{}", done(out(), "Engine up", None));
    }
    Ok(())
}

/// The engine switch registering the Electron apps' own schemes, read again
/// at each engine start, so an app that brought a new scheme runs on the
/// engine from the next one. See `domicile_launch::electron_schemes`.
///
/// Known apps' schemes always register. A record that can't be read
/// registers only those, with an error in the log: the other apps run on
/// their own Electron, as the engine does with a wrong switch.
fn electron_schemes(env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let Some(state) = state_directory(env) else {
        return schemes_switch(electron_schemes::KNOWN).expect("the known schemes register");
    };
    let path = state.join(electron_schemes::RECORD);
    let record = match std::fs::read_to_string(&path) {
        Ok(record) => record,
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => "{}".to_string(),
        Err(why) => {
            launcher_log::error(&format!("cannot read {}: {why}", path.display()));
            "{}".to_string()
        }
    };
    with_known(&record)
        .and_then(|record| schemes_switch(&record))
        .unwrap_or_else(|why| {
            launcher_log::error(&format!(
                "registering only known Electron apps' schemes, since {} is wrong: {why}",
                path.display()
            ));
            schemes_switch(electron_schemes::KNOWN).expect("the known schemes register")
        })
}

/// Sleeps for the backoff, returning early on a stop request.
///
/// The caller checks [`interrupted`] again on return.
fn wait_or_notice_a_stop(wait: Duration) {
    let until = Instant::now() + wait;
    while Instant::now() < until && !interrupted() {
        std::thread::sleep(ASK_EVERY);
    }
}

/// Serves the control socket on a thread, routing engine commands to `engine`
/// and screenshots and shell commands to the compositor's `chrome` socket.
///
/// A separate thread because the supervisor blocks on its children, and a
/// thread per connection because an interactive screenshot waits on the user.
/// A failed connection is logged and skipped, so one bad client cannot stop
/// the socket. `serving` tracks the current shell; see [`load_the_shell`].
fn answering(
    control: &Control,
    serving: Arc<Mutex<Shell>>,
    levels: Arc<Mutex<LogLevels>>,
    up: Arc<OnceLock<String>>,
    files: SettingsFiles,
    engine: PathBuf,
    chrome: PathBuf,
) -> Result<(), String> {
    let listener = control
        .listener()
        .map_err(|why| format!("cannot answer the control socket: {why}"))?;
    let (files, engine, chrome) = (Arc::new(files), Arc::new(engine), Arc::new(chrome));
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            match connection {
                Ok(stream) => {
                    let (serving, levels, up, files, engine, chrome) = (
                        serving.clone(),
                        levels.clone(),
                        up.clone(),
                        files.clone(),
                        engine.clone(),
                        chrome.clone(),
                    );
                    std::thread::spawn(move || {
                        answer_a_command(stream, &serving, &levels, &up, &files, &engine, &chrome)
                    });
                }
                Err(why) => launcher_log::error(&format!("a command did not arrive: {why}")),
            }
        }
    });
    Ok(())
}

/// Answers the one command on `stream`; see [`answering`].
fn answer_a_command(
    stream: UnixStream,
    serving: &Mutex<Shell>,
    levels: &Mutex<LogLevels>,
    up: &OnceLock<String>,
    files: &SettingsFiles,
    engine: &Path,
    chrome: &Path,
) {
    let journal = stderr_is_the_journal();
    let lending = |lent| lend(lent, chrome, ANSWER_WITHIN);
    let following = |subscription| follow(subscription, chrome);
    let admitting = |admission| admit(admission, chrome, DECIDING_WITHIN);
    if let Err(why) = serve_one(
        stream,
        ANSWER_WITHIN,
        &|line| {
            let page = served(serving);
            answer(
                line,
                &ControlDesktop {
                    shell: &page,
                    files,
                    // Asked once: the client stops waiting after `LOAD_WITHIN`
                    // plus `ANSWER_WITHIN`, so a retry could load a shell after
                    // it reported a failure.
                    load: &|page| load_the_shell(engine, page, serving, &|| true),
                    open: &|url, profile| {
                        open_url(engine, url, profile, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    open_app: &|url, id, reuse, profile| {
                        open_app(engine, url, id, reuse, profile, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    run_app: &|root, module| {
                        run_app(engine, root, module, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    launch: &|command| {
                        launch(chrome, command, Some(ANSWER_WITHIN + ANSWER_WITHIN))
                            .map_err(|why| why.to_string())
                    },
                    open_link: &|url| {
                        open_link(chrome, url, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    // The interactive one waits for the user, however long that
                    // takes.
                    capture: &|file| {
                        screenshot(chrome, file, file.map(|_| CAPTURE_WITHIN))
                            .map_err(|why| why.to_string())
                    },
                    // Until the user stops it, however long that takes.
                    record: &|| screen_record(chrome).map_err(|why| why.to_string()),
                    permissions: &|| {
                        site_permissions(engine, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    set_permission: &|site| {
                        set_site_permission(engine, site, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    send: &|command| {
                        send_shell(chrome, command, Some(SEND_WITHIN))
                            .map_err(|why| why.to_string())
                    },
                    load_unpacked: &|directory| {
                        load_unpacked(engine, directory, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    uninstall_extension: &|id| {
                        uninstall_extension(engine, id, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    config_extensions: &|| {
                        config_extensions(engine, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    media_devices: &|| {
                        media_devices(engine, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    set_media_device: &|kind, id| {
                        set_media_device(engine, kind, id, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    extensions: &|| {
                        extensions(engine, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    set_extension_enabled: &|id, enabled, profile| {
                        set_extension_enabled(engine, id, enabled, profile, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    browser_profiles: &|| {
                        browser_profiles(engine, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    pin_browser_site: &|site, profile| {
                        pin_browser_site(engine, site, profile, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    configure_extension: &|id, settings| {
                        configure_extension(engine, id, settings, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    history: &|query| {
                        history(engine, query, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    visits: &|url| {
                        visits(engine, url, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    delete_history: &|times| {
                        delete_history(engine, times, ANSWER_WITHIN).map_err(|why| why.to_string())
                    },
                    clear_browsing_data: &|data| {
                        clear_browsing_data(engine, data, CLEAR_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    // Both read every kind of storage from disk, as clearing does.
                    site_data: &|| site_data(engine, CLEAR_WITHIN).map_err(|why| why.to_string()),
                    clear_site_data: &|host| {
                        clear_site_data(engine, host, CLEAR_WITHIN).map_err(|why| why.to_string())
                    },
                    disable_while_typing: &|enabled| {
                        disable_while_typing(engine, enabled, ANSWER_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    theme: &|to| {
                        theme(chrome, to, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    power_displays: &|power, display| {
                        power_displays(chrome, power, display, Some(ANSWER_WITHIN))
                            .map_err(|why| why.to_string())
                    },
                    lock: &|| lock(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string()),
                    act_on_window: &|id, act| {
                        act_on_window(chrome, id, act, Some(ANSWER_WITHIN))
                            .map_err(|why| why.to_string())?
                    },
                    shoot_desk: &|file, fit, area| {
                        shoot_desk(chrome, file, fit, area, Some(CAPTURE_WITHIN))
                            .map_err(|why| why.to_string())?
                    },
                    emulate: &|input| {
                        emulate(chrome, input, Some(ANSWER_WITHIN))
                            .map_err(|why| why.to_string())?
                    },
                    devtools: &|window, method, params| {
                        devtools(engine, window, method, params, DEVTOOLS_WITHIN)
                            .map_err(|why| why.to_string())
                    },
                    // The compositor waits up to 5s for the desktop to be laid
                    // out again.
                    configure_display: &|display, change| {
                        configure_display(chrome, display, change, Some(CONFIGURE_WITHIN))
                            .map_err(|why| why.to_string())?
                    },
                    log_levels: &|| set_levels(levels),
                    // Kept, so a part that restarts starts at them too.
                    set_log_levels: &|asked| {
                        let mut set = levels
                            .lock()
                            .expect("nothing panics holding the log levels");
                        set_log_levels(chrome, asked, Some(ANSWER_WITHIN))
                            .map_err(|why| why.to_string())??;
                        let engine_levels = engine_levels(asked);
                        set_engine_log_levels(
                            engine,
                            engine_levels.min_level,
                            &engine_levels.vmodule,
                            ANSWER_WITHIN,
                        )
                        .map_err(|why| why.to_string())?;
                        launcher_log::set(asked);
                        domicile_launch::engine_log::set(asked);
                        *set = asked.clone();
                        Ok(())
                    },
                    up: up
                        .get()
                        .map_or("The desktop was not up yet.", String::as_str),
                    logs_in_the_journal: journal,
                    logs: &|| match journal {
                        true => from_the_journal(),
                        false => Ok(recent_log::kept()),
                    },
                    monitors: &|| {
                        monitors(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    displays: &|| {
                        displays(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    windows: &|| {
                        windows(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    status: &|| status(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string()),
                    shell_commands: &|| {
                        shell_commands(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    shell_bindings: &|| {
                        shell_bindings(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    inputs: &|| inputs(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string()),
                    idle_time: &|| {
                        idle_time(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string())
                    },
                    agents: &|| agents(chrome, Some(ANSWER_WITHIN)).map_err(|why| why.to_string()),
                    stop_agent: &|session| {
                        stop_agent(chrome, session, Some(ANSWER_WITHIN))
                            .map_err(|why| why.to_string())
                    },
                    forget_agent: &|agent| {
                        forget_agent(chrome, agent, Some(ANSWER_WITHIN))
                            .map_err(|why| why.to_string())
                    },
                },
            )
        },
        Lenders {
            monitor: &lending,
            subscribe: &following,
            agent: &admitting,
        },
    ) {
        launcher_log::error(&format!("a command went unanswered: {why}"));
    }
}

/// Watches the module config's directory and reloads on edits.
///
/// Re-evaluates into `evaluated`, which the compositor watches. With `shell`
/// (the served module and the engine socket), also rebuilds the config as the
/// shell and loads it.
fn watching_the_config(
    binary: &Path,
    config: &Path,
    evaluated: PathBuf,
    shell: Option<(Arc<Mutex<Shell>>, PathBuf)>,
) -> Result<config_watch::Watching, String> {
    let binary = binary.to_path_buf();
    let module_config = config.to_path_buf();
    config_watch::watch(&beside(config), Duration::from_millis(250), move || {
        let reloaded = reevaluated(&binary, &module_config, &evaluated).and_then(|()| {
            shell.as_ref().map_or(Ok(()), |(serving, engine)| {
                built(
                    &binary,
                    &["--entry".into(), module_config.clone().into_os_string()],
                    &mut |_| {},
                )
                .and_then(as_shell)
                // A reload can land while the engine restarts after a crash.
                .and_then(|page| load_the_shell(engine, &page, serving, &while_the_engine_starts()))
            })
        });
        match reloaded {
            Ok(()) => launcher_log::info(&format!("{} reloaded", module_config.display())),
            Err(why) => {
                launcher_log::error(&format!(
                    "{} did not reload, and the desk is as it was: {why}",
                    module_config.display()
                ));
                say_on_the_desk(&module_config, &why);
            }
        }
    })
}

/// Reports a failed reload as a notification, since the user is not watching
/// the terminal.
fn say_on_the_desk(config: &Path, why: &str) {
    let name = config
        .file_name()
        .unwrap_or(config.as_os_str())
        .to_string_lossy();
    let said = notification::session_bus()
        .and_then(|bus| notification::notify(&bus, "", &format!("{name} did not reload"), why));
    if let Err(unsaid) = said {
        launcher_log::error(&format!("cannot say so on the desk: {unsaid}"));
    }
}

/// Re-evaluates `config` into `evaluated` atomically, so the compositor never
/// reads a partial file.
fn reevaluated(binary: &Path, config: &Path, evaluated: &Path) -> Result<(), String> {
    let fresh = evaluated_json(binary, config)?;
    let staged = evaluated.with_extension("json.next");
    std::fs::copy(&fresh, &staged)
        .and_then(|_| std::fs::rename(&staged, evaluated))
        .map_err(|why| format!("cannot place the evaluated config: {why}"))
}

/// The shell the desktop is currently serving.
fn served(serving: &Mutex<Shell>) -> Shell {
    serving
        .lock()
        .expect("nothing panics holding which shell is served")
        .clone()
}

/// Sends `load_shell` to the engine until `given_up` and records the new
/// shell; see [`serve`].
fn load_the_shell(
    engine: &Path,
    page: &Shell,
    serving: &Mutex<Shell>,
    given_up: &dyn Fn() -> bool,
) -> Result<(), String> {
    serve(
        page,
        serving,
        &|page| load_shell(engine, page, LOAD_WITHIN),
        given_up,
        &mut || std::thread::sleep(ASK_EVERY),
    )
    .map_err(|why| why.to_string())
}

/// Gives up on the engine after twice [`PATIENCE`] from now, or on a stop
/// request. The engine has [`PATIENCE`] to start, so this outlasts a start or
/// restart.
fn while_the_engine_starts() -> impl Fn() -> bool {
    let asked = Instant::now();
    move || interrupted() || asked.elapsed() > 2 * PATIENCE
}

/// A built shell, or why it did not build.
type Building = Receiver<Result<Shell, String>>;

/// Starts the first build of the shell and waits [`SPLASH_AFTER`] for it.
///
/// Returns the built shell, or, while the build continues, the splash laid out
/// in `splash` and the build to wait on. Each step is told to the splash.
fn first_build(
    binary: &Path,
    asked: Vec<std::ffi::OsString>,
    splash: &Path,
) -> Result<(Shell, Option<Building>), String> {
    std::fs::create_dir_all(splash)
        .and_then(|()| tell(splash, &Progress::Starting))
        .map_err(|why| format!("cannot make the splash at {}: {why}", splash.display()))?;
    let (answer, building) = channel();
    let (builder_of, told) = (binary.to_path_buf(), splash.to_path_buf());
    std::thread::spawn(move || {
        let page = built(&builder_of, &asked, &mut |step| {
            if let Err(why) = tell(&told, &Progress::from(step)) {
                launcher_log::warn(&format!("the splash missed a step: {why}"));
            }
        })
        .and_then(as_shell);
        // The receiver is gone only if the run ended, and then nobody waits.
        let _ = answer.send(page);
    });
    let started = Instant::now();
    match building.recv_timeout(SPLASH_AFTER) {
        Ok(page) => page.map(|page| {
            if std::io::stdout().is_terminal() {
                println!("{}", built_in(out(), started.elapsed()));
            }
            (page, None)
        }),
        Err(_) => {
            let env = |name: &str| std::env::var(name).ok();
            let bundle = our_shell(binary, "splash", &env, &|path| path.exists())
                .map_err(|missing| missing.to_string())?;
            let page = lay_out(&bundle, splash)
                .map_err(|why| format!("cannot lay out the splash: {why}"))?;
            launcher_log::info("the shell is still building, so the desk starts on the splash");
            Ok((page, Some(building)))
        }
    }
}

/// Loads the shell `building` makes in place of the splash, on a thread.
///
/// The splash plays its ending first, which it says by writing [`ENDED`]. A
/// failed build or load stays on the splash, which shows why and logs out on a
/// key.
fn replacing_the_splash(
    building: Building,
    splash: PathBuf,
    serving: Arc<Mutex<Shell>>,
    engine: PathBuf,
) {
    std::thread::spawn(move || {
        let loaded = building
            .recv()
            .unwrap_or_else(|_| Err("the shell builder's thread ended without an answer".into()))
            .and_then(|page| {
                let ended = splash.join(ENDED);
                if let Err(why) = tell(&splash, &Progress::Built { ended: &ended }) {
                    launcher_log::warn(&format!("the splash missed its ending: {why}"));
                }
                // The engine has `PATIENCE` to start, and the splash cannot
                // end before it draws.
                if !the_page_ends(&ended, PATIENCE) {
                    launcher_log::warn("the splash did not end, so the shell loads over it");
                }
                load_the_shell(&engine, &page, &serving, &while_the_engine_starts())
                    .map(|()| page.root.join(&page.module))
            });
        match loaded {
            Ok(module) => {
                launcher_log::info(&format!("the splash gave way to {}", module.display()))
            }
            Err(why) => {
                launcher_log::error(&format!("the desk stays on the splash: {why}"));
                let failed = Progress::Failed {
                    supervisor: std::process::id(),
                    // `built` ends a failure with the build log, often empty.
                    why: why.trim_end(),
                };
                if let Err(unsaid) = tell(&splash, &failed) {
                    launcher_log::error(&format!("the splash cannot say so: {unsaid}"));
                }
            }
        }
    });
}

/// Waits for a milestone file, watching for exits and stop requests.
///
/// An engine that exits as a renderer unavailable meanwhile is
/// [`Down::RendererUnavailable`], so the run ends there too.
///
/// Checking for a stop here matters because startup can take a minute; see
/// [`reach`] for what an ignored Ctrl-C leaves on a tty.
fn wait_for(
    milestone: &Milestone,
    path: &Path,
    running: &mut Running,
    policy: &Policy,
) -> Result<(), Down> {
    let started = Instant::now();
    reach(
        milestone,
        &|| path.exists(),
        &mut || running.exited(),
        &interrupted,
        &mut || {
            std::thread::sleep(ASK_EVERY);
            started.elapsed()
        },
    )
    .map_err(|stalled| match stalled {
        Stalled::Exited { exit, .. } if renderer_unavailable(&exit, started.elapsed(), policy) => {
            launcher_log::error(&exit.to_string());
            Down::RendererUnavailable
        }
        stalled => Down::Failed(stalled.to_string()),
    })
}

/// The engine's broker socket, which must exist before the compositor starts.
fn broker(broker: &Path, engine: &Path) -> Milestone {
    Milestone {
        awaited: format!("the engine's broker socket at {}", broker.display()),
        check: format!(
            "The engine is {} and its own output is above -- an engine that \
             refused a flag, could not take the display, or stopped before it \
             got this far says so there.",
            engine.join("chrome").display()
        ),
        patience: PATIENCE,
    }
}

/// The compositor's session document, written once it is ready to serve.
fn session(session: &Path) -> Milestone {
    Milestone {
        awaited: format!("the compositor's session document at {}", session.display()),
        check: "The compositor writes it once every socket is bound and its \
                window is open, so anything it could not do comes first in its \
                own output above."
            .to_string(),
        patience: PATIENCE,
    }
}

/// Registers the run's desktops as the graphical session; see
/// `domicile_launch::graphical_session`.
///
/// - Each desktop registers again (its display may differ), but the session
///   ends only once, when the run ends. The session it took over from another
///   run (see `graphical_session::begin`) is the one from its first
///   registration. Ending is irreversible, and a desktop
///   restarted while the session is shutting down would be refused.
/// - Only on the DRM platform. A nested desktop leaves this to its host.
/// - Best effort: without a systemd user manager or `domicile-session.target`,
///   the portal does not start and a warning is printed. If the launcher is
///   killed, its variables remain until the next session sets its own.
/// - Clients get their own scopes only when a user manager answers, since
///   `systemd-run --user` fails without one and no app would start.
struct SaidSession {
    is_the_session: bool,
    scope_clients: bool,
    manager: Mutex<Option<zbus::blocking::Connection>>,
    /// This run's control socket and the session it took over, once said.
    took_over: Mutex<Option<(PathBuf, Vec<String>)>>,
}

impl SaidSession {
    /// Names the desktop to the user manager when it is the session, before
    /// any component starts; see `graphical_session::name`.
    fn new(platform: &str) -> Self {
        let is_the_session = platform == "drm";
        SaidSession {
            is_the_session,
            scope_clients: is_the_session && Self::a_user_manager_answers(),
            manager: Mutex::new(is_the_session.then(Self::named).flatten()),
            took_over: Mutex::new(None),
        }
    }

    /// Exports the desktop's name. Says why on stderr when it cannot.
    fn named() -> Option<zbus::blocking::Connection> {
        let named = notification::session_bus().and_then(|manager| {
            graphical_session::name(&manager)?;
            Ok(manager)
        });
        match named {
            Ok(manager) => Some(manager),
            Err(why) => {
                launcher_log::error(&format!(
                    "the user manager was not told this desktop's name before the \
                     desktop started: {why}"
                ));
                None
            }
        }
    }

    /// Whether `org.freedesktop.systemd1` is on the session bus. Says why on
    /// stderr when not.
    fn a_user_manager_answers() -> bool {
        let answered = notification::session_bus().and_then(|bus| {
            zbus::blocking::fdo::DBusProxy::new(&bus)?
                .name_has_owner("org.freedesktop.systemd1".try_into()?)
                .map_err(zbus::Error::from)
        });
        match answered {
            Ok(true) => true,
            Ok(false) => {
                launcher_log::warn(
                    "no systemd user manager is on the session bus, so apps share the \
                     desktop's cgroup",
                );
                false
            }
            Err(why) => {
                launcher_log::warn(&format!(
                    "the session bus did not say whether a user manager runs, so apps \
                     share the desktop's cgroup: {why}"
                ));
                false
            }
        }
    }

    /// Registers the desktop that just came up.
    fn say(&self, places: &Runtime) {
        if self.is_the_session {
            match Self::said(places) {
                Ok((manager, earlier)) => {
                    *self.manager.lock().expect("nothing panics holding it") = Some(manager);
                    self.took_over
                        .lock()
                        .expect("nothing panics holding it")
                        .get_or_insert_with(|| (places.control.clone(), earlier));
                }
                Err(why) => launcher_log::error(&format!(
                    "the user manager was not told this desktop is the session, so \
                     the portal will not start in it: {why}"
                )),
            }
        }
    }

    fn said(places: &Runtime) -> Result<(zbus::blocking::Connection, Vec<String>), String> {
        let session = published(places)?;
        let manager = notification::session_bus().map_err(|why| why.to_string())?;
        let earlier = graphical_session::begin(&manager, &session.wayland_display, &places.control)
            .map_err(|why| why.to_string())?;
        Ok((manager, earlier))
    }
}

impl Drop for SaidSession {
    fn drop(&mut self) {
        let manager = self.manager.get_mut().expect("nothing panics holding it");
        let took_over = self.took_over.get_mut().expect("nothing panics holding it");
        // A run that never said its desktop started no session to end, and
        // stopping one could stop another run's.
        if let (Some(manager), Some((control, earlier))) = (manager, took_over) {
            if let Err(why) = graphical_session::end(manager, control, earlier) {
                launcher_log::warn(&format!(
                    "the user manager still holds this desktop's session: {why}"
                ));
            }
        }
    }
}

/// Links `program` as `name` in `shims`, first on the apps' `PATH`. See
/// `domicile_launch::open`.
///
/// A symlink, not a copy, so the program can find `domicile` next to its real
/// path.
fn shim(shims: &Path, name: &str, program: &Path) -> Result<(), String> {
    std::fs::create_dir_all(shims)
        .map_err(|why| format!("cannot make {}: {why}", shims.display()))?;
    std::os::unix::fs::symlink(program, shims.join(name))
        .map_err(|why| format!("cannot put {name} in {}: {why}", shims.display()))
}

/// The installation's `share` directory, which holds `domicile-mimeapps.list`
/// and the `domicile-open-url` desktop entry.
///
/// In a checkout it does not exist, and missing data directories are skipped.
fn data_of(browser: &Path) -> Result<PathBuf, String> {
    browser
        .parent()
        .and_then(Path::parent)
        .map(|installation| installation.join("share"))
        .ok_or_else(|| format!("{} is in no installation of its own", browser.display()))
}

/// Creates this run's directory under `XDG_RUNTIME_DIR` (mode 700), or the
/// temp directory as a fallback.
///
/// The temp directory is world-readable, so there the sockets' own permissions
/// protect them.
fn tempdir() -> std::io::Result<std::path::PathBuf> {
    let base = std::env::var("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let mine = base.join(format!("domicile-{}", std::process::id()));
    std::fs::create_dir_all(&mine)?;
    Ok(mine)
}
