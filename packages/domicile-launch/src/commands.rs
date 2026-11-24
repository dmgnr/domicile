//! What each `domicile` command is, for a person: the one definition
//! `domicile --help`, `domicile help <command>` and the man pages are made
//! from ([`crate::help`], [`crate::man`]). [`crate::cli`] parses the commands.
//!
//! In text, `` `code` `` is typed as it is. In a usage, `<word>` is a value
//! to fill in, `[...]` is optional, `a|b` is a choice and `...` repeats.

/// A `domicile` command.
#[derive(Debug)]
pub struct Command {
    /// The verb, such as `list-windows`.
    pub name: &'static str,
    pub group: Group,
    /// What it takes, short, for the list of commands: `<display> <change>...`.
    pub takes: &'static str,
    /// What it does, in a line of a few words, without a period.
    pub summary: &'static str,
    /// Every way to call it, after `domicile`, when there is more than
    /// [`Command::takes`].
    pub forms: &'static [&'static str],
    /// What it does, in full: a paragraph each.
    pub about: &'static [&'static str],
    /// Its arguments, flags or changes, each section titled.
    pub sections: &'static [Section],
    /// Command lines, each after `$ `.
    pub examples: &'static [&'static str],
    /// The commands it goes with.
    pub see_also: &'static [&'static str],
}

impl Command {
    /// Every way to call it, after `domicile`.
    pub fn usages(&self) -> Vec<String> {
        match self.forms {
            [] => vec![format!("{} {}", self.name, self.takes)
                .trim_end()
                .to_string()],
            forms => forms.iter().map(|form| form.to_string()).collect(),
        }
    }
}

/// A titled list of what a command takes.
#[derive(Debug)]
pub struct Section {
    pub title: &'static str,
    pub entries: &'static [(&'static str, &'static str)],
}

/// Where a command is listed in `domicile --help`, in this order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Shell,
    Windows,
    Displays,
    Input,
    Desktop,
    Capture,
    Agents,
    Other,
}

impl Group {
    pub const ALL: [Group; 8] = [
        Group::Shell,
        Group::Windows,
        Group::Displays,
        Group::Input,
        Group::Desktop,
        Group::Capture,
        Group::Agents,
        Group::Other,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Group::Shell => "Shell",
            Group::Windows => "Apps and windows",
            Group::Displays => "Displays",
            Group::Input => "Input",
            Group::Desktop => "Desktop",
            Group::Capture => "Capture",
            Group::Agents => "Agents and automation",
            Group::Other => "Config and help",
        }
    }
}

/// What `domicile` takes before any command: running a desktop.
pub const RUN: Command = Command {
    name: "",
    group: Group::Other,
    takes: "[shell] [--config <file>]",
    summary: "Run a desktop",
    forms: &["[shell] [--config <file>]", "<command> [<arg>...]"],
    about: &[
        "Runs a desktop on `<shell>`, or on the shell the config names: a JSON \
         config's `\"shell\"`, or a config module's `Shell` export. In a Wayland \
         session it opens in a window; from a console login it takes the screen.",
        "The config is `~/.config/domicile/domicile.{ts,tsx,js,mjs,json}` unless \
         `--config` names one.",
        "Every other command talks to the desktop running in this terminal's \
         session, through `DOMICILE_CONTROL`, or works without one.",
    ],
    sections: &[
        Section {
            title: "Arguments",
            entries: &[(
                "<shell>",
                "A built shell module, a shell's `.ts`/`.tsx` entry (built first), \
                 an npm or `github:` package, or `@domicile-desktop/manganese`",
            )],
        },
        Section {
            title: "Options",
            entries: &[
                ("--config <file>", "Run with this config"),
                ("--json", "Print JSON for scripts"),
                ("-h, --help", "Print help, or a command's help"),
                ("--version", "Print the version, commit and engine"),
            ],
        },
        Section {
            title: "Environment",
            entries: &[
                (
                    "DOMICILE_CONTROL",
                    "The running desktop's control socket, set in its session",
                ),
                (
                    "DOMICILE_ENGINE_ARGS",
                    "Switches to add to the browser engine's command line",
                ),
                ("NO_COLOR", "Set to anything to print without color"),
            ],
        },
        Section {
            title: "Exit status",
            entries: &[
                ("0", "It did what it was asked"),
                ("1", "It failed, or the desktop refused, saying why"),
            ],
        },
    ],
    examples: &[
        "domicile",
        "domicile @domicile-desktop/manganese",
        "domicile ./shell.tsx --config ./desk.json",
    ],
    see_also: &[],
};

