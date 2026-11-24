#!/usr/bin/env bash
# Checks that an agent's `devtools` reaches the shell's own page as window
# `shell`, so it can read the shell's bars, panels and dialogs as text.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-agent-devtools-shell.sh /build/chromium/src
#
# The shell (guard-agent-devtools-shell.js) draws one button. The guard sends
# `devtools` for window `shell`, method `Accessibility.getFullAXTree`, to the
# engine's command socket, as `domicile devtools shell` does, and asserts the
# button's name is in the tree, and that `Page.navigate` on it is refused, so
# an agent can't take the desk away from the shell. Its control is in the
# same run: window `no-such-window` must be refused, so a tree answered for any
# window can't pass. See SendDevToolsToBrowserWindow.
#
# Headless, with no compositor or client.
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
  annotate "guard-agent-devtools-shell: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-agent-devtools-shell-broker}"
COMMAND="${COMMAND:-/tmp/domicile-agent-devtools-shell-command}"
PROFILE="${PROFILE:-/tmp/domicile-agent-devtools-shell-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-agent-devtools-shell-engine.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -f "$COMMAND"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-agent-devtools-shell: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-agent-devtools-shell: no python3, and the command is sent by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"
rm -f "$ENGINE_LOG" "$COMMAND"

"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-agent-devtools-shell.js" \
  --domicile-command-socket="$COMMAND" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# No early exit when it never comes: the verdict below says why, with the
# engine's log.
for _ in $(seq 1 $((FOR_SECONDS * 4))); do
  grep -qF "GUARD agent-shell ready" "$ENGINE_LOG" 2>/dev/null && [ -S "$COMMAND" ] && break
  sleep 0.25
done

# What the engine answers `devtools` for window $1, method $2 with params $3,
# as one line.
asked() {
  python3 - "$COMMAND" "$1" "$2" "$3" <<'PY' 2>&1
import json, socket, sys

path, window, method, params = sys.argv[1:5]
line = json.dumps({"type": "devtools", "version": 1, "window": window,
                   "method": method, "params": json.loads(params)})
try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(15)
    connection.connect(path)
    connection.sendall((line + "\n").encode())
    print(connection.makefile().readline().strip())
except OSError as failure:
    print("no answer: %s" % failure)
PY
}

SHELL_TREE="$(asked shell Accessibility.getFullAXTree '{}')"
NONE="$(asked no-such-window Accessibility.getFullAXTree '{}')"
NAVIGATED="$(asked shell Page.navigate '{"url": "https://example.com/"}')"

case "$NONE" in
*'"refused"'*) CONTROL="" ;;
*) CONTROL="the control failed: window no-such-window was answered ($NONE), so an answer for shell proves nothing" ;;
esac
case "$SHELL_TREE" in
*'GUARD agent button'*) FAILURE="" ;;
"no answer"*) FAILURE="the command socket did not answer ($SHELL_TREE)" ;;
*) FAILURE="devtools for window shell did not answer the shell page's tree: ${SHELL_TREE:0:300}" ;;
esac
case "$NAVIGATED" in
*'"refused"'*) ;;
*) FAILURE="${FAILURE:-Page.navigate on the shell page was not refused ($NAVIGATED)}" ;;
esac
FAILURE="${CONTROL:-$FAILURE}"

echo "shell: ${SHELL_TREE:0:200}"
echo "no-such-window: $NONE"
echo "shell Page.navigate: $NAVIGATED"

if [ -n "$FAILURE" ]; then
  annotate_from "guard-agent-devtools-shell: $FAILURE" "$ENGINE_LOG"
  echo "guard-agent-devtools-shell: $FAILURE" >&2
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
fi
echo "PASS: an agent's devtools reads the shell's page as window shell, refuses to navigate it, and refuses a window that isn't open"
