#!/usr/bin/env bash
# Runs a shell in Domicile and reloads it on every rebuild.
#
#   packages/dev-shell/bin/dev-shell.sh manganese
#   bun run --filter @domicile-desktop/manganese start:dev
#
# Starts the engine, compositor and shell as `nix run .#manganese` does. The
# shell's vite rebuilds the page on save, and `dev-shell-reload.sh` hands each
# build to the running desktop with `domicile load-shell`. Windows survive a
# reload.
#
# The engine is the one the flake pins, since building Chromium takes hours.
# The compositor and runner are built from this checkout.
set -u

# Resolved, because shells run it through their `node_modules/.bin` link.
ROOT="$(cd "$(dirname "$(realpath "$0")")/../../.." && pwd)"
SHELL_NAME="${1:-}"
if [ -z "$SHELL_NAME" ]; then
  echo "usage: dev-shell.sh <shell>   e.g. dev-shell.sh manganese" >&2
  exit 2
fi
SHELL_DIR="$ROOT/packages/shell-$SHELL_NAME"
[ -d "$SHELL_DIR" ] || {
  echo "no shell '$SHELL_NAME' — there is no packages/shell-$SHELL_NAME." >&2
  exit 1
}
# Output directory of the shell's own vite config.
PAGE_DIR="$SHELL_DIR/.vite/renderer/main_window"

# Build through turbo first so `^prepare` and `^build` run: `styled-system/`
# is generated, and workspace packages are imported from `dist/`. A bare
# `vite build --watch` on a fresh checkout builds a page without the SDK.
echo "building $SHELL_NAME"
(cd "$ROOT" && bun install --frozen-lockfile >/dev/null &&
   CI=1 bun run turbo build:vite --filter="./packages/shell-$SHELL_NAME") || {
  echo "the shell did not build" >&2
  exit 1
}

# Holds the socket file.
WORK="$(mktemp -d)"
WATCHING=()
cleanup() {
  if [ ${#WATCHING[@]} -gt 0 ]; then
    kill "${WATCHING[@]}" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# Watch the shell only. A change to its dependencies needs a restart.
#
# Keep the output directory: emptying it on the first watch build deletes the
# `shell.js` the turbo build wrote, and the desktop and reload loop below find
# no shell if they start before that build ends.
echo "watching $SHELL_DIR"
(cd "$SHELL_DIR" && exec bunx --bun vite build --watch --no-emptyOutDir) &
WATCHING+=($!)
# A shell that ships prebuilt CSS regenerates it with its `watch:css`.
if grep -q '"watch:css"' "$SHELL_DIR/package.json"; then
  (cd "$SHELL_DIR" && exec bun run watch:css) &
  WATCHING+=($!)
fi

# The reload loop waits for the socket file, so it can start before the
# `cargo build` below produces the `domicile` it runs.
"$ROOT/packages/dev-shell/bin/dev-shell-reload.sh" \
  "$ROOT/target/debug/domicile" "$PAGE_DIR/shell.js" "$WORK/sock" &
WATCHING+=($!)

# Use the flake's pinned engine. `DOMICILE_ENGINE` overrides it with a local
# build, such as `out/Agent`.
ENGINE="${DOMICILE_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  command -v nix >/dev/null 2>&1 || {
    echo "no nix on PATH, so there is no engine to run this in. Either install" >&2
    echo "  nix, or point DOMICILE_ENGINE at an engine you have already:" >&2
    echo "    DOMICILE_ENGINE=/build/chromium/src/out/Domicile $0 $SHELL_NAME" >&2
    exit 1
  }
  echo "fetching the pinned engine"
  ENGINE="$(nix build --no-link --print-out-paths "$ROOT#engine")" || {
    echo "the engine would not build. \`nix build .#engine\` says why." >&2
    exit 1
  }
fi

# `domicile` builds nothing, so build the compositor and runner here.
echo "building the compositor and the runner"
cargo build -p domicile-launch --bin domicile \
            -p domicile-compositor --bin domicile-compositor || exit 1

# `DOMICILE_PAGE` must name the module file; a directory is refused.
# `shell.js` is the entry name that
# `@domicile-desktop/component-library/vite-shell` pins.
#
# This script is not a child of `domicile`, so it reads the socket path from
# the end of the supervisor's "domicile is up." line instead of duplicating
# `control_socket::address`. That line comes once the engine runs, so a load
# is not refused.
echo "starting $SHELL_NAME"
DOMICILE_ENGINE="$ENGINE" \
DOMICILE_COMPOSITOR="$ROOT/target/debug/domicile-compositor" \
DOMICILE_PAGE="$PAGE_DIR/shell.js" \
  "$ROOT/target/debug/domicile" "$SHELL_NAME" | while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in
    ("domicile is up."*) printf '%s\n' "${line##*DOMICILE_SOCK=}" >"$WORK/sock" ;;
  esac
done
# Exit with the desktop's status, not the read loop's.
exit "${PIPESTATUS[0]}"
