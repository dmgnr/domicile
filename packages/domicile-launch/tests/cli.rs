//! Tests for parsing the `domicile` command line.

use std::path::PathBuf;

use domicile_launch::cli::{
    invocation, monitor_mode, monitor_size, CliError, Invocation, Listing, McpHttp, MonitorMode,
};
use domicile_launch::commands::COMMANDS;
use domicile_launch::control::{AppReuse, Request, Switch, ThemeChange};
use domicile_launch::power::Power;
use domicile_protocol::{
    DeskRect, DisplayChange, DisplayTransform, EmulatedInput, LogLevel, PointerButton, Scale,
    Subsystem, WatchTopic, WindowAct,
};

fn run(args: &[&str]) -> Result<Invocation, CliError> {
    invocation(args.iter().map(|arg| (*arg).to_string()))
}

#[test]
fn a_shell_is_the_whole_command_line() {
    assert_eq!(
        run(&["./my-desktop/dist/shell.js"]).unwrap(),
        Invocation::Run {
            config: None,
            shell: Some("./my-desktop/dist/shell.js".to_string())
        }
    );
}

#[test]
fn nothing_at_all_is_the_shell_the_config_names() {
    // The shell then comes from the config. The run checks that one exists.
    assert_eq!(
        run(&[]),
        Ok(Invocation::Run {
            config: None,
            shell: None
        })
    );
}

#[test]
fn a_second_argument_is_refused_and_named() {
    // Dropping a word silently could serve a shell other than the one typed.
    assert_eq!(
        run(&["./dist/shell.js", "simple"]),
        Err(CliError::TooMany {
            extra: "simple".to_string()
        })
    );
}

#[test]
fn a_listing_prints_a_table_or_with_json_what_the_desktop_said() {
    assert_eq!(
        run(&["list-displays"]),
        Ok(Invocation::List {
            listing: Listing::Displays,
            json: false
        })
    );
    assert_eq!(
        run(&["list-windows", "--json"]),
        Ok(Invocation::List {
            listing: Listing::Windows,
            json: true
        })
    );
    assert_eq!(
        run(&["status", "--json"]),
        Ok(Invocation::List {
            listing: Listing::Status,
            json: true
        })
    );
    assert_eq!(
        run(&["list-shell-commands"]),
        Ok(Invocation::List {
            listing: Listing::ShellCommands,
            json: false
        })
    );
    assert_eq!(
        run(&["list-bindings", "--json"]),
        Ok(Invocation::List {
            listing: Listing::Bindings,
            json: true
        })
    );
    assert_eq!(
        run(&["list-inputs"]),
        Ok(Invocation::List {
            listing: Listing::Inputs,
            json: false
        })
    );
    assert_eq!(
        run(&["idle-time", "--json"]),
        Ok(Invocation::List {
            listing: Listing::IdleTime,
            json: true
        })
    );
    // The shell's commands are what `send-shell` takes, so its help is them.
    assert_eq!(
        run(&["send-shell", "--help"]),
        Ok(Invocation::List {
            listing: Listing::ShellCommands,
            json: false
        })
    );
    assert_eq!(
        run(&["list-windows", "--yaml"]),
        Err(CliError::Extra {
            verb: "list-windows".to_string(),
            extra: "--yaml".to_string()
        })
    );
    assert_eq!(
        run(&["list-displays", "--json", "drm-1"]),
        Err(CliError::Extra {
            verb: "list-displays --json".to_string(),
            extra: "drm-1".to_string()
        })
    );
}

#[test]
fn a_verb_is_a_command_for_a_desktop_that_is_already_running() {
    assert_eq!(
        run(&["which-shell"]).unwrap(),
        Invocation::Ask {
            request: Request::WhichShell
        }
    );
}

#[test]
fn a_verb_given_an_argument_is_refused_and_named() {
    // A verb gets its own error, naming the extra word.
    assert_eq!(
        run(&["which-shell", "manganese"]),
        Err(CliError::Extra {
            verb: "which-shell".to_string(),
            extra: "manganese".to_string()
        })
    );
    // `--config` is refused too: the running desktop already read its config,
    // so accepting the flag would look like it worked when it did nothing.
    assert_eq!(
        run(&["which-shell", "--config", "/a.json"]),
        Err(CliError::Extra {
            verb: "which-shell".to_string(),
            extra: "--config".to_string()
        })
    );
}

#[test]
fn load_shell_is_the_verb_that_takes_a_shell() {
    // The shell is kept as typed. `shell_path` resolves it against the
    // working directory.
    assert_eq!(
        run(&["load-shell", "./my-desktop/dist/shell.js"]).unwrap(),
        Invocation::Load {
            shell: "./my-desktop/dist/shell.js".to_string()
        }
    );
}

#[test]
fn dev_is_the_verb_that_serves_a_shells_source() {
    // Kept as typed, like load-shell's shell: it is relative to where it was
    // typed.
    assert_eq!(
        run(&["dev", "./src/shell.tsx"]).unwrap(),
        Invocation::Dev {
            entry: "./src/shell.tsx".to_string()
        }
    );
}

#[test]
fn dev_with_nothing_to_serve_is_refused() {
    assert_eq!(run(&["dev"]), Err(CliError::NoEntryToServe));
}

#[test]
fn dev_serves_one_entry_and_the_extra_word_is_named() {
    assert_eq!(
        run(&["dev", "./src/shell.tsx", "./src/other.tsx"]),
        Err(CliError::ExtraToServe {
            extra: "./src/other.tsx".to_string()
        })
    );
}

#[test]
fn load_shell_with_nothing_to_load_is_refused() {
    // It does not mean "reload the current shell".
    assert_eq!(run(&["load-shell"]), Err(CliError::NoShellToLoad));
}

#[test]
fn load_shell_takes_one_shell_and_the_extra_word_is_named() {
    // A desktop serves one shell. `--config` is refused as with every verb.
    assert_eq!(
        run(&["load-shell", "./dist/shell.js", "./other.js"]),
        Err(CliError::ExtraToLoad {
            extra: "./other.js".to_string()
        })
    );
    assert_eq!(
        run(&["load-shell", "--config", "/a.json"]),
        Err(CliError::ExtraToLoad {
            extra: "/a.json".to_string()
        })
    );
}

