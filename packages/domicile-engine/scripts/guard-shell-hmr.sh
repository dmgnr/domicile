#!/usr/bin/env bash
# Checks that `domicile dev` gives a shell hot module replacement: an edit
# applies in place and the shell keeps its state.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-shell-hmr.sh /build/chromium/src
#
# `domicile-builder --serve` serves guard-shell-hmr.js, as `shell.js`, and a
# `label.js` from a unix socket. The engine starts on a plain shell, and
# `load_shell` with `"dev_server": true` moves it to the socket, as `domicile
# dev` does. The guard then:
#
#   edits label.js   the shell accepts it, so Vite swaps it in place: the
#                    module logs `updated` with the id it ran with, and does
#                    not run again. This is the claim.
#   edits shell.js   nothing accepts the entry, so Vite reloads the page: the
#                    module runs again with a new id. The control: it shows
#                    the guard sees a reload when there is one.
#
# Headless, with no compositor or client. The page's imports and Vite's
# updates go through the engine's dev server loader (shell_dev_server.cc).
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
  annotate "guard-shell-hmr: no path to chromium/src was given"
  exit 1
fi

ROOT="$(cd "$SCRIPTS/../../.." && pwd)"
OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-shell-hmr-broker}"
COMMAND="${COMMAND:-/tmp/domicile-shell-hmr-command}"
PROFILE="${PROFILE:-/tmp/domicile-shell-hmr-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-shell-hmr-engine.log}"
SERVER_LOG="${SERVER_LOG:-/tmp/domicile-shell-hmr-server.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"
# Outside the repository, so the builder finds no package.json above the
# project and installs nothing.
STAGE="$(mktemp -d)"
# Short: a unix socket's path is at most 107 bytes.
SOCKET="$STAGE/dev.sock"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -rf "$STAGE"
  rm -f "$COMMAND"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-shell-hmr: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-shell-hmr: no python3, and the command is sent by one"
  exit 77
}
command -v bun >/dev/null || {
  skip "guard-shell-hmr: no bun, and the dev server is the builder, which runs in it"
  exit 77
}

mkdir -p "$STAGE/plain" "$STAGE/project"
cp "$SCRIPTS/guard-shell-hmr.js" "$STAGE/project/shell.js"
echo 'export const label = "one";' >"$STAGE/project/label.js"
echo 'export const HostShell = () => { console.log("GUARD plain"); };' \
  >"$STAGE/plain/shell.js"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -aqF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}
TRIES=$((FOR_SECONDS * 4))

# 1. The dev server, as `domicile dev` starts it.
rm -f "$SERVER_LOG"
bun "$ROOT/packages/domicile-builder/src/main.ts" \
  --serve "$STAGE/project/shell.js" --socket "$SOCKET" \
  --domicile "$ROOT" --cache "$STAGE/cache" >"$SERVER_LOG" 2>&1 &
STARTED+=($!)
wait_for_line "$TRIES" '"step":"serving"' "$SERVER_LOG" || {
  annotate_from "guard-shell-hmr: the dev server never said it was serving" "$SERVER_LOG"
  tail -40 "$SERVER_LOG" >&2
  exit 1
}

# 2. The engine, on a plain shell.
fresh_broker; rm -rf "$PROFILE"; mkdir -p "$PROFILE"
rm -f "$COMMAND" "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app=domicile://shell/ \
  --domicile-shell-root="$STAGE/plain" \
  --domicile-shell-module=shell.js \
  --domicile-command-socket="$COMMAND" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)
wait_for_line "$TRIES" "GUARD plain" "$ENGINE_LOG" ||
  echo "the plain shell never ran; the verdict below says what that means" >&2

# 3. The dev server's shell, as `domicile dev` loads it.
ANSWER="$(python3 - "$COMMAND" "$SOCKET" <<'EOF' 2>&1
import json, socket, sys

path, root = sys.argv[1], sys.argv[2]
line = json.dumps({"type": "load_shell", "version": 1, "root": root,
                   "module": "domicile-dev-shell.js", "dev_server": True})
try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(30)
    connection.connect(path)
    connection.sendall((line + "\n").encode())
    print(connection.makefile().readline().strip())
