#!/usr/bin/env bash
# An Electron app's permission request handler: with a handler set on its
# session, the page's permission requests ask the app, not the shell, and
# the page gets the app's answer. See "Sessions" in
# docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-permissions.sh /build/chromium/src
#
# Set up as guard-electron-session.sh is, with an HTTP server of its own on
# 127.0.0.1, but under a nested Wayland compositor (under-wayland.sh), as
# guard-webview-permissions.sh is: PermissionRequestManager::AddRequest denies
# every request on a headless screen before any prompt. A python client plays
# `electron-host`. Its window asks for its location twice, from two origins:
# http://127.0.0.1, which the app grants, and then http://localhost, which it
# denies. It asserts:
#
#   ready    the socket took the hello
#   asked    the app heard 127.0.0.1's geolocation request, as its window's
#   granted  127.0.0.1's request was not denied (a position, or no position
#            to give, both come after a grant)
#   denied   the app heard localhost's request, and localhost was denied
#
# Geolocation, as the one kind a page here asks for without a click: in CI,
# `Notification.requestPermission()` and `getScreenDetails()` were refused
# before any prompt. No control run: the grant and the denial are each
# other's control.
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
  annotate "guard-electron-permissions: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-permissions-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-permissions-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-permissions-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-permissions-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-permissions-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-permissions-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-permissions-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-permissions-app.log}"
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
  annotate "guard-electron-permissions: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-permissions: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-permissions: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the Electron socket.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=wayland \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-app-module.js" \
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
python3 - "$ELECTRON" "$FOR_SECONDS" "$SCRIPTS/guard-electron-permissions-app" \
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
origin = "http://127.0.0.1:%d" % server.server_address[1]

def send(request):
    connection.sendall((json.dumps(request) + "\n").encode())

def hear_until(wanted):
    """Reads events until one matches `wanted` or time runs out, answering
    each permission request as it comes: 127.0.0.1's granted, the rest
    denied."""
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
        if event.get("type") == "permission_request":
            send({"type": "permission_answer", "ask": event["ask"],
                  "granted": event.get("requesting_url") == origin + "/"})
        if wanted(event):
            return event
    return None

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0", flush=True)
    sys.exit(0)
reader = connection.makefile("r", encoding="utf-8")

send({"type": "hello", "version": 1, "app_id": "guard.electron.permissions",
      "partition": "persist:electron-guard-permissions",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "permission_handler", "session": "", "handle": True})
other = "http://localhost:%d" % server.server_address[1]
send({"type": "open_window", "window": 1, "url": origin + "/index.html"})

def page_says():
    """How the page ended its request: "error 1" when denied."""
    done = hear_until(lambda e: e.get("type") == "title_changed" and
                      e.get("window") == 1 and
                      e.get("title", "").startswith("done|"))
    if done is None:
        return ""
    # So the next page's title is not this one's.
    heard.remove(done)
    return done["title"][len("done|"):]

first = page_says()
send({"type": "load_url", "window": 1, "url": other + "/index.html"})
second = page_says()

def asked(url):
    return any(e.get("type") == "permission_request" and
               e.get("permission") == "geolocation" and
               e.get("window") == 1 and e.get("session") == "" and
               e.get("requesting_url") == url + "/"
               for e in heard)

print("measured: %d %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    asked(origin),
    first not in ("", "error 1"),
    asked(other) and second == "error 1"),
    flush=True)
server.shutdown()
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready asked granted denied)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-permissions-guard.sh`
# runs this block directly. MEASURED is "<ready> <asked> <granted> <denied>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1")
  PASSED="the app's permission request handler answered its page's \\
requests, granting one and denying the other"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \\
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the app never heard its page's geolocation request as its \\
window's: MakePrompt must hand an Electron page's prompt to \\
ElectronPermissionPrompt while its session HandlesPermissions, and \\
ElectronPermissionFor must name it"
  ;;
"1 1 0 "*)
  FAILURE="the page was denied what the app's handler granted: \\
ElectronPermissionPrompt::Decide must Accept"
  ;;
"1 1 1 0")
  FAILURE="THE SECOND ORIGIN GOT PAST THE APP'S DENIAL, OR THE APP NEVER \\
HEARD IT: ElectronPermissionPrompt::Decide \\
must Deny, and ElectronPermissionFor must name geolocation"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-permissions: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