#[test]
fn open_takes_one_thing_to_open_as_typed() {
    assert_eq!(
        run(&["open", "~/notes.org"]).unwrap(),
        Invocation::Open {
            target: "~/notes.org".to_string(),
            profile: None,
        }
    );
    assert_eq!(run(&["open"]), Err(CliError::NothingToOpen));
    assert_eq!(
        run(&["open", "a.txt", "b.txt"]),
        Err(CliError::ExtraToOpen {
            extra: "b.txt".to_string()
        })
    );
}

#[test]
fn open_with_profile_names_the_browser_profile() {
    assert_eq!(
        run(&["open", "--profile", "work", "https://example.com"]).unwrap(),
        Invocation::Open {
            target: "https://example.com".to_string(),
            profile: Some("work".to_string()),
        }
    );
    assert_eq!(
        run(&["open", "--profile"]),
        Err(CliError::FlagWithoutValue {
            flag: "--profile".to_string()
        })
    );
    assert_eq!(
        run(&["open", "--profile", "work"]),
        Err(CliError::NothingToOpen)
    );
    assert_eq!(
        run(&["open", "--profile", "work", "a.example", "b.example"]),
        Err(CliError::ExtraToOpen {
            extra: "b.example".to_string()
        })
    );
}

#[test]
fn open_with_which_asks_what_would_open_it() {
    assert_eq!(
        run(&["open", "--which", "a.txt"]).unwrap(),
        Invocation::Opener {
            target: "a.txt".to_string()
        }
    );
    assert_eq!(run(&["open", "--which"]), Err(CliError::NothingToOpen));
}

#[test]
fn open_with_electron_takes_an_app_and_its_command() {
    assert_eq!(
        run(&["open", "--electron", "slack.desktop"]).unwrap(),
        Invocation::OpenElectron {
            target: "slack.desktop".to_string(),
            command: vec![],
        }
    );
    assert_eq!(
        run(&[
            "open",
            "--electron",
            "slack.desktop",
            "--",
            "slack",
            "-u",
            "slack://a"
        ])
        .unwrap(),
        Invocation::OpenElectron {
            target: "slack.desktop".to_string(),
            command: vec!["slack".into(), "-u".into(), "slack://a".into()],
        }
    );
    assert_eq!(run(&["open", "--electron"]), Err(CliError::NothingToOpen));
    assert_eq!(
        run(&["open", "--electron", "slack", "-u"]),
        Err(CliError::ExtraToOpen {
            extra: "-u".to_string()
        })
    );
}

#[test]
fn open_with_app_opens_an_address_or_module_as_an_app() {
    assert_eq!(
        run(&["open", "--app", "https://example.com/"]).unwrap(),
        Invocation::OpenAsApp {
            target: "https://example.com/".to_string(),
            id: None,
            reuse: AppReuse::New,
            profile: None,
        }
    );
    assert_eq!(run(&["open", "--app"]), Err(CliError::NothingToOpen));
    assert_eq!(
        run(&["open", "--app", "./a.js", "./b.js"]),
        Err(CliError::ExtraToOpen {
            extra: "./b.js".to_string()
        })
    );
}

#[test]
fn open_with_app_takes_an_id_and_what_to_do_when_its_window_is_open() {
    assert_eq!(
        run(&["open", "--app", "--id", "mail", "https://mail.example/"]).unwrap(),
        Invocation::OpenAsApp {
            target: "https://mail.example/".to_string(),
            id: Some("mail".to_string()),
            reuse: AppReuse::New,
            profile: None,
        }
    );
    for (word, reuse) in [
        ("new", AppReuse::New),
        ("focus", AppReuse::Focus),
        ("navigate", AppReuse::Navigate),
    ] {
        assert_eq!(
            run(&[
                "open",
                "--app",
                "--reuse",
                word,
                "--id",
                "mail",
                "https://mail.example/"
            ])
            .unwrap(),
            Invocation::OpenAsApp {
                target: "https://mail.example/".to_string(),
                id: Some("mail".to_string()),
                reuse,
                profile: None,
            }
        );
    }
}

#[test]
fn open_with_app_takes_a_browser_profile() {
    assert_eq!(
        run(&[
            "open",
            "--app",
            "--id",
            "mail",
            "--profile",
            "work",
            "https://mail.example/"
        ])
        .unwrap(),
        Invocation::OpenAsApp {
            target: "https://mail.example/".to_string(),
            id: Some("mail".to_string()),
            reuse: AppReuse::New,
            profile: Some("work".to_string()),
        }
    );
    assert_eq!(
        run(&["open", "--app", "--profile"]),
        Err(CliError::FlagWithoutValue {
            flag: "--profile".to_string()
        })
    );
}

#[test]
fn open_with_app_refuses_a_reuse_it_cannot_carry_out() {
    assert_eq!(
        run(&["open", "--app", "--reuse", "focus", "https://mail.example/"]),
        Err(CliError::ReuseWithoutId)
    );
    assert_eq!(
        run(&["open", "--app", "--id", "mail", "--reuse", "raise", "x"]),
        Err(CliError::UnknownReuse {
            given: "raise".to_string()
        })
    );
    assert_eq!(
        run(&["open", "--app", "--id"]),
        Err(CliError::FlagWithoutValue {
            flag: "--id".to_string()
        })
    );
    assert_eq!(
        run(&["open", "--app", "--id", "mail"]),
        Err(CliError::NothingToOpen)
    );
}

#[test]
fn install_app_is_the_verb_that_takes_a_site() {
    assert_eq!(
        run(&["install-app", "https://example.com/"]).unwrap(),
        Invocation::InstallApp {
            url: "https://example.com/".to_string()
        }
    );
    assert_eq!(run(&["install-app"]), Err(CliError::NothingToInstall));
    assert_eq!(
        run(&["install-app", "https://a.example", "https://b.example"]),
        Err(CliError::ExtraToInstall {
            extra: "https://b.example".to_string()
        })
    );
}

