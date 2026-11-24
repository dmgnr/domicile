# Running a desktop

How to run, install and configure a Domicile desktop, in detail. For a
friendlier start, read the [user guide](use/README.md). You need a
[package for your distribution](#other-distributions) or [Nix](#on-nixos),
and either a Wayland session or a console login.

```sh
domicile @domicile-desktop/manganese      # tiling, sway's keys, address bar
domicile @domicile-desktop/shell-simple   # floating windows only
```

With Nix, run either without installing:

```sh
nix run github:cprussin/domicile/release#manganese
nix run github:cprussin/domicile/release#simple
```

- `release` is the newest release. `/stable` runs the newest `main` built
  with the production engine (PGO, ThinLTO, no DCHECKs); drop the branch to
  run `main`, which uses a slower checked engine after an engine change until
  the nightly build is pinned.
  A checked engine posts a "This is a development build" notification whose
  "How to switch" button opens the install docs.
- With Nix, each desktop is its own app. Install one with
  `nix profile install`.
- `/release` and `/stable` download from Domicile's binary cache instead of
  building. `nix run` asks to trust it if you are in `trusted-users`; a NixOS
  config trusts it for everyone with:

  ```nix
  nix.settings = {
    substituters = [ "https://packages.domicile-desktop.com/nix" ];
    trusted-public-keys = [ "packages.domicile-desktop.com-1:iAulr298MtC52WMi2GPI8bqPEvOXHoQtSRAGOo0ny90=" ];
  };
  ```
- In a Wayland session the desktop opens in a window. On a console login it
  takes the screen; no setting is needed
  ([how](/docs/architecture/A-DESKTOP-ON-A-TTY.md)).
- The packages and the flake ship a prebuilt engine, so you do not build
  Chromium ([how](/packages/domicile-engine/README.md#using-a-prebuilt-engine)).
- Each desktop documents its own keys and settings:
  [simple](/packages/shell-simple/README.md),
  [manganese](/packages/shell-manganese/README.md).
- Clients that draw in software are copied into a GPU buffer. This is checked
  on NVIDIA's driver and llvmpipe, not on Mesa hardware drivers
  ([status](/docs/architecture/WINDOW-COMPOSITING.md#wl_shm-clients-on-a-gpu)).
- A tty desktop on a card with no 3D composites on the CPU
  ([how](/docs/architecture/A-DESKTOP-ON-A-TTY.md#software-output)).
- To run your own shell: `domicile ./dist/shell.js`.
  See [WRITING-A-SHELL.md](/docs/WRITING-A-SHELL.md).

Settings live in `~/.config/domicile/domicile.json` (or `.ts`/`.js`). Reference:
[SHELL-CONFIG.md](SHELL-CONFIG.md).

## Launch an app into it

- Domicile prints `XDG_RUNTIME_DIR` and `WAYLAND_DISPLAY` at startup. Set both
  to start any Wayland client on the desktop.
- `simple`: Alt+Enter opens a terminal. More:
  [shell-simple](/packages/shell-simple/README.md#launch-an-app-into-it).
- manganese has no launch binding by default. Add one that `exec`s your
  launcher or terminal.
- Apps started from the desktop's terminal or launcher run on the desktop.
- `startup.commands` lists programs to start with the desktop, each as an argv.
  They run once at startup, not on reload.

```json
{ "startup": { "commands": [["emacsclient", "-e", "t"], ["sh", "-c", "mako >/dev/null"]] } }
```

### Each app gets its own scope

- A desktop that is the login session starts each app it launches (keys,
  launcher, `startup.commands`, the portal's mail client) through
  `systemd-run --user --scope`, in `app.slice`, named
  `app-domicile-<program>-<random>.scope`.
- The desktop stays in the login session's cgroup and the apps move to the
  user manager's. The kernel shares CPU between those before it looks at nice
  values, so a build in a terminal cannot take the desktop's share.
- This needs `systemd-run` on `PATH` and a systemd user manager on the session
  bus. Without one, the launcher says so and apps start in the desktop's
  cgroup. A nested desktop leaves its apps to the host session.
- An app's own children stay in its scope: `systemctl --user status` shows them
  under it.
- Each scope is `PartOf=graphical-session.target`: when the desk's session
  ends, its apps stop, daemons they left behind (such as `emacs --daemon`)
  included.

### Links open on the desktop

- Apps get `BROWSER=domicile-open-url`, which opens the URL in a desktop
  browser window.
- Apps get Domicile's `xdg-open` first on `PATH`. It runs `domicile open`,
  so files open as the launcher opens them, and web links on the desktop.
- GTK apps (via GIO) read `domicile-mimeapps.list`, which Domicile puts first
  on `XDG_DATA_DIRS`. A browser you set in your own `mimeapps.list` still
  wins.
- PDFs, images and videos open in a desktop browser window too, through the
  same `domicile-mimeapps.list`. A default of your own for the type still
  wins.
- A desktop that is the login session starts `domicile-session.target`, so the
  portal runs. Through it, Flatpak apps open links on the desktop and get the
  theme.
- `domicile open <file|url>` does the same from a terminal on the desktop.
  A file or folder opens with its type's default (see
  [LAUNCHER.md](LAUNCHER.md#opening-files)). `domicile open --app <url>`
  opens a site as an app, without an address bar
  ([WEB-APPS.md](architecture/WEB-APPS.md)). `domicile install-app <url>`
  adds a site to your applications from its web app manifest.
  `domicile uninstall-app <url>` removes it, given the same address.

## Screenshots

Run these from a terminal on the desktop. Both are refused while the desk is
locked.

- **`domicile screenshot`** opens the shell's screenshot picker, as the
  shell's screenshot key does (Print in manganese). Pick a monitor, a window
  or an area. The PNG goes under `$XDG_PICTURES_DIR/Screenshots/` and its path
  is printed. Ctrl+C in the picker copies the pick to the clipboard instead,
  saves nothing and prints `domicile: the screenshot was copied to the
  clipboard`. Dismissing the picker prints
  `domicile: the screenshot was canceled` and exits 1. It waits as long as
  the picker is open. With a shell that answers no portal requests, it waits
  until the desktop exits, and Ctrl-C does not withdraw the request.
- **`domicile screenshot <file>`** writes a PNG of the whole desk, every
  monitor at the highest density, to `<file>` and prints its path.

## Screen recordings

**`domicile screen-record`**, or Screen Record in the launcher, opens the
shell's screen cast picker. Pick a monitor, a window or an area, and it
records, with its sound, until the toolbar's Stop. The toolbar also pauses,
resumes and discards it, and is left out of the recording. The WebM goes
under `$XDG_VIDEOS_DIR/Screen recordings/` and its path is printed. Dismissing
the picker or discarding prints `domicile: the screen recording was
canceled` and exits 1. Refused while the desk is locked. See
[PORTALS.md](PORTALS.md#screen-recording).

## Shell commands

`domicile send-shell <word>…` runs a shell command from a terminal on the
desktop, as a keybinding bound to it does. `domicile send-shell focus right`
moves focus right in manganese, like Meta+l.

- Every word after `send-shell` is the command. The shell's README lists its
  commands; manganese's are in [KEYS.md](../packages/manganese-window-management/docs/KEYS.md#commands).
- Every page of the desktop hears it.
- It fails when no page listens for commands, and while the desk is locked.
- It exits 0 once the pages have the command. The shell does not report
  whether it knew it.

## Disable while typing

On a tty, typing suppression pauses a touchpad while a keyboard types. Turn
it off for games that use the keyboard and the touchpad together:

```sh
domicile disable-while-typing off     # or on, or toggle
domicile disable-while-typing         # prints on or off
```

- Each prints the setting after it.
- On by default. The [touchpad config](SHELL-CONFIG.md#touchpads-and-mice) selects
  native libinput behavior or a custom pause. A touchpad or mouse settings
  edit, or an engine restart, restores the configured enabled state.
- `disable_while_typing: "libinput"` preserves libinput's paired keyboards,
  contact lifetime and physical button behavior, as in Sway. Touchpads without
  native typing suppression, normally including external Magic Trackpads,
  stay available. Libinput owns its timers, so `typing_pause_ms` and
  `typing_repeat_pause_ms` must keep the defaults `200` and `500` in this mode.
- Custom `enabled` (the default) and `internal` modes pause motion, scrolling,
  taps and new clicks. `enabled` covers all touchpads; `internal` covers
  built-in pads. Any keyboard counts. A key pauses them for 200 ms, and
  continued typing for 500 ms. Both durations are configurable, including
  zero. Continued typing means another typing key within 200 ms or during an
  active pause.
- In custom modes, modifiers, F-keys, media and navigation keys rest nothing,
  nor do keys pressed with Ctrl, Alt or Super held. Shift+letter is typing.
  Motion while a touchpad button is held is a drag and always passes.
- Settings edits clear custom pauses and typing history. In native mode,
  libinput retains contact state; a suppressed contact can remain suppressed
  until the fingers lift.
- A nested desktop refuses the command: the host compositor reads the
  touchpad. Use its setting.

## Theme

`domicile theme` switches the desktop between light and dark from a terminal,
as the shell's toggle does:

```sh
domicile theme toggle     # or light, or dark
domicile theme            # prints light or dark
```

- Each prints the theme after it.
- The compositor owns the theme, so it works with any shell, and while the
  desk is locked.
- It lasts until the desktop restarts. Set `theme.mode` in the
  [config](SHELL-CONFIG.md#theme) to keep it.

## Host shortcuts in a window

A nested desktop needs the Meta key, which your host compositor also uses.

- While the desktop's window has keyboard focus, it requests
  `zwp_keyboard_shortcuts_inhibit_unstable_v1`. The host then passes its key
  bindings through to the desktop.
- When the window loses focus, the host's bindings work again.
- On sway, mark bindings you need while the desktop is focused with
  `--inhibited`:

```
bindsym --inhibited XF86AudioRaiseVolume exec wpctl set-volume @DEFAULT_SINK@ 5%+
bindsym --inhibited Mod4+Shift+q kill
```

- `seat * shortcuts_inhibitor disable` turns inhibiting off in sway. The
  nested desktop then gets no Meta chords.
- A host without the protocol keeps its bindings. The engine logs this.
- The inhibitor covers keys only. sway's `floating_modifier` drag still moves
  the desktop's own window. Use another modifier in sway, such as
  `floating_modifier Mod1 normal`, to drag windows inside the desktop.
- On a console login there is no host, so none of this applies.

## Pointer settings on a tty

Set `input.touchpad` and `input.mouse` in the
[config](SHELL-CONFIG.md#touchpads-and-mice) for tap and click behavior, natural
scrolling, pointer acceleration, scrolling speed and the typing pause.
Settings apply on reload, device attachment, Bluetooth reconnection and a
return from another console. A nested desktop uses its host compositor's
settings; headless and EIS input do not pass through libinput.

## Engine flags

`DOMICILE_ENGINE_ARGS` adds switches to the engine's command line, split on
whitespace: `DOMICILE_ENGINE_ARGS='--log-level=0 --enable-features=Vulkan'`.

- Its `--enable-features` and `--disable-features` values join the launcher's,
  so the built-in `LibinputHandleTouchpad,LibinputHandleMouse` stay on. A
  feature in both lists is disabled.
- Every other switch goes after the launcher's, and the last copy of a switch
  wins.

### GPU flags

The launcher passes no GPU flags, so the engine runs with Chromium's Linux
defaults. None of the flags below is known to be safe on every Mesa, Intel,
AMD and NVIDIA driver, so each is opt-in:

| Flag | Effect | Caveat |
|---|---|---|
| `--enable-gpu-rasterization` | Rasters tiles on the GPU. | Off on Linux unless the build enables `DefaultEnableGpuRasterization`. Overrides the blocklist. |
| `--enable-zero-copy` | Rasters into the GPU buffer, skipping the upload copy. | Off outside ChromeOS. |
| `--enable-features=Vulkan` | Skia draws with Vulkan, which also turns on GPU rasterization. | tty only: Chromium refuses Vulkan with `--ozone-platform=wayland`. |
| `--ignore-gpu-blocklist` | Turns on what the blocklist turns off for your driver. | The blocklist lists driver bugs. Read which entry matched first. |

Domicile's browser windows refuse `chrome://` pages, so check what a flag did
in the pinned engine run as a browser, nested:

```sh
nix build .#engine
./result/chrome --ozone-platform=wayland --user-data-dir="$(mktemp -d)" <flags> chrome://gpu
```

- **Graphics Feature Status** shows `Rasterization`, `Vulkan` and the Skia
  backend.
- **Problems Detected** lists the blocklist entries that matched your driver.
- Vulkan cannot be checked this way, since it needs a tty.

## The launcher

The launcher searches files in your home, desktop entries and bookmarks.
Configure it with `files.omit` and manganese's `applications` option:
[LAUNCHER.md](LAUNCHER.md).

## Blanking and locking

```json
{ "idle": { "blank_after_seconds": 600, "lock_after_seconds": 900 } }
```

- Screens turn off after `idle.blank_after_seconds` without input. Unset never
  blanks. `0` is an error.
- Apps playing video can keep the screens on.
- The desktop locks after `idle.lock_after_seconds` without input, on its own
  clock from blanking. Unset locks only when the shell asks. Your password
  unlocks it.
- The password is checked by the PAM service `domicile` (`lock.pam_service`
  names another). The machine declares it: use the
  [NixOS module](#the-machines-half) or add
  `security.pam.services.domicile = {};`. A home-manager module cannot. The
  [distribution packages](#other-distributions) install it. Elsewhere, add
  `/etc/pam.d/domicile` ([LOCK.md](LOCK.md#verifiers)). Without it the desktop
  does not lock, since nothing could unlock it. A notification says so, and
  the log names the file to add.
- A `lock` edit applies on reload. It never unlocks a locked desktop
  ([LOCK.md](LOCK.md#reloading)).

Reference: [idle](SHELL-CONFIG.md#idle), [lock](SHELL-CONFIG.md#lock). Design:
[IDLE.md](IDLE.md), [LOCK.md](LOCK.md). Known gaps: [KNOWN-GAPS.md](/docs/KNOWN-GAPS.md).

## Thread priorities

The threads every frame and input event pass through ask for nice -8, so the
desktop stays smooth while the machine is busy.

| Process | Threads | How |
|---|---|---|
| compositor | the Wayland thread; `domicile-engine`, the engine library's IO thread | `setpriority`, then rtkit's `MakeThreadHighPriority` |
| engine | the threads that draw and present frames | `setpriority`, then rtkit's `MakeThreadHighPriorityWithPID` from the browser process; the page-flip thread asks for `SCHED_RR` 6 |

- `setpriority` to -8 needs an `RLIMIT_NICE` of at least 28, or
  `CAP_SYS_NICE`. Most sessions have 0.
- **rtkit** raises a thread the limits refuse. The NixOS module enables it,
  and the distribution packages recommend it. It grants each user 25 requests
  per 20 seconds, so a burst of new engine threads, such as several pages
  opening at once, can be refused.
- **The `domicile` group** grants the limits, so every raise succeeds and
  `SCHED_RR` works. Join it on NixOS with
  `users.users.<you>.extraGroups = ["domicile"]`, and with the packages with
  `sudo usermod -aG domicile "$USER"`. Elsewhere, grant the same limits in
  `/etc/security/limits.d/10-domicile.conf` and log in again:

  ```
  @domicile - nice -10
  @domicile - rtprio 8
  ```

- **Home Manager alone** cannot grant limits or enable rtkit; both are system
  configuration.
- Without either, the compositor logs `could not raise the thread to nice -8`
  once per thread, and the engine logs `rtkit did not raise thread` once.
  Those threads run at the nice value they started at.
- Apps and the shell's processes start at the compositor's starting nice
  value, not at -8.
- Threads the Wayland thread starts after it is raised (clipboard copies, the
  lock's passphrase check) inherit -8. The service threads started before it
  do not.
- `domicile` does not raise the soft `RLIMIT_NICE` to the hard one: pam_limits
  (`-`) and systemd's `LimitNICE=` set both together, so there is nothing to
  raise.

## On NixOS

`homeManagerModules.default` writes the config and sets the shell. It
installs no login session and no PAM service; those are the
[machine's half](#the-machines-half). See
[SHELL-CONFIG.md](SHELL-CONFIG.md#home-manager) for its options, and
[SHELL-CONFIG.md](SHELL-CONFIG.md#displays) for monitor profiles.

### The machine's half

`nixosModules.default` goes in the system configuration:

```nix
{
  imports = [domicile.nixosModules.default];

  programs.domicile.enable = true;
  services.displayManager.defaultSession = "domicile";
}
```

It provides:

- **The `domicile` login session.** It runs the shell your config names, so one
  session serves every desktop. Without the module,
  `services.displayManager.sessionPackages = [domicile]` adds it.
- **The `domicile` PAM service**, which unlocks the desktop.
- **rtkit**, and **the `domicile` group**. Both raise the desktop's threads;
  the group's limits never refuse. See
  [Thread priorities](#thread-priorities). Join the group with
  `users.users.<you>.extraGroups = ["domicile"]` and log in again.
- **UPower**, which the battery readout reads. Without it, manganese shows no
  battery. Set `services.upower.enable = false` to opt out.
- **Casting to Miracast TVs**: TCP port 7236 open, which a TV connects back
  to, and Avahi, which finds TVs on the LAN. TVs over Wi-Fi Direct also need
  NetworkManager with `wpa_supplicant`, NixOS's default. Set
  `programs.domicile.miracast = false` to opt out.
- **`domicile-session.target`**, started by a desktop that is the session. User
  services bound to `graphical-session.target` and `~/.config/autostart`
  entries start with it. The package is also on the system profile, so the
  portal finds `domicile-mimeapps.list`.
- **A build check that Domicile loads your graphics driver**, when
  `hardware.graphics.enable` is set. The compositor and the engine load the
  driver in `/run/opengl-driver` with Domicile's own glibc, so a driver from a
  newer nixpkgs does not load and the desktop draws without the graphics card.
  The check fails the system build instead. Fix it by building Domicile from
  your nixpkgs:

  ```nix
  inputs.domicile.inputs.nixpkgs.follows = "nixpkgs";
  ```

- **Portal routing**, when `xdg.portal.enable` is set. Domicile is the only
  backend and the shell draws every dialog. `domicile-portals.conf` sends
  `Secret` to `gnome-keyring`, which you install (`oo7-portal` works too).
  The home-manager module offers the same for home-manager's `xdg.portal`.

It does not enable a display manager or set the default session.

## Other distributions

Domicile is packaged for Debian, Ubuntu, Fedora, openSUSE and Arch, two ways:

- **[Releases](#from-the-package-repositories)**, from signed package
  repositories and the AUR. Your package manager upgrades them.
- **[Each `stable` commit](#a-stable-commit)**, as packages you download. They
  run the same desktop as the newest `stable` commit.

### From the package repositories

The repositories at `https://packages.domicile-desktop.com` hold the three
newest releases, signed by the key at
[`domicile.asc`](https://packages.domicile-desktop.com/domicile.asc).

Until 1.0.0 they hold prereleases (`1.0.0~pre.<date>.<time>`; `1.0.0pre…` on
Arch). They upgrade in place to 1.0.0.

**Debian 13+, Ubuntu 24.04+** (`legacy` instead of `current` on Debian 12 and
Ubuntu 22.04):

```sh
sudo curl -fsSL -o /etc/apt/keyrings/domicile.asc https://packages.domicile-desktop.com/domicile.asc
echo "deb [signed-by=/etc/apt/keyrings/domicile.asc] https://packages.domicile-desktop.com/apt current main" |
  sudo tee /etc/apt/sources.list.d/domicile.list
sudo apt update && sudo apt install domicile
```

**Fedora, RHEL 10+:**

```sh
sudo tee /etc/yum.repos.d/domicile.repo <<'REPO'
[domicile]
name=Domicile
baseurl=https://packages.domicile-desktop.com/rpm/fedora
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://packages.domicile-desktop.com/domicile.asc
REPO
sudo dnf install domicile
```

**openSUSE Tumbleweed:**

```sh
sudo rpm --import https://packages.domicile-desktop.com/domicile.asc
sudo zypper addrepo --gpgcheck https://packages.domicile-desktop.com/rpm/opensuse domicile
sudo zypper install domicile
```

**Arch:** `domicile-bin` on the AUR, or the repository:

```sh
curl -fsSL -o domicile.asc https://packages.domicile-desktop.com/domicile.asc
sudo pacman-key --add domicile.asc
sudo pacman-key --lsign-key "$(gpg --show-keys --with-colons domicile.asc | awk -F: '/^fpr/ {print $10; exit}')"
printf '[domicile]\nServer = https://packages.domicile-desktop.com/arch/$arch\n' |
  sudo tee -a /etc/pacman.conf
sudo pacman -Syu domicile
```

Then [finish the install](#after-installing).

### A `stable` commit

Each commit `stable` moves to replaces the packages in
[`packages-latest`](https://github.com/cprussin/domicile-builds/releases/tag/packages-latest),
under fixed names, so the commands below always fetch the newest.

Download your distribution's package and `SHA256SUMS`, and check the package:

```sh
base=https://github.com/cprussin/domicile-builds/releases/download/packages-latest
pkg=domicile_amd64.deb   # your package from the table below
curl -fL -O "$base/$pkg" -O "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
```

Then install it:

| Distribution | Install |
|---|---|
| Debian 13+, Ubuntu 24.04+ | `sudo apt install ./domicile_amd64.deb` |
| Debian 12, Ubuntu 22.04 | `sudo apt install ./domicile_amd64.noapparmor.deb` |
| Fedora, RHEL 10+ | `sudo dnf install ./domicile-fedora.x86_64.rpm` |
| openSUSE Tumbleweed | `sudo zypper install --allow-unsigned-rpm ./domicile-opensuse.x86_64.rpm` |
| Arch | `sudo pacman -U ./domicile-x86_64.pkg.tar.zst` |

### After installing

1. Name a shell in `~/.config/domicile/domicile.json`:
   `{ "shell": "@domicile-desktop/manganese" }`.
2. Log out and pick the **Domicile** session in your display manager.

The package installs what [the NixOS module](#the-machines-half) provides:

- **Domicile:** `/usr/bin/domicile` and its programs, and under
  `/usr/libexec/domicile` the engine, the prebuilt shells and apps, and the
  bun the shell builder runs on.
- **The `domicile` session** (`/usr/share/wayland-sessions/domicile.desktop`)
  and its user units.
- **`/etc/pam.d/domicile`**, which unlocks the desktop. It includes
  the distribution's stack: `common-auth` on Debian and openSUSE,
  `password-auth` on Fedora, `system-local-login` on Arch.
- **The `domicile` group** (`/usr/lib/sysusers.d/domicile.conf`) and its
  [limits](#thread-priorities) (`/etc/security/limits.d/10-domicile.conf`).
- **Portal routing:** Domicile's backend and `domicile-portals.conf`. `Secret`
  goes to `gnome-keyring`, which you install.
- **On Ubuntu 24.04+, an AppArmor profile** that lets the engine's sandbox
  make user namespaces. Without it the engine does not start. The
  `noapparmor` package has none: Debian 12 and Ubuntu 22.04 do not restrict
  user namespaces, and their AppArmor predates the profile's `userns` rule.
- **Shutdown, Reboot and Logout** launcher entries, which ask in Domicile's
  dialog first.
- **Recommended** (optional on Arch): UPower (the battery readout), rtkit
  ([thread priorities](#thread-priorities)), hwdata (monitor makers), `pactl`
  (the volume readout), curl, `xdg-desktop-portal`.

Upgrade a `stable` package by downloading and installing it again.

### Nix on another distribution

`nix profile install github:cprussin/domicile/release#domicile` installs
Domicile without the machine's half. Add it by hand, from this repository:

- **Session:** `packages/distro/share/domicile-session.desktop` as
  `/usr/local/share/wayland-sessions/domicile.desktop`, with `@bin@` replaced
  by your profile's `bin` as an absolute path (`/home/<you>/.nix-profile/bin`).
- **PAM:** your distribution's file from `packages/distro/pam/` as
  `/etc/pam.d/domicile`.
- **Group and limits:** `packages/distro/sysusers.conf` as
  `/etc/sysusers.d/domicile.conf` (then `sudo systemd-sysusers`), and
  `packages/distro/limits.conf` as `/etc/security/limits.d/10-domicile.conf`.
- **User units:** link `~/.nix-profile/lib/systemd/user/domicile-*.target`
  into `~/.config/systemd/user/`.
