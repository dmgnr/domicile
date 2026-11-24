# Install

One package has all of Domicile:

- `domicile`, which runs a shell, in a window or on the whole screen
- the **Domicile** login session
- manganese, the reference shell
- React and the `@domicile-desktop/*` packages a shell builds against

Install it from your distribution's package manager, or with Nix.

Domicile runs on `x86_64` Linux and runs Wayland apps. X11 apps run through
[xwayland-satellite](use/COMPATIBILITY.md#x11-apps). GPUs, distributions and what is checked:
[What it runs on](use/COMPATIBILITY.md).

<!-- tab: Debian and Ubuntu -->

Debian 13+ and Ubuntu 24.04+. On Debian 12 and Ubuntu 22.04, write `legacy`
in place of `current`.

```sh
sudo curl -fsSL -o /etc/apt/keyrings/domicile.asc https://packages.domicile-desktop.com/domicile.asc
echo "deb [signed-by=/etc/apt/keyrings/domicile.asc] https://packages.domicile-desktop.com/apt current main" |
  sudo tee /etc/apt/sources.list.d/domicile.list
sudo apt update && sudo apt install domicile
```

<!-- tab: Fedora -->

Fedora and RHEL 10+.

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

<!-- tab: openSUSE -->

openSUSE Tumbleweed.

```sh
sudo rpm --import https://packages.domicile-desktop.com/domicile.asc
sudo zypper addrepo --gpgcheck https://packages.domicile-desktop.com/rpm/opensuse domicile
sudo zypper install domicile
```

<!-- tab: Arch -->

Install `domicile-bin` from the AUR, or add the repository:

```sh
curl -fsSL -o domicile.asc https://packages.domicile-desktop.com/domicile.asc
sudo pacman-key --add domicile.asc
sudo pacman-key --lsign-key "$(gpg --show-keys --with-colons domicile.asc | awk -F: '/^fpr/ {print $10; exit}')"
printf '[domicile]\nServer = https://packages.domicile-desktop.com/arch/$arch\n' |
  sudo tee -a /etc/pacman.conf
sudo pacman -Syu domicile
```

<!-- tab: NixOS -->

Add the flake to your system and home configurations. A complete flake that
does it: [`examples/nixos`](/examples/nixos).

```nix
# configuration.nix
{
  imports = [domicile.nixosModules.default];
  programs.domicile.enable = true;
  services.displayManager.defaultSession = "domicile";

  nix.settings = {
    substituters = [ "https://packages.domicile-desktop.com/nix" ];
    trusted-public-keys = [ "packages.domicile-desktop.com-1:iAulr298MtC52WMi2GPI8bqPEvOXHoQtSRAGOo0ny90=" ];
  };
}
```

```nix
# home.nix
{
  imports = [domicile.homeManagerModules.default];
  programs.domicile = {
    enable = true;
    # manganese, or your own shell's built module.
    shell = "${domicile.packages.${system}.manganese}/shell.js";
  };
}
```

The system module adds the login session, the password check for the lock
screen, battery and casting support. The home module writes your
[config file](SHELL-CONFIG.md#home-manager).

`nix.settings` adds Domicile's binary cache, so a rebuild downloads Domicile
instead of compiling it. The cache holds every `release` and `stable` commit.

<!-- /tabs -->

Your package manager keeps Domicile up to date. The repositories hold the
three newest releases. This is the same install as manganese's
([Install manganese](use/INSTALL.md)).

## After installing

On every distribution but NixOS:

1. Name the shell the login session runs in `~/.config/domicile/domicile.json`:
   manganese, as here, or your own
   ([The config file](SHELL-CONFIG.md#where-it-is)).

   ```json
   { "shell": "@domicile-desktop/manganese" }
   ```

2. Log out, and pick **Domicile** in your login screen.

You don't need the login session to write a shell: `domicile ./shell.tsx`
runs one in a window on your current desktop. Start with the
[Shell quickstart](SHELL-QUICKSTART.md).

## Try it first

With [Nix](https://nixos.org/download), run manganese in a window on your
current desktop, with nothing installed:

```sh
nix run github:cprussin/domicile/release#manganese
```

`nix run` installs nothing on the system, so the password check the lock
screen uses (`/etc/pam.d/domicile`) is missing. Without it the screen doesn't
lock, not even when the machine sleeps, and a notification says so. To lock,
install a package or add the file ([LOCK.md](LOCK.md#verifiers)).

## The newest build

Packages of the newest `stable` build, before it is released, and Nix on
another distribution: [Install manganese](use/INSTALL.md#the-newest-build) and
[RUNNING-A-DESKTOP.md](RUNNING-A-DESKTOP.md).