#[test]
fn uninstall_app_is_the_verb_that_takes_an_app_address() {
    assert_eq!(
        run(&["uninstall-app", "https://example.com/"]).unwrap(),
        Invocation::UninstallApp {
            url: "https://example.com/".to_string()
        }
    );
    assert_eq!(run(&["uninstall-app"]), Err(CliError::NothingToUninstall));
    assert_eq!(
        run(&["uninstall-app", "https://a.example", "https://b.example"]),
        Err(CliError::ExtraToUninstall {
            extra: "https://b.example".to_string()
        })
    );
}

#[test]
fn screenshot_is_the_verb_that_takes_a_file() {
    // Kept as typed; the client makes it absolute.
    assert_eq!(
        run(&["screenshot", "shot.png"]).unwrap(),
        Invocation::Screenshot {
            file: Some("shot.png".to_string())
        }
    );
}

#[test]
fn screenshot_with_no_file_is_the_shells_own() {
    assert_eq!(
        run(&["screenshot"]).unwrap(),
        Invocation::Screenshot { file: None }
    );
}

#[test]
fn screenshot_takes_one_file_and_the_extra_word_is_named() {
    assert_eq!(
        run(&["screenshot", "a.png", "b.png"]),
        Err(CliError::ExtraToSave {
            extra: "b.png".to_string()
        })
    );
}

#[test]
fn screen_record_is_a_verb_that_takes_nothing() {
    assert_eq!(
        run(&["screen-record"]).unwrap(),
        Invocation::Ask {
            request: Request::ScreenRecord
        }
    );
    assert_eq!(
        run(&["screen-record", "a.webm"]),
        Err(CliError::Extra {
            verb: "screen-record".to_string(),
            extra: "a.webm".to_string()
        })
    );
}

#[test]
fn power_off_and_reboot_are_verbs_that_take_nothing() {
    assert_eq!(
        run(&["power-off"]),
        Ok(Invocation::Power { power: Power::Off })
    );
    assert_eq!(
        run(&["reboot"]),
        Ok(Invocation::Power {
            power: Power::Reboot
        })
    );
    assert_eq!(
        run(&["reboot", "now"]),
        Err(CliError::Extra {
            verb: "reboot".to_string(),
            extra: "now".to_string()
        })
    );
}

#[test]
fn log_out_is_a_verb_that_takes_nothing() {
    assert_eq!(
        run(&["log-out"]),
        Ok(Invocation::Power {
            power: Power::LogOut
        })
    );
    assert_eq!(
        run(&["log-out", "now"]),
        Err(CliError::Extra {
            verb: "log-out".to_string(),
            extra: "now".to_string()
        })
    );
}

#[test]
fn send_shell_sends_every_word_after_it_as_the_command() {
    assert_eq!(
        run(&["send-shell", "focus", "right"]),
        Ok(Invocation::Ask {
            request: Request::SendShell {
                command: vec!["focus".to_string(), "right".to_string()]
            }
        })
    );
}

#[test]
fn send_shell_with_no_command_is_refused() {
    assert_eq!(run(&["send-shell"]), Err(CliError::NothingToSend));
}

#[test]
fn disable_while_typing_takes_on_off_toggle_or_nothing() {
    let asked = |to| {
        Ok(Invocation::Ask {
            request: Request::DisableWhileTyping { to },
        })
    };
    assert_eq!(run(&["disable-while-typing"]), asked(None));
    assert_eq!(
        run(&["disable-while-typing", "on"]),
        asked(Some(Switch::On))
    );
    assert_eq!(
        run(&["disable-while-typing", "off"]),
        asked(Some(Switch::Off))
    );
    assert_eq!(
        run(&["disable-while-typing", "toggle"]),
        asked(Some(Switch::Toggle))
    );
}

#[test]
fn disable_while_typing_refuses_anything_else() {
    assert_eq!(
        run(&["disable-while-typing", "maybe"]),
        Err(CliError::NotASwitch {
            said: "maybe".to_string()
        })
    );
    assert_eq!(
        run(&["disable-while-typing", "on", "now"]),
        Err(CliError::Extra {
            verb: "disable-while-typing on".to_string(),
            extra: "now".to_string()
        })
    );
}

#[test]
fn theme_takes_light_dark_toggle_or_nothing() {
    let asked = |to| {
        Ok(Invocation::Ask {
            request: Request::Theme { to },
        })
    };
    assert_eq!(run(&["theme"]), asked(None));
    assert_eq!(run(&["theme", "light"]), asked(Some(ThemeChange::Light)));
    assert_eq!(run(&["theme", "dark"]), asked(Some(ThemeChange::Dark)));
    assert_eq!(run(&["theme", "toggle"]), asked(Some(ThemeChange::Toggle)));
}

#[test]
fn set_log_level_takes_a_level_and_subsystems_or_reset_or_nothing() {
    let ask = |request| Ok(Invocation::Ask { request });
    assert_eq!(run(&["set-log-level"]), ask(Request::LogLevels));
    assert_eq!(
        run(&["set-log-level", "debug"]),
        ask(Request::SetLogLevel {
            level: LogLevel::Debug,
            subsystems: Vec::new()
        })
    );
    assert_eq!(
        run(&["set-log-level", "trace", "input", "displays"]),
        ask(Request::SetLogLevel {
            level: LogLevel::Trace,
            subsystems: vec![Subsystem::Input, Subsystem::Displays]
        })
    );
    assert_eq!(
        run(&["set-log-level", "--reset"]),
        ask(Request::ResetLogLevels)
    );
}

#[test]
fn set_log_level_names_what_it_takes() {
    assert_eq!(
        run(&["set-log-level", "loud"]),
        Err(CliError::NotALogLevel {
            said: "loud".to_string()
        })
    );
    assert_eq!(
        run(&["set-log-level", "debug", "inptu"]),
        Err(CliError::NotASubsystem {
            said: "inptu".to_string()
        })
    );
    assert_eq!(
        run(&["set-log-level", "--reset", "input"]),
        Err(CliError::Extra {
            verb: "set-log-level --reset".to_string(),
            extra: "input".to_string()
        })
    );
    let said = CliError::NotASubsystem {
        said: "inptu".to_string(),
    }
    .to_string();
    assert!(said.contains("input, displays, windows"), "{said}");
}

