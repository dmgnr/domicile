#!/usr/bin/env bash
# An app module, run with `run_app`: its `main` runs in an app window and its
# system call reaches the compositor as an app's. See
# docs/architecture/APP-MODULES.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-app-module.sh /build/chromium/src
#
# Headless and software-composited like the other <webview> guards. A
# stand-in compositor (guard-app-module-compositor.py) answers the control
# socket. The guard sends `run_app` to the engine's command socket, naming
# guard-app-module-app/app.js. Then it asserts:
#
#   the engine answered `opened`   the command reached the engine
#   main ran once                  the app's document was served and DomicileApp
#                                  called its `main`
#   the desktop is narrow          `main` was handed the SDK layer's
#                                  AppDomicile, which has no `windows`, not
#                                  the shell's Domicile
#   the compositor heard app_hello the app's channel said it is an app
#   the answer reached the app     the call crossed both ways
#   the app fetched its own file   fetch() reads the app's origin (patch 0126)
#   and not the shell's            ShellURLLoaderFactory::MayReadFiles refuses
#                                  another origin
#   the app is isolated            crossOriginIsolated and SharedArrayBuffer,
#                                  with no COOP or COEP (patch 0225)
#
# Control: NEGATIVE=1 also opens the app's address with `open_url`, in a
# window no app was opened in. That window must not run the app: an app's
# address follows from its path, so only the pin keeps any page from opening
# any directory as an app. `main` must still have run once.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-last-words.sh
. "$SCRIPTS/lib-last-words.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-app-module: no path to chromium/src was given"
  exit 1
fi

NEGATIVE="${NEGATIVE:-0}"
MODE="pinned"
[ "$NEGATIVE" = "1" ] && MODE="unpinned"

OUT="${OUT:-out/Domicile}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
BROKER="${BROKER:-/tmp/domicile-app-module$WHICH-broker}"
COMMAND="${COMMAND:-/tmp/domicile-app-module$WHICH-command}"
CONTROL="${CONTROL:-/tmp/domicile-app-module$WHICH-control}"
PROFILE="${PROFILE:-/tmp/domicile-app-module$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-app-module$WHICH-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-app-module$WHICH-socket.log}"
FOR_SECONDS="${FOR_SECONDS:-120}"
# How long the control watches for the unpinned window to run the app. Bounded
# because it expects an absence.
WATCH_SECONDS="${WATCH_SECONDS:-10}"
APP_ROOT="$SCRIPTS/guard-app-module-app"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -f "$COMMAND" "$CONTROL"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-app-module: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-app-module: no python3, and the compositor and the command are both driven by one"
  exit 77
}

fresh_broker
rm -f "$COMMAND" "$CONTROL"; rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# Sends one command line to the engine and prints its answer.
command_line() { # $1 JSON line
  python3 - "$COMMAND" "$1" <<'PY' 2>&1
import socket, sys

path, line = sys.argv[1], sys.argv[2]
try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
    connection.sendall((line + "\n").encode())
    print(connection.makefile().readline().strip())
except OSError as failure:
    print("no answer: %s" % failure)
PY
}

# 1. The compositor's end of the control socket.
rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-app-module-compositor.py" --socket "$CONTROL" \
  >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-app-module: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the command socket `domicile open --app` uses.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-app-module.js" \
  --domicile-control-socket="$CONTROL" \
  --domicile-command-socket="$COMMAND" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" ||
  echo "the shell never loaded; the verdict below says what that means" >&2
sleep 1

# 3. Run the app, as `domicile open --app` does.
RUN="$(command_line "{\"type\":\"run_app\",\"version\":1,\"root\":\"$APP_ROOT\",\"module\":\"app.js\"}")"
echo "run_app was answered: $RUN"
wait_for_line "$TRIES" "GUARD app-answered" "$ENGINE_LOG" ||
  echo "the app's call was never answered; the verdict below says what that means" >&2
wait_for_line "$TRIES" "GUARD app-fetch" "$ENGINE_LOG" ||
  echo "the app never said what it fetched; the verdict below says what that means" >&2
wait_for_line "$TRIES" "GUARD app-isolated" "$ENGINE_LOG" ||
  echo "the app never said whether it is isolated; the verdict below says what that means" >&2

ANSWERED=0
[ "$RUN" = '{"type":"opened"}' ] && ANSWERED=1