/// Every command, in the order `domicile --help` lists them in each group.
pub const COMMANDS: &[Command] = &[
    // Shell
    Command {
        name: "which-shell",
        group: Group::Shell,
        takes: "",
        summary: "Print the shell the desktop serves",
        forms: &[],
        about: &["Prints the path of the shell module the running desktop serves."],
        sections: &[],
        examples: &[],
        see_also: &["load-shell", "status"],
    },
    Command {
        name: "load-shell",
        group: Group::Shell,
        takes: "<shell>",
        summary: "Serve another shell, or a new build",
        forms: &[],
        about: &[
            "Serves another shell, or a new build of the same one, in the running \
             desktop. Windows stay open. It takes the same shells as `domicile [shell]`.",
            "A failed build prints the error and keeps the running shell. A shell \
             that fails to run prints why, and the desktop goes back to the shell \
             it had.",
        ],
        sections: &[],
        examples: &["domicile load-shell ./my-desktop/dist/shell.js"],
        see_also: &["which-shell", "dev"],
    },
    Command {
        name: "dev",
        group: Group::Shell,
        takes: "<entry>",
        summary: "Serve a shell's source, hot reloading",
        forms: &[],
        about: &[
            "Serves a shell from its source, with hot module replacement, until \
             Ctrl-C. Then the desktop goes back to the shell it replaced. `<entry>` \
             is the file the shell's source starts at.",
            "An edit Vite can apply in place keeps the page's state. Any other edit \
             reloads the shell, and windows stay open.",
        ],
        sections: &[],
        examples: &["domicile dev ./my-desktop/src/shell.tsx"],
        see_also: &["load-shell"],
    },
    Command {
        name: "send-shell",
        group: Group::Shell,
        takes: "<word>...",
        summary: "Run a shell command, as a key does",
        forms: &[],
        about: &[
            "Runs a shell command, as a keybinding bound to it does, and prints \
             what it answers. `send-shell --help` lists the running shell's \
             commands.",
            "Fails with the shell's reason when no page listens, when every page \
             refuses the command, or when none says it ran it within a second.",
        ],
        sections: &[],
        examples: &[
            "domicile send-shell workspace 2",
            "domicile send-shell get-workspaces | jq '.[].name'",
        ],
        see_also: &["list-shell-commands", "list-bindings"],
    },
    Command {
        name: "list-shell-commands",
        group: Group::Shell,
        takes: "[--json]",
        summary: "List what send-shell takes",
        forms: &[],
        about: &["Prints the commands `send-shell` takes, as the running shell describes them."],
        sections: &[JSON],
        examples: &[],
        see_also: &["send-shell"],
    },
    Command {
        name: "list-bindings",
        group: Group::Shell,
        takes: "[--json]",
        summary: "List the shell's keys and gestures",
        forms: &[],
        about: &["Prints the running shell's keys and gestures in each binding mode, and what each runs."],
        sections: &[JSON],
        examples: &[],
        see_also: &["send-shell"],
    },
    // Apps and windows
    Command {
        name: "open",
        group: Group::Windows,
        takes: "<file|folder|url>",
        summary: "Open with its default app",
        forms: &[
            "open <file|folder|url>",
            "open --profile <id> <url>",
            "open --app [<option>...] <url|module>",
            "open --which <file|url>",
            "open --electron <entry|path> [-- <command>...]",
        ],
        about: &[
            "Opens a file or folder with its type's default app, or a link in a \
             browser window, in the profile its site opens in. Apps on the desktop \
             run it for `xdg-open` and `$BROWSER`.",
        ],
        sections: &[Section {
            title: "Options",
            entries: &[
                (
                    "--profile <id>",
                    "Open in browser profile `<id>`: a link, or with `--app`, a new window",
                ),
                (
                    "--app",
                    "Open a site or app module as an app: its own window, without an address bar",
                ),
                ("--id <id>", "With `--app`, make a site's window app `<id>`'s"),
                (
                    "--reuse new|focus|navigate",
                    "With `--id`, bring app `<id>`'s open window to the front, \
                     or also load the address in it, instead of opening another",
                ),
                ("--which", "Print the app `open` would use, and open nothing"),
                (
                    "--electron",
                    "Run an installed Electron app on the desktop's engine. \
                     `<command>` is its own, which runs it if the engine can't",
                ),
            ],
        }],
        examples: &[
            "domicile open ~/notes.org",
            "domicile open --app --id mail --reuse focus https://mail.example",
            "domicile open --electron slack.desktop",
        ],
        see_also: &["exec", "install-app"],
    },
    Command {
        name: "exec",
        group: Group::Windows,
        takes: "<program> [<arg>...]",
        summary: "Start a program as the desktop does",
        forms: &[],
        about: &[
            "Starts a program as the desktop starts apps: with the desktop's \
             environment, in its own scope, without a shell. A `<program>` with no \
             `/` is found on the desktop's `PATH`. Fails saying why when it does \
             not start.",
        ],
        sections: &[],
        examples: &["domicile exec kitty --hold btop"],
        see_also: &["open"],
    },
    Command {
        name: "list-windows",
        group: Group::Windows,
        takes: "[--json]",
        summary: "List native and browser windows",
        forms: &[],
        about: &[
            "Prints each window: native windows in the order they opened, then \
             browser and app windows. `focused` marks the native window with the \
             keyboard, `urgent` one that asked for it, and `private` a private \
             browser window.",
        ],
        sections: &[JSON],
        examples: &[],
        see_also: &["focus-window", "close-window", "kill-window", "subscribe"],
    },
    Command {
        name: "focus-window",
        group: Group::Windows,
        takes: "<id>",
        summary: "Show and focus a window",
        forms: &[],
        about: &[
            "Asks the shell to show and focus native window `<id>`, as \
             `list-windows` prints it. The shell decides how: Manganese switches \
             to its workspace.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["list-windows"],
    },
    Command {
        name: "close-window",
        group: Group::Windows,
        takes: "<id>",
        summary: "Ask a window to close",
        forms: &[],
        about: &[
            "Asks native window `<id>` to close, as its close button does. The app \
             may ask first, for example about unsaved work.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["list-windows", "kill-window"],
    },
    Command {
        name: "kill-window",
        group: Group::Windows,
        takes: "<id>",
        summary: "Kill a window's process",
        forms: &[],
        about: &[
            "Kills the process of native window `<id>` with `SIGKILL`, for an app \
             that no longer answers. Every window of that process goes with it.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["list-windows", "close-window"],
    },
    Command {
        name: "install-app",
        group: Group::Windows,
        takes: "<url>",
        summary: "Add a site to your applications",
        forms: &[],
        about: &[
            "Adds a site to your applications, named and drawn from its web app \
             manifest. It opens with `domicile open --app`. Needs no running desktop.",
        ],
        sections: &[],
        examples: &["domicile install-app https://example.com"],
        see_also: &["uninstall-app", "open"],
    },
    Command {
        name: "uninstall-app",
        group: Group::Windows,
        takes: "<url>",
        summary: "Remove a site install-app added",
        forms: &[],
        about: &["Removes a site `install-app` added, given the same address."],
        sections: &[],
        examples: &[],
        see_also: &["install-app"],
    },
    // Displays
    Command {
        name: "list-displays",
        group: Group::Displays,
        takes: "[--json]",
        summary: "List displays, their modes and layout",
        forms: &[],
        about: &[
            "Prints each display: every name it answers to, its mode, its size and \
             position in logical pixels, scale, rotation, HDR, adaptive sync, and \
             whether it is lit.",
        ],
        sections: &[JSON],
        examples: &[],
        see_also: &["configure-display", "sleep-displays"],
    },
    Command {
        name: "configure-display",
        group: Group::Displays,
        takes: "<display> <change>...",
        summary: "Change a monitor until restart",
        forms: &[],
        about: &[
            "Changes a monitor until the desktop restarts, like `swaymsg output`. \
             The changes sit over the display profile that matches the plugged-in \
             monitors; the config file is left alone.",
            "A change the config would refuse, such as turning off the last \
             monitor, changes nothing. Refused when the config sets \
             `output.displays`.",
        ],
        sections: &[
            Section {
                title: "Arguments",
                entries: &[(
                    "<display>",
                    "Any name `list-displays` prints, such as `DP-1`",
                )],
            },
            Section {
                title: "Changes",
                entries: &[
                    ("mode <W>x<H>[@Hz]", "A mode the monitor offers"),
                    ("scale <S>", "Scale, such as 1.25"),
                    ("position <X>,<Y>", "Top-left corner, in logical pixels"),
                    ("transform normal|90|180|270", "Turn it counterclockwise"),
                    ("adaptive-sync on|off", "Variable refresh rate"),
                    ("hdr on|off", "High dynamic range"),
                    ("sdr-white <nits>", "SDR white level while HDR is on"),
                    ("enable", "Light the monitor"),
                    ("disable", "Turn it off and leave it out of the desktop"),
                    ("reset", "Drop its earlier changes, back to the config"),
                ],
            },
        ],
        examples: &[
            "domicile configure-display DP-1 mode 2560x1440@144 scale 1.25",
            "domicile configure-display eDP-1 position 0,1440 hdr on",
            "domicile configure-display DP-1 reset",
        ],
        see_also: &["list-displays"],
    },
    Command {
        name: "sleep-displays",
        group: Group::Displays,
        takes: "[display]",
        summary: "Turn monitors off until input",
        forms: &[],
        about: &[
            "Turns every monitor off until a key, a click or a pointer move, or \
             `wake-displays`. Windows and programs carry on. Input in the first \
             second is ignored.",
            "With a display, turns only that one off, until `wake-displays` names \
             it or names none.",
        ],
        sections: &[],
        examples: &["domicile sleep-displays", "domicile sleep-displays eDP-1"],
        see_also: &["wake-displays", "list-displays"],
    },
    Command {
        name: "wake-displays",
        group: Group::Displays,
        takes: "[display]",
        summary: "Turn monitors back on",
        forms: &[],
        about: &[
            "Turns the monitors back on, after `sleep-displays` or idle blanking, \
             or only the display named.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["sleep-displays"],
    },
    Command {
        name: "monitor",
        group: Group::Displays,
        takes: "<name> <W>x<H>[@Hz] [scale]",
        summary: "Add a virtual monitor",
        forms: &[],
        about: &[
            "Adds a monitor with no screen and prints its output, such as \
             `virtual-1`. Each line read from stdin, like `1024x768@30` or \
             `3840x2160 2`, resizes it in place. It goes when stdin ends.",
            "Only a desktop on a tty or headless has monitors to add to. 60 Hz and \
             scale 1 unless given.",
        ],
        sections: &[],
        examples: &["domicile monitor \"Left pane\" 1280x720"],
        see_also: &["list-displays"],
    },
    // Input
    Command {
        name: "list-inputs",
        group: Group::Input,
        takes: "[--json]",
        summary: "List keyboards, pointers and touch",
        forms: &[],
        about: &[
            "Prints each keyboard, pointer and touch device the desktop reads, in \
             the order it found them, with its USB or Bluetooth ids as `lsusb` \
             prints them.",
        ],
        sections: &[JSON],
        examples: &[],
        see_also: &["disable-while-typing"],
    },
    Command {
        name: "pointer",
        group: Group::Input,
        takes: "<x>,<y> [click]",
        summary: "Move the pointer, then click",
        forms: &["pointer <x>,<y> [click|double-click|right-click|middle-click]"],
        about: &[
            "Moves the pointer to `<x>,<y>`, in logical pixels from the desk's \
             top-left corner, then clicks there.",
        ],
        sections: &[],
        examples: &["domicile pointer 640,360 click"],
        see_also: &["drag", "scroll", "screenshot"],
    },
    Command {
        name: "drag",
        group: Group::Input,
        takes: "<x>,<y> <x>,<y>",
        summary: "Drag from one point to another",
        forms: &[],
        about: &[
            "Presses the left button at the first point, moves to the second \
             holding it, and lets go there.",
        ],
        sections: &[],
        examples: &["domicile drag 640,360 800,360"],
        see_also: &["pointer"],
    },
    Command {
        name: "scroll",
        group: Group::Input,
        takes: "<dx>,<dy>",
        summary: "Scroll where the pointer is",
        forms: &[],
        about: &["Scrolls where the pointer is, in logical pixels: positive is right and down."],
        sections: &[],
        examples: &["domicile scroll 0,120"],
        see_also: &["pointer"],
    },
    Command {
        name: "key",
        group: Group::Input,
        takes: "<chord>",
        summary: "Press a chord such as ctrl+shift+Tab",
        forms: &[],
        about: &[
            "Presses the keys of a chord in order, then releases them in reverse. \
             Each key is an XKB keysym name in any case; `ctrl`, `shift`, `alt` \
             and `super` name the left modifiers.",
        ],
        sections: &[],
        examples: &["domicile key ctrl+shift+Tab"],
        see_also: &["type"],
    },
    Command {
        name: "type",
        group: Group::Input,
        takes: "<text>",
        summary: "Type text",
        forms: &[],
        about: &[
            "Types `<text>` on the desk's keyboard, holding Shift where a character \
             needs it. A line break presses Return.",
        ],
        sections: &[],
        examples: &["domicile type 'hello, world'"],
        see_also: &["key"],
    },
    Command {
        name: "disable-while-typing",
        group: Group::Input,
        takes: "[on|off|toggle]",
        summary: "Set the touchpad setting",
        forms: &[],
        about: &[
            "Sets whether a touchpad ignores the pointer while you type, or prints \
             it. On by default, and on again when the desktop restarts.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["list-inputs"],
    },
    // Desktop
    Command {
        name: "status",
        group: Group::Desktop,
        takes: "[--json]",
        summary: "Show the shell, theme, lock and more",
        forms: &[],
        about: &[
            "Prints how the desktop is: its shell, theme and keymap, whether it is \
             locked and its screens lit, what keeps them on, and what records or \
             controls it.",
        ],
        sections: &[JSON],
        examples: &[],
        see_also: &["subscribe"],
    },
    Command {
        name: "theme",
        group: Group::Desktop,
        takes: "[light|dark|toggle]",
        summary: "Set the theme, or print it",
        forms: &[],
        about: &[
            "Sets the theme until the desktop restarts, or prints it. Set \
             `theme.mode` in the config to keep one.",
        ],
        sections: &[],
        examples: &["domicile theme toggle"],
        see_also: &["status"],
    },
    Command {
        name: "lock",
        group: Group::Desktop,
        takes: "",
        summary: "Lock the desktop",
        forms: &[],
        about: &["Locks the desktop now, as its lock timeout does."],
        sections: &[],
        examples: &[],
        see_also: &["status"],
    },
    Command {
        name: "idle-time",
        group: Group::Desktop,
        takes: "[--json]",
        summary: "Print seconds since the last input",
        forms: &[],
        about: &[
            "Prints how many whole seconds nobody has used the desktop. Idle \
             inhibitors don't reset it.",
        ],
        sections: &[JSON],
        examples: &[],
        see_also: &["inhibit-idle"],
    },
    Command {
        name: "inhibit-idle",
        group: Group::Desktop,
        takes: "-- <command>...",
        summary: "Keep the screens on while it runs",
        forms: &[],
        about: &[
            "Runs a command and keeps the screens on, and the desktop unlocked, \
             until it exits, like `systemd-inhibit --what=idle`. Exits as the \
             command does. `--` is needed only when the command starts with `-`.",
        ],
        sections: &[],
        examples: &["domicile inhibit-idle -- rsync -a ~/photos backup:photos"],
        see_also: &["idle-time", "status"],
    },
    Command {
        name: "subscribe",
        group: Group::Desktop,
        takes: "[<topic>...]",
        summary: "Print changes as JSON lines",
        forms: &["subscribe [windows|displays|inputs|status]..."],
        about: &[
            "Prints what each topic's `--json` listing would, as one JSON line, \
             then again whenever it changes, until stopped. With no topic, every \
             one.",
        ],
        sections: &[],
        examples: &["domicile subscribe windows | jq -c '.windows | map(.title)'"],
        see_also: &["list-windows", "list-displays", "list-inputs", "status"],
    },
    Command {
        name: "power-off",
        group: Group::Desktop,
        takes: "",
        summary: "Ask, then turn the computer off",
        forms: &[],
        about: &["Asks in Domicile's dialog, then turns the computer off."],
        sections: &[],
        examples: &[],
        see_also: &["reboot", "log-out"],
    },
    Command {
        name: "reboot",
        group: Group::Desktop,
        takes: "",
        summary: "Ask, then restart the computer",
        forms: &[],
        about: &["Asks in Domicile's dialog, then restarts the computer."],
        sections: &[],
        examples: &[],
        see_also: &["power-off", "log-out"],
    },
    Command {
        name: "log-out",
        group: Group::Desktop,
        takes: "",
        summary: "Ask, then end the session",
        forms: &[],
        about: &["Asks in Domicile's dialog, then ends the login session."],
        sections: &[],
        examples: &[],
        see_also: &["power-off", "reboot"],
    },
    // Capture
    Command {
        name: "screenshot",
        group: Group::Capture,
        takes: "[file]",
        summary: "Take a screenshot",
        forms: &[
            "screenshot [file]",
            "screenshot --fit <px> [--area <x>,<y>,<w>x<h>] <file>",
        ],
        about: &[
            "With no file, opens the shell's screenshot picker and prints where the \
             picture went; Ctrl+C in the picker copies it instead. With a file, \
             writes every monitor to it as a PNG, without asking.",
        ],
        sections: &[Section {
            title: "Options",
            entries: &[
                (
                    "--fit <px>",
                    "Shrink it so neither side is over `<px>`, and print what it shows as JSON",
                ),
                (
                    "--area <x>,<y>,<w>x<h>",
                    "Take only that area of the desk, in logical pixels",
                ),
            ],
        }],
        examples: &["domicile screenshot", "domicile screenshot --fit 1280 desk.png"],
        see_also: &["screen-record", "pointer"],
    },
    Command {
        name: "screen-record",
        group: Group::Capture,
        takes: "",
        summary: "Record the screen",
        forms: &[],
        about: &[
            "Opens the shell's screen cast picker and records what is picked, with \
             its sound, until the toolbar's Stop. Prints where the video went.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["screenshot"],
    },
    Command {
        name: "trace",
        group: Group::Capture,
        takes: "[--seconds <n>] <file>",
        summary: "Record a Perfetto trace of the engine",
        forms: &[],
        about: &[
            "Records the engine's trace events to a Perfetto trace at `<file>`: \
             frame production, the GPU, page flips and input. It waits for the \
             engine to attach first; do what is slow while it records. Open it at \
             https://ui.perfetto.dev.",
        ],
        sections: &[Section {
            title: "Options",
            entries: &[("--seconds <n>", "Record for `<n>` seconds instead of 20")],
        }],
        examples: &["domicile trace switch.pftrace"],
        see_also: &["set-log-level"],
    },
    Command {
        name: "set-log-level",
        group: Group::Capture,
        takes: "[<level> [<subsystems>]]",
        summary: "Turn logs up or down until restart",
        forms: &[
            "set-log-level [<level> [<subsystem>...]]",
            "set-log-level --reset",
        ],
        about: &[
            "Sets the level the desktop logs at: `error`, `warn`, `info`, `debug` \
             or `trace`. With subsystems it sets theirs alone; without, it sets \
             everything's. The compositor and every engine process change at \
             once, and the levels last until the desktop restarts. With nothing \
             it prints the levels; `--reset` goes back to those it started at.",
            "The subsystems are input, displays, windows, rendering, cast, \
             portals, idle, clipboard, notifications, electron, agents, shell \
             and session.",
        ],
        sections: &[],
        examples: &[
            "domicile set-log-level trace input",
            "domicile set-log-level --reset",
        ],
        see_also: &["trace", "logs"],
    },
    Command {
        name: "logs",
        group: Group::Capture,
        takes: "[--follow]",
        summary: "Print the desktop's logs",
        forms: &["logs [--follow]"],
        about: &[
            "Prints what every part of the desktop logged since it started. On \
             the journal it runs `journalctl` for them; otherwise it prints the \
             newest lines the desktop kept. `--follow`, or `-f`, keeps printing \
             new ones, on the journal.",
        ],
        sections: &[],
        examples: &["domicile logs --follow"],
        see_also: &["export-logs", "set-log-level"],
    },
    Command {
        name: "export-logs",
        group: Group::Capture,
        takes: "[<file>]",
        summary: "Save the logs to attach to a bug",
        forms: &["export-logs [--show-everything] [<file>]"],
        about: &[
            "Writes the desktop's logs to one text file, with its version, \
             shell, displays and inputs, to attach to a bug report. Without a \
             file it writes `domicile-logs-<time>.txt` here.",
            "Web addresses and window titles are hidden, since they say what \
             someone was doing. `--show-everything` leaves them in.",
        ],
        sections: &[],
        examples: &["domicile export-logs", "domicile export-logs ~/bug.txt"],
        see_also: &["logs"],
    },
    // Agents and automation
    Command {
        name: "mcp",
        group: Group::Agents,
        takes: "[--http <address> | --relay]",
        summary: "Serve the Model Context Protocol",
        forms: &[
            "mcp",
            "mcp --http <address> [--url <url>]",
            "mcp --relay [<relay>]",
        ],
        about: &[
            "Serves the Model Context Protocol on stdio, so an agent can drive the \
             running desktop. Its first tool call asks you, in Domicile's dialog, \
             to let the agent in: the entire desktop, or only the windows you \
             check.",
        ],
        sections: &[Section {
            title: "Options",
            entries: &[
                (
                    "--http <address>",
                    "Serve it over HTTP, for agents that sign in",
                ),
                ("--url <url>", "The address agents reach it at, if not `<address>`"),
                (
                    "--relay [<relay>]",
                    "Serve it to agents on the web, such as claude.ai, through a relay",
                ),
            ],
        }],
        examples: &["claude mcp add domicile -- domicile mcp"],
        see_also: &["agent", "list-agents"],
    },
    Command {
        name: "agent",
        group: Group::Agents,
        takes: "<name>",
        summary: "Ask to let an agent in",
        forms: &[],
        about: &[
            "Asks to let agent `<name>` see and use the desktop, and prints what \
             you allowed, then each change, as JSON lines. Each line read from \
             stdin shows in the bar as what it did. It stays in until stdin ends.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["mcp", "list-agents"],
    },
    Command {
        name: "list-agents",
        group: Group::Agents,
        takes: "[--json]",
        summary: "List agents let in and remembered",
        forms: &[],
        about: &[
            "Prints the agents in now, with the session `stop-agent` takes and \
             what they reach, then those remembered.",
        ],
        sections: &[JSON],
        examples: &[],
        see_also: &["stop-agent", "forget-agent"],
    },
    Command {
        name: "stop-agent",
        group: Group::Agents,
        takes: "<session>",
        summary: "Stop an agent",
        forms: &[],
        about: &["Stops an agent, by its `list-agents` session, as Stop in the bar does."],
        sections: &[],
        examples: &["domicile stop-agent 12"],
        see_also: &["list-agents"],
    },
    Command {
        name: "forget-agent",
        group: Group::Agents,
        takes: "<name>",
        summary: "Make an agent ask again",
        forms: &[],
        about: &["Makes a remembered agent ask again the next time it connects."],
        sections: &[],
        examples: &[],
        see_also: &["list-agents"],
    },
    Command {
        name: "accessibility",
        group: Group::Agents,
        takes: "<window>",
        summary: "Print a window's accessibility tree",
        forms: &[],
        about: &[
            "Prints a native window's accessibility tree, one element a line with \
             its ref. Needs the accessibility bus, which at-spi2-core runs.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["accessibility-act", "list-windows"],
    },
    Command {
        name: "accessibility-act",
        group: Group::Agents,
        takes: "<window> <ref> <act>",
        summary: "Act on a window's element",
        forms: &["accessibility-act <window> <ref> click|focus|set-text <text>"],
        about: &[
            "Clicks an element of a native window by its ref from `accessibility`, \
             gives it the keyboard focus, or replaces its text.",
        ],
        sections: &[],
        examples: &[],
        see_also: &["accessibility"],
    },
    Command {
        name: "devtools",
        group: Group::Agents,
        takes: "<window> <method> [params]",
        summary: "Send a DevTools Protocol method",
        forms: &["devtools [--view <view>] <window> <method> [params]"],
        about: &[
            "Sends a DevTools Protocol method, with its params as a JSON object, to \
             a browser window's page, or `shell` for the shell's page, and prints \
             its result. Only the methods an agent needs to read and drive a page \
             go through.",
        ],
        sections: &[Section {
            title: "Options",
            entries: &[(
                "--view <view>",
                "Send it to one of the window's views, by its `list-windows --json` id",
            )],
        }],
        examples: &["domicile devtools shell Accessibility.getFullAXTree"],
        see_also: &["list-windows", "mcp"],
    },
    // Config and help
    Command {
        name: "check-config",
        group: Group::Other,
        takes: "<file>",
        summary: "Check a config without a desktop",
        forms: &[],
        about: &[
            "Checks a config file without a desktop. Fails with the reason the \
             compositor would refuse it.",
        ],
        sections: &[],
        examples: &["domicile check-config ~/.config/domicile/domicile.json"],
        see_also: &[],
    },
    Command {
        name: "help",
        group: Group::Other,
        takes: "[command]",
        summary: "Print help, or a command's",
        forms: &["help [command]", "help --man <dir>"],
        about: &[
            "Prints the commands, or one command's help. `--help` and `-h` do the \
             same, also after a command, except that `send-shell --help` lists the \
             shell's own commands.",
        ],
        sections: &[Section {
            title: "Options",
            entries: &[("--man <dir>", "Write the man pages to `<dir>`")],
        }],
        examples: &["domicile help configure-display"],
        see_also: &[],
    },
];

/// `--json` on a command that lists.
const JSON: Section = Section {
    title: "Options",
    entries: &[("--json", "Print JSON for scripts")],
};

/// The command named `name`.
pub fn command(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|command| command.name == name)
}

/// The command `word` most likely meant, if it is a near miss.
pub fn meant(word: &str) -> Option<&'static str> {
    COMMANDS
        .iter()
        .map(|command| {
            let whole = distance(word, command.name);
            // Also a word of a longer name: `windows` for `list-windows`.
            let part = command
                .name
                .split('-')
                .map(|part| distance(word, part))
                .min()
                .expect("a name has a word");
            (whole.min(part + 1), command.name)
        })
        .filter(|(distance, name)| *distance <= (name.len().min(word.len()) / 3).max(1))
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, name)| name)
}

/// The Levenshtein distance between `a` and `b`.
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (above + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(ca != *cb));
            diagonal = above;
        }
    }
    row[b.len()]
}