#[test]
fn theme_refuses_anything_else() {
    assert_eq!(
        run(&["theme", "blue"]),
        Err(CliError::NotATheme {
            said: "blue".to_string()
        })
    );
    assert_eq!(
        run(&["theme", "dark", "now"]),
        Err(CliError::Extra {
            verb: "theme dark".to_string(),
            extra: "now".to_string()
        })
    );
}

#[test]
fn sleep_and_wake_displays_take_a_display_or_nothing() {
    let sleep = |display: Option<&str>| Request::SleepDisplays {
        display: display.map(str::to_string),
    };
    let wake = |display: Option<&str>| Request::WakeDisplays {
        display: display.map(str::to_string),
    };
    for (verb, request) in [
        ("sleep-displays", &sleep as &dyn Fn(Option<&str>) -> Request),
        ("wake-displays", &wake),
    ] {
        assert_eq!(
            run(&[verb]),
            Ok(Invocation::Ask {
                request: request(None)
            })
        );
        assert_eq!(
            run(&[verb, "DP-1"]),
            Ok(Invocation::Ask {
                request: request(Some("DP-1"))
            })
        );
        assert_eq!(
            run(&[verb, "DP-1", "eDP-1"]),
            Err(CliError::Extra {
                verb: format!("{verb} DP-1"),
                extra: "eDP-1".to_string()
            })
        );
    }
}

#[test]
fn help_is_asked_for_by_flag_word_or_after_a_verb() {
    for line in [&["--help"][..], &["-h"], &["help"]] {
        assert_eq!(
            run(line),
            Ok(Invocation::Help { command: None }),
            "{line:?}"
        );
    }
    for line in [
        &["theme", "--help"][..],
        &["theme", "-h"],
        &["help", "theme"],
    ] {
        assert_eq!(
            run(line),
            Ok(Invocation::Help {
                command: Some("theme".to_string())
            }),
            "{line:?}"
        );
    }
}

#[test]
fn help_with_man_writes_the_man_pages_to_a_directory() {
    assert_eq!(
        run(&["help", "--man", "share/man/man1"]),
        Ok(Invocation::Manuals {
            dir: PathBuf::from("share/man/man1")
        })
    );
    assert_eq!(
        run(&["help", "--man"]),
        Err(CliError::FlagWithoutValue {
            flag: "--man".to_string()
        })
    );
}

#[test]
fn help_after_a_verb_s_first_argument_is_that_argument() {
    // `exec` runs whatever follows, flags included.
    assert_eq!(
        run(&["send-shell", "exec", "foot", "--help"]),
        Ok(Invocation::Ask {
            request: Request::SendShell {
                command: vec!["exec".to_string(), "foot".to_string(), "--help".to_string()]
            }
        })
    );
}

#[test]
fn version_is_asked_for_by_flag_and_takes_nothing() {
    assert_eq!(run(&["--version"]), Ok(Invocation::Version));
    assert_eq!(
        run(&["--version", "simple"]),
        Err(CliError::Extra {
            verb: "--version".to_string(),
            extra: "simple".to_string()
        })
    );
}

#[test]
fn a_flag_domicile_does_not_take_is_refused_and_named() {
    // Taken as a shell, it reached the shell builder, which failed on it.
    for line in [&["--bsaothus"][..], &["./dist/shell.js", "--bsaothus"]] {
        assert_eq!(
            run(line),
            Err(CliError::UnknownFlag {
                flag: "--bsaothus".to_string()
            }),
            "{line:?}"
        );
    }
}

#[test]
fn help_takes_one_command_it_knows() {
    assert_eq!(
        run(&["help", "lsit-windows"]),
        Err(CliError::UnknownCommand {
            said: "lsit-windows".to_string(),
            meant: Some("list-windows")
        })
    );
    assert_eq!(
        run(&["help", "theme", "lock"]),
        Err(CliError::Extra {
            verb: "help theme".to_string(),
            extra: "lock".to_string()
        })
    );
}

#[test]
fn every_command_in_the_help_parses_as_a_verb() {
    let verbs = [
        "which-shell",
        "load-shell",
        "dev",
        "open",
        "install-app",
        "uninstall-app",
        "screenshot",
        "screen-record",
        "send-shell",
        "check-config",
        "disable-while-typing",
        "theme",
        "sleep-displays",
        "wake-displays",
        "power-off",
        "reboot",
        "log-out",
        "monitor",
        "subscribe",
        "lock",
        "focus-window",
        "close-window",
        "kill-window",
        "inhibit-idle",
        "exec",
        "trace",
        "configure-display",
        "list-displays",
        "list-windows",
        "status",
        "list-shell-commands",
        "list-bindings",
        "list-inputs",
        "idle-time",
        "list-agents",
        "stop-agent",
        "forget-agent",
        "mcp",
        "agent",
        "pointer",
        "drag",
        "scroll",
        "key",
        "type",
        "devtools",
        "accessibility",
        "accessibility-act",
        "set-log-level",
        "logs",
        "export-logs",
        "help",
    ];
    for verb in verbs {
        assert!(
            COMMANDS.iter().any(|command| command.name == verb),
            "{verb} is not in --help"
        );
    }
    assert_eq!(COMMANDS.len(), verbs.len());
    for command in COMMANDS {
        assert!(
            !matches!(
                run(&[command.name]),
                Ok(Invocation::Run { .. }) | Err(CliError::TooMany { .. })
            ),
            "--help lists {}, which is not a verb",
            command.name
        );
    }
}

#[test]
fn a_shell_whose_name_is_a_verb_is_still_reachable_as_a_path() {
    // Verbs always win over a bare word, regardless of what is on disk. A
    // shell with a verb's name is run by path.
    assert_eq!(
        run(&["./which-shell"]).unwrap(),
        Invocation::Run {
            config: None,
            shell: Some("./which-shell".to_string())
        }
    );
}

