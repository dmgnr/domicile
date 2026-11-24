#!/usr/bin/env bash
# Lays out the `/usr` tree every distribution package is made from.
#
#   packages/distro/stage.sh <binaries> <engine> <bun> <workspace> <rev> <stage>
#
# - <binaries>: the Rust binaries `flake.nix` installs, built by
#   `packages/distro/binaries.sh`.
# - <engine>: the engine release, unpacked: the directory holding `chrome`.
# - <bun>: the bun binary the shell builder runs with. It also installs the
#   builder's modules.
# - <workspace>: a checkout after `packages/distro/build.sh`'s workspace build.
# - <rev>: <workspace>'s commit, whose version the shipped packages carry,
#   unless `DOMICILE_RELEASE=1`, when they carry their own.
# - <stage>: created; `<stage>/usr` is the tree.
#
# The layout is `domicilePackage`'s in `flake.nix` with `/usr` as the prefix,
# so `domicile` finds every part beside itself
# (docs/architecture/THE-DOMICILE-BINARY.md). Machine configuration (PAM,
# limits, AppArmor) differs by distribution and is in `packages/distro/nfpm.yaml`.
set -euo pipefail

[ "$#" -eq 6 ] || {
  echo "usage: stage.sh <binaries> <engine> <bun> <workspace> <rev> <stage>" >&2
  exit 2
}
BINARIES="$1"
ENGINE="$2"
BUN="$3"
WORKSPACE="$4"
REV="$5"
STAGE="$6"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

mapfile -t PROGRAMS < <(grep -v '^#' "$ROOT/packages/distro/programs")
SHELLS=(manganese simple splash)
APP_MODULES=(settings history)

# What `domicile` resolves at run time, and where `PREFIX` puts it.
PREFIX=/usr
USR="$STAGE$PREFIX"
LIBEXEC="$USR/libexec/domicile"
ICONS="$PREFIX/share/domicile/icons"

# Fails naming `what` if `path` is missing.
need() { # path, what
  [ -e "$1" ] || {
    echo "stage.sh: no $2 at $1" >&2
    exit 1
  }
}

for program in "${PROGRAMS[@]}"; do
  need "$BINARIES/$program" "binary $program"
done
# The files `domicileEngine`'s install check requires.
for file in chrome libdomicile_engine.so; do
  need "$ENGINE/$file" "engine file $file"
done
for shell in "${SHELLS[@]}"; do
  need "$WORKSPACE/packages/shell-$shell/.vite/renderer/main_window/shell.js" \
    "built $shell shell"
done
for module in "${APP_MODULES[@]}"; do
  need "$WORKSPACE/packages/app-$module/.vite/app/$module.js" "built $module app"
done
need "$BUN" "bun"

rm -rf "$STAGE"
mkdir -p "$USR/bin" "$LIBEXEC/shells" "$LIBEXEC/app-modules"

# Copies, not symlinks: `domicile` finds its siblings from `current_exe`.
for program in "${PROGRAMS[@]}"; do
  install -m 755 "$BINARIES/$program" "$USR/bin/$program"
done

# `man domicile` and `man domicile-<command>`, as in `flake.nix`.
"$USR/bin/domicile" help --man "$USR/share/man/man1"

# Unmodified. On a distribution, `libEGL.so.1` and the GSettings schemas are on
# the default paths, so the engine needs no wrapper, unlike in `flake.nix`.
cp -a "$ENGINE" "$LIBEXEC/engine"

# What `domicile --version` prints first, as `domicilePackage` in `flake.nix`.
VERSION="$(jq -er .version "$WORKSPACE/packages/domicile/package.json")"
printf 'domicile %s\ncommit   %s\n' "$VERSION" "$REV" >"$LIBEXEC/version"

install -m 755 "$BUN" "$LIBEXEC/bun"
install -m 755 "$ROOT/packages/distro/builder" "$LIBEXEC/builder"
install -m 755 "$ROOT/packages/distro/electron-host" "$LIBEXEC/electron-host"

