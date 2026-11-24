#!/usr/bin/env bash
# An Electron app's views (WebContentsView): a view the app places in its
# window is listed to the shell under that window, where the app asks, and
# the app hears the size the shell gave each page. See "Windows" in
# docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-views.sh /build/chromium/src
#
# Set up as guard-electron-session.sh is, with an HTTP server of its own on
# 127.0.0.1, and a shell of its own (guard-electron-views-module.js) that
# draws each window full page and each view where its app asks. A python
# client plays `electron-host`: it opens a window and a view, places the view
# at 300x200, then moves it to 400x100. It asserts:
#
#   ready    the socket took the hello
#   window   the app heard its window's page sized, as the shell drew it
#   placed   the app heard its view's page sized 300x200, where it placed it
#   moved    and then 400x100, after it placed it again
#
# No control run: the view has no size until the app places it, and its
# second size is the first's control.
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
  annotate "guard-electron-views: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-views-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-views-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-views-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-views-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-views-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-views-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-views-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-views-app.log}"
FOR_SECONDS="${FOR_SECONDS:-120}"
# The shell's window. Headless, it has no size unless given one, and the
# window's page, drawn across it, would have none to report.
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

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
  annotate "guard-electron-views: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-views: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-views: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the Electron socket.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --window-size="$WIDTH,$HEIGHT" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-electron-views-module.js" \
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
import http.server, json, socket, sys, threading, time

path, seconds, root = sys.argv[1], float(sys.argv[2]), sys.argv[3]
heard = []

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

def hear_until(wanted):
    """Reads events until one matches `wanted` or time runs out."""
    for event in heard:
        if wanted(event):
            return event
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        connection.settimeout(max(0.1, deadline - time.monotonic()))
        try:
            line = reader.readline()
        except (OSError, ValueError):
            return None
        if not line:
            return None
        event = json.loads(line)
        print("heard: %s" % line.strip(), flush=True)
        heard.append(event)
        if wanted(event):
            return event
    return None

def sized(window, width=None, height=None):
    """Waits for window `window`'s page to be sized, at `width` x `height`
    when given."""
    return hear_until(lambda e: e.get("type") == "resized" and
                      e.get("window") == window and
                      (width is None or e.get("width") == width) and
                      (height is None or e.get("height") == height)) \
        is not None

def place(width, height):
    send({"type": "set_views", "window": 1, "views": [
        {"window": 2, "x": 10, "y": 20, "width": width, "height": height}]})

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0", flush=True)
    sys.exit(0)
reader = connection.makefile("r", encoding="utf-8")

send({"type": "hello", "version": 1, "app_id": "guard.electron.views",
      "partition": "persist:electron-guard-views",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "open_window", "window": 1, "url": page})
send({"type": "open_window", "window": 2, "url": page, "view": True})
window = sized(1)
place(300, 200)
placed = sized(2, 300, 200)
place(400, 100)
moved = sized(2, 400, 100)

print("measured: %d %d %d %d" % (
    ready is not None and ready["type"] == "ready", window, placed, moved),
    flush=True)
server.shutdown()
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready window placed moved)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-views-guard.sh`
# runs this block directly. MEASURED is "<ready> <window> <placed> <moved>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1")
  PASSED="the app's view was listed under its window where the app placed \\
it, and the app heard each page's size"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \\
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the app never heard its window's size: ElectronPage must tell \\
the app its page's size when it is resized (see what it heard, below)"
  ;;
"1 1 0 "*)
  FAILURE="the app never heard its view sized where it placed it: \\
DeskWindows::List must list a view under the window that holds it, with \\
the app's bounds, after SetViews"
  ;;
"1 1 1 0")
  FAILURE="THE VIEW KEPT ITS FIRST SIZE AFTER THE APP PLACED IT AGAIN: \\
SetViews must relist the view with its new bounds"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-views: $FAILURE" "$ENGINE_LOG"
echo "what the Electron pages heard of their size:" >&2
grep -F "an Electron page heard" "$ENGINE_LOG" >&2 || echo "  nothing" >&2
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