#[test]
fn a_config_is_the_other_half_of_a_run() {
    // The config is passed through to the compositor.
    assert_eq!(
        run(&["./dist/shell.js", "--config", "/etc/domicile/desk.json"]).unwrap(),
        Invocation::Run {
            config: Some(PathBuf::from("/etc/domicile/desk.json")),
            shell: Some("./dist/shell.js".to_string())
        }
    );
}

#[test]
fn the_config_may_come_before_the_shell() {
    // Order does not matter. Wrapper scripts often put fixed flags first.
    assert_eq!(
        run(&["--config", "/etc/domicile/desk.json", "./dist/shell.js"]).unwrap(),
        Invocation::Run {
            config: Some(PathBuf::from("/etc/domicile/desk.json")),
            shell: Some("./dist/shell.js".to_string())
        }
    );
}

#[test]
fn a_config_flag_with_nothing_behind_it_is_refused() {
    // Refused rather than read as "no config". A bare `--config` could mean
    // either the defaults or a missing path.
    assert_eq!(
        run(&["./dist/shell.js", "--config"]),
        Err(CliError::ConfigWithoutPath)
    );
}

#[test]
fn two_configs_are_refused_and_the_second_is_named() {
    // Keeping either silently could apply settings nobody chose.
    assert_eq!(
        run(&[
            "./dist/shell.js",
            "--config",
            "/a.json",
            "--config",
            "/b.json"
        ]),
        Err(CliError::TwoConfigs {
            second: "/b.json".to_string()
        })
    );
}

#[test]
fn a_config_alone_is_a_run_on_the_shell_it_names() {
    assert_eq!(
        run(&["--config", "/a.json"]),
        Ok(Invocation::Run {
            config: Some(PathBuf::from("/a.json")),
            shell: None
        })
    );
}

#[test]
fn check_config_is_the_verb_that_takes_a_config() {
    assert_eq!(
        run(&["check-config", "domicile.json"]).unwrap(),
        Invocation::Check {
            config: PathBuf::from("domicile.json")
        }
    );
}

#[test]
fn check_config_with_no_config_is_refused() {
    assert_eq!(run(&["check-config"]), Err(CliError::NothingToCheck));
}

#[test]
fn check_config_takes_one_config_and_the_extra_word_is_named() {
    assert_eq!(
        run(&["check-config", "a.json", "b.json"]),
        Err(CliError::ExtraToCheck {
            extra: "b.json".to_string()
        })
    );
}

#[test]
fn every_command_in_the_help_has_a_section_in_the_cli_reference() {
    let reference = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/CLI.md"),
    )
    .expect("docs/CLI.md is the CLI reference");
    for verb in COMMANDS.iter().map(|command| command.name) {
        assert!(
            reference.contains(&format!("## `domicile {verb}")),
            "docs/CLI.md has no section for {verb}"
        );
    }
}

#[test]
fn monitor_takes_a_name_and_a_size() {
    assert_eq!(
        run(&["monitor", "Left pane", "1280x720"]),
        Ok(Invocation::Monitor {
            name: "Left pane".to_string(),
            mode: MonitorMode {
                size: (1280, 720),
                refresh_mhz: 60_000,
                scale: Scale::ONE,
            },
        })
    );
}

#[test]
fn a_monitor_may_take_a_scale_after_its_size() {
    assert_eq!(
        run(&["monitor", "TV", "3840x2160@30", "2"]),
        Ok(Invocation::Monitor {
            name: "TV".to_string(),
            mode: MonitorMode {
                size: (3840, 2160),
                refresh_mhz: 30_000,
                scale: Scale::try_from(2.0).expect("a scale"),
            },
        })
    );
}

#[test]
fn monitor_refuses_a_scale_it_cannot_read_and_names_it() {
    for said in ["big", "0", "-1", "inf", "NaN"] {
        assert_eq!(
            run(&["monitor", "Pane", "1280x720", said]),
            Err(CliError::NotAScale {
                said: said.to_string()
            }),
            "{said}"
        );
    }
}

#[test]
fn a_line_read_is_a_size_and_maybe_a_scale() {
    assert_eq!(
        monitor_mode("1280x720"),
        Some(MonitorMode {
            size: (1280, 720),
            refresh_mhz: 60_000,
            scale: Scale::ONE,
        })
    );
    assert_eq!(
        monitor_mode(" 800x600@30   1.5 "),
        Some(MonitorMode {
            size: (800, 600),
            refresh_mhz: 30_000,
            scale: Scale::try_from(1.5).expect("a scale"),
        })
    );
    for said in ["", "huge", "800x600 big", "800x600 0", "800x600 2 again"] {
        assert_eq!(monitor_mode(said), None, "{said}");
    }
}

#[test]
fn a_monitors_size_may_name_its_refresh_rate() {
    assert_eq!(monitor_size("1280x720@30"), Some(((1280, 720), 30_000)));
    assert_eq!(
        monitor_size("1920x1080@59.94"),
        Some(((1920, 1080), 59_940))
    );
}

#[test]
fn a_size_that_is_not_one_is_none() {
    for said in [
        "",
        "1280",
        "1280x",
        "x720",
        "0x720",
        "1280x0",
        "big",
        "1280x720@",
        "1280x720@0",
    ] {
        assert_eq!(monitor_size(said), None, "{said}");
    }
}

#[test]
fn monitor_refuses_a_size_it_cannot_read_and_names_it() {
    assert_eq!(
        run(&["monitor", "Pane", "huge"]),
        Err(CliError::NotASize {
            said: "huge".to_string()
        })
    );
}

#[test]
fn monitor_needs_a_name_and_a_size() {
    assert_eq!(run(&["monitor"]), Err(CliError::NoMonitor));
    assert_eq!(run(&["monitor", "Pane"]), Err(CliError::NoMonitor));
}

#[test]
fn monitor_takes_nothing_after_its_scale() {
    assert_eq!(
        run(&["monitor", "Pane", "1280x720", "2", "again"]),
        Err(CliError::Extra {
            verb: "monitor Pane 1280x720 2".to_string(),
            extra: "again".to_string()
        })
    );
}

