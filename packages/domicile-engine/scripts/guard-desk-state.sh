#!/usr/bin/env bash
# The desk's state attributes on the desktop -- idle, lock, both themes,
# clipboard, tray, modifiers -- say what the compositor said, to a shell that
# reads them without listening for their events. Also that the pointer theme
# on `appearance` reaches the browser process.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-desk-state.sh /build/chromium/src
#
# WHY THIS EXISTS. Each of these used to reach a page only as an event, gone if
# nobody was listening yet. Each is now the last thing the compositor said,
# null until it has said anything, so a shell reads and then listens. The
# notifications and extensions attributes are the same code -- the last
# event's payload -- and are left to the shells that read them.
# See packages/chrome-sdk/README.md.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-desk-state: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-desk-state-broker}"
CONTROL="${CONTROL:-/tmp/domicile-desk-state-control}"
PROFILE="${PROFILE:-/tmp/domicile-desk-state-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-desk-state-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-desk-state-socket.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-desk-state: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-desk-state: no python3, and the compositor's end of the control socket is one"
  exit 77
}

fresh_broker
rm -f "$CONTROL"; rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-desk-state-compositor.py" --socket "$CONTROL" \
  >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-desk-state: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-desk-state.js" \
  --domicile-control-socket="$CONTROL" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 --vmodule=desk_cursor_theme=1 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD listening" "$ENGINE_LOG" || {
  annotate_from "guard-desk-state: the shell module never ran" "$ENGINE_LOG"
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
wait_for_line "$TRIES" "sent the sequence" "$SOCKET_LOG" || {
  annotate_from "guard-desk-state: the compositor stand-in never finished its sequence" "$SOCKET_LOG"
  tail -20 "$SOCKET_LOG" >&2
  exit 1
}

# The page logs a reading whenever one changes. The browser applies the
# stand-in's lines some time after they are sent, later on a loaded machine,
# so judge the latest reading until it is right or the deadline passes.
for _ in $(seq 1 "$TRIES"); do
  FAILURE="$(python3 "$SCRIPTS/guard-desk-state-verdict.py" "$ENGINE_LOG")"
  [ -z "$FAILURE" ] && break
  sleep 0.25
done
STATE=$(grep -oE '"GUARD state .*"' "$ENGINE_LOG" | tail -1)

echo "page: $STATE"

# The pointer theme stops in the browser process, which logs it at VLOG 1. A
# headless engine has no DRM cursor factory to load it, so this checks the
# crossing.
POINTER='the desk'"'"'s pointer theme is "domicile-guard" at 48 px'
if [ -z "$FAILURE" ] && ! wait_for_line "$TRIES" "$POINTER" "$ENGINE_LOG"; then
  FAILURE="the browser never logged the pointer theme the compositor sent"
fi

if [ -n "$FAILURE" ]; then
  annotate_from "guard-desk-state: $FAILURE" "$ENGINE_LOG"
  echo "guard-desk-state: $FAILURE" >&2
  echo "the compositor stand-in said:" >&2
  tail -20 "$SOCKET_LOG" >&2
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
fi
echo "PASS: a shell that reads without listening reads the desk's state, and the browser takes the pointer theme"
