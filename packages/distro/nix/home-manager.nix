# Home-manager module for Domicile.
#
# Writes `~/.config/domicile/domicile.json` and installs a `domicile` that runs
# the configured shell by default, plus a desktop entry for each of `webApps`.
# `settings` mirrors the `domicile-config` crate's schema;
# `packages/distro/tests/test-the-home-manager-module-agrees.sh` checks that they match.
# `settings` is freeform so a newer domicile works with an older module.
# `configDirectory` builds a TS config into that file and a shell.
#
# The login session belongs to the NixOS module (`packages/distro/nix/nixos.nix`).
#
# Curried so `domicilePackages` can supply this flake's package defaults and
# `bun2nix` its `fetchBunDeps`.
{
  domicilePackages,
  bun2nix,
}: {
  lib,
  pkgs,
  config,
  ...
}: let
  cfg = config.programs.domicile;

  json = pkgs.formats.json {};

  # A two-element list, as the config file takes it: `"size": [1920, 1080]`.
  pairOf = element: lib.types.addCheck (lib.types.listOf element) (xs: lib.length xs == 2);

  pair = element: description:
    lib.mkOption {
      inherit description;
      type = pairOf element;
    };

  # Drops nulls recursively, through attrsets and lists.
  #
  # `domicile` reads an absent key as a setting (no `idle.blank_after_seconds`
  # means never blank) and rejects `null` for most keys. Recurses into lists
  # because `output.profiles` contains nullable options.
  withoutNulls = value:
    if lib.isAttrs value
    then lib.mapAttrs (_: withoutNulls) (lib.filterAttrs (_: each: each != null) value)
    else if lib.isList value
    then map withoutNulls value
    else value;

  # One of the `lockdown` switches, which applications read through the
  # Lockdown portal.
  lockdownSwitch = description:
    lib.mkOption {
      inherit description;
      type = lib.types.bool;
      default = false;
    };

  # `wl_output` rotations, counterclockwise as in kanshi and sway: `rotate-270`
  # suits a panel standing on its left side. The strings match the config
  # file, not the Rust variant names.
  transform = lib.types.enum ["normal" "rotate-90" "rotate-180" "rotate-270"];

  # A display for a nested run, which has no hardware to report its size.
  display = lib.types.submodule {
    options = lib.recursiveUpdate (removed.optionsUnder "output.displays[]") {
      name = lib.mkOption {
        description = "The display's name, shared by the chrome and the compositor. Matched exactly.";
        type = lib.types.str;
      };
      position =
        (pair lib.types.int "The top-left corner, in the config's coordinate space. May be negative.")
        // {default = [0 0];};
      size = pair lib.types.ints.positive "Width and height in logical units. The `wl_output` mode is this times `scale`.";
      scale = lib.mkOption {
        description = "The `wl_output` scale advertised to clients on this display.";
        type = lib.types.ints.positive;
        default = 1;
      };
    };
  };

  # One monitor's placement in a profile. The monitor reports its own mode, so
  # there is no size.
  placement = lib.types.submodule {
    options = lib.recursiveUpdate (removed.optionsUnder "output.profiles[].displays[]") {
      display = lib.mkOption {
        description = ''
          The monitor to place. Matches the output name (`drm-<id>`), the EDID's
          `"<MAKE> <MODEL> <SERIAL>"` (`DEL DELL U3219Q 2ZLS413`), or the same
          with the maker's name from hwdata's `pnp.ids` (`Dell Inc. DELL U3219Q
          2ZLS413`), as kanshi and sway use.
        '';
        type = lib.types.str;
      };
      enabled = lib.mkOption {
        description = "Whether to turn this monitor on. A profile must still list the monitors it turns off.";
        type = lib.types.bool;
        default = true;
      };
      mode = lib.mkOption {
        description = ''
          The mode to light this monitor at, in physical pixels. If the monitor
          offers no mode of this size, the running desktop is left as is and
          the problem is reported. `null` uses the monitor's native mode.
        '';
        type = lib.types.nullOr (pairOf lib.types.ints.positive);
        default = null;
      };
      refresh = lib.mkOption {
        description = ''
          The refresh rate to light this monitor at, in Hz, such as `59.94` or
          `120`. The nearest rate the monitor offers is used. `null` uses the
          native mode's rate, or the highest one at a non-native `mode`.
        '';
        type = lib.types.nullOr lib.types.numbers.positive;
        default = null;
      };
      adaptive_sync = lib.mkOption {
        description = ''
          Whether to scan out with a variable refresh rate (adaptive sync,
          FreeSync, G-Sync Compatible). Used only where the monitor and its
          driver support it; the display reports whether it took.
        '';
        type = lib.types.bool;
        default = false;
      };
      hdr = lib.mkOption {
        description = ''
          Whether to drive this monitor in HDR (HDR10). Used only where the
          monitor's EDID takes PQ and the connector scans out in 10 bits;
          elsewhere it stays SDR.
        '';
        type = lib.types.bool;
        default = false;
      };
      sdr_white = lib.mkOption {
        description = ''
          In HDR, how bright ordinary (SDR) content's white is, in cd/m².
          `null` is 203, the ITU-R BT.2408 reference white.
        '';
        type = lib.types.nullOr (lib.types.ints.between 1 10000);
        default = null;
      };
      position =
        (pair lib.types.int "The top-left corner, in the desktop's logical units.")
        // {default = [0 0];};
      scale = lib.mkOption {
        description = ''
          Device pixels per logical pixel. May be fractional: 1.5 on a 2880x1920
          panel gives a 1920x1280 desktop.
        '';
        type = lib.types.numbers.positive;
        default = 1.0;
      };
      transform = lib.mkOption {
        description = "The monitor's rotation.";
        type = transform;
        default = "normal";
      };
    };
  };

  # A cursor theme for each of `theme.mode`'s modes.
  perModeCursorThemes = lib.types.submodule {
    options = {
      dark = lib.mkOption {
        description = "The cursor theme in dark mode.";
        type = lib.types.str;
      };
      light = lib.mkOption {
        description = "The cursor theme in light mode.";
        type = lib.types.str;
      };
    };
  };

  # A keymap to switch to, as `input.keyboard.keymaps` lists it.
  keymap = lib.types.submodule {
    options = {
      name = lib.mkOption {
        description = "What the `keymap` command and the bar call it, such as `dvp`. Unique, and not `next`.";
        type = lib.types.str;
      };
      xkb_rules = lib.mkOption {
        description = "Passed to xkb as is. Empty uses the libxkbcommon default.";
        type = lib.types.str;
        default = "";
      };
      xkb_model = lib.mkOption {
        description = "Passed to xkb as is. Empty uses the libxkbcommon default.";
        type = lib.types.str;
        default = "";
      };
      xkb_layout = lib.mkOption {
        description = "The layout, in sway's format.";
        type = lib.types.str;
        default = "us";
      };
      xkb_variant = lib.mkOption {
        description = "The variant, e.g. `dvp`. Empty uses the layout's default.";
        type = lib.types.str;
        default = "";
      };
      xkb_options = lib.mkOption {
        description = "xkb options, as a list.";
        type = lib.types.listOf lib.types.str;
        default = [];
      };
    };
  };

  # A tablet or touchscreen and the monitor it covers.
  pointer = lib.types.submodule {
    options = {
      device = lib.mkOption {
        description = ''
          The device's evdev name or `phys`, matched exactly. A shared name
          (`QEMU QEMU USB Tablet`) binds every device that has it; `phys`
          (`usb-0000:00:04.0-1/input0`) tells them apart.
        '';
        type = lib.types.str;
      };
      display = lib.mkOption {
        description = "The monitor the device covers, named as a profile's `display` is.";
        type = lib.types.str;
      };
    };
  };

  # A monitor arrangement, chosen by which monitors are connected. The first
  # profile whose exact set is connected wins, rechecked on every hotplug.
  profile = lib.types.submodule {
    options = lib.recursiveUpdate (removed.optionsUnder "output.profiles[]") {
      name = lib.mkOption {
        description = "The profile's name, used in logs. Must be unique.";
        type = lib.types.str;
      };
      displays = lib.mkOption {
        description = "The monitors this profile places. It applies only when exactly this set is connected.";
        type = lib.types.listOf placement;
      };
    };
  };

  # Runs `domicile`, appending the configured shell unless the command line
  # already names what to run:
  #
  #   domicile                       -- runs the configured shell
  #   domicile which-shell           -- passed through
  #   domicile load-shell ./other.js -- passed through
  #   domicile ./other.js            -- the typed shell wins
  #
  # The scan skips the argument after `--config`.
  launcher = pkgs.writeShellScript "domicile" ''
    for word in "$@"; do
      if [ -n "''${skip-}" ]; then
        skip=
        continue
      fi
      case "$word" in
        --config) skip=1 ;;
        *) named_one=1 ;;
      esac
    done

    # A verb is only a verb as the first word, and a line that starts with one
    # has said what it wants whatever follows -- `load-shell` takes a shell of
    # its own and `open` an address, none of which is the configured shell
    # being asked for.
    case "''${1-}" in
      which-shell|load-shell|open) named_one=1 ;;
    esac

    if [ -n "''${named_one-}" ]; then
      exec ${cfg.package}/bin/domicile "$@"
    fi
    exec ${cfg.package}/bin/domicile "$@" ${lib.escapeShellArg (toString cfg.shell)}
  '';

  # One argument of a desktop entry's `Exec`, quoted as the spec asks: `"`,
  # `` ` ``, `$` and `\` escaped inside the quotes, then `\` escaped again as a
  # string value, and `%` doubled so it is not a field code.
  execArgument = word:
    lib.replaceStrings ["\\" "%"] ["\\\\" "%%"]
    ''"${lib.escape ["\\" "\"" "`" "$"] word}"'';

  # Settings the compositor no longer reads, by dotted path, and where each
  # went. `packages/distro/nix/removed-settings.nix` makes them hidden options that
  # fail an assertion when set.
  # `packages/distro/tests/test-a-dropped-config-field-is-removed-here.sh`
  # fails when a field leaves `domicile-config` and neither it nor an ancestor
  # is listed here.
  removedSettings = {
    applications = ''
      `applications.omit` and `applications.bookmarks` are manganese's
      `applications` option. See docs/LAUNCHER.md.
    '';
    "lock.passphrase" = ''
      The account password unlocks the desk, through PAM. See docs/LOCK.md.
    '';
    "lock.passphrase_hash" = ''
      The account password unlocks the desk, through PAM. See docs/LOCK.md.
    '';
    "idle.warn_before_seconds" = ''
      The shell chooses when to dim before blanking, with
      `session.idleBeforeBlanking`. See docs/SHELL-IDLE-AND-LOCK.md.
    '';
    "extensions.settings.*.private" = ''
      A private browser profile's extension switches say what runs in
      private windows: `browser.profiles.<id>.extensions`. See
      docs/architecture/BROWSER-PROFILES.md.
    '';
    "electron.profiles" = ''
      An Electron app's own `setWindowOpenHandler` decides on its pages' new
      windows, and the links it hands to `shell.openExternal` open in the
      browser. See docs/architecture/ELECTRON-APPS.md.
    '';
  };

  removed = import ./removed-settings.nix {inherit lib;} removedSettings;

  # The config file, checked by the `domicile` that reads it. A setting the
  # compositor refuses fails the build instead of the desk.
  checkedConfig = settings: let
    written = json.generate "domicile.json" settings;
    # A TS config's exports go over `settings`, so the module's defaults do not
    # replace them.
    file =
      if cfg.configDirectory == null
      then written
      else
        pkgs.runCommandLocal "domicile.json" {nativeBuildInputs = [pkgs.jq];} ''
          jq -s '.[0] * .[1]' ${written} ${built}/config.json >"$out"
        '';
  in
    pkgs.runCommandLocal "domicile.json" {} ''
      ${cfg.package}/bin/domicile check-config ${file}
      cp ${file} "$out"
    '';

  # `configDirectory` built: `config.json` holds every export but `Shell`, and
  # `shell/` the bundled `Shell`. bun's cache comes from the directory's
  # `bun.nix`, so the builder installs without a network.
  #
  # Forces `entry` first, so a directory without a config module fails on that
  # instead of on a missing `bun.nix`.
  built = let
    entry = configModuleIn cfg.configDirectory;
  in
    builtins.seq entry (pkgs.runCommand "domicile-config" {
      nativeBuildInputs = [pkgs.jq];
      bunDeps = bun2nix.fetchBunDeps {bunNix = cfg.configDirectory + "/bun.nix";};
    } ''
      set -o pipefail
      export HOME="$TMPDIR"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      # Dereferenced and writable: bun copies packages out of its cache and
      # fails on read-only store files.
      cp -rL "$bunDeps/share/bun-cache" "$BUN_INSTALL_CACHE_DIR"
      cp -r ${cfg.configDirectory} config
      chmod -R u+w "$BUN_INSTALL_CACHE_DIR" config

      # Runs the builder and prints `field` of its `step` line.
      run() { # step field builder-arguments...
        ${cfg.package}/libexec/domicile/builder "''${@:3}" --cache "$TMPDIR/cache" \
          | tee /dev/stderr \
          | jq -rR "fromjson? | select(.step == \"$1\") | $2"
      }
      evaluated=$(run evaluated .config --evaluate config/${entry})
      shell=$(run built .root --entry config/${entry})
      mkdir "$out"
      cp "$evaluated" "$out/config.json"
      cp -r "$shell" "$out/shell"
    '');

  # The one `domicile.{ts,tsx,js,mjs}` in `directory`.
  configModuleIn = directory: let
    found =
      lib.filter (name: lib.pathExists (directory + "/${name}"))
      (map (extension: "domicile.${extension}") ["ts" "tsx" "js" "mjs"]);
  in
    if lib.length found == 1
    then lib.head found
    else throw "programs.domicile.configDirectory: ${toString directory} must hold one of domicile.{ts,tsx,js,mjs}, and holds ${toString (lib.length found)}";