# 4. The control: the app's address in a window no app was opened in.
if [ "$NEGATIVE" = "1" ]; then
  ADDRESS="domicile://app-$(printf '%s' "$APP_ROOT" | sha256sum | cut -c1-32)/"
  OPEN="$(command_line "{\"type\":\"open_url\",\"version\":1,\"url\":\"$ADDRESS\",\"app\":true}")"
  echo "open_url $ADDRESS was answered: $OPEN"
  [ "$OPEN" = '{"type":"opened"}' ] || ANSWERED=0
  sleep "$WATCH_SECONDS"
fi

# The readings. A console line ends in Chromium's closing quote; see
# guard-windows-state.sh.
MAINS="$(grep -cE '"GUARD app-main narrow=' "$ENGINE_LOG")"
NARROW=0
grep -qE '"GUARD app-main narrow=true"' "$ENGINE_LOG" && NARROW=1
HELLO=0
grep -qx "app-hello" "$SOCKET_LOG" && HELLO=1
REPLIED=0
grep -qE '"GUARD app-answered written=true"' "$ENGINE_LOG" && REPLIED=1
FETCHED=0
grep -qE '"GUARD app-fetch own=read shell=(empty|refused)"' "$ENGINE_LOG" && FETCHED=1
ISOLATED=0
grep -qE '"GUARD app-isolated isolated=true shared=true"' "$ENGINE_LOG" && ISOLATED=1

MEASURED="$MODE $ANSWERED $MAINS $NARROW $HELLO $REPLIED $FETCHED $ISOLATED"
echo
echo "measured: $MEASURED"
echo "  (mode answered mains narrow app-hello replied fetched isolated)"

# Which end to blame. `packages/domicile-engine/tests/test-app-module-guard.sh` runs this block
# directly. MEASURED is "<mode> <answered> <mains> <narrow> <hello>
# <replied> <fetched> <isolated>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"pinned 1 1 1 1 1 1 1")
  PASSED="an app module ran: run_app opened its window, its main was handed \
the layer's AppDomicile, its system call crossed to the compositor as an \
app's and back, and it is cross-origin isolated"
  ;;
"unpinned 1 1 1 1 1 1 1")
  PASSED="the control is sharp: the app's address in a window no app was \
opened in ran nothing, so only the pinned window runs the app"
  ;;
"unpinned 1 2 "*)
  FAILURE="AN UNPINNED WINDOW RAN THE APP: open_url showed the app's address \
in a window run_app did not open. WebViewGuest::Navigate must refuse it \
(MayShowInWebView with the guest's app_host)"
  ;;
"pinned 0 "* | "unpinned 0 "*)
  FAILURE="the engine did not answer opened: the command socket was not \
bound (--domicile-command-socket), or it refused run_app or open_url -- the \
answers are printed above"
  ;;
"pinned 1 0 "* | "unpinned 1 0 "*)
  FAILURE="the app's main never ran: the app's document was not served \
(ShellURLLoaderFactory::ServeApp, AppRoots), the window was refused it, or \
DomicileApp did not run the module -- the engine log has its console"
  ;;
"pinned 1 1 0 "* | "unpinned 1 1 0 "*)
  FAILURE="main was handed a host with spawn: the app got the shell's \
DomicileHost instead of a DomicileAppHost"
  ;;
"pinned 1 1 1 0 "* | "unpinned 1 1 1 0 "*)
  FAILURE="the compositor never heard app_hello: the app's channel was not \
bound (the AppChannel binder refused it, or the window was not pinned), or it \
said hello as a shell"
  ;;
"pinned 1 1 1 1 0 "* | "unpinned 1 1 1 1 0 "*)
  FAILURE="the app's call was not answered: AppChannel dropped the \
system_reply, or DomicileAppHost did not dispatch it"
  ;;
"pinned 1 1 1 1 1 0 "* | "unpinned 1 1 1 1 1 0 "*)
  FAILURE="the app did not fetch its own file, or read the shell's -- its \
app-fetch line is in the engine log. Blink refuses fetch() on a scheme not \
registered as supporting the Fetch API (patch 0126); \
ShellURLLoaderFactory::MayReadFiles serves a file only to its own origin"
  ;;
"pinned 1 1 1 1 1 1 0" | "unpinned 1 1 1 1 1 1 0")
  FAILURE="the app is not cross-origin isolated, or has no \
SharedArrayBuffer -- its app-isolated line is in the engine log. \
NavigationRequest::ComputeCrossOriginIsolationKey isolates an origin \
IsCrossOriginIsolatedOrigin names (patch 0225)"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-app-module: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the compositor stand-in heard:" >&2
tail -20 "$SOCKET_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
