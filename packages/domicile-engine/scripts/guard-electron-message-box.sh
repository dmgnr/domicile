#!/usr/bin/env bash
# An Electron app's message boxes: a box an app asks over its window is listed
# to the shell with the window, one at a time, as the shell shows it over the
# window's page, and the shell's answer reaches the app. A window that closes
# under a box answers it with its cancel button. See "Dialogs" in
# docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-message-box.sh /build/chromium/src
#
# Set up as guard-electron-views.sh is, with an HTTP server of its own on
# 127.0.0.1, and a shell of its own (guard-electron-message-box-module.js)
# that says each box as it reads it and answers "Quit?" and "Second?". A
# python client plays `electron-host`: it opens a window, asks "Quit?" and
# "Second?" back to back, waits for both answers, asks "Third?", which the
# shell leaves, and destroys the window under it. It asserts:
#
#   ready    the socket took the hello
#   listed   the shell read "Quit?" with its buttons, default, cancel and
#            checkbox
#   first    the app heard "Quit?" answered with Quit, its checkbox checked
#   second   the app heard "Second?" answered with Cancel, listed only after
#            "Quit?" was answered
#   closed   the app heard "Third?" answered with its cancel button when its
#            window closed
#
# No control run: a box is listed only once the app asks it, and each answer
# names its own box.
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
  annotate "guard-electron-message-box: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-message-box-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-message-box-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-message-box-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-message-box-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-message-box-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-message-box-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-message-box-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-message-box-app.log}"
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
  annotate "guard-electron-message-box: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-message-box: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-message-box: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the Electron socket.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-electron-message-box-module.js" \
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

def hear_until(wanted):
    """Reads events until one matches `wanted` or time runs out. Reads
    through select, so a wait that runs out leaves the connection readable
    for the next."""
    for event in heard:
        if wanted(event):
            return event
    deadline = time.monotonic() + seconds
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

def ask(box, message, buttons, default_id, cancel_id, checkbox_label=""):
    send({"type": "show_message_box", "window": 1, "box": box,
          "box_type": "question", "title": "Guard", "message": message,
          "detail": "", "buttons": buttons, "default_id": default_id,
          "cancel_id": cancel_id, "checkbox_label": checkbox_label,
          "checkbox_checked": False})

def answer_to(box):
    return hear_until(lambda e: e.get("type") == "message_box_answered" and
                      e.get("box") == box)

def answered(event, response, checked):
    return (event is not None and event["window"] == 1 and
            event["response"] == response and
            event["checkbox_checked"] == checked)

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0", flush=True)
    sys.exit(0)
connection.settimeout(None)

send({"type": "hello", "version": 1, "app_id": "guard.electron.box",
      "partition": "persist:electron-guard-box",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "open_window", "window": 1, "url": page})
hear_until(lambda e: e.get("type") == "window_loaded")
ask(1, "Quit?", ["Cancel", "Quit"], 1, 0, "Don't ask again")
ask(2, "Second?", ["Cancel", "OK"], 1, 0)
first = answer_to(1)
second = answer_to(2)
ask(3, "Third?", ["Save", "Don't Save", "Cancel"], 0, 2)
# The shell leaves it; give it time to be listed before the window goes.
time.sleep(2)
send({"type": "destroy_window", "window": 1})
closed = answer_to(3)

print("measured: %d %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    answered(first, 1, True), answered(second, 0, False),
    answered(closed, 2, False)), flush=True)
server.shutdown()
PY

APP_MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
LISTED=0
grep -qF "GUARD box id=1 Quit? buttons=Cancel,Quit default=1 cancel=0 checkbox=Don't ask again" \
  "$ENGINE_LOG" && LISTED=1
read -r READY FIRST SECOND CLOSED <<<"${APP_MEASURED:-0 0 0 0}"
MEASURED="$READY $LISTED $FIRST $SECOND $CLOSED"
echo
echo "measured: $MEASURED"
echo "  (ready listed first second closed)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-message-box-guard.sh`
# runs this block directly. MEASURED is
# "<ready> <listed> <first> <second> <closed>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1")
  PASSED="the app's boxes were listed with its window one at a time, the \\
shell's answers reached the app, and closing the window answered the last \\
with its cancel button"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \\
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the shell never read the app's message box: DeskWindows::ShowMessageBox \\
must list it with its window, and DomicileBrowserWindow.messageBox give it"
  ;;
"1 1 0 "*)
  FAILURE="THE APP NEVER HEARD THE SHELL'S ANSWER: answerBrowserWindowMessageBox \\
must reach DeskWindows::AnswerMessageBox, and the app hear message_box_answered \\
with the button and the checkbox"
  ;;
"1 1 1 0 "*)
  FAILURE="the app's second box was never answered: once the first is \\
answered, the window must list the next one it asked"
  ;;
"1 1 1 1 0")
  FAILURE="A BOX OVER A CLOSED WINDOW WAS NEVER ANSWERED: closing a window \\
must answer its boxes with their cancel buttons, as the app waits on each"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-message-box: $FAILURE" "$ENGINE_LOG"
echo "what the shell read of the boxes:" >&2
grep -E "GUARD (box|answered)" "$ENGINE_LOG" >&2 || echo "  nothing" >&2
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