# What the builder and `electron-host` need, as in `shellWorkspace` in
# `flake.nix`.
"$ROOT/packages/distro/shell-workspace.sh" modules "$BUN" "$WORKSPACE" "$LIBEXEC/workspace"
"$ROOT/packages/distro/shell-workspace.sh" files "$BUN" "$WORKSPACE" "$LIBEXEC/workspace"
# A release ships the versions changesets gave the packages.
if [ "${DOMICILE_RELEASE:-}" != 1 ]; then
  "$ROOT/packages/distro/stamp-version.sh" "$REV" "$LIBEXEC"/workspace/packages/*/package.json >/dev/null
fi

for shell in "${SHELLS[@]}"; do
  cp -a "$WORKSPACE/packages/shell-$shell/.vite/renderer/main_window" \
    "$LIBEXEC/shells/$shell"
done
for module in "${APP_MODULES[@]}"; do
  cp -a "$WORKSPACE/packages/app-$module/.vite/app" "$LIBEXEC/app-modules/$module"
done

# Fills `@bin@`, `@icon@` and `@preview@` in a template from `packages/distro/nix/`, as
# `substitute` does in `flake.nix`.
fill() { # template, destination, icon name
  local icon="${3:-}"
  mkdir -p "$(dirname "$2")"
  sed -e "s|@bin@|$PREFIX/bin|g" \
    -e "s|@icon@|$ICONS/$icon.svg|g" \
    -e "s|@preview@|$ICONS/$icon-preview.svg|g" \
    "$1" >"$2"
}

fill "$ROOT/packages/distro/share/domicile-session.desktop" "$USR/share/wayland-sessions/domicile.desktop"
fill "$ROOT/packages/distro/share/domicile-open-url.desktop" "$USR/share/applications/domicile-open-url.desktop"
install -D -m 644 "$ROOT/packages/distro/share/domicile-mimeapps.list" \
  "$USR/share/applications/domicile-mimeapps.list"

# The launcher's entries for Domicile's own programs.
mkdir -p "$STAGE$ICONS"
launcher() { # id, directory holding <id>.svg and <id>-preview.svg
  cp "$2/$1.svg" "$2/$1-preview.svg" "$STAGE$ICONS/"
  fill "$ROOT/packages/distro/share/launcher/domicile-$1.desktop" \
    "$USR/share/applications/domicile-$1.desktop" "$1"
}
launcher history "$WORKSPACE/packages/app-history/icons"
launcher settings "$WORKSPACE/packages/app-settings/icons"
launcher screenshot "$ROOT/packages/distro/share/launcher"
launcher screen-record "$ROOT/packages/distro/share/launcher"
launcher shutdown "$ROOT/packages/distro/share/launcher"
launcher reboot "$ROOT/packages/distro/share/launcher"
launcher logout "$ROOT/packages/distro/share/launcher"

fill "$ROOT/packages/distro/share/net.domicile.Miracast.service" \
  "$USR/share/dbus-1/services/net.domicile.Miracast.service"
fill "$ROOT/packages/distro/share/domicile-miracast.service" \
  "$USR/lib/systemd/user/domicile-miracast.service"

install -D -m 644 "$ROOT/packages/distro/share/domicile.portal" \
  "$USR/share/xdg-desktop-portal/portals/domicile.portal"
install -D -m 644 "$ROOT/packages/distro/share/domicile-portals.conf" \
  "$USR/share/xdg-desktop-portal/domicile-portals.conf"
install -D -m 644 "$ROOT/packages/distro/share/domicile-session.target" \
  "$USR/lib/systemd/user/domicile-session.target"
install -D -m 644 "$ROOT/packages/distro/share/domicile-session-shutdown.target" \
  "$USR/lib/systemd/user/domicile-session-shutdown.target"
install -D -m 644 "$ROOT/packages/distro/sysusers.conf" "$USR/lib/sysusers.d/domicile.conf"

install -D -m 644 "$ROOT/LICENSE" "$USR/share/doc/domicile/LICENSE"
install -D -m 644 "$ROOT/packages/domicile-engine/LICENSE.chromium" \
  "$USR/share/doc/domicile/LICENSE.chromium"