in {
  imports = [
    (lib.mkRemovedOptionModule ["programs" "domicile" "defaultBrowser"] ''
      Domicile ships its own `domicile-mimeapps.list` and puts it in front of
      every app's data directories, so the home needs no file: inside a desk
      web links open there unless a `mimeapps.list` of your own names a
      browser.
    '')
  ];

  options.programs.domicile = {
    enable = lib.mkEnableOption "Domicile, a Wayland compositor whose renderer is a web engine";

    package = lib.mkOption {
      description = ''
        The package providing `domicile`, `domicile-compositor` and the
        engine beside them.
      '';
      type = lib.types.package;
      default = domicilePackages.domicile;
      defaultText = lib.literalExpression "domicile.packages.\${system}.domicile";
    };

    shell = lib.mkOption {
      description = ''
        The built JavaScript module for your desktop, baked into the `domicile`
        on PATH.

        Must be the module file, not its directory; `domicile` refuses a
        directory.

        `null` leaves `domicile` taking the shell as an argument, for switching
        between desktops.
      '';
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "\"\${domicile.packages.\${system}.manganese}/shell.js\"";
    };

    configDirectory = lib.mkOption {
      description = ''
        A directory holding a TS or JS config, `domicile.{ts,tsx,js,mjs}`,
        with its `package.json`, `bun.lock` and the `bun.nix` that
        `bunx bun2nix -o bun.nix` writes. The build evaluates its exports into
        the config file over `settings`, and builds its `Shell` as `shell`.

        `null` leaves the config to `settings` and `shell`.
      '';
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./domicile";
    };

    settings = lib.mkOption {
      description = ''
        The compositor configuration, written to
        `''${config.xdg.configHome}/domicile/domicile.json`, the default
        `--config` path.

        `domicile` re-reads it while running, so a rebuild applies to a running
        desk without closing windows. Options read only at startup say so.

        This mirrors the `domicile-config` schema. It is freeform: unknown keys
        are written through.
      '';
      default = {};
      type = lib.types.submodule {
        freeformType = json.type;
        options = lib.recursiveUpdate (removed.optionsUnder "") {
          extensions = {
            web_store = lib.mkOption {
              description = ''
                Chrome Web Store IDs of extensions to install and keep updated.
                Listing one installs it without a prompt; removing it uninstalls
                it. Manifest V3 only.
              '';
              type = lib.types.listOf lib.types.str;
              default = [];
              example = ["ddkjiahejlhfcafbddmgiahcphecmpfh"];
            };
            unpacked = lib.mkOption {
              description = ''
                Directories of unpacked extensions to load. Absolute, or
                starting with `~` (`~` or `~/...`), expanded to the desk's home.
                `~user` is refused.
              '';
              type = lib.types.listOf lib.types.str;
              default = [];
              example = ["~/src/my-extension"];
            };
            settings = lib.mkOption {
              description = ''
                Each extension's chrome://extensions settings, by extension ID.
                A setting left unset is changed in the Settings app; one
                removed from here goes back to Chrome's default. An extension
                that cannot use a setting refuses it.
              '';
              type = lib.types.attrsOf (lib.types.submodule {
                options = lib.recursiveUpdate (removed.optionsUnder "extensions.settings.*") {
                  file_access = lib.mkOption {
                    description = "Runs on local files (`file://` pages). Chrome's default is no.";
                    type = lib.types.nullOr lib.types.bool;
                    default = null;
                  };
                  user_scripts = lib.mkOption {
                    description = "May run the user scripts you add to it (`chrome.userScripts`). Chrome's default is no.";
                    type = lib.types.nullOr lib.types.bool;
                    default = null;
                  };
                  site_access = lib.mkOption {
                    description = ''
                      Which of the sites it asks for it runs on: `"on_click"`,
                      `"all_sites"`, or a list of hosts, each also as `*.host`
                      for its subdomains. Chrome's default is all.
                    '';
                    type = lib.types.nullOr (lib.types.either (lib.types.enum ["on_click" "all_sites"]) (lib.types.listOf lib.types.str));
                    default = null;
                  };
                };
              });
              default = {};
              example = {
                eimadpbcbfnmbkopoojfekhnkhdbieeh = {
                  file_access = true;
                  site_access = ["github.com"];
                };
              };
            };
          };

          files.omit = lib.mkOption {
            description = ''
              Paths the launcher's file index skips, as gitignore-style globs
              relative to the home: `*` stops at `/`, `**` does not, a leading
              `!` re-includes, and the last matching pattern wins. Skipped
              directories are not walked, so nothing under them can be
              re-included.

              The default skips hidden files at any depth. Setting a list
              replaces it.

              Applied on reload; the home is re-indexed.
            '';
            type = lib.types.listOf lib.types.str;
            default = ["**/.*"];
            example = ["*/*" "!Scratch/*"];
          };

          idle = {
            blank_after_seconds = lib.mkOption {
              description = ''
                Seconds without input before the screens blank. Any key, click,
                scroll or pointer movement wakes them.

                `null`, the default, never blanks. A blank screen looks like a
                crash, so this is opt-in.

                Blanking does not lock; see `lock_after_seconds`.

                Applied on reload, including adding or removing the timeout.
                Blanked screens turn back on when this changes.
              '';
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              example = 600;
            };
            lock_after_seconds = lib.mkOption {
              description = ''
                Seconds without input before the desk locks. It runs on its own
                clock, so it may be shorter or longer than
                `blank_after_seconds`. Apps holding the screens on hold the
                lock off too.

                `null`, the default, locks only when the shell asks. Applied on
                reload.
              '';
              type = lib.types.nullOr lib.types.ints.positive;
              default = null;
              example = 900;
            };
          };

          lock = {
            pam_service = lib.mkOption {
              description = ''
                The PAM service that checks the user's password to unlock the
                desk. `null`, the default, is `domicile`.

                Home-manager cannot declare a PAM service. The flake's NixOS
                module declares `domicile`, or declare it yourself:

                    security.pam.services.domicile = {};

                Without it the desk does not lock, since nothing could unlock
                it, until the service is declared. See docs/LOCK.md.

                The desk locks when `idle.lock_after_seconds` elapses or when
                its shell asks. Applied on reload; a reload never unlocks a
                locked desk.
              '';
              type = lib.types.nullOr lib.types.str;
              default = null;
              example = "login";
            };
          };

          # Agents on the web, such as claude.ai, reach the desk through
          # Domicile's relay while this is set: the compositor runs
          # `domicile mcp --relay`. Applied on reload.
          agents.web = lib.mkOption {
            description = ''
              Whether agents on the web, such as claude.ai, can reach the
              desktop through Domicile's relay. Each still signs in only once
              you allow it on the desktop, and asks before it uses anything. Settings ›
              Agents › Connect from the web sets it.
            '';
            type = lib.types.bool;
            default = false;
          };

          # Applications enforce these themselves; the compositor reports them
          # through the Lockdown portal. Applied on reload.
          lockdown = {
            disable_printing = lockdownSwitch "Asks applications not to print.";
            disable_save_to_disk = lockdownSwitch "Asks applications not to save files.";
            disable_application_handlers = lockdownSwitch "Asks applications not to open files or links in other applications.";
            disable_location = lockdownSwitch "Asks applications not to read the location.";
            disable_camera = lockdownSwitch "Asks applications not to use cameras.";
            disable_microphone = lockdownSwitch "Asks applications not to use microphones.";
            disable_sound_output = lockdownSwitch "Asks applications not to play sound.";
          };

          shell_options = lib.mkOption {
            description = ''
              Values for the options the shell declares, by key. The shell
              reads them live; the Settings app's Shell page lists them.
              Applied on reload.
            '';
            type = lib.types.attrsOf json.type;
            default = {};
            example = {clock.format = "12h";};
          };

          startup.commands = lib.mkOption {
            description = ''
              Commands the desk runs once at startup, each an argv with no
              shell. They run on the desk's display. A reload does not rerun
              them.
            '';
            type = lib.types.listOf (lib.types.nonEmptyListOf lib.types.str);
            default = [];
            example = [["emacsclient" "-e" "t"]];
          };

          terminal = lib.mkOption {
            description = ''
              The terminal applications such as htop and vim run in: an argv
              that opens a terminal on its own and runs an application's argv
              put after it. The launcher and `domicile open` offer those
              applications only when it is set, and Manganese opens it on
              Meta+Return. Unset, there is no terminal. Applied on reload.
            '';
            type = lib.types.nullOr (lib.types.nonEmptyListOf lib.types.str);
            default = null;
            example = ["kitty"];
          };

          theme.mode = lib.mkOption {
            description = ''
              Whether the desktop is drawn dark or light.

              There is no `"system"` value, because Domicile is the system and
              has no preference to follow. `"system"` is refused.

              The shell draws with it, and the compositor passes it to the
              settings portal, which GTK, Qt, Electron and Firefox windows read.

              This is the startup theme. The shell's toggle changes the live
              theme without writing this file, since the file is generated. A
              rebuild that changes this value overrides the toggle.
            '';
            type = lib.types.enum ["dark" "light"];
            default = "dark";
            example = "light";
          };

          theme.accent_color = lib.mkOption {
            description = ''
              The color applications highlight with, as `"#rrggbb"`, through
              the settings portal. `null`, the default, leaves each
              application its own.
            '';
            type = lib.types.nullOr (lib.types.strMatching "#[0-9a-fA-F]{6}");
            default = null;
            example = "#3584e4";
          };

          theme.contrast = lib.mkOption {
            description = "Whether applications draw with high contrast, through the settings portal.";
            type = lib.types.enum ["normal" "high"];
            default = "normal";
          };

          theme.reduced_motion = lib.mkOption {
            description = "Whether applications keep animation to a minimum, through the settings portal.";
            type = lib.types.bool;
            default = false;
          };

          theme.icon_theme = lib.mkOption {
            description = ''
              The icon theme shells and applications draw icons from, by its
              directory name under `share/icons`. Install the theme's package
              too. `null`, the default, leaves shells with `hicolor`.
            '';
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = "Papirus-Dark";
          };

          theme.cursor_theme = lib.mkOption {
            description = ''
              The cursor theme applications draw their cursors from, by its
              directory name under `share/icons`, through the settings portal,
              and the engine draws the pointer from on a tty. A string is used
              in both modes; `{ dark; light; }` names one per mode. Install
              the theme's package too. `null`, the default, leaves each
              application its own.
            '';
            type = lib.types.nullOr (lib.types.either lib.types.str perModeCursorThemes);
            default = null;
            example = {
              dark = "Bibata-Modern-Ice";
              light = "Bibata-Modern-Classic";
            };
          };

          theme.cursor_size = lib.mkOption {
            description = "The cursor size applications draw, in logical pixels, through the settings portal, and the engine draws the pointer at on a tty. `null`, the default, leaves each application its own.";
            type = lib.types.nullOr (lib.types.ints.between 1 65535);
            default = null;
            example = 32;
          };

          theme.cursor_hide_after_ms = lib.mkOption {
            description = "Hides the pointer after this many milliseconds without pointer input. `null`, the default, never hides it.";
            type = lib.types.nullOr (lib.types.ints.between 1 4294967295);
            default = null;
            example = 1000;
          };

          theme.cursor_hide_when_typing = lib.mkOption {
            description = "Hides the pointer on a typing key press, until the pointer is next used.";
            type = lib.types.bool;
            default = false;
          };

          theme.font_name = lib.mkOption {
            description = "The interface font applications draw text in, as a Pango font description, through the settings portal. `null`, the default, leaves each application its own.";
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = "Inter 11";
          };

          theme.monospace_font_name = lib.mkOption {
            description = "The fixed-width font applications draw code and terminals in, as a Pango font description, through the settings portal. `null`, the default, leaves each application its own.";
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = "Iosevka 12";
          };

          theme.force_dark = lib.mkOption {
            description = ''
              Host names of sites the browser draws dark while `theme.mode` is
              `"dark"`, for sites with no dark theme of their own. A host
              covers its subdomains.
            '';
            type = lib.types.listOf lib.types.str;
            default = [];
            example = ["mail.google.com"];
          };

          spellcheck = {
            enabled = lib.mkOption {
              description = ''
                Whether text fields in browser tabs, web apps and Electron apps
                underline misspelled words and offer fixes in their menu.
              '';
              type = lib.types.bool;
              default = true;
            };
            languages = lib.mkOption {
              description = ''
                The languages words are checked in, as language tags. The
                dictionaries ship with the engine; none is downloaded.
              '';
              type = lib.types.nonEmptyListOf lib.types.str;
              default = ["en-US"];
              example = ["en-US" "de-DE"];
            };
          };

          input.keyboard = {
            xkb_rules = lib.mkOption {
              description = "Passed to xkb as is. Empty uses the libxkbcommon default.";
              type = lib.types.str;
              default = "";
            };
            xkb_model = lib.mkOption {
              description = "Passed to xkb as is. Empty uses the libxkbcommon default.";
              type = lib.types.str;
              default = "";
            };
            xkb_layout = lib.mkOption {
              description = ''
                The layout, in sway's format, including comma-separated multiple
                layouts (`"us,de"`).
              '';
              type = lib.types.str;
              default = "us";
            };
            xkb_variant = lib.mkOption {
              description = "The variant, e.g. `dvp`. Empty uses the layout's default.";
              type = lib.types.str;
              default = "";
            };
            xkb_options = lib.mkOption {
              description = ''
                xkb options, as a list instead of sway's comma-separated string.
              '';
              type = lib.types.listOf lib.types.str;
              default = [];
              example = ["caps:escape"];
            };
            keymaps = lib.mkOption {
              description = ''
                Keymaps the desktop switches between, with the `keymap`
                command or the bar. The first is the one it starts on. Set
                these or the `xkb_*` fields above, not both. A switch lasts
                until the desktop restarts.
              '';
              type = lib.types.listOf keymap;
              default = [];
              example = [
                {
                  name = "dvp";
                  xkb_variant = "dvp";
                }
                {name = "us";}
              ];
            };
            repeat = {
              delay_ms = lib.mkOption {
                description = "Milliseconds a key is held before it repeats, in native windows and pages.";
                type = lib.types.ints.u16;
                default = 500;
              };
              rate = lib.mkOption {
                description = "Repeats a second while a key is held. 0 turns repeat off.";
                type = lib.types.ints.u16;
                default = 25;
              };
            };
          };

          input.touchpad = {
            tap = lib.mkOption {
              description = "Tap to click.";
              type = lib.types.bool;
              default = true;
            };
            tap_button_map = lib.mkOption {
              description = "Buttons for one-, two- and three-finger taps.";
              type = lib.types.enum ["lrm" "lmr"];
              default = "lrm";
            };
            tap_drag = lib.mkOption {
              description = "Drag by tapping, then holding a second tap.";
              type = lib.types.bool;
              default = true;
            };
            drag_lock = lib.mkOption {
              description = "Keep a tap drag held when the fingers lift briefly.";
              type = lib.types.bool;
              default = false;
            };
            natural_scroll = lib.mkOption {
              description = "Move content in the direction the fingers move.";
              type = lib.types.bool;
              default = false;
            };
            accel_profile = lib.mkOption {
              description = "How movement speed affects pointer acceleration.";
              type = lib.types.enum ["adaptive" "flat"];
              default = "adaptive";
            };
            speed = lib.mkOption {
              description = "Pointer acceleration speed, from -1 to 1.";
              type = lib.types.addCheck lib.types.number (value: value >= -1 && value <= 1);
              default = 0;
            };
            click_method = lib.mkOption {
              description = "Physical click behavior; `default` uses the device's libinput default, and clickfinger maps one, two and three fingers to left, right and middle.";
              type = lib.types.enum ["default" "clickfinger" "button_areas"];
              default = "default";
            };
            middle_emulation = lib.mkOption {
              description = "Emulate a middle click by pressing left and right together.";
              type = lib.types.bool;
              default = false;
            };
            scroll_method = lib.mkOption {
              description = "Scrolling gesture; `default` uses the device's libinput default.";
              type = lib.types.enum ["default" "two_finger" "edge" "on_button_down"];
              default = "default";
            };
            scroll_factor = lib.mkOption {
              description = "Multiplier applied once to both scrolling axes.";
              type = lib.types.numbers.positive;
              default = 1;
            };
            scroll_acceleration = lib.mkOption {
              description = "Increase page scroll distance with gesture speed, up to four times.";
              type = lib.types.bool;
              default = true;
            };
            disable_while_typing = lib.mkOption {
              description = "Typing suppression policy; `libinput` uses native keyboard pairing and contacts, while custom `internal` excludes external pads.";
              type = lib.types.enum ["enabled" "disabled" "internal" "libinput"];
              default = "enabled";
            };
            typing_pause_ms = lib.mkOption {
              description = "Custom pause after one typing key in milliseconds; zero means no pause, and `libinput` mode requires 200.";
              type = lib.types.ints.between 0 2147483647;
              default = 200;
            };
            typing_repeat_pause_ms = lib.mkOption {
              description = "Custom pause during continued typing in milliseconds; zero means no pause, and `libinput` mode requires 500.";
              type = lib.types.ints.between 0 2147483647;
              default = 500;
            };
          };

          input.mouse = {
            accel_profile = lib.mkOption {
              description = "How movement speed affects pointer acceleration.";
              type = lib.types.enum ["adaptive" "flat"];
              default = "adaptive";
            };
            speed = lib.mkOption {
              description = "Pointer acceleration speed, from -1 to 1.";
              type = lib.types.addCheck lib.types.number (value: value >= -1 && value <= 1);
              default = 0;
            };
            natural_scroll = lib.mkOption {
              description = "Reverse the mouse wheel's scrolling direction.";
              type = lib.types.bool;
              default = false;
            };
            middle_emulation = lib.mkOption {
              description = "Emulate a middle click by pressing left and right together.";
              type = lib.types.bool;
              default = false;
            };
            scroll_factor = lib.mkOption {
              description = "Multiplier applied once to both scrolling axes.";
              type = lib.types.numbers.positive;
              default = 1;
            };
          };

          input.pointers = lib.mkOption {
            description = ''
              Tablets and touchscreens on a tty, each bound to the monitor it
              covers. An unbound one covers no monitor.
            '';
            type = lib.types.listOf pointer;
            default = [];
            example = [
              {
                device = "usb-0000:00:04.0-1/input0";
                display = "Virtual-1";
              }
            ];
          };

          output = {
            displays = lib.mkOption {
              description = ''
                Explicit displays for a nested run, which has no monitors to
                enumerate. Empty gives a single output that follows Domicile's
                window.
              '';
              type = lib.types.listOf display;
              default = [];
            };
            max_scale = lib.mkOption {
              description = ''
                The highest `wl_output` scale to advertise. Limits cost: a
                client at scale N draws N² times the pixels. `1` disables
                scaling.

                Applies only to the output that follows Domicile's window; a
                listed display sets its own scale.

                Applied on reload.
              '';
              type = lib.types.ints.positive;
              default = 2;
            };
            profiles = lib.mkOption {
              description = ''
                Monitor arrangements, as in kanshi: the first profile whose
                exact set is connected wins, rechecked on every hotplug.
              '';
              type = lib.types.listOf profile;
              default = [];
            };
          };
        };
      };
    };

    webApps = lib.mkOption {
      description = ''
        Sites to install as apps, by the name launchers show. Each gets a
        desktop entry that runs `domicile open --app <url>`, which opens the site
        in a window with no address bar. See docs/architecture/WEB-APPS.md.
      '';
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          url = lib.mkOption {
            description = "The address the app opens.";
            type = lib.types.str;
            example = "https://music.example/";
          };
          icon = lib.mkOption {
            description = "The entry's icon: a name from the icon theme or a file. `null` leaves launchers their default.";
            type = lib.types.nullOr (lib.types.either lib.types.str lib.types.path);
            default = null;
          };
        };
      });
      default = {};
    };

    finalPackage = lib.mkOption {
      description = "The installed package: `package`, wrapped if `shell` is set.";
      type = lib.types.package;
      readOnly = true;
      visible = false;
    };
  };

  config = lib.mkIf cfg.enable {
    # Also set the config's `shell`, so a `domicile` started without the
    # wrapper (such as the NixOS login session) runs the same one. A default,
    # so an explicit `settings.shell` wins.
    programs.domicile.settings.shell =
      lib.mkIf (cfg.shell != null) (lib.mkDefault (toString cfg.shell));

    programs.domicile.shell =
      lib.mkIf (cfg.configDirectory != null) (lib.mkDefault "${built}/shell/shell.js");

    # Wrap only when there is a shell to add.
    programs.domicile.finalPackage =
      if cfg.shell == null
      then cfg.package
      else
        pkgs.symlinkJoin {
          name = "domicile-with-a-shell";
          paths = [cfg.package];
          # A script instead of `wrapProgram --add-flags`: `domicile` reads a
          # verb only as the first argument, so prepending the shell path
          # would break `domicile which-shell`. The script appends the shell,
          # and only when the command line names none.
          postBuild = ''
            rm "$out/bin/domicile"
            ln -s ${launcher} "$out/bin/domicile"
          '';
          inherit (cfg.package) meta;
        };

    home.packages = [cfg.finalPackage];

    # Takes effect only when `xdg.portal.enable` is set. Domicile is the only
    # backend; `domicile-portals.conf` sends `Secret` to the keyring, which
    # the user installs.
    xdg.portal = {
      extraPortals = [cfg.finalPackage];
      configPackages = [cfg.finalPackage];
    };

    xdg.desktopEntries =
      lib.mapAttrs (name: app: {
        inherit name;
        inherit (app) icon;
        exec = "${cfg.package}/bin/domicile open --app ${execArgument app.url}";
      })
      cfg.webApps;

    assertions = removed.assertions cfg.settings;

    # `domicile` reads this path when no `--config` is given. Nulls are
    # dropped; see `withoutNulls`.
    xdg.configFile."domicile/domicile.json".source =
      checkedConfig (withoutNulls cfg.settings);
  };
}