except OSError as failure:
    print("no answer: %s" % failure)
EOF
)"
echo "the engine answered: $ANSWER"

# The closing quote is Chromium's and keeps each match on the message: see
# guard-windows-state.sh.
runs() { grep -aoE '"GUARD ran [^"]*"' "$ENGINE_LOG" 2>/dev/null; }
FIRST="$(wait_for_line "$TRIES" "GUARD ran " "$ENGINE_LOG" && runs | head -1)"
ID="$(printf '%s' "$FIRST" | grep -oE 'id=[a-z0-9]+')"
# Vite's client says so once its update stream is open.
wait_for_line "$TRIES" "[vite] connected" "$ENGINE_LOG" ||
  echo "Vite's client never connected; the verdict below says what that means" >&2

# 4. The claim: an edit to a module the shell accepts.
echo 'export const label = "two";' >"$STAGE/project/label.js"
wait_for_line "$TRIES" "GUARD updated $ID label=two" "$ENGINE_LOG" ||
  echo "no update with the first run's id turned up" >&2
# Long enough for a reload, had the edit caused one, to have run the module.
sleep 3
RUNS_AFTER_UPDATE="$(runs | wc -l)"

# 5. The control: an edit nothing accepts reloads the shell.
echo '// edited' >>"$STAGE/project/shell.js"
for _ in $(seq 1 "$TRIES"); do
  [ "$(runs | wc -l)" -ge 2 ] && break
  sleep 0.25
done

ANSWERED=0
[ "$ANSWER" = '{"type":"loaded"}' ] && ANSWERED=1
RAN=0
[ "$FIRST" = "\"GUARD ran $ID label=one\"" ] && [ -n "$ID" ] && RAN=1
UPDATED=0
grep -aqF "GUARD updated $ID label=two" "$ENGINE_LOG" 2>/dev/null && UPDATED=1
KEPT=0
[ "$RUNS_AFTER_UPDATE" = "1" ] && KEPT=1
RELOADED=0
runs | sed -n 2p | grep -q "label=two" &&
  ! runs | sed -n 2p | grep -qF "$ID" && RELOADED=1

MEASURED="$ANSWERED $RAN $UPDATED $KEPT $RELOADED"
echo "runs: $(runs | tr '\n' ' ')"
echo "measured: $MEASURED"
echo "  (answered ran updated kept reloaded)"

case "$MEASURED" in
"1 1 1 1 1")
  FAILURE=""
  ;;
"0 "*)
  FAILURE="the engine never answered the load_shell with loaded ($ANSWER): it refused dev_server, or the dev server's shell never ran (command_protocol.cc, shell_swap.cc)"
  ;;
"1 0 "*)
  FAILURE="the engine said loaded and the dev server's shell never logged its first run ($FIRST): a module from the socket did not load (shell_dev_server.cc), or Vite's preamble threw"
  ;;
"1 1 0 "*)
  FAILURE="THE EDIT NEVER REACHED THE SHELL: no 'GUARD updated $ID label=two'. Vite's client never got the update over GET /@domicile/hmr (the engine must stream a body as it arrives), or the updated module did not load"
  ;;
"1 1 1 0 "*)
  FAILURE="the update applied and the shell also ran again ($RUNS_AFTER_UPDATE runs), so its state was lost: Vite reloaded the page on an edit the shell accepts"
  ;;
"1 1 1 1 0")
  FAILURE="the control failed: an edit to the entry did not reload the shell with a new id, so the guard could not have seen a reload either. Vite's full-reload calls location.reload() on the shell's page"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$FAILURE" ]; then
  annotate_from "guard-shell-hmr: $FAILURE" "$ENGINE_LOG"
  echo "guard-shell-hmr: $FAILURE" >&2
  echo "the engine said:" >&2
  grep -aE "GUARD|vite|domicile|dev server|ERROR|FATAL" "$ENGINE_LOG" | tail -60 >&2
  echo "the dev server said:" >&2
  tail -30 "$SERVER_LOG" >&2
  exit 1
fi
echo "PASS: an edit the shell accepts applied in place and kept its state; an edit to the entry reloaded it"
