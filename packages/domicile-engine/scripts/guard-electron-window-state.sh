#!/usr/bin/env bash
# An Electron app's window state: what the app asks for a window
# (win.maximize, minimize, setFullScreen) is listed to the shell with the
# window, and what the shell makes the window reaches the app, once per
# change. See "Window state" in docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-window-state.sh /build/chromium/src
#
# Set up as guard-electron-menu-bar.sh is, with a shell of its own
# (guard-electron-window-state-module.js) that says what each window wants
# as it reads it, and grants it: it makes the window just that. A python
# client plays `electron-host`: it opens a window, asks for fullscreen and
# waits to hear the shell made it so, then asks for normal again. It asserts:
#
#   ready    the socket took the hello
#   listed   the shell read the fullscreen the app asked, then the normal
#   heard    the app heard the window made fullscreen, then normal
#   once     the app heard each change once, though the shell reported the
#            same state again
#
# No control run: nothing is listed or heard until the app asks.
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
  annotate "guard-electron-window-state: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-window-state-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-window-state-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-window-state-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-window-state-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-window-state-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-window-state-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-window-state-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-window-state-app.log}"
FOR_SECONDS="${FOR_SECONDS:-120}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -f "$COMMAND" "$CONTROL" "$ELECTRON"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-electron-window-state: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-window-state: no python3, and the compositor and the app are both driven by one"
  exit 77
}

fresh_broker
rm -f "$COMMAND" "$CONTROL" "$ELECTRON"; rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The compositor's end of the control socket.
rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-app-module-compositor.py" --socket "$CONTROL" \
  >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-electron-window-state: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the Electron socket.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-electron-window-state-module.js" \
  --domicile-control-socket="$CONTROL" \
  --domicile-command-socket="$COMMAND" \
  --domicile-electron-socket="$ELECTRON" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" ||
  echo "the shell never loaded; the verdict below says what that means" >&2
sleep 1

# 3. The app: one connection, as `electron-host` holds one. Prints each event
# it hears, then what it measured.
python3 - "$ELECTRON" "$FOR_SECONDS" "$SCRIPTS/guard-electron-views-app" \
  >"$APP_LOG" 2>&1 <<'PY'
import http.server, json, select, socket, sys, threading, time

path, seconds, root = sys.argv[1], float(sys.argv[2]), sys.argv[3]
heard = []
pending = [b""]

class Server(http.server.BaseHTTPRequestHandler):
    """The network: the page."""
    def do_GET(self):
        if self.path == "/index.html":
            with open(root + "/index.html", "rb") as page_file:
                body = page_file.read()
            self.send_response(200)
            self.send_header("content-type", "text/html")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server)
threading.Thread(target=server.serve_forever, daemon=True).start()
page = "http://127.0.0.1:%d/index.html" % server.server_address[1]

def send(request):
    connection.sendall((json.dumps(request) + "\n").encode())

def hear_until(wanted, within):
    """Reads events until one matches `wanted` or `within` seconds pass.
    Reads through select, so a wait that runs out leaves the connection
    readable for the next."""
    for event in heard:
        if wanted(event):
            return event
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        while b"\n" not in pending[0]:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([connection], [], [], left)[0]:
                return None
            chunk = connection.recv(65536)
            if not chunk:
                return None
            pending[0] += chunk
        line, pending[0] = pending[0].split(b"\n", 1)
        event = json.loads(line)
        print("heard: %s" % line.decode(), flush=True)
        heard.append(event)
        if wanted(event):
            return event
    return None

def state(fullscreen):
    return {"type": "set_window_state", "window": 1, "maximized": False,
            "minimized": False, "fullscreen": fullscreen}

def made(fullscreen):
    return lambda e: (e.get("type") == "window_state" and
                      e.get("window") == 1 and
                      e.get("fullscreen") == fullscreen and
                      not e.get("maximized") and not e.get("minimized"))

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0", flush=True)
    sys.exit(0)
connection.settimeout(None)

send({"type": "hello", "version": 1, "app_id": "guard.electron.state",
      "partition": "persist:electron-guard-state",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"), seconds)
send({"type": "open_window", "window": 1, "url": page})
hear_until(lambda e: e.get("type") == "window_loaded", seconds)
send(state(True))
full = hear_until(made(True), seconds)
send(state(False))
normal = hear_until(made(False), seconds)
# The shell reports again on every listing; the app hears only changes.
time.sleep(2)
hear_until(lambda e: False, 1)
states = [e for e in heard if e.get("type") == "window_state"]

print("measured: %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    full is not None and normal is not None,
    len(states) == 2),
    flush=True)
server.shutdown()
PY

APP_MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
LISTED=0
grep -qF "GUARD wants id=1 fullscreen" "$ENGINE_LOG" &&
  grep -qF "GUARD wants id=1 normal" "$ENGINE_LOG" && LISTED=1
read -r READY HEARD ONCE <<<"${APP_MEASURED:-0 0 0}"
MEASURED="$READY $LISTED $HEARD $ONCE"
echo
echo "measured: $MEASURED"
echo "  (ready listed heard once)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-window-state-guard.sh`
# runs this block directly. MEASURED is "<ready> <listed> <heard> <once>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1")
  PASSED="the state the app asked was listed with its window, and what the \\
shell made the window reached the app once per change"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \\
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the shell never read the state the app asked: \\
DeskWindows::SetWindowState must list it with the window, and \\
DomicileBrowserWindow.wantsFullscreen give it"
  ;;
"1 1 0 "*)
  FAILURE="THE APP NEVER HEARD WHAT THE SHELL MADE ITS WINDOW: \\
setBrowserWindowState must reach DeskWindows::ReportWindowState and the \\
window's ElectronPage, and the app hear window_state"
  ;;
"1 1 1 0")
  FAILURE="the app heard the same window state more than once: \\
ElectronPage::WindowStateChanged must say only a change"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-window-state: $FAILURE" "$ENGINE_LOG"
echo "what the shell read of the windows:" >&2
grep -F "GUARD wants" "$ENGINE_LOG" >&2 || echo "  nothing" >&2
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