#[test]
fn subscribe_takes_topics_or_hears_every_one() {
    assert_eq!(
        run(&["subscribe", "windows", "status", "windows"]),
        Ok(Invocation::Subscribe {
            topics: vec![WatchTopic::Windows, WatchTopic::Status]
        })
    );
    assert_eq!(
        run(&["subscribe"]),
        Ok(Invocation::Subscribe {
            topics: vec![
                WatchTopic::Windows,
                WatchTopic::Displays,
                WatchTopic::Inputs,
                WatchTopic::Status,
            ]
        })
    );
    assert_eq!(
        run(&["subscribe", "workspaces"]),
        Err(CliError::NotATopic {
            said: "workspaces".to_string()
        })
    );
}

#[test]
fn a_window_is_acted_on_by_its_id() {
    assert_eq!(
        run(&["kill-window", "kD3m"]),
        Ok(Invocation::Ask {
            request: Request::ActOnWindow {
                id: "kD3m".to_string(),
                act: WindowAct::Kill
            }
        })
    );
    assert_eq!(
        run(&["focus-window"]),
        Err(CliError::NoWindow {
            verb: "focus-window".to_string()
        })
    );
    assert_eq!(
        run(&["lock"]),
        Ok(Invocation::Ask {
            request: Request::Lock
        })
    );
}

#[test]
fn inhibit_idle_runs_what_follows_the_dashes() {
    assert_eq!(
        run(&["inhibit-idle", "--", "mpv", "--fs", "film.mkv"]),
        Ok(Invocation::InhibitIdle {
            command: vec![
                "mpv".to_string(),
                "--fs".to_string(),
                "film.mkv".to_string()
            ]
        })
    );
    assert_eq!(
        run(&["inhibit-idle", "sleep", "60"]),
        Ok(Invocation::InhibitIdle {
            command: vec!["sleep".to_string(), "60".to_string()]
        })
    );
    assert_eq!(run(&["inhibit-idle", "--"]), Err(CliError::NothingToRun));
}

#[test]
fn exec_starts_every_word_after_it_as_argv() {
    assert_eq!(
        run(&["exec", "kitty", "--hold", "btop"]),
        Ok(Invocation::Ask {
            request: Request::Launch {
                command: vec![
                    "kitty".to_string(),
                    "--hold".to_string(),
                    "btop".to_string()
                ]
            }
        })
    );
    assert_eq!(run(&["exec"]), Err(CliError::NothingToExec));
}

#[test]
fn configure_display_reads_every_change() {
    assert_eq!(
        run(&[
            "configure-display",
            "DP-1",
            "mode",
            "2560x1440@143.912",
            "scale",
            "1.25",
            "position",
            "-1920,0",
            "transform",
            "270",
            "adaptive-sync",
            "on",
            "hdr",
            "off",
            "sdr-white",
            "240",
            "enable",
        ]),
        Ok(Invocation::Ask {
            request: Request::ConfigureDisplay {
                display: "DP-1".to_string(),
                change: DisplayChange {
                    reset: false,
                    enabled: Some(true),
                    mode: Some((2560, 1440)),
                    refresh: Some(143.912),
                    scale: Some(1.25),
                    position: Some((-1920, 0)),
                    transform: Some(DisplayTransform::Rotate270),
                    adaptive_sync: Some(true),
                    hdr: Some(false),
                    sdr_white: Some(240),
                },
            }
        })
    );
}

#[test]
fn configure_display_leaves_the_refresh_alone_without_one() {
    let Ok(Invocation::Ask {
        request: Request::ConfigureDisplay { change, .. },
    }) = run(&["configure-display", "eDP-1", "mode", "1920x1080", "reset"])
    else {
        panic!("not a display change");
    };
    assert_eq!(change.mode, Some((1920, 1080)));
    assert_eq!(change.refresh, None);
    assert!(change.reset);
}

#[test]
fn configure_display_names_what_it_could_not_read() {
    assert_eq!(
        run(&["configure-display"]),
        Err(CliError::NoDisplayToConfigure)
    );
    assert_eq!(
        run(&["configure-display", "DP-1"]),
        Err(CliError::NothingToConfigure {
            display: "DP-1".to_string()
        })
    );
    assert_eq!(
        run(&["configure-display", "DP-1", "scale"]),
        Err(CliError::NotADisplaySetting {
            setting: "scale".to_string(),
            said: "nothing".to_string(),
            expected: "a scale like 2 or 1.25",
        })
    );
    assert_eq!(
        run(&["configure-display", "DP-1", "transform", "45"]),
        Err(CliError::NotADisplaySetting {
            setting: "transform".to_string(),
            said: "45".to_string(),
            expected: "normal, 90, 180 or 270",
        })
    );
    assert_eq!(
        run(&["configure-display", "DP-1", "brightness", "50"]),
        Err(CliError::NotADisplayChange {
            said: "brightness".to_string()
        })
    );
}

#[test]
fn mcp_serves_agents_on_stdio_or_over_http() {
    assert_eq!(run(&["mcp"]), Ok(Invocation::Mcp { http: None }));
    assert_eq!(
        run(&["mcp", "--relay"]),
        Ok(Invocation::McpRelay { relay: None })
    );
    assert_eq!(
        run(&["mcp", "--relay", "relay.example:7444"]),
        Ok(Invocation::McpRelay {
            relay: Some("relay.example:7444".into())
        })
    );
    assert!(run(&["mcp", "--relay", "relay.example:7444", "more"]).is_err());
    assert_eq!(
        run(&["mcp", "--http", "127.0.0.1:7465"]),
        Ok(Invocation::Mcp {
            http: Some(McpHttp {
                listen: "127.0.0.1:7465".parse().unwrap(),
                url: None,
            })
        })
    );
    assert_eq!(
        run(&[
            "mcp",
            "--http",
            "[::1]:7465",
            "--url",
            "https://desk.example/"
        ]),
        Ok(Invocation::Mcp {
            http: Some(McpHttp {
                listen: "[::1]:7465".parse().unwrap(),
                url: Some("https://desk.example".to_string()),
            })
        })
    );
    assert_eq!(
        run(&["mcp", "--http", "everywhere"]),
        Err(CliError::NotAListenAddress {
            said: "everywhere".to_string()
        })
    );
    assert_eq!(
        run(&["mcp", "--http"]),
        Err(CliError::NotAListenAddress {
            said: "nothing".to_string()
        })
    );
    assert_eq!(
        run(&["mcp", "extra"]),
        Err(CliError::Extra {
            verb: "mcp".to_string(),
            extra: "extra".to_string()
        })
    );
    assert_eq!(
        run(&["mcp", "--url", "https://desk.example"]),
        Err(CliError::Extra {
            verb: "mcp".to_string(),
            extra: "--url".to_string()
        })
    );
}

