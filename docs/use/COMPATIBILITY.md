# What it runs on

Domicile runs on 64-bit x86 Linux (`x86_64`). Every published build is
`x86_64` only: the distribution packages, the AUR package and the Nix flake's
prebuilt engine. There are no ARM builds.

## Distributions

| Distribution | Package | Installed in CI |
|---|---|---|
| Debian 13, Ubuntu 24.04 | `.deb`, `current` | yes |
| Debian 12, Ubuntu 22.04 | `.deb`, `legacy` | yes |
| Fedora | `.rpm` | yes (Fedora 44) |
| RHEL 10 | the Fedora `.rpm` | no |
| openSUSE Tumbleweed | `.rpm` | yes |
| Arch | `pacman` repository or `domicile-bin` (AUR) | yes |
| NixOS, or Nix anywhere | the flake | builds and VM tests |

"Installed in CI" means `distro-packages-install.sh` installs the package in
that distribution's container for every release and every change to the
packaging. Steps: [Install](INSTALL.md).

## Apps

- Wayland apps run. Electron, SDL and Qt apps are started in Wayland mode.
- Electron apps can run on the desktop's browser instead:
  [Electron apps](ELECTRON-APPS.md).
- Apps that only speak X11 run through xwayland-satellite: [X11 apps](#x11-apps).
- Which apps are checked: [Apps we check](FIRST-STEPS.md#apps-we-check).

## X11 apps

Domicile has no Xwayland of its own. Run
[xwayland-satellite](https://github.com/Supreeeme/xwayland-satellite) to open
apps that only speak X11. Their windows open like any other.

1. Install `xwayland-satellite` from your distribution's packages. If it isn't
   packaged, build it from its repository.
2. Start it when you log in, as in the steps below.
3. Start each X11 app with `DISPLAY` set to the same display:
   `env DISPLAY=:12 xeyes`.

<!-- tab: Settings app -->

Open **Settings**, then **Startup**, and add the command
`xwayland-satellite :12`.

<!-- tab: Config file -->

```json
{ "startup": { "commands": [["xwayland-satellite", ":12"]] } }
```

<!-- tab: NixOS -->

In your home configuration:

```nix
home.packages = [ pkgs.xwayland-satellite ];
programs.domicile.settings.startup.commands = [ [ "xwayland-satellite" ":12" ] ];
```

<!-- /tabs -->

- `:12` is any free display number.
- Domicile starts apps without `DISPLAY`, so apps that speak both choose
  Wayland. To start an X11 app from the launcher, copy its `.desktop` file to
  `~/.local/share/applications` and start its `Exec=` line with
  `env DISPLAY=:12`.

## GPUs

| GPU | Status |
|---|---|
| NVIDIA, proprietary driver (GTX 970) | Checked by CI on every engine build, with no monitor attached. The docs' screenshots and videos are taken on it |
| AMD (Radeon 890M, Framework 13) | In daily use on a console login, with monitors through a dock |
| Intel | Tested by hand |
| No GPU | Runs: nested on llvmpipe, and on a console login the desktop draws on the CPU ([how](../architecture/A-DESKTOP-ON-A-TTY.md#software-output)) |

Gaps that can show on a first run:

- **What reaches a lit screen is unmeasured.** Every automated check reads the
  frame back before it is shown.

A blank screen or a display that won't light: [GPU and display
issues](../TTY-DEBUGGING.md). Everything else not done yet: [Known
gaps](../KNOWN-GAPS.md).
