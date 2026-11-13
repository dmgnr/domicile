{
  description = "Domicile — a Wayland compositor whose renderer is a web engine";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Fetches the packages of a home-manager TS config from its `bun.nix`.
    bun2nix = {
      url = "github:nix-community/bun2nix?ref=2.1.2";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, bun2nix }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; overlays = [ bunOverlay ]; };

      # The bun `package.json` asks for, ahead of nixpkgs'. The x86_64 build is
      # nixpkgs' choice of upstream zip. Drop this once nixpkgs ships it.
      # `packages/distro/tests/nix-the-flake-ships-the-bun-package-json-asks-for.sh` checks
      # the version.
      bunOverlay = final: prev: {
        bun = prev.bun.overrideAttrs (finalAttrs: old: {
          version = "1.4.4";
          # As nixpkgs' own `src`. Restated, or nixpkgs warns that only the
          # version changed.
          src = finalAttrs.passthru.sources.${final.stdenv.hostPlatform.system};
          passthru = old.passthru // {
            sources = old.passthru.sources // {
              x86_64-linux = final.fetchurl {
                url = "https://github.com/oven-sh/bun/releases/download/bun-v${finalAttrs.version}/bun-linux-x64-baseline.zip";
                hash = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
              };
            };
          };
        });
      };

      # bun named `node`, so the tools whose scripts start `#!/usr/bin/env node`
      # (vite, tsc, next) run on bun. `patchShebangs` points them here.
      bunAsNode = pkgs.runCommand "bun-as-node" { } ''
        mkdir -p "$out/bin"
        ln -s ${pkgs.bun}/bin/bun "$out/bin/node"
      '';

      # Tools to build and test the pure-logic Rust crates and the TypeScript
      # workspace. No graphics libraries, so `nix develop` stays fast.
      coreTools = with pkgs; [
        cargo
        rustc
        rustfmt
        clippy
        rust-analyzer
        pkg-config
        # bun runs packages, tests and the tools they call (`bunfig.toml`'s
        # `[run] bun`), biome lints and formats. turbo comes from the lockfile
        # via `bun install`.
        bun
        biome
        # For the engine release scripts (`packages/domicile-engine/scripts/update-engine-release.sh`,
        # `.github/scripts/engine-release-*.sh`) and `spike-iframe.sh`. In the
        # core shell because the release workflow runs there.
        curl
        jq
        zstd
        # This curl shadows the system's and reads CAs from OpenSSL's default
        # path, which is empty on Fedora- and SUSE-style hosts. cacert's setup
        # hook exports `NIX_SSL_CERT_FILE` to fix that. Setting `SSL_CERT_FILE`
        # on the shell does not work: nix drops it.
        cacert
      ];

      # Native libraries the compositor needs: Smithay's Wayland stack, plus GL
      # and DRM for dmabuf import. Only in `nix develop .#full`, so the core
      # shell stays small.
      hostLibs = with pkgs; [
        wayland
        wayland-protocols
        libxkbcommon
        libinput
        udev
        libgbm          # gbm for DRM/KMS + dmabuf
        mesa
        libGL
        seatd
        # Minimal Wayland clients for exercising the compositor in tests.
        weston
        wayland-utils
        # `wl-copy` and `wl-paste`, the data-control clients the clipboard
        # checks run.
        wl-clipboard
        # `grim`, the screenshot tool the screencopy checks run.
        grim
        # `dbus-daemon`, a private session bus for the portal checks
        # (`packages/domicile-compositor/tests/`).
        dbus
        # The terminal the demo shell's Alt+Enter binding launches.
        kitty
        # A display for the compositor's `--present` window in headless e2e
        # tests (`e2e-a-dense-display.sh`, `e2e-chrome-fills-a-window.sh`).
        xvfb
        # Resizes Domicile's window under Xvfb, which has no window manager.
        # `e2e-chrome-fills-a-window.sh` skips without it.
        xdotool
        # libpipewire for screen casting, and the daemon
        # `e2e-a-window-casts-to-pipewire.sh` starts.
        pipewire
        # libgstreamer, which `domicile-recorder` links, and the plugins its
        # tests' pipelines name.
        gst_all_1.gstreamer
        gst_all_1.gst-plugins-base
        gst_all_1.gst-plugins-good
        # libclang, which the `pipewire` crate's bindings are generated with.
        rustPlatform.bindgenHook
      ];

      # Runtime libraries for the prebuilt Chromium engine
      # (`libdomicile_engine.so`).
      #
      # The compositor `dlopen`s the engine, so these must be on the loader
      # path of the shell the compositor runs in. Kept apart from `hostLibs`
      # because they track Chromium (`packages/domicile-engine/CHROMIUM_PIN`),
      # not Domicile.
      engineRuntimeLibs = with pkgs; [
        glib
        nss
        nspr
        dbus
        # Also provides `atk` and `at-spi2-atk`, which are aliases of it.
        at-spi2-core
        cups
        expat
        alsa-lib
        pango
        cairo
        gdk-pixbuf
        gtk3
        libdrm
        # libgbm.so.1, for GPU buffer allocation.
        libgbm
        # libinput.so.10, for trackpad input (`use_libinput = true`). Linked,
        # not `dlopen`ed, so `autoPatchelfHook` fails the build without it.
        libinput
        libxshmfence
        # libudev.so.1, to enumerate input and GPU devices. `udev` is an alias
        # of this package.
        systemd
        # X client libraries. Chromium picks its ozone platform at runtime, so
        # these must resolve even when it does not run on X.
        libxcomposite
        libxdamage
        libxext
        libxfixes
        libxrender
        libxtst
        libxcb
      ];

      # ── The engine CI built, as a package ───────────────────────────────
      #
      # `autoPatchelfHook` makes the generic-linux build start on NixOS.
      # `dontStrip` because stripping a large release binary gains nothing.
      # `autoPatchelfIgnoreMissingDeps` is unset so a missing library fails
      # the build, not the desktop.
      #
      # Uses the production build of this series when one exists, else the
      # checked build. See engine-pin.nix.
      engineRelease = import ./packages/domicile-engine/engine-pin.nix {
        checked = import ./packages/domicile-engine/engine-release.nix;
        official =
          let file = ./packages/domicile-engine/engine-official.nix;
          in if builtins.pathExists file then import file else null;
      };
      domicileEngine = pkgs.stdenv.mkDerivation {
        pname = "domicile-engine";
        version = builtins.substring 0 7 engineRelease.commit;

        src = pkgs.fetchurl { inherit (engineRelease) url hash; };

        nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.zstd pkgs.makeWrapper ];
        buildInputs = engineRuntimeLibs;
        dontStrip = true;

        # The tarball holds one directory: the engine, with `chrome` directly
        # inside. `DOMICILE_ENGINE` and `libexec/domicile/engine` point at it.
        unpackPhase = ''
          runHook preUnpack
          mkdir -p unpacked
          tar --use-compress-program=unzstd -xf "$src" -C unpacked
          cd unpacked/*
          runHook postUnpack
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          cp -R . "$out/"
          runHook postInstall
        '';

        # Chromium `dlopen`s `libEGL.so.1` at run time, which
        # `autoPatchelfHook` cannot see. Without it on the path the GPU process
        # exits and the window stays white. It also `dlopen`s
        # `libpipewire-0.3.so.0` for a page's screen capture, and
        # `libpulse.so.0` for sound. Without libpulse the audio service falls
        # back to ALSA, which cannot open a cast's sound node by name, so a
        # page's `getDisplayMedia()` of a window or monitor with audio fails.
        # And it `dlopen`s `libvulkan.so.1` by name for
        # `--enable-features=Vulkan` and WebGPU. nixpkgs' loader finds NixOS
        # drivers in `/run/opengl-driver/share`; the engine's own does not.
        # Dawn also opens the `libvulkan.so.1` beside `chrome` directly, before
        # the library path, so that file is replaced with nixpkgs' loader too.
        #
        # A wrapper, not an rpath: chrome re-execs itself for its zygote and
        # renderers, and only environment variables reach those children.
        # `/run/opengl-driver/lib` comes first so NixOS uses the driver
        # matching its kernel; the nixpkgs libraries cover other hosts.
        #
        # GIO finds GSettings schemas through `XDG_DATA_DIRS`, and nixpkgs
        # installs them where host data dirs never look. Without them every
        # start logs a GLib-GIO-CRITICAL. Prefixed, so host dirs still follow.
        postFixup = ''
          ln -sf "${pkgs.vulkan-loader}/lib/libvulkan.so.1" "$out/libvulkan.so.1"
          mv "$out/chrome" "$out/.chrome-unwrapped"
          makeWrapper "$out/.chrome-unwrapped" "$out/chrome" \
            --prefix LD_LIBRARY_PATH : "/run/opengl-driver/lib:${
              pkgs.lib.makeLibraryPath [
                pkgs.libglvnd
                pkgs.mesa
                pkgs.libgbm
                pkgs.libGL
                pkgs.pipewire
                pkgs.libpulseaudio
                pkgs.vulkan-loader
              ]
            }" \
            --prefix XDG_DATA_DIRS : "${
              pkgs.lib.concatMapStringsSep ":" pkgs.glib.getSchemaDataDirPath [
                pkgs.gsettings-desktop-schemas
                pkgs.gtk3
              ]
            }"
        '';

        # Fail the build, not the desktop, if a release lacks a file consumers
        # look up by name.
        doInstallCheck = true;
        installCheckPhase = ''
          for needed in chrome libdomicile_engine.so; do
            [ -e "$out/$needed" ] || {
              echo "the published engine has no $needed" >&2
              exit 1
            }
          done
          # Run through the wrapper, as every caller does.
          "$out/chrome" --version
          # Check `chrome` is the wrapper. If the `mv` failed, the unwrapped
          # binary still passes `--version` but loses its GPU process at run
          # time.
          grep -q LD_LIBRARY_PATH "$out/chrome" || {
            echo "the engine's chrome is not wrapped, so it carries no GL path" >&2
            exit 1
          }
          # Check the wrapper carries libpulse, which the audio service needs
          # to open a cast's sound node.
          grep -q libpulseaudio "$out/chrome" || {
            echo "the engine's chrome carries no libpulse, so it plays and captures sound through ALSA" >&2
            exit 1
          }
          # Check the wrapper carries a Vulkan loader, which Chromium
          # `dlopen`s by name for `--enable-features=Vulkan` and WebGPU.
          grep -q vulkan-loader "$out/chrome" || {
            echo "the engine's chrome carries no Vulkan loader, so Vulkan and WebGPU get no adapter" >&2
            exit 1
          }
          # Check the loader beside chrome, which Dawn opens directly, is
          # nixpkgs' too.
          cmp -s "$out/libvulkan.so.1" "${pkgs.vulkan-loader}/lib/libvulkan.so.1" || {
            echo "Dawn's engine-local Vulkan loader is not nixpkgs' NixOS-aware one" >&2
            exit 1
          }
          # Check the wrapper adds compiled GSettings schemas.
          schemas=$(grep -o "[^:\"']*/share/gsettings-schemas/[^:\"']*" "$out/chrome" || true)
          [ -n "$schemas" ] || {
            echo "the engine's chrome carries no GSettings schemas" >&2
            exit 1
          }
          for dir in $schemas; do
            [ -e "$dir/glib-2.0/schemas/gschemas.compiled" ] || {
              echo "$dir has no compiled GSettings schemas" >&2
              exit 1
            }
          done
        '';

        meta = {
          description =
            "The patched Chromium domicile-compositor uses as its engine";
          # Chromium's license; see packages/domicile-engine/LICENSE.
          license = pkgs.lib.licenses.bsd3;
        };
      };

      # ── The three things a desktop is made of ───────────────────────────
      #
      # `domicile` starts a bridge, an engine and a compositor, and finds each
      # beside itself. These build them in the store so `nix run` starts a
      # desktop without building.

      # A shell's web page: only the renderer bundle. `build:vite`'s launcher,
      # main and preload bundles are for running a shell outside a browser.
      shellPage = name: pkgs.stdenv.mkDerivation {
        pname = "domicile-page-${name}";
        version = "0.0.0";
        src = self;
        nativeBuildInputs = [ pkgs.bun bunAsNode ];
        configurePhase = sharedShellConfigure;
        buildPhase = ''
          runHook preBuild
          node_modules/.bin/turbo build:vite \
            --filter "./packages/shell-${name}" --no-daemon
          runHook postBuild
        '';
        # `main_window` is the window name in the shell's `vite.config.ts`.
        installPhase = ''
          runHook preInstall
          cp -R "packages/shell-${name}/.vite/renderer/main_window" "$out"
          runHook postInstall
        '';
        # Fail the build if there is no entry module; at run time that shows
        # only as a blank screen.
        #
        # A shell is a module and Domicile writes the document.
        # `@domicile-desktop/component-library/vite-shell` fixes the entry name
        # as `shell.js`. `domicile` accepts any module name, so this check and
        # `desktop` below are the only places that rely on it.
        doInstallCheck = true;
        installCheckPhase = ''
          [ -f "$out/shell.js" ] || {
            echo "${name} built no shell.js; it has:" >&2
            ls "$out" >&2
            exit 1
          }
        '';
      };

      # One of Domicile's own apps as an app module: its directory, which
      # `domicile-<name>` runs with `domicile open --app`. See
      # docs/architecture/APP-MODULES.md.
      appModule = name: pkgs.stdenv.mkDerivation {
        pname = "domicile-app-${name}";
        version = "0.0.0";
        src = self;
        nativeBuildInputs = [ pkgs.bun bunAsNode ];
        configurePhase = sharedShellConfigure;
        buildPhase = ''
          runHook preBuild
          node_modules/.bin/turbo build:vite \
            --filter "./packages/app-${name}" --no-daemon
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          cp -R "packages/app-${name}/.vite/app" "$out"
          runHook postInstall
        '';
        # `domicile open --app` would fail on a missing module.
        doInstallCheck = true;
        installCheckPhase = ''
          [ -f "$out/${name}.js" ] || {
            echo "${name} built no ${name}.js; it has:" >&2
            ls "$out" >&2
            exit 1
          }
        '';
      };

      # A launcher entry, `domicile-<id>.desktop`, for something Domicile
      # does: `packages/distro/share/launcher/domicile-<id>.desktop` filled in, as
      # `packages/distro/stage.sh` does. The icon is `<icon>` and the launcher's
      # preview `<preview>`, both SVGs.
      launcherFile = { id, icon, preview }: ''
        substitute ${./packages/distro/share/launcher + "/domicile-${id}.desktop"} \
          "$out/share/applications/domicile-${id}.desktop" \
          --subst-var-by bin "$out/bin" \
          --subst-var-by icon ${icon} \
          --subst-var-by preview ${preview}
      '';

      # The built workspace a shell is built against: the builder's
      # `--domicile`, from which it resolves manganese and React. Laid out like
      # this repository, because that is the layout the builder reads. Holds
      # only what the builder and manganese ship, as `packages/distro/stage.sh` does.
      shellWorkspace = pkgs.stdenv.mkDerivation {
        pname = "domicile-shell-workspace";
        version = "0.0.0";
        src = self;
        nativeBuildInputs = [ pkgs.bun bunAsNode pkgs.jq ];
        configurePhase = sharedShellConfigure;
        buildPhase = ''
          runHook preBuild
          node_modules/.bin/turbo run prepare build \
            --filter "@domicile-desktop/manganese..." --no-daemon
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          cp -a ${shellModules} "$out"
          chmod -R u+w "$out"
          bash ${./packages/distro/shell-workspace.sh} files ${pkgs.bun}/bin/bun "$PWD" "$out"
          bash packages/distro/stamp-version.sh ${self.rev or self.dirtyRev} \
            "$out"/packages/*/package.json
          runHook postInstall
        '';
      };

      # The program `domicile` builds a shell with, from an entry or a
      # package. A script, because the builder is TypeScript run by bun.
      domicileBuilder = pkgs.writeShellScript "domicile-builder" ''
        exec ${pkgs.bun}/bin/bun ${shellWorkspace}/packages/domicile-builder/src/main.ts \
          --domicile ${shellWorkspace} "$@"
      '';

      # Domicile, laid out so that `domicile` can find the rest of itself.
      #
      #   bin/domicile
      #   bin/domicile-compositor
      #   bin/domicile-open-url       what `BROWSER` names inside a desktop
      #   bin/domicile-xdg-open       what `xdg-open` is inside a desktop
      #   bin/domicile-history        opens the History app
      #   bin/domicile-settings       opens the Settings app
      #   bin/domicile-app-host       what Domicile's apps spawn for the
      #                               desktop's state
      #   bin/domicile-recorder       what the compositor records the
      #                               screen with
      #   libexec/domicile/engine     the Chromium tree, `chrome` inside it
      #   libexec/domicile/builder    builds a shell from an entry or a package
      #   libexec/domicile/shells/    Domicile's prebuilt shells, which
      #                               `@domicile-desktop/manganese` names,
      #                               and the splash
      #   libexec/domicile/app-modules/
      #                               Domicile's own app modules, which
      #                               `domicile-<name>` runs
      #   share/applications/         launcher entries for History,
      #                               Settings, Screenshot, Screen Record,
      #                               Shutdown, Reboot and Logout
      #
      # The binaries are copied, not symlinked. `domicile` finds its siblings
      # from `current_exe`, which resolves symlinks, so a symlink would point
      # into the Rust derivation where there is no `libexec`. The engine can
      # stay a symlink because nothing resolves its path.
      domicilePackage = pkgs.runCommand "domicile"
        {
          # The login session, `packages/distro/share/domicile-session.desktop`. NixOS's
          # `sessionPackages` requires `providedSessions`.
          passthru.providedSessions = [ "domicile" ];
          meta = {
            description = "Run a Domicile desktop from a shell you built yourself";
            license = pkgs.lib.licenses.mit;
            mainProgram = "domicile";
            platforms = [ system ];
          };
        } ''
        mkdir -p "$out/bin" "$out/libexec/domicile"
        cp ${domicileBinaries}/bin/domicile "$out/bin/domicile"
        cp ${domicileBinaries}/bin/domicile-compositor "$out/bin/domicile-compositor"
        # `BROWSER` inside a desktop. Copied for the same reason as above.
        cp ${domicileBinaries}/bin/domicile-open-url "$out/bin/domicile-open-url"
        # `xdg-open` inside a desktop, first on every app's PATH.
        cp ${domicileBinaries}/bin/domicile-xdg-open "$out/bin/domicile-xdg-open"
        # Opens the History app. Copied for the same reason as above.
        cp ${domicileBinaries}/bin/domicile-history "$out/bin/domicile-history"
        # Opens the Settings app. Copied for the same reason.
        cp ${domicileBinaries}/bin/domicile-settings "$out/bin/domicile-settings"
        # The host Domicile's apps spawn, which asks the desktop over
        # `DOMICILE_SOCK`. Copied for the same reason.
        cp ${domicileBinaries}/bin/domicile-app-host "$out/bin/domicile-app-host"
        # The Miracast service, which D-Bus starts. Copied for the same
        # reason.
        cp ${domicileBinaries}/bin/domicile-miracast "$out/bin/domicile-miracast"
        mkdir -p "$out/share/dbus-1/services"
        substitute ${./packages/distro/share/net.domicile.Miracast.service} \
          "$out/share/dbus-1/services/net.domicile.Miracast.service" \
          --subst-var-by bin "$out/bin"
        # Records the screen for the compositor, which finds it beside
        # itself. Copied for the same reason.
        cp ${domicileBinaries}/bin/domicile-recorder "$out/bin/domicile-recorder"
        # The web link handler and the file making it the default.
        mkdir -p "$out/share/applications"
        substitute ${./packages/distro/share/domicile-open-url.desktop} \
          "$out/share/applications/domicile-open-url.desktop" \
          --subst-var-by bin "$out/bin"
        cp ${./packages/distro/share/domicile-mimeapps.list} \
          "$out/share/applications/domicile-mimeapps.list"
        ln -s ${domicileEngine} "$out/libexec/domicile/engine"
        cp ${domicileBuilder} "$out/libexec/domicile/builder"
        mkdir -p "$out/libexec/domicile/shells"
        ln -s ${shellPage "manganese"} "$out/libexec/domicile/shells/manganese"
        ln -s ${shellPage "simple"} "$out/libexec/domicile/shells/simple"
        # What a desktop shows while it builds its shell on first start.
        ln -s ${shellPage "splash"} "$out/libexec/domicile/shells/splash"
        mkdir -p "$out/libexec/domicile/app-modules"
        ln -s ${appModule "settings"} "$out/libexec/domicile/app-modules/settings"
        ln -s ${appModule "history"} "$out/libexec/domicile/app-modules/history"
        # What the launcher offers of Domicile's own.
        ${launcherFile {
          id = "history";
          icon = ./packages/app-history/icons/history.svg;
          preview = ./packages/app-history/icons/history-preview.svg;
        }}
        ${launcherFile {
          id = "settings";
          icon = ./packages/app-settings/icons/settings.svg;
          preview = ./packages/app-settings/icons/settings-preview.svg;
        }}
        ${launcherFile {
          id = "screenshot";
          icon = ./packages/distro/share/launcher/screenshot.svg;
          preview = ./packages/distro/share/launcher/screenshot-preview.svg;
        }}
        ${launcherFile {
          id = "screen-record";
          icon = ./packages/distro/share/launcher/screen-record.svg;
          preview = ./packages/distro/share/launcher/screen-record-preview.svg;
        }}
        ${launcherFile {
          id = "shutdown";
          icon = ./packages/distro/share/launcher/shutdown.svg;
          preview = ./packages/distro/share/launcher/shutdown-preview.svg;
        }}
        ${launcherFile {
          id = "reboot";
          icon = ./packages/distro/share/launcher/reboot.svg;
          preview = ./packages/distro/share/launcher/reboot-preview.svg;
        }}
        ${launcherFile {
          id = "logout";
          icon = ./packages/distro/share/launcher/logout.svg;
          preview = ./packages/distro/share/launcher/logout-preview.svg;
        }}
        # Tells `xdg-desktop-portal` which interfaces Domicile implements. The
        # compositor owns the D-Bus name and sets the matching
        # `XDG_CURRENT_DESKTOP` on clients.
        mkdir -p "$out/share/xdg-desktop-portal/portals"
        cp ${./packages/distro/share/domicile.portal} \
          "$out/share/xdg-desktop-portal/portals/domicile.portal"
        # Routes portal calls (xdg-desktop-portal >= 1.17): Domicile for
        # everything but `Secret`, which goes to the keyring.
        cp ${./packages/distro/share/domicile-portals.conf} \
          "$out/share/xdg-desktop-portal/domicile-portals.conf"
        # The user target the login session starts. It binds
        # `graphical-session.target`, which the portal requires.
        mkdir -p "$out/lib/systemd/user"
        cp ${./packages/distro/share/domicile-session.target} \
          "$out/lib/systemd/user/domicile-session.target"
        cp ${./packages/distro/share/domicile-session-shutdown.target} \
          "$out/lib/systemd/user/domicile-session-shutdown.target"
        mkdir -p "$out/share/wayland-sessions"
        substitute ${./packages/distro/share/domicile-session.desktop} \
          "$out/share/wayland-sessions/domicile.desktop" \
          --subst-var-by bin "$out/bin"
      '';

      # A desktop: `domicile` wrapped with a prebuilt shell module. The wrapper
      # `exec`s, so `current_exe` is still the copied binary above.
      #
      # `domicile` takes the module file, not its directory. `shellPage`'s
      # install check guarantees `shell.js` exists.
      #
      # Adds kitty to `PATH` because `simple` binds Alt+Return to
      # `domicile.spawn(["kitty"])`. `--suffix`, so a user's own kitty wins.
      # `manganese` binds no terminal.
      desktop = { name, description }:
        pkgs.runCommand name
          {
            nativeBuildInputs = [ pkgs.makeWrapper ];
            meta = {
              inherit description;
              license = pkgs.lib.licenses.mit;
              mainProgram = name;
              platforms = [ system ];
            };
          } ''
          # `--add-flags` puts the page first. That is fine here because this
          # binary has no subcommands; the home-manager module's `domicile`
          # does, so it appends the shell instead.
          makeWrapper ${domicilePackage}/bin/domicile "$out/bin/${name}" \
            --add-flags ${shellPage name}/shell.js \
            --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.kitty ]}
        '';

      # ── What a user installs ────────────────────────────────────────────
      #
      # - `.#manganese`, `.#simple`: Domicile with one of this repository's
      #   shells.
      # - `.#domicile`: Domicile alone; takes the path to a built shell.
      #
      # There is no default package because the flake cannot pick a desktop
      # for you. The default `nix run` app is `domicile`, which takes a shell.

      # Every package with a `Cargo.toml`.
      rustCrates = builtins.attrNames (pkgs.lib.filterAttrs
        (name: _: builtins.pathExists (./packages + "/${name}/Cargo.toml"))
        (builtins.readDir ./packages));

      # The Rust binaries. Not an output: `domicile-compositor` is only started
      # by `domicile`, and `domicile` must be installed in `domicilePackage`'s
      # layout to find its siblings.
      domicileBinaries = pkgs.rustPlatform.buildRustPackage {
        pname = "domicile-binaries";
        version = "0.0.0";
        # Include everything cargo can reach, not only `.rs` files:
        # `include_str!` reads shaders. A narrower filter breaks with only "file
        # missing".
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions
            ([ ./Cargo.toml ./Cargo.lock ]
              ++ map (name: ./packages + "/${name}") rustCrates);
        };
        cargoLock = {
          lockFile = ./Cargo.lock;
          # The Smithay fork `[patch.crates-io]` in `Cargo.toml` names. Update
          # with its `rev`, and drop with it.
          outputHashes."smithay-0.7.0" = "sha256-hWXiFYCSzXoUxQtF9mA1T+GH9pjAWlTcS1t2uG1gJy8=";
        };

        nativeBuildInputs = [
          pkgs.pkg-config
          pkgs.makeWrapper
          # libclang, for the `pipewire` crate's bindings.
          pkgs.rustPlatform.bindgenHook
        ];
        # libxkbcommon and libpipewire are linked. Smithay's winit and EGL code
        # probes for the rest at build time; `postFixup` makes them loadable at
        # run time.
        # GStreamer is linked by `domicile-recorder`.
        buildInputs = with pkgs; [ libxkbcommon wayland libGL libgbm pipewire gst_all_1.gstreamer ];

        # `domicile-compositor` and `domicile-recorder` must be named because
        # `default-members` omits them. Binaries are named too, so the
        # test-only `domicile-test-client` binary is not installed.
        cargoBuildFlags = [
          "-p" "domicile-compositor" "--bin" "domicile-compositor"
          "-p" "domicile-recorder" "--bin" "domicile-recorder"
          "-p" "domicile-launch" "--bin" "domicile" "--bin" "domicile-open-url" "--bin" "domicile-xdg-open" "--bin" "domicile-history" "--bin" "domicile-settings" "--bin" "domicile-app-host"
          "-p" "domicile-miracast" "--bin" "domicile-miracast"
        ];

        # CI's `cargo-test` job runs the tests on every push; repeating them
        # per install only costs time.
        doCheck = false;

        # Add `dlopen`ed libraries to the rpath: libEGL for dmabuf import, the
        # Wayland and X11 client libraries winit probes, and libpam for the
        # lock screen. `/run/opengl-driver/lib` comes first so NixOS uses the
        # EGL matching its kernel driver.
        #
        # - `DOMICILE_PNP_IDS`: hwdata's EDID vendor table. Read at run time,
        #   not vendored, because it is GPL-2+.
        # - `PATH`, after the user's own: PulseAudio's `pactl` and `parec`,
        #   which the shell's mixer spawns (PipeWire systems may have none),
        #   and `curl`, which shells spawn to fetch bookmark icons
        #   (`@domicile-desktop/system-apps/curl`) and check for a captive
        #   portal (`@domicile-desktop/system-network/portal`), and `ip`, for
        #   the network panel's addresses
        #   (`@domicile-desktop/system-network/interfaces`).
        #
        # `--set-default` and `--suffix` so a user's own value wins.
        postFixup = ''
          patchelf --add-rpath "${pkgs.lib.makeLibraryPath (with pkgs; [
            libGL mesa libgbm wayland libxkbcommon
            libx11 libxcursor libxrandr libxi
            pam
          ])}" "$out/bin/domicile-compositor"
          wrapProgram "$out/bin/domicile-compositor" \
            --prefix LD_LIBRARY_PATH : "/run/opengl-driver/lib" \
            --set-default DOMICILE_PNP_IDS "${pkgs.hwdata}/share/hwdata/pnp.ids" \
            --suffix PATH : "${pkgs.lib.makeBinPath [ pkgs.pulseaudio pkgs.curl pkgs.iproute2 ]}"
          # `gst-launch-1.0` and the plugins a Miracast cast's pipeline uses
          # (`packages/domicile-miracast/src/stream.rs`).
          wrapProgram "$out/bin/domicile-miracast" \
            --suffix PATH : "${pkgs.lib.makeBinPath [ pkgs.gst_all_1.gstreamer ]}" \
            --set-default GST_PLUGIN_SYSTEM_PATH_1_0 "${pkgs.lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" (with pkgs.gst_all_1; [
              gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav pkgs.pipewire
            ])}"
          # The plugins the recorder's pipeline names: `pipewiresrc`, VA-API
          # and VP8, Opus and WebM.
          wrapProgram "$out/bin/domicile-recorder" \
            --prefix GST_PLUGIN_SYSTEM_PATH_1_0 : "${pkgs.lib.makeSearchPath "lib/gstreamer-1.0" (with pkgs; [
              gst_all_1.gstreamer.out gst_all_1.gst-plugins-base gst_all_1.gst-plugins-good gst_all_1.gst-plugins-bad pipewire
            ])}"
        '';
      };

      # `domicile-test-client`, for the VM tests that need a window which
      # prints every event it gets. Not installed by any package.
      testClient = domicileBinaries.overrideAttrs {
        pname = "domicile-test-client";
        cargoBuildFlags = [ "-p" "domicile-compositor" "--bin" "domicile-test-client" ];
        postFixup = "";
      };

      # The workspace's manifests and lockfile: all `bun install` reads, so
      # editing source does not refetch the modules.
      workspaceManifests = pkgs.lib.fileset.toSource {
        root = ./.;
        fileset = pkgs.lib.fileset.unions ([ ./package.json ./bun.lock ./bunfig.toml ]
          ++ pkgs.lib.mapAttrsToList (name: _: ./packages + "/${name}/package.json")
            (pkgs.lib.filterAttrs
              (name: _: builtins.pathExists (./packages + "/${name}/package.json"))
              (builtins.readDir ./packages)));
      };

      # Everything `bun install` fetches, as one fixed-output derivation.
      # Install scripts are skipped so the result is reproducible.
      #
      # Update `outputHash` by hand whenever `bun.lock` changes. A stale hash
      # fails only on a store that has not built this path before; elsewhere
      # nix silently reuses the old modules. CI
      # (`.github/workflows/nix-build.yml`) builds on a cold store and
      # catches it.
      nodeModules = pkgs.stdenv.mkDerivation {
        pname = "domicile-node-modules";
        version = "0.0.0";
        src = workspaceManifests;
        nativeBuildInputs = [ pkgs.bun ];
        dontConfigure = true;
        buildPhase = ''
          runHook preBuild
          export HOME="$TMPDIR"
          bun install --frozen-lockfile --ignore-scripts --no-progress
          runHook postBuild
        '';
        # Copy every `node_modules`, root and per package, at its original
        # depth. Some tools (`panda`, `tsc`) live only in per-package trees,
        # and the relative symlinks inside resolve only at the same depth.
        installPhase = ''
          runHook preInstall
          rm -rf node_modules/.cache
          # Keep the output hash stable. `bun install` sometimes links an
          # extra `.bin` entry inside its internal store (about one run in
          # six). Nothing uses those directories, so drop them.
          find node_modules/.bun -mindepth 3 -maxdepth 3 \
            -type d -path '*/node_modules/.bin' -exec rm -rf {} +
          mkdir -p "$out"
          cp -a node_modules "$out/node_modules"
          for tree in packages/*/node_modules; do
            mkdir -p "$out/$(dirname "$tree")"
            cp -a "$tree" "$out/$tree"
          done
          runHook postInstall
        '';
        dontFixup = true;
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-IWE6+5N23DAKEnREvJ0ZA/GKnXHAu1VjxtjQhFcLSgU=";
      };

      # The production modules `shellWorkspace` ships, from
      # `packages/distro/shell-workspace.sh modules`. A fixed-output derivation like
      # `nodeModules`, and its `outputHash` goes stale with the same changes.
      shellModules = pkgs.stdenv.mkDerivation {
        pname = "domicile-shell-modules";
        version = "0.0.0";
        src = workspaceManifests;
        nativeBuildInputs = [ pkgs.bun ];
        dontConfigure = true;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          export HOME="$TMPDIR"
          bash ${./packages/distro/shell-workspace.sh} modules ${pkgs.bun}/bin/bun "$PWD" "$out"
          rm -rf "$out/node_modules/.cache"
          # As in `nodeModules`.
          find "$out/node_modules/.bun" -mindepth 3 -maxdepth 3 \
            -type d -path '*/node_modules/.bin' -exec rm -rf {} +
          runHook postInstall
        '';
        dontFixup = true;
        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        outputHash = "sha256-k3jDSQA29wu6LhLhTWwP5amUK68GHNGPKxF1LEGN3vo=";
      };


      # Prepares a workspace build to run turbo: writable modules, patched
      # shebangs and turbo's writable directories. Shared by every derivation
      # that builds the workspace.
      sharedShellConfigure = ''
            runHook preConfigure
            cp -a "${nodeModules}/node_modules" node_modules
            for tree in "${nodeModules}"/packages/*/node_modules; do
              cp -a "$tree" "packages/$(basename "$(dirname "$tree")")/node_modules"
            done
            chmod -R u+w node_modules packages/*/node_modules
            # The sandbox has no `/usr/bin/env`, so `#!/usr/bin/env node`
            # shims fail with `bad interpreter`. Point them at `bunAsNode`.
            patchShebangs node_modules packages/*/node_modules
            export HOME="$TMPDIR"
            # Stops `//#build:install-modules` from running `bun install`;
            # there is no network, and the modules are already in place.
            export CI=1
            # turbo writes a cache and telemetry state; only $TMPDIR is
            # writable.
            export TURBO_CACHE_DIR="$TMPDIR/turbo"
            export TURBO_TELEMETRY_DISABLED=1
            runHook postConfigure
          '';

      # The desktops this repository ships, shared by `packages` and `apps`.
      desktops = {
        manganese = desktop {
          name = "manganese";
          description = "The Domicile desktop: tabbed windows, a launcher, and a settings surface";
        };
        simple = desktop {
          name = "simple";
          description = "The smallest Domicile desktop: floating windows on the Alt key, Alt+Enter for a terminal";
        };
      };

      # examples/dioxus-shell built: `shell.js` and the wasm it loads. Run it
      # with `domicile <out>/shell.js`. It is its own cargo workspace, so
      # Dioxus stays out of Domicile's Cargo.lock. wasm-bindgen-cli must match
      # the `wasm-bindgen` version its Cargo.toml pins.
      dioxusShellExample = pkgs.rustPlatform.buildRustPackage {
        pname = "dioxus-shell-example";
        version = "0.1.0";
        src = ./examples/dioxus-shell;
        cargoLock.lockFile = ./examples/dioxus-shell/Cargo.lock;
        nativeBuildInputs = [ pkgs.lld pkgs.wasm-bindgen-cli_0_2_127 ];
        buildPhase = ''
          runHook preBuild
          cargo build --release --offline --target wasm32-unknown-unknown
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          wasm-bindgen --target web --no-typescript --out-dir $out/pkg \
            target/wasm32-unknown-unknown/release/dioxus_shell.wasm
          cp shell.js $out/
          runHook postInstall
        '';
        doCheck = false;
        meta.description = "The quickstart shell in Rust with Dioxus, compiled to WebAssembly";
      };

      # Domicile running examples/dioxus-shell, for `nix run`. Inside a
      # desktop it opens nested.
      dioxusShellDesktop = pkgs.runCommand "dioxus-shell-example"
        {
          nativeBuildInputs = [ pkgs.makeWrapper ];
          meta = {
            inherit (dioxusShellExample.meta) description;
            license = pkgs.lib.licenses.mit;
            mainProgram = "dioxus-shell-example";
            platforms = [ system ];
          };
        } ''
        makeWrapper ${domicilePackage}/bin/domicile "$out/bin/dioxus-shell-example" \
          --add-flags ${dioxusShellExample}/shell.js \
          --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.kitty ]}
      '';

      # The desktops as `nix run` apps.
      domicileApps = pkgs.lib.mapAttrs
        (name: package: {
          type = "app";
          program = pkgs.lib.getExe package;
          meta.description = package.meta.description;
        })
        desktops;
    in
    {
      # Home-manager module for configuring Domicile alongside the rest of a
      # user's environment.
      #
      # Not per-system: the module reads `pkgs` from the importing
      # configuration. It gets this flake's `packages` as the default package,
      # which users can override.
      #
      # The login session and the lock screen's PAM service are machine
      # settings, so they live in `nixosModules`.
      homeManagerModules = rec {
        domicile = import ./packages/distro/nix/home-manager.nix {
          domicilePackages = self.packages.${system};
          bun2nix = bun2nix.packages.${system}.default;
        };
        # `default` for `imports = [domicile.homeManagerModules.default]`;
        # `domicile` for configurations that import several flakes' modules.
        default = domicile;
      };

      # NixOS module for the machine-level settings.
      nixosModules = rec {
        domicile = import ./packages/distro/nix/nixos.nix {
          domicilePackages = self.packages.${system};
        };
        default = domicile;
      };

      # No `default`: the flake cannot choose a desktop for you.
      packages.${system} = desktops // {
        # Domicile alone, for users with their own shell.
        domicile = domicilePackage;
        # The engine alone, for setting `DOMICILE_ENGINE` yourself.
        engine = domicileEngine;
        # The shell builder on its own, for `DOMICILE_BUILDER`.
        builder = domicileBuilder;
        # Domicile running examples/dioxus-shell, a shell written in Rust.
        dioxus-shell-example = dioxusShellDesktop;
      };

      # The nixpkgs this flake builds with, so scripts take tools such as
      # `.#bun` from the same set.
      legacyPackages.${system} = pkgs;

      # `nix run` offers running a desktop and claiming a new npm package.
      # Checks, e2e scripts and measurements need a checkout; run them with
      # `bun run check` or their package's turbo task.

      # `nix flake check` evaluates the two modules, which nothing else does.
      #
      # `packages/distro/tests/test-the-home-manager-module-agrees.sh` checks option names
      # against the Rust schema without nix. These checks cover types,
      # defaults and the generated config JSON.
      #
      # The home-manager check stubs the few options the module sets outside
      # its namespace, instead of adding home-manager as an input and its
      # closure to every check. `xdg.mimeApps` is left out so that setting it
      # is an evaluation error.
      checks.${system} =
        let
          # The home-manager options the modules here set, for checks that
          # evaluate a home module without home-manager.
          homeManagerStub = { lib, ... }: {
            options = {
              home.packages = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              xdg.configFile = lib.mkOption {
                type = lib.types.attrsOf (lib.types.submodule {
                  options.source = pkgs.lib.mkOption { type = pkgs.lib.types.path; };
                });
                default = { };
              };
              # Where a removed option names its replacement.
              assertions = lib.mkOption {
                type = lib.types.listOf lib.types.unspecified;
                default = [ ];
              };
              warnings = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
              };
              xdg.portal.extraPortals = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              xdg.portal.configPackages = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              xdg.desktopEntries = lib.mkOption {
                type = lib.types.attrsOf lib.types.attrs;
                default = { };
              };
            };
          };
        in
        {
        # The Rust example shell still builds.
        dioxus-shell-example = dioxusShellExample;

        home-manager-module =
          let
            stub = homeManagerStub;
            # A config using each part of the schema: a rotated monitor at a
            # fractional scale, a disabled one, a described display and a
            # keyboard.
            desk = { ... }: {
              programs.domicile = {
                enable = true;
                shell = "${desktops.simple}/shell.js";
                settings = {
                  input.keyboard = {
                    xkb_layout = "us";
                    xkb_variant = "dvp";
                    xkb_options = [ "caps:escape" ];
                  };
                  input.touchpad = {
                    natural_scroll = true;
                    click_method = "clickfinger";
                    scroll_method = "two_finger";
                    scroll_acceleration = false;
                    disable_while_typing = "libinput";
                  };
                  input.mouse = {
                    accel_profile = "flat";
                    speed = -0.25;
                    scroll_factor = 1.5;
                  };
                  output = {
                    max_scale = 2;
                    displays = [{
                      name = "nested";
                      position = [ 0 0 ];
                      size = [ 1920 1080 ];
                      scale = 1;
                    }];
                    profiles = [{
                      name = "desk";
                      displays = [
                        { display = "drm-1"; enabled = false; }
                        {
                          display = "DEL DELL U3219Q 2ZLS413";
                          mode = [ 3840 2160 ];
                          position = [ 0 0 ];
                          scale = 1.2;
                          transform = "rotate-270";
                        }
                      ];
                    }];
                  };
                };
              };
            };
            evaluated = pkgs.lib.evalModules {
              modules = [ stub self.homeManagerModules.domicile desk ];
              specialArgs = { inherit pkgs; };
            };
            written = evaluated.config.xdg.configFile."domicile/domicile.json".source;

            # The module with settings of its own on top of `desk`.
            deskWith = settings: pkgs.lib.evalModules {
              modules = [ stub self.homeManagerModules.domicile desk { programs.domicile.settings = settings; } ];
              specialArgs = { inherit pkgs; };
            };

            # A removed setting fails an assertion that says where it went.
            removedSettingSaysWhere = pkgs.lib.any
              (each: !each.assertion && pkgs.lib.hasInfix "manganese" each.message)
              (deskWith { applications.omit = [ "*" ]; }).config.assertions;

            # A config the compositor refuses fails to build, so it never
            # reaches a desk. Its log is the compositor's reason.
            refused = pkgs.testers.testBuildFailure
              (deskWith { no_such_section = { }; }).config.xdg.configFile."domicile/domicile.json".source;

            # A web app whose address holds characters an `Exec` line must
            # quote or escape.
            withApp = pkgs.lib.evalModules {
              modules = [
                stub
                self.homeManagerModules.domicile
                desk
                {
                  programs.domicile.webApps.Music = {
                    url = "https://music.example/play?list=a%20b&shuffle$1#top";
                    icon = "music";
                  };
                }
              ];
              specialArgs = { inherit pkgs; };
            };
            # The module with `packages/distro/nix/test-ts-config`, a TS config that
            # imports a package from npm, as its config directory.
            fromDirectory = directory: pkgs.lib.evalModules {
              modules = [
                stub
                self.homeManagerModules.domicile
                {
                  programs.domicile = {
                    enable = true;
                    configDirectory = directory;
                    settings.idle.lock_after_seconds = 900;
                  };
                }
              ];
              specialArgs = { inherit pkgs; };
            };
            fromTs = (fromDirectory ./packages/distro/nix/test-ts-config).config;
            # A directory with no `domicile.{ts,tsx,js,mjs}` fails evaluation.
            withoutModule = builtins.tryEval
              (fromDirectory ./packages/distro/share/launcher).config.programs.domicile.shell;

            appEntry = withApp.config.xdg.desktopEntries.Music;
            # Built as home-manager builds it, so `desktop-file-validate` runs.
            appFile = pkgs.makeDesktopItem {
              name = "Music";
              desktopName = appEntry.name;
              inherit (appEntry) exec icon;
            };

            # The same module with a `domicile` that prints its arguments, to
            # test the wrapper's command lines. The real binary needs a
            # compositor, which the sandbox lacks.
            sawArgs = pkgs.lib.evalModules {
              modules = [
                stub
                self.homeManagerModules.domicile
                desk
                { programs.domicile.package = pkgs.writeShellScriptBin "domicile" ''printf '%s\n' "$@"''; }
              ];
              specialArgs = { inherit pkgs; };
            };
          in
          pkgs.runCommand "home-manager-module-evaluates" { nativeBuildInputs = [ pkgs.jq ]; } ''
            # Assert values at their keys with `jq`, independent of how
            # `pkgs.formats.json` formats the file.
            cp ${written} config.json
            expect() {
              jq -e "$1" config.json >/dev/null || {
                echo "the module did not write: $1" >&2
                echo "--- what it wrote ---" >&2
                cat config.json >&2
                exit 1
              }
            }
            expect '.input.keyboard.xkb_variant == "dvp"'
            expect '.input.keyboard.xkb_options == ["caps:escape"]'
            expect '.input.touchpad | .natural_scroll == true and .click_method == "clickfinger"'
            expect '.input.touchpad | .scroll_method == "two_finger" and .scroll_acceleration == false'
            expect '.input.touchpad | .disable_while_typing == "libinput" and .typing_pause_ms == 200 and .typing_repeat_pause_ms == 500'
            expect '.input.touchpad | .tap == true and .tap_drag == true and .drag_lock == false'
            expect '.input.touchpad | .tap_button_map == "lrm" and .typing_repeat_pause_ms == 500'
            expect '.input.mouse | .accel_profile == "flat" and .speed == -0.25 and .scroll_factor == 1.5'
            expect '.input.mouse | .natural_scroll == false and .middle_emulation == false'
            expect '.output.max_scale == 2'
            expect '.output.profiles[0].name == "desk"'
            expect '.output.profiles[0].displays[0] | .display == "drm-1" and .enabled == false'
            expect '.output.profiles[0].displays[1] | .scale == 1.2 and .transform == "rotate-270"'
            # The shell is also written to the config, so the login session,
            # which runs `domicile` without the wrapper, uses it too.
            expect '.shell == "${desktops.simple}/shell.js"'

            # No nulls: `domicile` rejects a null for most keys, and one bad
            # key rejects the whole file. The desk sets `mode` on only one
            # display, so this checks that `withoutNulls` recurses into lists.
            expect '[.. | select(. == null)] | length == 0'

            # A mode that is set reaches the file.
            expect '.output.profiles[0].displays[1].mode == [3840, 2160]'

            grep -qF 'unknown field `no_such_section`' ${refused}/testBuildFailure.log || {
              echo "a config domicile refuses did not fail to build over it:" >&2
              cat ${refused}/testBuildFailure.log >&2
              exit 1
            }

            [ ${pkgs.lib.boolToString removedSettingSaysWhere} = true ] || {
              echo "setting programs.domicile.settings.applications fails no assertion naming manganese" >&2
              exit 1
            }

            # Check the arguments the wrapped `domicile` receives. The shell
            # must go last, because a subcommand is recognized only as the
            # first argument.
            domicile=${sawArgs.config.programs.domicile.finalPackage}/bin/domicile

            saw() { # what was typed -> what reached the binary
              want="$1"; shift
              got="$("$domicile" "$@" | tr '\n' ' ')"
              [ "$got" = "$want " ] || {
                echo "domicile $* reached the binary as: $got" >&2
                echo "and it should have been: $want" >&2
                exit 1
              }
            }

            # No arguments: the configured shell.
            saw "${desktops.simple}/shell.js"
            # A subcommand passes through unchanged.
            saw "which-shell" which-shell
            # `load-shell`'s argument is not a shell to run, so nothing is
            # appended.
            saw "load-shell ./other.js" load-shell ./other.js
            # An explicit shell overrides the configured one.
            saw "./other.js" ./other.js
            # `--config`'s path is not a shell, so the configured shell is
            # still appended.
            saw "--config /tmp/x ${desktops.simple}/shell.js" --config /tmp/x

            # `open` takes an address, so nothing is appended.
            saw "open https://example.com" open https://example.com
            # Nor to `screenshot`'s file or `check-config`'s config.
            saw "screenshot shot.png" screenshot shot.png
            saw "check-config domicile.json" check-config domicile.json

            # The default-browser file ships in Domicile's `share`, which
            # `domicile` puts first in `XDG_DATA_DIRS`. The module must not
            # write one into the home.
            [ ${pkgs.lib.boolToString (evaluated.config.xdg.configFile ? "domicile-mimeapps.list")} = false ] || {
              echo "the module still writes domicile-mimeapps.list into the home" >&2
              exit 1
            }
            mimeapps=${domicilePackage}/share/applications/domicile-mimeapps.list
            for line in \
              '[Default Applications]' \
              'text/html=domicile-open-url.desktop' \
              'x-scheme-handler/http=domicile-open-url.desktop' \
              'x-scheme-handler/https=domicile-open-url.desktop'
            do
              grep -qxF "$line" "$mimeapps" || {
                echo "domicile's own domicile-mimeapps.list is missing: $line" >&2
                cat "$mimeapps" >&2
                exit 1
              }
            done

            # The module adds Domicile's portal backend and its
            # `domicile-portals.conf` to `xdg.portal` without enabling
            # portals, and offers no gtk backend.
            [ ${pkgs.lib.boolToString (pkgs.lib.elem pkgs.xdg-desktop-portal-gtk evaluated.config.xdg.portal.extraPortals)} = false ] || {
              echo "xdg.portal.extraPortals still offers xdg-desktop-portal-gtk" >&2
              exit 1
            }
            ${pkgs.lib.concatMapStrings ({ option, package }: ''
              [ ${pkgs.lib.boolToString (pkgs.lib.elem package evaluated.config.xdg.portal.${option})} = true ] || {
                echo "xdg.portal.${option} does not hold ${package.name}" >&2
                exit 1
              }
            '') [
              { option = "extraPortals"; package = evaluated.config.programs.domicile.finalPackage; }
              { option = "configPackages"; package = evaluated.config.programs.domicile.finalPackage; }
            ]}

            # A web app's entry opens its address in an app window. The
            # address is quoted, `$` escaped and `%` doubled, as the desktop
            # entry spec asks.
            [ ${pkgs.lib.escapeShellArg appEntry.exec} = ${pkgs.lib.escapeShellArg ''${domicilePackage}/bin/domicile open --app "https://music.example/play?list=a%%20b&shuffle\\$1#top"''} ] || {
              echo "the Music web app's Exec is: "${pkgs.lib.escapeShellArg appEntry.exec} >&2
              exit 1
            }
            [ ${pkgs.lib.escapeShellArg "${appEntry.name} ${appEntry.icon}"} = "Music music" ] || {
              echo "the Music web app's entry has the wrong Name or Icon" >&2
              exit 1
            }
            test -e ${appFile}/share/applications/Music.desktop

            # A TS config's exports are written over `settings`, so the
            # module's defaults do not replace them. Its `Shell` is built
            # and becomes the shell.
            cp -f ${fromTs.xdg.configFile."domicile/domicile.json".source} config.json
            expect '.idle.blank_after_seconds == 600'
            expect '.idle.lock_after_seconds == 900'
            expect '.input.keyboard.xkb_layout == "de"'
            expect '.shell == "${fromTs.programs.domicile.shell}"'
            grep -qF 'a desktop from a TS config' ${fromTs.programs.domicile.shell} || {
              echo "the TS config's Shell did not build into ${fromTs.programs.domicile.shell}" >&2
              exit 1
            }
            [ ${pkgs.lib.boolToString withoutModule.success} = false ] || {
              echo "a config directory without a config module evaluated" >&2
              exit 1
            }

            touch "$out"
          '';

        # `packages/distro/nix/removed-settings.nix` on its own, with paths the real
        # module does not list: one at the top, one in a section, one in a
        # list's elements.
        removed-settings =
          let
            lib = pkgs.lib;
            removed = import ./packages/distro/nix/removed-settings.nix { inherit lib; } {
              gone = "top note";
              "section.gone" = "section note";
              "items[].gone" = "item note";
            };
            evaluate = settings: (lib.evalModules {
              modules = [
                ({ config, ... }: {
                  options.assertions = lib.mkOption { type = lib.types.listOf lib.types.unspecified; };
                  options.settings = lib.mkOption {
                    type = lib.types.submodule {
                      freeformType = (pkgs.formats.json { }).type;
                      options = lib.recursiveUpdate {
                        section.kept = lib.mkOption { default = 1; };
                        items = lib.mkOption {
                          type = lib.types.listOf (lib.types.submodule {
                            options = lib.recursiveUpdate
                              { kept = lib.mkOption { default = 1; }; }
                              (removed.optionsUnder "items[]");
                          });
                          default = [ ];
                        };
                      } (removed.optionsUnder "");
                    };
                    default = { };
                  };
                  config.assertions = removed.assertions config.settings;
                })
                { inherit settings; }
              ];
            }).config;
            # The notes of the assertions that fail.
            failing = settings: map (each: each.message)
              (lib.filter (each: !each.assertion) (evaluate settings).assertions);
            expect = what: holds: lib.optionalString (!holds) "echo ${lib.escapeShellArg "removed-settings: ${what}"} >&2; exit 1\n";
            unset = evaluate { items = [ { } ]; };
          in
          pkgs.runCommandLocal "removed-settings" { } ''
            ${expect "nothing set fails nothing" (failing { items = [ { } ]; } == [ ])}
            ${expect "an unset removed setting is null" (unset.settings.gone == null && unset.settings.section.gone == null && (lib.head unset.settings.items).gone == null)}
            ${expect "a removed setting at the top fails with its note" (failing { gone = 1; } == [ "programs.domicile.settings.gone is removed. top note" ])}
            ${expect "a removed setting in a section fails with its note" (failing { section.gone = 1; } == [ "programs.domicile.settings.section.gone is removed. section note" ])}
            ${expect "a removed setting in a list's element fails with its note" (failing { items = [ { } { gone = 1; } ]; } == [ "programs.domicile.settings.items[].gone is removed. item note" ])}
            touch "$out"
          '';

        # examples/nixos, which the install docs link: its system and home
        # modules evaluate with this flake as `domicile`. Evaluation builds no
        # system.
        nixos-example =
          let
            machine = nixpkgs.lib.nixosSystem {
              inherit system;
              specialArgs.domicile = self;
              modules = [
                ./examples/nixos/configuration.nix
                {
                  # Stands in for the machine's hardware-configuration.nix.
                  boot.loader.grub.enable = false;
                  fileSystems."/" = {
                    device = "nodev";
                    fsType = "tmpfs";
                  };
                }
              ];
            };
            home = pkgs.lib.evalModules {
              modules = [
                homeManagerStub
                ({ lib, ... }: { options.home.stateVersion = lib.mkOption { type = lib.types.str; }; })
                ./examples/nixos/home.nix
              ];
              specialArgs = { inherit pkgs; domicile = self; };
            };
          in
          pkgs.runCommandLocal "nixos-example-evaluates" { } ''
            echo ${builtins.unsafeDiscardStringContext machine.config.system.build.toplevel.drvPath}
            echo ${builtins.unsafeDiscardStringContext home.config.xdg.configFile."domicile/domicile.json".source}
            touch "$out"
          '';

        # The NixOS module, evaluated with real NixOS instead of a stub, since
        # NixOS's own checks (such as `sessionPackages` requiring
        # `providedSessions`) are what is under test. Evaluation builds no
        # system.
        nixos-module =
          let
            machine = pkgs.nixos {
              imports = [ self.nixosModules.domicile ];
              programs.domicile.enable = true;
              # The module does not enable a display manager itself.
              services.displayManager.enable = true;
              # The minimum a NixOS configuration needs to evaluate.
              boot.loader.grub.enable = false;
              fileSystems."/" = {
                device = "nodev";
                fsType = "tmpfs";
              };
              system.stateVersion = pkgs.lib.trivial.release;
            };
            # The sessions the display manager receives. NixOS rejects a
            # package missing the file its `providedSessions` names.
            inherit (machine.config.services.displayManager.sessionData) sessionNames;
            session = "${machine.config.services.displayManager.sessionData.desktops}/share/wayland-sessions/domicile.desktop";
          in
          pkgs.runCommand "nixos-module-evaluates" { } ''
            # One session, `domicile`; the config chooses the shell.
            [ ${pkgs.lib.escapeShellArg (toString sessionNames)} = domicile ] || {
              echo "the sessions NixOS sees are: ${toString sessionNames}" >&2
              echo "and they should have been: domicile" >&2
              exit 1
            }
            # The display manager sets `XDG_CURRENT_DESKTOP` from
            # `DesktopNames` before the compositor starts.
            for line in 'Exec=${domicilePackage}/bin/domicile' 'DesktopNames=domicile'; do
              grep -qxF "$line" ${session} || {
                echo "the domicile session is missing: $line" >&2
                cat ${session} >&2
                exit 1
              }
            done

            # The user units must be installed: the launcher starts
            # `domicile-session.target`, which binds
            # `graphical-session.target`, which the portal requires.
            [ ${pkgs.lib.boolToString (pkgs.lib.elem domicilePackage machine.config.systemd.packages)} = true ] || {
              echo "the module does not install domicile's user units" >&2
              exit 1
            }
            target=${domicilePackage}/lib/systemd/user/domicile-session.target
            for line in 'BindsTo=graphical-session.target' 'Before=graphical-session.target'; do
              grep -qxF "$line" "$target" || {
                echo "domicile-session.target is missing: $line" >&2
                cat "$target" >&2
                exit 1
              }
            done
            # The shutdown target stops the graphical session even while the
            # portal runs.
            shutdown=${domicilePackage}/lib/systemd/user/domicile-session-shutdown.target
            grep -qxF 'Conflicts=graphical-session.target graphical-session-pre.target' "$shutdown" || {
              echo "domicile-session-shutdown.target does not conflict the session down" >&2
              cat "$shutdown" >&2
              exit 1
            }

            # Domicile must be on the system profile so the portal, which runs
            # outside the desktop, finds its default-browser file.
            [ ${pkgs.lib.boolToString (pkgs.lib.elem domicilePackage machine.config.environment.systemPackages)} = true ] || {
              echo "the module does not put domicile on the system profile" >&2
              exit 1
            }

            # The PAM service that unlocks the desk. Home-manager cannot
            # declare it, and without it a locked desk opens to nothing.
            [ ${pkgs.lib.boolToString (machine.config.security.pam.services ? domicile)} = true ] || {
              echo "the module declared no domicile PAM service" >&2
              exit 1
            }

            # UPower, which `@domicile-desktop/system-battery` reads. NixOS
            # enables it only with a desktop that asks for it.
            [ ${pkgs.lib.boolToString machine.config.services.upower.enable} = true ] || {
              echo "the module does not enable UPower, so the shell has no battery" >&2
              exit 1
            }

            # The `domicile` group's sessions may raise threads to the
            # priorities the engine asks for its frame and audio threads.
            [ ${pkgs.lib.boolToString (machine.config.users.groups ? domicile)} = true ] || {
              echo "the module declares no domicile group" >&2
              exit 1
            }
            for limit in ${pkgs.lib.escapeShellArgs (map (each: "${each.domain} ${each.type} ${each.item} ${toString each.value}") machine.config.security.pam.loginLimits)}; do
              echo "$limit"
            done >limits
            for expected in '@domicile - nice -10' '@domicile - rtprio 8'; do
              grep -qxF "$expected" limits || {
                echo "the module's login limits are missing: $expected" >&2
                cat limits >&2
                exit 1
              }
            done

            # `domicile-portals.conf` routes every portal call to Domicile but
            # `Secret`, which goes to the keyring.
            found=
            for package in ${toString machine.config.xdg.portal.configPackages}; do
              conf="$package/share/xdg-desktop-portal/domicile-portals.conf"
              if [ -e "$conf" ]; then
                found="$conf"
              fi
            done
            [ -n "$found" ] || {
              echo "no configPackage holds a domicile-portals.conf" >&2
              exit 1
            }
            routes=$(grep -vE '^(#|$)' "$found")
            [ "$routes" = "$(printf '%s\n' \
              '[preferred]' \
              'default=domicile' \
              'org.freedesktop.impl.portal.Secret=gnome-keyring')" ] || {
              echo "domicile-portals.conf routes other than domicile and the keyring:" >&2
              cat "$found" >&2
              exit 1
            }
            # No gtk backend is offered.
            [ ${pkgs.lib.boolToString (pkgs.lib.elem pkgs.xdg-desktop-portal-gtk machine.config.xdg.portal.extraPortals)} = false ] || {
              echo "the module still offers xdg-desktop-portal-gtk" >&2
              exit 1
            }

            touch "$out"
          '';

        # A tty desktop on a card with no 3D: 2D virtio-gpu, no virgl. The
        # launcher picks software compositing, the engine scans out dumb
        # buffers, a `wl_shm` client's window reaches the screen, and one GPU
        # process stays up under seccomp. See
        # docs/architecture/A-DESKTOP-ON-A-TTY.md#software-output.
        #
        # Runs the pinned engine, so on a pull request that changes the fork it
        # fails until engine.yml writes the release back.
        tty-on-a-card-with-no-3d = pkgs.testers.runNixOSTest {
          name = "tty-on-a-card-with-no-3d";
          extraPythonPackages = python: [ python.pillow ];
          nodes.machine = {
            imports = [ self.nixosModules.domicile ];
            programs.domicile.enable = true;
            virtualisation = {
              memorySize = 4096;
              # The store as a disk image, not the host's over 9p. Over 9p the
              # engine's startup page faults stall behind the runner's other
              # builds, long enough that the desk misses the test's timeouts.
              useNixStoreImage = true;
              cores = 2;
              # The only card, so it is `card0`, and 2D.
              qemu.options = [ "-vga none" "-device virtio-gpu-pci,xres=1280,yres=800" ];
            };
            users.users.alice = {
              isNormalUser = true;
              uid = 1000;
              extraGroups = [ "domicile" "video" "input" ];
            };
            # A logind session on tty1, as a console login gets.
            services.getty.autologinUser = "alice";
            environment.loginShellInit = ''
              if [ "$(tty)" = /dev/tty1 ]; then
                # What the engine does on the way to the desk, for a failure.
                export DOMICILE_ENGINE_ARGS="--log-level=0 --vmodule=*ozone*=1,*domicile*=1,*viz*=1"
                export RUST_LOG=domicile_compositor=debug
                exec ${self.packages.${system}.simple}/bin/simple >/tmp/domicile.log 2>&1
              fi
            '';
            environment.systemPackages = [ pkgs.foot pkgs.gdb ];
            fonts.enableDefaultPackages = true;
          };
          testScript = ''
            import datetime as dt
            import os
            from PIL import Image

            def colors_on_the_screen(name):
                """Each color on the screen and its share of the pixels."""
                machine.screenshot(name)
                image = Image.open(os.path.join(machine.out_dir, f"{name}.png")).convert("RGB")
                pixels = image.width * image.height
                colors = image.getcolors(maxcolors=pixels)
                assert colors is not None
                return {color: count / pixels for count, color in colors}

            def the_desktop_shows_a_window():
                machine.wait_until_succeeds(
                    "grep -q 'composites on the CPU' /tmp/domicile.log", timeout=dt.timedelta(seconds=120))
                machine.wait_until_succeeds("ls /run/user/1000/wayland-[0-9]", timeout=dt.timedelta(seconds=90))

                # The page covers the screen. The console it replaced is mostly
                # black.
                def page_is_up(_):
                    shares = colors_on_the_screen("desk")
                    color = max(shares, key=lambda color: shares[color])
                    return shares[color] > 0.5 and color != (0, 0, 0)
                retry(page_is_up, timeout=dt.timedelta(seconds=300))

                # foot draws only in shared memory.
                machine.succeed(
                    "su alice -c 'XDG_RUNTIME_DIR=/run/user/1000 "
                    "WAYLAND_DISPLAY=$(basename $(ls /run/user/1000/wayland-[0-9] | head -1)) "
                    # foot follows the desk's theme, so both of its palettes.
                    "foot --override=colors-dark.background=3366cc "
                    "--override=colors-light.background=3366cc "
                    "--window-size-pixels=400x300 sleep 600' >/tmp/foot.log 2>&1 &")

                # foot's 400x300 is 12% of the 1280x800 screen.
                def window_is_up(_):
                    return colors_on_the_screen("window").get((0x33, 0x66, 0xCC), 0) > 0.04
                retry(window_is_up, timeout=dt.timedelta(seconds=300))

            def the_gpu_process_stays_up_in_its_sandbox():
                # One GPU process, not one restarting forever, under seccomp
                # (`Seccomp: 2`). Mesa's GBM loads inside the sandbox
                # (patch 0169) and the CPU draws through it (patch 0135).
                def gpu_process():
                    pids = machine.succeed("pgrep -u alice -f -- '--type=gpu-process' || true").split()
                    assert len(pids) == 1, f"GPU processes: {pids}"
                    return pids[0]
                first = gpu_process()
                machine.sleep(10)
                assert gpu_process() == first, "the GPU process restarted"
                seccomp = machine.succeed(f"grep -E '^Seccomp:' /proc/{first}/status").split()
                assert seccomp == ["Seccomp:", "2"], f"the GPU process is not under seccomp: {seccomp}"

            machine.wait_for_unit("multi-user.target")
            try:
                the_desktop_shows_a_window()
                the_gpu_process_stays_up_in_its_sandbox()
            except Exception:
                # What the screen showed instead: its biggest colors.
                shares = colors_on_the_screen("failed")
                screen = sorted(shares.items(), key=lambda share: -share[1])[:4]
                # The session ends first: a crashing process floods the console,
                # and CI keeps only the last 100 lines.
                machine.execute("systemctl stop getty@tty1.service; pkill -u alice; sleep 3")
                # What the launcher and the session saw, for the CI log.
                for command in [
                    "grep -E 'FATAL|Check failed|ERROR:.*domicile' /tmp/domicile.log | tail -6 | cut -c1-200 || true",
                    # The compositor's complaints, and how far foot's window got.
                    "grep -E ' (WARN|ERROR) ' /tmp/domicile.log | tail -6 | cut -c1-200 || true",
                    "grep -E 'toplevel created|brokered a frame sink|first frame' /tmp/domicile.log "
                    "| tail -5 | cut -c1-200 || true",
                    "tail -3 /tmp/foot.log | cut -c1-160",
                    # A crashing engine process: which one, and its crashing thread.
                    "coredumpctl list --no-pager --no-legend 2>/dev/null | tail -2 | cut -c1-150 || true",
                    "coredumpctl info --no-pager -1 2>/dev/null | grep -oE -m1 -- '--type=[a-z-]+' || true",
                    "coredumpctl info --no-pager -1 2>/dev/null | grep -E -m1 -A24 'Stack trace of thread' "
                    "| cut -c1-110 || true",
                ]:
                    print(f"$ {command}")
                    print(machine.execute(f"{command} 2>&1")[1])
                print("the screen's biggest colors:", screen)
                raise
          '';
        };

        # A tty desktop on the GPU whose engine falls back to the CPU: 2D
        # virtio-gpu with GPU compositing forced, so the engine finds no GBM,
        # as on a card the launcher took for 3D. App windows still reach the
        # screen, and the fallback is logged as an error. See
        # docs/architecture/A-DESKTOP-ON-A-TTY.md#software-output.
        #
        # Runs the pinned engine, as `tty-on-a-card-with-no-3d` does.
        tty-with-an-engine-that-fell-back-to-the-cpu = pkgs.testers.runNixOSTest {
          name = "tty-with-an-engine-that-fell-back-to-the-cpu";
          extraPythonPackages = python: [ python.pillow ];
          nodes.machine = {
            imports = [ self.nixosModules.domicile ];
            programs.domicile.enable = true;
            virtualisation = {
              memorySize = 4096;
              # Not over 9p; see `tty-on-a-card-with-no-3d`.
              useNixStoreImage = true;
              cores = 2;
              qemu.options = [ "-vga none" "-device virtio-gpu-pci,xres=1280,yres=800" ];
            };
            users.users.alice = {
              isNormalUser = true;
              uid = 1000;
              extraGroups = [ "domicile" "video" "input" ];
            };
            services.getty.autologinUser = "alice";
            environment.loginShellInit = ''
              if [ "$(tty)" = /dev/tty1 ]; then
                export DOMICILE_SOFTWARE_COMPOSITING=no
                export DOMICILE_ENGINE_ARGS="--log-level=0 --vmodule=*ozone*=1,*domicile*=1,*viz*=1"
                export RUST_LOG=domicile_compositor=debug
                exec ${self.packages.${system}.simple}/bin/simple >/tmp/domicile.log 2>&1
              fi
            '';
            environment.systemPackages = [ pkgs.foot ];
            fonts.enableDefaultPackages = true;
          };
          testScript = ''
            import datetime as dt
            import os
            from PIL import Image

            def colors_on_the_screen(name):
                """Each color on the screen and its share of the pixels."""
                machine.screenshot(name)
                image = Image.open(os.path.join(machine.out_dir, f"{name}.png")).convert("RGB")
                pixels = image.width * image.height
                colors = image.getcolors(maxcolors=pixels)
                assert colors is not None
                return {color: count / pixels for count, color in colors}

            def the_desktop_shows_a_window():
                machine.wait_until_succeeds("ls /run/user/1000/wayland-[0-9]", timeout=dt.timedelta(seconds=120))

                def page_is_up(_):
                    shares = colors_on_the_screen("desk")
                    color = max(shares, key=lambda color: shares[color])
                    return shares[color] > 0.5 and color != (0, 0, 0)
                retry(page_is_up, timeout=dt.timedelta(seconds=300))

                machine.succeed(
                    "su alice -c 'XDG_RUNTIME_DIR=/run/user/1000 "
                    "WAYLAND_DISPLAY=$(basename $(ls /run/user/1000/wayland-[0-9] | head -1)) "
                    "foot --override=colors-dark.background=3366cc "
                    "--override=colors-light.background=3366cc "
                    "--window-size-pixels=400x300 sleep 600' >/tmp/foot.log 2>&1 &")

                def window_is_up(_):
                    return colors_on_the_screen("window").get((0x33, 0x66, 0xCC), 0) > 0.04
                retry(window_is_up, timeout=dt.timedelta(seconds=300))

                # Falling back is a bug, so it is loud.
                machine.succeed("grep -qE 'ERROR.*fell back to software compositing' /tmp/domicile.log")

            machine.wait_for_unit("multi-user.target")
            try:
                the_desktop_shows_a_window()
            except Exception:
                shares = colors_on_the_screen("failed")
                screen = sorted(shares.items(), key=lambda share: -share[1])[:4]
                machine.execute("systemctl stop getty@tty1.service; pkill -u alice; sleep 3")
                for command in [
                    "ls -l /sys/class/drm/*/device/driver",
                    "dmesg | grep -i vmw | tail -8 | cut -c1-200",
                    "grep -iE 'GBM|composites|software|refused|no GPU|gpu_init|GL ' /tmp/domicile.log "
                    "| sort | uniq -c | sort -rn | head -12 | cut -c1-220 || true",
                    "grep -E 'FATAL|Check failed|ERROR:' /tmp/domicile.log | tail -8 | cut -c1-220 || true",
                    "grep -E ' (WARN|ERROR) ' /tmp/domicile.log | tail -6 | cut -c1-200 || true",
                    "tail -3 /tmp/foot.log | cut -c1-160",
                ]:
                    print(f"$ {command}")
                    print(machine.execute(f"{command} 2>&1")[1])
                print("the screen's biggest colors:", screen)
                raise
          '';
        };

        # Manganese on two monitors: one 2D virtio-gpu card with two heads,
        # started cold. Checks what docs/HARDWARE-CHECKS.md#several-monitors
        # asks of a lit panel: a bar and a wallpaper on each, keyboard focus
        # following the pointer across, `mod+2`, and an `exec` key opening its
        # window on the monitor with the keyboard. Also that a touchpad pinch
        # works off the monitor hosting the desk.
        #
        # Runs the pinned engine, as `tty-on-a-card-with-no-3d` does.
        two-monitors-on-a-tty = pkgs.testers.runNixOSTest {
          name = "two-monitors-on-a-tty";
          extraPythonPackages = python: [ python.pillow ];
          nodes.machine = {
            imports = [ self.nixosModules.domicile ];
            programs.domicile.enable = true;
            virtualisation = {
              memorySize = 4096;
              # Not over 9p; see `tty-on-a-card-with-no-3d`.
              useNixStoreImage = true;
              cores = 2;
              # Both heads lit from boot. `video0` names the card to
              # `screendump`.
              qemu.options = [
                "-vga none"
                "-device '${builtins.toJSON {
                  driver = "virtio-gpu-pci";
                  id = "video0";
                  max_outputs = 2;
                  outputs = [
                    { name = "left"; xres = 1280; yres = 800; }
                    { name = "right"; xres = 1280; yres = 800; }
                  ];
                }}'"
              ];
            };
            users.users.alice = {
              isNormalUser = true;
              uid = 1000;
              extraGroups = [ "domicile" "video" "input" ];
            };
            services.getty.autologinUser = "alice";
            environment.loginShellInit =
              let
                # Two terminal keys, each a foot of its own color, so a screen
                # shows which key opened what.
                config = pkgs.writeText "domicile.tsx" ''
                  import { runManganese } from "@domicile-desktop/manganese";
                  import {
                    DEFAULT_KEYBINDINGS,
                    exec,
                  } from "@domicile-desktop/manganese-window-management/keyboard/commands";

                  const foot = (background: string) =>
                    exec(
                      "foot",
                      `--override=colors-dark.background=''${background}`,
                      `--override=colors-light.background=''${background}`,
                      "sleep",
                      "600",
                    );

                  export const Shell = runManganese({
                    keybindings: {
                      keybindings: {
                        ...DEFAULT_KEYBINDINGS,
                        "Meta+t": foot("3366cc"),
                        "Meta+y": foot("cc6633"),
                      },
                    },
                  });
                '';
              in
              ''
                if [ "$(tty)" = /dev/tty1 ]; then
                  mkdir -p ~/.config/domicile
                  cp ${config} ~/.config/domicile/domicile.tsx
                  export DOMICILE_ENGINE_ARGS="--log-level=0 --vmodule=*domicile*=1,*/domicile/*=1,*evdev*=1"
                  export RUST_LOG=domicile_compositor=debug
                  exec ${self.packages.${system}.domicile}/bin/domicile >/tmp/domicile.log 2>&1
                fi
              '';
            environment.systemPackages = [ pkgs.foot ];
            # A relative mouse the test moves through `/run/pointer`, one
            # `dx dy` per line, or `meta pinch` for a two-finger spread on a
            # multitouch pad with Meta held. QEMU's PS/2 mouse reached the
            # kernel with no events.
            hardware.uinput.enable = true;
            systemd.services.test-pointer = {
              wantedBy = [ "multi-user.target" ];
              before = [ "getty@tty1.service" ];
              serviceConfig.ExecStart = pkgs.writers.writePython3 "test-pointer"
                { libraries = [ pkgs.python3Packages.evdev ]; } ''
                import os
                import time

                from evdev import AbsInfo, UInput, ecodes

                # 100 x 65 mm at 40 units a millimeter.
                WIDTH, HEIGHT, RESOLUTION = 4000, 2600, 40


                def span(size):
                    """An axis from 0 to `size` at the pad's resolution."""
                    return AbsInfo(0, 0, size, 0, 0, RESOLUTION)


                pointer = UInput(
                    {
                        ecodes.EV_REL: [ecodes.REL_X, ecodes.REL_Y],
                        ecodes.EV_KEY: [ecodes.BTN_LEFT, ecodes.BTN_RIGHT],
                    },
                    name="test pointer",
                )
                keyboard = UInput(
                    {ecodes.EV_KEY: [ecodes.KEY_LEFTMETA]},
                    name="test keyboard",
                )
                pad = UInput(
                    {
                        ecodes.EV_KEY: [
                            ecodes.BTN_LEFT, ecodes.BTN_TOUCH,
                            ecodes.BTN_TOOL_FINGER, ecodes.BTN_TOOL_DOUBLETAP,
                        ],
                        ecodes.EV_ABS: [
                            (ecodes.ABS_X, span(WIDTH)),
                            (ecodes.ABS_Y, span(HEIGHT)),
                            (ecodes.ABS_MT_SLOT, AbsInfo(0, 0, 4, 0, 0, 0)),
                            (ecodes.ABS_MT_TRACKING_ID, AbsInfo(0, 0, 65535, 0, 0, 0)),
                            (ecodes.ABS_MT_POSITION_X, span(WIDTH)),
                            (ecodes.ABS_MT_POSITION_Y, span(HEIGHT)),
                        ],
                    },
                    name="test touchpad",
                    input_props=[
                        ecodes.INPUT_PROP_POINTER, ecodes.INPUT_PROP_BUTTONPAD,
                    ],
                )


                def frame(fingers):
                    """Each finger's `(x, y)`, one slot each, then a report."""
                    for slot, (x, y) in enumerate(fingers):
                        pad.write(ecodes.EV_ABS, ecodes.ABS_MT_SLOT, slot)
                        pad.write(ecodes.EV_ABS, ecodes.ABS_MT_POSITION_X, x)
                        pad.write(ecodes.EV_ABS, ecodes.ABS_MT_POSITION_Y, y)
                    pad.write(ecodes.EV_ABS, ecodes.ABS_X, fingers[0][0])
                    pad.write(ecodes.EV_ABS, ecodes.ABS_Y, fingers[0][1])
                    pad.syn()
                    time.sleep(0.012)


                def meta_pinch():
                    """Meta held, two fingers 25 mm apart spread to 85 mm."""
                    keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTMETA, 1)
                    keyboard.syn()
                    time.sleep(0.05)
                    for slot in range(2):
                        pad.write(ecodes.EV_ABS, ecodes.ABS_MT_SLOT, slot)
                        pad.write(ecodes.EV_ABS, ecodes.ABS_MT_TRACKING_ID, slot + 1)
                    pad.write(ecodes.EV_KEY, ecodes.BTN_TOUCH, 1)
                    pad.write(ecodes.EV_KEY, ecodes.BTN_TOOL_DOUBLETAP, 1)
                    for step in range(40):
                        frame([(1500 - 30 * step, 1300), (2500 + 30 * step, 1300)])
                    for slot in range(2):
                        pad.write(ecodes.EV_ABS, ecodes.ABS_MT_SLOT, slot)
                        pad.write(ecodes.EV_ABS, ecodes.ABS_MT_TRACKING_ID, -1)
                    pad.write(ecodes.EV_KEY, ecodes.BTN_TOUCH, 0)
                    pad.write(ecodes.EV_KEY, ecodes.BTN_TOOL_DOUBLETAP, 0)
                    pad.syn()
                    keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTMETA, 0)
                    keyboard.syn()


                os.mkfifo("/run/pointer")
                while True:
                    with open("/run/pointer") as moves:
                        for move in moves:
                            if move.split() == ["meta", "pinch"]:
                                meta_pinch()
                                continue
                            dx, dy = (int(each) for each in move.split())
                            pointer.write(ecodes.EV_REL, ecodes.REL_X, dx)
                            pointer.write(ecodes.EV_REL, ecodes.REL_Y, dy)
                            pointer.syn()
              '';
            };
            fonts.enableDefaultPackages = true;
          };
          testScript = ''
            import datetime as dt
            import os
            import tempfile
            import time
            from PIL import Image, ImageChops

            BLUE = (0x33, 0x66, 0xCC)
            ORANGE = (0xCC, 0x66, 0x33)
            # Manganese's `TOP_BAR`, and the gradient it paints below itself.
            BAR = 40
            WAIT = dt.timedelta(seconds=300)

            def screen(head, name):
                """What head `head` shows, also kept as `name`.png."""
                with tempfile.TemporaryDirectory() as directory:
                    dump = os.path.join(directory, "screen.ppm")
                    machine.send_monitor_command(f"screendump {dump} video0 {head}")
                    image = Image.open(dump).convert("RGB")
                image.save(os.path.join(machine.out_dir, f"{name}.png"))
                return image

            def shares(image):
                """Each color in `image` and its share of the pixels."""
                pixels = image.width * image.height
                colors = image.getcolors(maxcolors=pixels)
                assert colors is not None
                return {color: count / pixels for count, color in colors}

            def shows_a_photo(head):
                """A photograph below the bar: many colors, none of them most."""
                image = screen(head, f"wallpaper-{head}")
                below = shares(image.crop((0, BAR, image.width, image.height)))
                return len(below) > 1000 and max(below.values()) < 0.3

            def the_clock_ticks_in_a_bar(head):
                """The clock's seconds are the only change, and at the top."""
                before = screen(head, f"bar-{head}")
                time.sleep(1.5)
                changed = ImageChops.difference(before, screen(head, f"bar-{head}")).getbbox()
                return changed is not None and changed[3] <= BAR

            def share_of(head, color, name):
                return shares(screen(head, name)).get(color, 0)

            def move_the_pointer(dx):
                """Far enough to cross a whole monitor."""
                machine.succeed(f"for _ in $(seq 30); do echo '{dx} 0' >/run/pointer; done")

            def the_desk_spans_two_monitors():
                machine.wait_until_succeeds(
                    "grep -q 'composites on the CPU' /tmp/domicile.log", timeout=WAIT)
                machine.wait_until_succeeds(
                    "grep -q 'told the chrome about 2 display(s)' /tmp/domicile.log", timeout=WAIT)
                for head in [0, 1]:
                    retry(lambda _: shows_a_photo(head), timeout=WAIT)
                    retry(lambda _: the_clock_ticks_in_a_bar(head), timeout=dt.timedelta(seconds=60))
                # One presenter per CRTC.
                machine.succeed("grep -q 'presenting the desk on display' /tmp/domicile.log")

                # The pointer onto the right monitor takes the keyboard there,
                # so the blue terminal opens on it.
                move_the_pointer(100)
                # Gives the shell time to move the keyboard to the pointer's screen.
                time.sleep(2)
                machine.send_key("meta_l-t")
                retry(lambda _: share_of(1, BLUE, "blue") > 0.5, timeout=WAIT)
                assert share_of(0, BLUE, "blue-left") == 0, "the blue terminal reached the left monitor"

                # Back on the left monitor, `mod+2` sends the keyboard to the
                # right one, which shows workspace 2, and moves no workspace.
                # The orange terminal opens as a tab over the blue one.
                move_the_pointer(-100)
                time.sleep(2)
                machine.send_key("meta_l-2")
                machine.send_key("meta_l-y")
                retry(lambda _: share_of(1, ORANGE, "orange") > 0.5, timeout=WAIT)
                left = shares(screen(0, "orange-left"))
                assert left.get(ORANGE, 0) == 0 and left.get(BLUE, 0) == 0, (
                    "a terminal reached the left monitor")
                assert shows_a_photo(0), "the left monitor left its empty workspace"
                # Closing it shows the blue terminal, still drawing.
                machine.send_key("meta_l-shift-q")
                retry(lambda _: share_of(1, BLUE, "blue-again") > 0.5, timeout=WAIT)

                # With the pointer on the right monitor, whose window only
                # presents the desk the left one hosts, Meta+pinch magnifies
                # the desk there. A pinch went by the window holding the
                # pointer's place, so off the host's monitor it reached
                # nothing.
                move_the_pointer(100)
                time.sleep(1)
                before = screen(1, "before-pinch")
                machine.succeed("echo 'meta pinch' >/run/pointer")

                def magnified(_):
                    changed = ImageChops.difference(before, screen(1, "pinched")).getbbox()
                    return changed is not None and changed[3] > BAR

                retry(magnified, timeout=dt.timedelta(seconds=30))

            machine.wait_for_unit("multi-user.target")
            try:
                the_desk_spans_two_monitors()
            except Exception:
                screens = [
                    sorted(shares(screen(head, f"failed-{head}")).items(), key=lambda share: -share[1])[:4]
                    for head in [0, 1]
                ]
                machine.execute("systemctl stop getty@tty1.service; pkill -u alice; sleep 3")
                for command in [
                    "grep -E 'FATAL|Check failed|ERROR:.*domicile' /tmp/domicile.log | tail -6 | cut -c1-200 || true",
                    "grep -E ' (WARN|ERROR) ' /tmp/domicile.log | tail -6 | cut -c1-200 || true",
                    "grep -E 'display\\(s\\)|presenting the desk|toplevel created' /tmp/domicile.log "
                    "| tail -8 | cut -c1-200 || true",
                    "grep -vE '^\\[' /tmp/domicile.log | head -20 | cut -c1-200",
                    "grep -iE 'input device|handed over|evdev|cursor' /tmp/domicile.log | tail -20 | cut -c1-200 || true",
                ]:
                    print(f"$ {command}")
                    print(machine.execute(f"{command} 2>&1")[1])
                print("each monitor's biggest colors:", screens)
                raise
          '';
        };

        # A touchpad on a tty: libinput in the engine reads a uinput
        # multitouch pad, and a native window under the pointer gets its
        # two-finger swipe as finger scrolling with axis stops, and its pinch
        # as `zwp_pointer_gestures_v1`. Covers the acquisition the nested
        # guards cannot. See docs/architecture/GESTURES.md. Also hides the
        # pointer on typing and after a pause, and shows it on a move,
        # keeping the window's pointer focus.
        #
        # Runs the pinned engine, as `tty-on-a-card-with-no-3d` does.
        touchpad-gestures-on-a-tty = pkgs.testers.runNixOSTest {
          name = "touchpad-gestures-on-a-tty";
          nodes.machine = {
            imports = [ self.nixosModules.domicile ];
            programs.domicile.enable = true;
            virtualisation = {
              memorySize = 4096;
              # Not over 9p; see `tty-on-a-card-with-no-3d`.
              useNixStoreImage = true;
              cores = 2;
              qemu.options = [ "-vga none" "-device virtio-gpu-pci,xres=1280,yres=800" ];
            };
            users.users.alice = {
              isNormalUser = true;
              uid = 1000;
              extraGroups = [ "domicile" "video" "input" ];
            };
            services.getty.autologinUser = "alice";
            environment.loginShellInit =
              let
                config = pkgs.writeText "domicile.json" (builtins.toJSON {
                  theme = {
                    cursor_hide_after_ms = 5000;
                    cursor_hide_when_typing = true;
                  };
                });
              in
              ''
                if [ "$(tty)" = /dev/tty1 ]; then
                  mkdir -p ~/.config/domicile
                  cp ${config} ~/.config/domicile/domicile.json
                  export DOMICILE_ENGINE_ARGS="--log-level=0 --vmodule=*evdev*=1,*domicile*=1"
                  export RUST_LOG=domicile_compositor=debug
                  exec ${self.packages.${system}.simple}/bin/simple >/tmp/domicile.log 2>&1
                fi
              '';
            # Screenshots with and without the pointer.
            environment.systemPackages = [ pkgs.grim ];
            # A mouse to put the pointer over the window, a keyboard, and a
            # multitouch pad libinput takes for a touchpad. The test writes a
            # command per line to `/run/input`: `move DX DY`, `key a`, `key
            # shift`, `swipe`, `pinch`, `meta pinch` or `meta scroll`.
            hardware.uinput.enable = true;
            systemd.services.test-input = {
              wantedBy = [ "multi-user.target" ];
              before = [ "getty@tty1.service" ];
              serviceConfig.ExecStart = pkgs.writers.writePython3 "test-input"
                { libraries = [ pkgs.python3Packages.evdev ]; } ''
                import os
                import time

                from evdev import AbsInfo, UInput, ecodes as e

                # 100 x 65 mm at 40 units a millimeter.
                WIDTH, HEIGHT, RESOLUTION = 4000, 2600, 40
                mouse = UInput(
                    {
                        e.EV_REL: [e.REL_X, e.REL_Y],
                        e.EV_KEY: [e.BTN_LEFT, e.BTN_RIGHT],
                    },
                    name="test mouse",
                )
                keyboard = UInput(
                    {e.EV_KEY: [e.KEY_A, e.KEY_LEFTSHIFT, e.KEY_LEFTMETA]},
                    name="test keyboard",
                )
                KEYS = {"a": e.KEY_A, "shift": e.KEY_LEFTSHIFT}
                pad = UInput(
                    {
                        e.EV_KEY: [
                            e.BTN_LEFT, e.BTN_TOUCH, e.BTN_TOOL_FINGER,
                            e.BTN_TOOL_DOUBLETAP, e.BTN_TOOL_TRIPLETAP,
                            e.BTN_TOOL_QUADTAP,
                        ],
                        e.EV_ABS: [
                            (e.ABS_X, AbsInfo(0, 0, WIDTH, 0, 0, RESOLUTION)),
                            (e.ABS_Y, AbsInfo(0, 0, HEIGHT, 0, 0, RESOLUTION)),
                            (e.ABS_MT_SLOT, AbsInfo(0, 0, 4, 0, 0, 0)),
                            (e.ABS_MT_TRACKING_ID, AbsInfo(0, 0, 65535, 0, 0, 0)),
                            (e.ABS_MT_POSITION_X, AbsInfo(0, 0, WIDTH, 0, 0, RESOLUTION)),
                            (e.ABS_MT_POSITION_Y, AbsInfo(0, 0, HEIGHT, 0, 0, RESOLUTION)),
                        ],
                    },
                    name="test touchpad",
                    input_props=[e.INPUT_PROP_POINTER, e.INPUT_PROP_BUTTONPAD],
                )
                tracking = 0


                def frame(fingers):
                    """Each finger's `(x, y)`, one slot each, then a report."""
                    for slot, (x, y) in enumerate(fingers):
                        pad.write(e.EV_ABS, e.ABS_MT_SLOT, slot)
                        pad.write(e.EV_ABS, e.ABS_MT_POSITION_X, x)
                        pad.write(e.EV_ABS, e.ABS_MT_POSITION_Y, y)
                    pad.write(e.EV_ABS, e.ABS_X, fingers[0][0])
                    pad.write(e.EV_ABS, e.ABS_Y, fingers[0][1])
                    pad.syn()
                    time.sleep(0.012)


                def two_fingers(path):
                    """Two fingers down, through `path`'s frames, then up."""
                    global tracking
                    for slot in range(2):
                        tracking += 1
                        pad.write(e.EV_ABS, e.ABS_MT_SLOT, slot)
                        pad.write(e.EV_ABS, e.ABS_MT_TRACKING_ID, tracking)
                    pad.write(e.EV_KEY, e.BTN_TOUCH, 1)
                    pad.write(e.EV_KEY, e.BTN_TOOL_DOUBLETAP, 1)
                    frame(path[0])
                    for fingers in path[1:]:
                        frame(fingers)
                    for slot in range(2):
                        pad.write(e.EV_ABS, e.ABS_MT_SLOT, slot)
                        pad.write(e.EV_ABS, e.ABS_MT_TRACKING_ID, -1)
                    pad.write(e.EV_KEY, e.BTN_TOUCH, 0)
                    pad.write(e.EV_KEY, e.BTN_TOOL_DOUBLETAP, 0)
                    pad.syn()
                    time.sleep(0.2)


                def swipe():
                    """Side by side, 15 mm apart, 40 mm to the right."""
                    two_fingers([
                        [(1000 + 40 * step, 1300), (1600 + 40 * step, 1300)]
                        for step in range(40)
                    ])


                def pinch():
                    """25 mm apart, spreading to 85 mm."""
                    two_fingers([
                        [(1500 - 30 * step, 1300), (2500 + 30 * step, 1300)]
                        for step in range(40)
                    ])


                def scroll():
                    """Side by side, 15 mm apart, 30 mm down."""
                    two_fingers([
                        [(1700, 800 + 30 * step), (2300, 800 + 30 * step)]
                        for step in range(40)
                    ])


                def with_meta(gesture):
                    """`gesture` with the left Meta key held."""
                    keyboard.write(e.EV_KEY, e.KEY_LEFTMETA, 1)
                    keyboard.syn()
                    time.sleep(0.05)
                    gesture()
                    keyboard.write(e.EV_KEY, e.KEY_LEFTMETA, 0)
                    keyboard.syn()


                os.mkfifo("/run/input")
                # A writer of its own, never written to, so the reader never
                # sees end of file between the test's writers: alone, it closed
                # and reopened after each, and a writer that opened in that gap
                # got EPIPE. The reader stays read-only text, which hands each
                # line over as it arrives.
                os.open("/run/input", os.O_RDWR | os.O_NONBLOCK)
                while True:
                    with open("/run/input") as commands:
                        for command in commands:
                            match command.split():
                                case ["move", dx, dy]:
                                    mouse.write(e.EV_REL, e.REL_X, int(dx))
                                    mouse.write(e.EV_REL, e.REL_Y, int(dy))
                                    mouse.syn()
                                case ["key", name]:
                                    keyboard.write(e.EV_KEY, KEYS[name], 1)
                                    keyboard.syn()
                                    time.sleep(0.05)
                                    keyboard.write(e.EV_KEY, KEYS[name], 0)
                                    keyboard.syn()
                                case ["swipe"]:
                                    swipe()
                                case ["pinch"]:
                                    pinch()
                                case ["meta", "pinch"]:
                                    with_meta(pinch)
                                case ["meta", "scroll"]:
                                    with_meta(scroll)
              '';
            };
            fonts.enableDefaultPackages = true;
          };
          testScript = ''
            import datetime as dt

            WAIT = dt.timedelta(seconds=300)
            CLIENT = (
                "su alice -c 'XDG_RUNTIME_DIR=/run/user/1000 "
                "WAYLAND_DISPLAY=$(basename $(ls /run/user/1000/wayland-[0-9] | head -1)) "
                "${testClient}/bin/domicile-test-client --trace --title gestures' "
                ">/tmp/client.log 2>&1 &"
            )


            def say(command):
                machine.succeed(f"echo '{command}' >/run/input")


            def traced(pattern):
                """Whether the client's trace has a line matching `pattern`."""
                return machine.execute(f"grep -qE '{pattern}' /tmp/client.log")[0] == 0


            def the_window_has_the_pointer():
                machine.wait_until_succeeds("ls /run/user/1000/wayland-[0-9]", timeout=WAIT)
                machine.succeed(CLIENT)
                # Sized, so the shell has placed it on the monitor. The first
                # configure comes before the engine has a display, when the
                # pointer has nowhere to move.
                machine.wait_until_succeeds(
                    "grep -qE 'configure\\([1-9]' /tmp/client.log", timeout=WAIT)

                def entered(_):
                    # The simple shell opens the first window at the top left,
                    # 320 by 240. Into the corner, then a little way back out,
                    # each try.
                    machine.succeed("for _ in $(seq 40); do echo 'move -100 -100' >/run/input; done")
                    machine.succeed("for _ in $(seq 10); do echo 'move 8 8' >/run/input; done")
                    return traced(r"wl_pointer@[0-9]+\.enter\(")

                retry(entered, timeout=dt.timedelta(seconds=60))


            def a_swipe_scrolls_with_fingers_and_stops():
                say("swipe")
                # `wl_pointer.axis_source` finger is 1, and the horizontal axis
                # is 1.
                retry(lambda _: traced(r"axis_source\(1\)"), timeout=dt.timedelta(seconds=30))
                assert traced(r"\baxis\([0-9]+, 1, "), "no horizontal finger scrolling"
                # The stop comes when the fingers lift, after the whole swipe's
                # scrolling has reached the client.
                try:
                    retry(lambda _: traced(r"axis_stop\([0-9]+, 1\)"), timeout=dt.timedelta(seconds=30))
                except Exception:
                    raise AssertionError("the horizontal axis never stopped")
                assert not traced(r"axis_discrete\("), "a finger scroll came with wheel steps"


            def the_pointer_is_drawn():
                """Whether a screenshot with the pointer differs from one without."""
                shoot = (
                    "su alice -c 'XDG_RUNTIME_DIR=/run/user/1000 "
                    "WAYLAND_DISPLAY=$(basename $(ls /run/user/1000/wayland-[0-9] | head -1)) "
                    "grim {flag} /tmp/{name}.png'"
                )
                machine.succeed(shoot.format(flag="-c", name="with"))
                machine.succeed(shoot.format(flag="", name="without"))
                return machine.execute("cmp -s /tmp/with.png /tmp/without.png")[0] != 0


            def leaves():
                return int(machine.succeed(
                    "grep -cE 'wl_pointer@[0-9]+\\.leave\\(' /tmp/client.log || true").strip())


            def the_pointer_hides_while_typing_and_after_a_pause():
                left = leaves()
                say("move 1 1")
                say("key shift")
                assert the_pointer_is_drawn(), "Shift alone hid the pointer"
                say("key a")
                try:
                    retry(lambda _: not the_pointer_is_drawn(), timeout=dt.timedelta(seconds=10))
                except Exception:
                    raise AssertionError("typing never hid the pointer")
                say("move 1 1")
                try:
                    retry(lambda _: the_pointer_is_drawn(), timeout=dt.timedelta(seconds=10))
                except Exception:
                    raise AssertionError("a move never showed the pointer")
                # `cursor_hide_after_ms` is 5000.
                try:
                    retry(lambda _: not the_pointer_is_drawn(), timeout=dt.timedelta(seconds=30))
                except Exception:
                    raise AssertionError("the pointer never hid after a pause")
                assert leaves() == left, "hiding the pointer took it off the window"


            def a_pinch_reaches_the_window():
                say("pinch")
                retry(lambda _: traced(r"pinch_begin\([0-9]+, 2\)"), timeout=dt.timedelta(seconds=30))
                assert traced(r"pinch_update\("), "the pinch never updated"
                retry(lambda _: traced(r"pinch_end\([0-9]+, 0\)"), timeout=dt.timedelta(seconds=10))


            def counted(pattern):
                """How many of the client's trace lines match `pattern`."""
                return int(machine.succeed(
                    f"grep -cE '{pattern}' /tmp/client.log || true").strip())


            def the_screen():
                """A screenshot without the pointer, to compare."""
                machine.succeed(
                    "su alice -c 'XDG_RUNTIME_DIR=/run/user/1000 "
                    "WAYLAND_DISPLAY=$(basename $(ls /run/user/1000/wayland-[0-9] | head -1)) "
                    "grim /tmp/screen.png' && cp /tmp/screen.png /tmp/before.png")


            def the_screen_changed():
                machine.succeed(
                    "su alice -c 'XDG_RUNTIME_DIR=/run/user/1000 "
                    "WAYLAND_DISPLAY=$(basename $(ls /run/user/1000/wayland-[0-9] | head -1)) "
                    "grim /tmp/screen.png'")
                return machine.execute("cmp -s /tmp/screen.png /tmp/before.png")[0] != 0


            def meta_magnifies_the_desk_instead(gesture, events):
                """Meta+`gesture` over the window magnifies the desk, and the
                window gets none of its `events`."""
                before = counted(events)
                say("move 1 1")
                the_screen()
                say(f"meta {gesture}")
                try:
                    retry(lambda _: the_screen_changed(), timeout=dt.timedelta(seconds=30))
                except Exception:
                    raise AssertionError(f"Meta+{gesture} never magnified the desk")
                assert counted(events) == before, f"Meta+{gesture} reached the window"


            machine.wait_for_unit("multi-user.target")
            try:
                the_window_has_the_pointer()
                a_swipe_scrolls_with_fingers_and_stops()
                a_pinch_reaches_the_window()
                the_pointer_hides_while_typing_and_after_a_pause()
                meta_magnifies_the_desk_instead("pinch", r"pinch_begin\(")
                meta_magnifies_the_desk_instead("scroll", r"\baxis\(")
            except Exception:
                machine.execute("systemctl stop getty@tty1.service; pkill -u alice; sleep 3")
                # The runner keeps only the tail of this output, so the
                # compositor and engine lines come last.
                for command in [
                    "grep -vE 'frame\\(|motion\\(|release\\(|global\\(' /tmp/client.log | tail -15 | cut -c1-160",
                    "echo motions: $(grep -c 'motion(' /tmp/client.log)",
                    "grep -E 'FATAL|Check failed|ERROR:.*domicile' /tmp/domicile.log | tail -4 | cut -c1-200 || true",
                    "grep -vE '^\\[' /tmp/domicile.log | grep -iE 'pointer|focus|toplevel|seat|window' | tail -15 | cut -c1-200 || true",
                    "grep -E '^\\[' /tmp/domicile.log | grep -iE 'pointer|cursor|test mouse|touchpad' | tail -12 | cut -c1-200 || true",
                    "grep -E 'hides the pointer' /tmp/domicile.log | tail -3 | cut -c1-200 || true",
                ]:
                    print(f"$ {command}")
                    print(machine.execute(f"{command} 2>&1")[1])
                raise
          '';
        };


        # A touchscreen on a tty: the engine's evdev touch path reads a uinput
        # multitouch screen bound to the display in `input.pointers`, and a
        # native window under the finger gets it as `wl_touch`. In Manganese,
        # which binds swipes in from the side edges: a finger along the edge
        # is replayed to the window, and one in from the left edge is the
        # shell's and goes back to the workspace before. See
        # docs/architecture/GESTURES.md#touchscreen.
        #
        # Runs the pinned engine, as `tty-on-a-card-with-no-3d` does.
        touchscreen-on-a-tty = pkgs.testers.runNixOSTest {
          name = "touchscreen-on-a-tty";
          nodes.machine = {
            imports = [ self.nixosModules.domicile ];
            programs.domicile.enable = true;
            virtualisation = {
              memorySize = 4096;
              cores = 2;
              # No EDID, so the head is named by its connector, `Virtual-1`,
              # as the config binds it.
              qemu.options = [ "-vga none" "-device virtio-gpu-pci,xres=1280,yres=800,edid=off" ];
            };
            users.users.alice = {
              isNormalUser = true;
              uid = 1000;
              extraGroups = [ "domicile" "video" "input" ];
            };
            services.getty.autologinUser = "alice";
            environment.loginShellInit =
              let
                config = pkgs.writeText "domicile.json" (builtins.toJSON {
                  input.pointers = [ { device = "test touchscreen"; display = "Virtual-1"; } ];
                });
              in
              ''
                if [ "$(tty)" = /dev/tty1 ]; then
                  mkdir -p ~/.config/domicile
                  cp ${config} ~/.config/domicile/domicile.json
                  export DOMICILE_ENGINE_ARGS="--log-level=0 --vmodule=*evdev*=1,*domicile*=1,*/domicile/*=1"
                  export RUST_LOG=domicile_compositor=trace
                  exec ${self.packages.${system}.manganese}/bin/manganese >/tmp/domicile.log 2>&1
                fi
              '';
            # A multitouch screen the engine takes for a touchscreen. The test
            # writes `tap X Y` or `drag X Y DX DY`, in the display's pixels, a
            # command per line to `/run/input`.
            hardware.uinput.enable = true;
            systemd.services.test-input = {
              wantedBy = [ "multi-user.target" ];
              before = [ "getty@tty1.service" ];
              serviceConfig.ExecStart = pkgs.writers.writePython3 "test-input"
                { libraries = [ pkgs.python3Packages.evdev ]; } ''
                import os
                import time

                from evdev import AbsInfo, UInput, ecodes as e

                # The display, 1280 by 800, in 4096 units a side.
                WIDTH, HEIGHT, RANGE = 1280, 800, 4095
                screen = UInput(
                    {
                        e.EV_KEY: [e.BTN_TOUCH],
                        e.EV_ABS: [
                            (e.ABS_X, AbsInfo(0, 0, RANGE, 0, 0, 0)),
                            (e.ABS_Y, AbsInfo(0, 0, RANGE, 0, 0, 0)),
                            (e.ABS_MT_SLOT, AbsInfo(0, 0, 9, 0, 0, 0)),
                            (e.ABS_MT_TRACKING_ID, AbsInfo(0, 0, 65535, 0, 0, 0)),
                            (e.ABS_MT_POSITION_X, AbsInfo(0, 0, RANGE, 0, 0, 0)),
                            (e.ABS_MT_POSITION_Y, AbsInfo(0, 0, RANGE, 0, 0, 0)),
                        ],
                    },
                    name="test touchscreen",
                    input_props=[e.INPUT_PROP_DIRECT],
                )
                tracking = 0


                def at(x, y):
                    """The display's pixel `x`, `y` in the screen's units."""
                    return round(x * RANGE / WIDTH), round(y * RANGE / HEIGHT)


                def report(x, y):
                    x, y = at(x, y)
                    screen.write(e.EV_ABS, e.ABS_MT_POSITION_X, x)
                    screen.write(e.EV_ABS, e.ABS_MT_POSITION_Y, y)
                    screen.write(e.EV_ABS, e.ABS_X, x)
                    screen.write(e.EV_ABS, e.ABS_Y, y)
                    screen.syn()
                    time.sleep(0.012)


                def drag(x, y, dx, dy, steps):
                    """One finger down at `x`, `y`, through `dx`, `dy`, then up."""
                    global tracking
                    tracking += 1
                    screen.write(e.EV_ABS, e.ABS_MT_SLOT, 0)
                    screen.write(e.EV_ABS, e.ABS_MT_TRACKING_ID, tracking)
                    screen.write(e.EV_KEY, e.BTN_TOUCH, 1)
                    report(x, y)
                    for step in range(1, steps + 1):
                        report(x + dx * step / steps, y + dy * step / steps)
                    screen.write(e.EV_ABS, e.ABS_MT_TRACKING_ID, -1)
                    screen.write(e.EV_KEY, e.BTN_TOUCH, 0)
                    screen.syn()
                    time.sleep(0.2)


                os.mkfifo("/run/input")
                # A writer of its own, never written to, so the reader never
                # sees end of file between the test's writers: alone, it closed
                # and reopened after each, and a writer that opened in that gap
                # got EPIPE. The reader stays read-only text, which hands each
                # line over as it arrives.
                os.open("/run/input", os.O_RDWR | os.O_NONBLOCK)
                while True:
                    with open("/run/input") as commands:
                        for command in commands:
                            match command.split():
                                case ["tap", x, y]:
                                    drag(int(x), int(y), 0, 0, 0)
                                case ["drag", x, y, dx, dy]:
                                    drag(int(x), int(y), int(dx), int(dy), 20)
              '';
            };
            fonts.enableDefaultPackages = true;
          };
          testScript = ''
            import datetime as dt

            WAIT = dt.timedelta(seconds=300)
            CLIENT = (
                "su alice -c 'XDG_RUNTIME_DIR=/run/user/1000 "
                "WAYLAND_DISPLAY=$(basename $(ls /run/user/1000/wayland-[0-9] | head -1)) "
                "${testClient}/bin/domicile-test-client --trace --title touch' "
                ">/tmp/client.log 2>&1 &"
            )


            def say(command):
                machine.succeed(f"echo '{command}' >/run/input")


            def traced(pattern):
                """Whether the client's trace has a line matching `pattern`."""
                return machine.execute(f"grep -qE '{pattern}' /tmp/client.log")[0] == 0


            def downs():
                return int(machine.succeed(
                    "grep -cE 'wl_touch@[0-9]+\\.down\\(' /tmp/client.log || true").strip())


            def a_window_is_up():
                machine.wait_until_succeeds("ls /run/user/1000/wayland-[0-9]", timeout=WAIT)
                machine.succeed(CLIENT)
                # Sized, so the shell has placed it: Manganese tiles the
                # first window over the monitor, 20 pixels in from its sides.
                machine.wait_until_succeeds(
                    "grep -qE 'configure\\([1-9]' /tmp/client.log", timeout=WAIT)


            def a_finger_reaches_the_window_as_touch():
                # Tried until one lands: the engine binds the screen to its
                # display once the compositor has sent the displays.
                def landed(_):
                    say("drag 600 400 60 40")
                    return traced(r"wl_touch@[0-9]+\.up\(")

                retry(landed, timeout=dt.timedelta(seconds=60))
                assert traced(r"wl_touch@[0-9]+\.down\("), "no touch down"
                assert traced(r"wl_touch@[0-9]+\.touch_motion\("), "the finger never moved"
                assert traced(r"wl_touch@[0-9]+\.touch_frame\(\)"), "no touch frame"
                assert not traced(r"wl_pointer@[0-9]+\.button\("), "the finger was a click too"


            def a_finger_along_the_edge_is_the_windows():
                # Lands in the left edge's band, over the window past the
                # gap, and goes down along the edge: withheld, then replayed.
                before = downs()
                say("drag 30 300 0 200")
                retry(lambda _: downs() > before, timeout=dt.timedelta(seconds=10))


            def resumed():
                return int(machine.succeed(
                    "grep -cE '\\.suspended\\(false\\)' /tmp/client.log || true").strip())


            def a_finger_in_from_the_edge_is_the_shells():
                # An empty workspace 2 hides the window. In from the left edge
                # is the workspace before, which shows it again, and the
                # window never has the finger: `workspace prev_on_output`
                # needs a workspace to step to, as sway's does.
                machine.send_key("meta_l-2")
                retry(lambda _: traced(r"\.suspended\(true\)"), timeout=dt.timedelta(seconds=30))
                before, shown = downs(), resumed()
                say("drag 4 400 300 0")
                try:
                    retry(lambda _: resumed() > shown, timeout=dt.timedelta(seconds=10))
                except Exception:
                    raise AssertionError("the swipe did not change the workspace")
                assert downs() == before, "the window had the shell's finger"


            machine.wait_for_unit("multi-user.target")
            try:
                a_window_is_up()
                a_finger_reaches_the_window_as_touch()
                a_finger_along_the_edge_is_the_windows()
                a_finger_in_from_the_edge_is_the_shells()
            except Exception:
                machine.execute("systemctl stop getty@tty1.service; pkill -u alice; sleep 3")
                # The runner keeps only the tail of this output, so the
                # compositor and engine lines come last.
                for command in [
                    "grep -E 'wl_(pointer|touch)@' /tmp/client.log | tail -10 | cut -c1-160 || true",
                    "grep -E 'FATAL|Check failed|ERROR:.*domicile' /tmp/domicile.log | tail -4 | cut -c1-200 || true",
                    "grep -E 'chrome -> host' /tmp/domicile.log | grep -v activity | tail -6 | cut -c1-200 || true",
                    "grep -iE 'pointers|touchscreens bound' /tmp/domicile.log | tail -6 | cut -c1-200 || true",
                    "grep -E 'suspended' /tmp/client.log | tail -4 | cut -c1-160 || true",
                    "grep -iE 'gesture|workspace' /tmp/domicile.log | tail -6 | cut -c1-200 || true",
                    "grep -E '^\\[' /tmp/domicile.log | grep -iE 'touch|finger|evdev' | tail -12 | cut -c1-200 || true",
                ]:
                    print(f"$ {command}")
                    print(machine.execute(f"{command} 2>&1")[1])
                raise
          '';
        };
      };

      apps.${system} = {
        # `nix run github:cprussin/domicile` runs `domicile`, which takes the
        # shell to run. Use `#manganese` or `#simple` for a bundled desktop.
        default = {
          type = "app";
          program = pkgs.lib.getExe domicilePackage;
          meta.description = domicilePackage.meta.description;
        };
        inherit (domicileApps) manganese simple;
        # No `engine` app: running it would only start bare Chromium. Use
        # `nix build .#engine`.
      } // pkgs.lib.genAttrs [ "npm-claim" "npm-claim-cleanup" ] (name:
        let
          script = pkgs.writeShellApplication {
            inherit name;
            # npm: bun has no `dist-tag` or `unpublish`.
            runtimeInputs = [ pkgs.nodejs_24 pkgs.jq ];
            text = builtins.readFile ./.github/scripts/${name}.sh;
          };
        in
        {
          type = "app";
          program = pkgs.lib.getExe script;
          meta.description =
            {
              npm-claim = "Claim a new @domicile-desktop npm package for publish-packages.yml";
              npm-claim-cleanup = "Remove a claimed npm package's placeholder once CI has published it";
            }.${name};
        });

      devShells.${system} = {
        # Default shell: tools for the pure-logic crates and TypeScript.
        default = pkgs.mkShell {
          packages = coreTools;
          RUST_BACKTRACE = "1";
          FORCE_COLOR = 1;
          # biome resolves its platform binary from here instead of downloading
          # one, so the nix-pinned version is the one turbo runs.
          BIOME_BINARY = pkgs.lib.getExe pkgs.biome;
          shellHook = ''
            echo "domicile dev shell (core) — cargo $(cargo --version 2>/dev/null | cut -d' ' -f2), bun $(bun --version 2>/dev/null)"
          '';
        };

        # Full shell: adds the libraries domicile-compositor needs.
        full = pkgs.mkShell {
          packages = coreTools ++ hostLibs;
          RUST_BACKTRACE = "1";
          FORCE_COLOR = 1;
          BIOME_BINARY = pkgs.lib.getExe pkgs.biome;
          # The EDID vendor table the installed wrapper sets, so `cargo run`
          # names monitor makers the same way.
          DOMICILE_PNP_IDS = "${pkgs.hwdata}/share/hwdata/pnp.ids";
          # `dlopen`ed libraries are not on the loader path from `packages`
          # alone. `/run/opengl-driver/lib` comes first so NixOS uses the EGL
          # matching its kernel driver.
          LD_LIBRARY_PATH =
            "/run/opengl-driver/lib:${pkgs.lib.makeLibraryPath [
              pkgs.libGL
              pkgs.mesa
              pkgs.libgbm
              # winit probes both Wayland and X11 client libraries. Without
              # them it reports `NoWaylandLib` and opens no window.
              pkgs.wayland
              pkgs.libxkbcommon
              pkgs.libx11
              pkgs.libxcursor
              pkgs.libxrandr
              pkgs.libxi
              # libpam for the lock screen, so tests use the same one as the
              # package instead of the host's.
              pkgs.pam
            ]}:${pkgs.lib.makeLibraryPath engineRuntimeLibs}";
          shellHook = ''
            echo "domicile dev shell (full: +wayland +drm +gl)"
          '';
        };
      };
    };
}