#[test]
fn screenshot_fit_shrinks_the_desk_into_a_file() {
    assert_eq!(
        run(&["screenshot", "--fit", "1280", "desk.png"]),
        Ok(Invocation::ShootDesk {
            file: "desk.png".to_string(),
            fit: 1280,
            area: None,
        })
    );
    assert_eq!(
        run(&[
            "screenshot",
            "--fit",
            "1280",
            "--area",
            "-10,20,300x200",
            "desk.png"
        ]),
        Ok(Invocation::ShootDesk {
            file: "desk.png".to_string(),
            fit: 1280,
            area: Some(DeskRect {
                position: (-10, 20),
                size: (300, 200),
            }),
        })
    );
    assert!(run(&["screenshot", "--fit", "1280", "--area", "10,20", "desk.png"]).is_err());
    assert!(run(&["screenshot", "--fit", "1280"]).is_err());
    assert!(run(&["screenshot", "--fit", "big", "desk.png"]).is_err());
}

fn emulated(input: Vec<EmulatedInput>) -> Result<Invocation, CliError> {
    Ok(Invocation::Ask {
        request: Request::Emulate { input },
    })
}

fn left(pressed: bool) -> EmulatedInput {
    EmulatedInput::Button {
        button: PointerButton::Left,
        pressed,
    }
}

#[test]
fn pointer_moves_then_clicks_presses_or_releases() {
    let to = EmulatedInput::PointTo { x: 10.0, y: 20.5 };
    assert_eq!(run(&["pointer", "10,20.5"]), emulated(vec![to.clone()]));
    assert_eq!(
        run(&["pointer", "10,20.5", "click"]),
        emulated(vec![to.clone(), left(true), left(false)])
    );
    assert_eq!(
        run(&["pointer", "10,20.5", "double-click"]),
        emulated(vec![
            to.clone(),
            left(true),
            left(false),
            left(true),
            left(false)
        ])
    );
    assert_eq!(
        run(&["pointer", "10,20.5", "right-click"]),
        emulated(vec![
            to.clone(),
            EmulatedInput::Button {
                button: PointerButton::Right,
                pressed: true
            },
            EmulatedInput::Button {
                button: PointerButton::Right,
                pressed: false
            },
        ])
    );
    assert!(run(&["pointer", "ten,20"]).is_err());
    assert!(run(&["pointer", "10,20", "poke"]).is_err());
    // A press would be let go as the command ends; `drag` holds one.
    assert!(run(&["pointer", "10,20", "press"]).is_err());
    assert!(run(&["pointer"]).is_err());
}

#[test]
fn drag_holds_the_left_button_while_moving_there_a_step_at_a_time() {
    let Ok(Invocation::Ask {
        request: Request::Emulate { input },
    }) = run(&["drag", "0,0", "100,50"])
    else {
        panic!("drag emulates input");
    };
    let moves: Vec<(f64, f64)> = input
        .iter()
        .filter_map(|event| match event {
            EmulatedInput::PointTo { x, y } => Some((*x, *y)),
            _ => None,
        })
        .collect();

    assert_eq!(
        input[..2],
        [EmulatedInput::PointTo { x: 0.0, y: 0.0 }, left(true)]
    );
    assert_eq!(input.last(), Some(&left(false)));
    assert_eq!(moves.last(), Some(&(100.0, 50.0)));
    assert!(
        moves.len() > 2,
        "moves on the way, as a hand does: {moves:?}"
    );
    assert!(input
        .iter()
        .any(|event| matches!(event, EmulatedInput::Wait { .. })));
    assert!(run(&["drag", "0,0"]).is_err());
    assert!(run(&["drag", "0,0", "1,1", "2,2"]).is_err());
}

#[test]
fn scroll_takes_a_distance_across_and_down() {
    assert_eq!(
        run(&["scroll", "0,-30"]),
        emulated(vec![EmulatedInput::Scroll { dx: 0.0, dy: -30.0 }])
    );
}

#[test]
fn key_presses_a_chord_in_order_and_releases_it_in_reverse() {
    let key = |key: &str, pressed| EmulatedInput::Key {
        key: key.to_string(),
        pressed,
    };
    assert_eq!(
        run(&["key", "ctrl+shift+Tab"]),
        emulated(vec![
            key("Control_L", true),
            key("Shift_L", true),
            key("Tab", true),
            key("Tab", false),
            key("Shift_L", false),
            key("Control_L", false),
        ])
    );
    assert_eq!(
        run(&["key", "alt+super+F4"]),
        emulated(vec![
            key("Alt_L", true),
            key("Super_L", true),
            key("F4", true),
            key("F4", false),
            key("Super_L", false),
            key("Alt_L", false),
        ])
    );
}

#[test]
fn type_types_its_text_as_given() {
    assert_eq!(
        run(&["type", "Hello, world"]),
        emulated(vec![EmulatedInput::Text {
            text: "Hello, world".to_string()
        }])
    );
    assert!(run(&["type"]).is_err());
}

#[test]
fn devtools_sends_a_method_and_its_params_to_a_window() {
    let devtools = |params| {
        Ok(Invocation::Ask {
            request: Request::DevTools {
                window: "Xy7p".to_string(),
                view: None,
                method: "DOM.getBoxModel".to_string(),
                params,
            },
        })
    };
    assert_eq!(
        run(&[
            "devtools",
            "Xy7p",
            "DOM.getBoxModel",
            "{\"backendNodeId\":4}"
        ]),
        devtools(serde_json::json!({"backendNodeId": 4}))
    );
    assert_eq!(
        run(&["devtools", "Xy7p", "DOM.getBoxModel"]),
        devtools(serde_json::json!({}))
    );
    assert_eq!(
        run(&["devtools", "--view", "9", "Xy7p", "Page.reload"]),
        Ok(Invocation::Ask {
            request: Request::DevTools {
                window: "Xy7p".to_string(),
                view: Some("9".to_string()),
                method: "Page.reload".to_string(),
                params: serde_json::json!({}),
            },
        })
    );
    assert!(run(&["devtools", "--view"]).is_err());
    assert!(run(&["devtools", "Xy7p"]).is_err());
    assert!(run(&["devtools", "Xy7p", "Page.reload", "[1]"]).is_err());
    assert!(run(&["devtools", "Xy7p", "Page.reload", "{", "more"]).is_err());
}

#[test]
fn accessibility_reads_a_windows_tree_and_acts_on_its_elements() {
    use domicile_launch::accessibility::Act;
    assert_eq!(
        run(&["accessibility", "kD3m"]),
        Ok(Invocation::Accessibility {
            window: "kD3m".to_string()
        })
    );
    let act = |act| {
        Ok(Invocation::AccessibilityAct {
            window: "kD3m".to_string(),
            element: ":1.7/w/1".to_string(),
            act,
        })
    };
    assert_eq!(
        run(&["accessibility-act", "kD3m", ":1.7/w/1", "click"]),
        act(Act::Click)
    );
    assert_eq!(
        run(&["accessibility-act", "kD3m", ":1.7/w/1", "focus"]),
        act(Act::Focus)
    );
    assert_eq!(
        run(&[
            "accessibility-act",
            "kD3m",
            ":1.7/w/1",
            "set-text",
            "hi there"
        ]),
        act(Act::SetText("hi there".to_string()))
    );
    assert!(run(&["accessibility"]).is_err());
    assert!(run(&["accessibility-act", "kD3m", ":1.7/w/1"]).is_err());
    assert!(run(&["accessibility-act", "kD3m", ":1.7/w/1", "explode"]).is_err());
    assert!(run(&["accessibility-act", "kD3m", ":1.7/w/1", "set-text"]).is_err());
    assert!(run(&["accessibility-act", "kD3m", ":1.7/w/1", "click", "more"]).is_err());
}

#[test]
fn agent_takes_one_name() {
    assert_eq!(
        run(&["agent", "Claude Code"]),
        Ok(Invocation::Agent {
            name: "Claude Code".to_string()
        })
    );
    for refused in [&["agent"][..], &["agent", " "], &["agent", "a", "b"]] {
        assert!(
            matches!(run(refused), Err(CliError::NotOne { .. })),
            "{refused:?}"
        );
    }
}

#[test]
fn agents_are_listed_stopped_by_session_and_forgotten_by_name() {
    use domicile_launch::control::Request;
    assert_eq!(
        run(&["list-agents", "--json"]),
        Ok(Invocation::List {
            listing: Listing::Agents,
            json: true
        })
    );
    assert_eq!(
        run(&["stop-agent", "12"]),
        Ok(Invocation::Ask {
            request: Request::StopAgent { session: 12 }
        })
    );
    assert!(matches!(
        run(&["stop-agent", "Claude"]),
        Err(CliError::NotASession { .. })
    ));
    assert_eq!(
        run(&["forget-agent", "Claude Code"]),
        Ok(Invocation::Ask {
            request: Request::ForgetAgent {
                agent: "Claude Code".into()
            }
        })
    );
    for refused in [
        &["stop-agent"][..],
        &["forget-agent"],
        &["forget-agent", "a", "b"],
    ] {
        assert!(
            matches!(run(refused), Err(CliError::NotOne { .. })),
            "{refused:?}"
        );
    }
}

#[test]
fn trace_writes_a_file_for_twenty_seconds_or_as_long_as_asked() {
    assert_eq!(
        run(&["trace", "switch.pftrace"]),
        Ok(Invocation::Trace {
            file: "switch.pftrace".to_string(),
            seconds: 20
        })
    );
    assert_eq!(
        run(&["trace", "--seconds", "5", "switch.pftrace"]),
        Ok(Invocation::Trace {
            file: "switch.pftrace".to_string(),
            seconds: 5
        })
    );
}

#[test]
fn trace_needs_a_file_and_a_whole_number_of_seconds() {
    assert_eq!(run(&["trace"]), Err(CliError::NoTraceFile));
    assert_eq!(
        run(&["trace", "--seconds", "soon", "switch.pftrace"]),
        Err(CliError::NotSeconds {
            said: "soon".to_string()
        })
    );
    assert_eq!(
        run(&["trace", "a.pftrace", "b.pftrace"]),
        Err(CliError::Extra {
            verb: "trace".to_string(),
            extra: "b.pftrace".to_string()
        })
    );
}

#[test]
fn logs_prints_them_or_follows_them() {
    assert_eq!(run(&["logs"]), Ok(Invocation::Logs { follow: false }));
    assert_eq!(
        run(&["logs", "--follow"]),
        Ok(Invocation::Logs { follow: true })
    );
    assert_eq!(run(&["logs", "-f"]), Ok(Invocation::Logs { follow: true }));
    assert_eq!(
        run(&["logs", "--errors"]),
        Err(CliError::UnknownFlag {
            flag: "--errors".to_string()
        })
    );
}

#[test]
fn export_logs_hides_urls_and_titles_unless_asked_to_show_everything() {
    assert_eq!(
        run(&["export-logs"]),
        Ok(Invocation::ExportLogs {
            file: None,
            redact: true
        })
    );
    assert_eq!(
        run(&["export-logs", "--show-everything", "bug.txt"]),
        Ok(Invocation::ExportLogs {
            file: Some("bug.txt".to_string()),
            redact: false
        })
    );
    assert_eq!(
        run(&["export-logs", "bug.txt", "more.txt"]),
        Err(CliError::Extra {
            verb: "export-logs".to_string(),
            extra: "more.txt".to_string()
        })
    );
}
