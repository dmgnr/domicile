#!/usr/bin/env bash
# An Electron app's session calls: the app gives its session a user agent
# and a cookie before its window opens, and the page loads as that agent
# with that cookie; cookies.get then finds the cookie the page set too, and
# clearStorageData leaves the page's next load with no cookies and no
# localStorage. See "Sessions" in docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-session.sh /build/chromium/src
#
# Set up as guard-electron-web-request.sh is, with an HTTP server of its own
# on 127.0.0.1. A python client plays `electron-host`, and asserts:
#
#   ready    the socket took the hello
#   agent    the server and the page both saw the session's user agent
#   cookie   the server and the page both saw the cookie the app set
#   got      cookies.get found the app's cookie and the one the page set
#   cleared  after clearStorageData, the page's next load had no cookies and
#            no localStorage
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
  annotate "guard-electron-session: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-session-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-session-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-session-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-session-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-session-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-session-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-session-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-session-app.log}"
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
  annotate "guard-electron-session: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-session: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-session: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the Electron socket.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
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
python3 - "$ELECTRON" "$FOR_SECONDS" "$SCRIPTS/guard-electron-session-app" \
  >"$APP_LOG" 2>&1 <<'PY'
import http.server, json, socket, sys, threading, time

path, seconds, root = sys.argv[1], float(sys.argv[2]), sys.argv[3]
heard = []
seen = []

class Server(http.server.BaseHTTPRequestHandler):
    """The network: the page, and the headers each of its loads came with."""
    def do_GET(self):
        if self.path.startswith("/index.html"):
            seen.append((self.headers.get("user-agent", ""),
                         self.headers.get("cookie", "")))
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

def call(number, method, **arguments):
    """A session call on the app's own session, and its result."""
    send(dict({"type": "session_call", "call": number, "session": "",
               "method": method}, **arguments))
    return hear_until(lambda e: e.get("type") == "session_result" and
                      e.get("call") == number)

def page_says(again):
    """The words of the page's title once it has loaded, or none."""
    done = hear_until(lambda e: e.get("type") == "title_changed" and
                      e.get("window") == 1 and
                      e.get("title", "").startswith("done|") and
                      e["title"].endswith("|" + again))
    # "done|<userAgent>|<document.cookie>|<localStorage x>|<search>"
    return ((done or {}).get("title", "").split("|") + ["", "", "", ""])[1:]

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0 0", flush=True)
    sys.exit(0)
reader = connection.makefile("r", encoding="utf-8")

send({"type": "hello", "version": 1, "app_id": "guard.electron.session",
      "partition": "persist:electron-guard-session",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
agent_set = call(1, "set_user_agent", user_agent="GuardAgent/1")
cookie_set = call(2, "cookies_set",
                  details={"url": origin + "/", "name": "app", "value": "1"})
send({"type": "open_window", "window": 1, "url": origin + "/index.html"})
first = page_says("")
got = call(3, "cookies_get", filter={"url": origin + "/"})
cleared = call(4, "clear_storage_data")
# The renderer keeps its own copy of the page's localStorage, which hears of
# the clear on a pipe of its own, so a load right after clear_storage_data
# answers may still read the old item. Later loads only read: storage the
# clear missed reads back every time, a stale copy only until it hears.
second = ["", "", "", ""]
for attempt in range(1, 6):
    again = "?again%d" % attempt
    send({"type": "load_url", "window": 1, "url": origin + "/index.html" + again})
    second = page_says(again)
    if second[1] == "" and second[2] == "none":
        break
    time.sleep(0.2)

names = sorted(cookie.get("name") for cookie in
               ((got or {}).get("result") or []))
print("measured: %d %d %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    agent_set is not None and "error" not in agent_set and
    first[0] == "GuardAgent/1" and len(seen) > 0 and
    seen[0][0] == "GuardAgent/1",
    cookie_set is not None and "error" not in cookie_set and
    "app=1" in first[1] and len(seen) > 0 and "app=1" in seen[0][1],
    names == ["app", "page"],
    cleared is not None and "error" not in cleared and first[2] == "none" and
    second[1] == "" and second[2] == "none"),
    flush=True)
server.shutdown()
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready agent cookie got cleared)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-session-guard.sh`
# runs this block directly. MEASURED is "<ready> <agent> <cookie> <got>
# <cleared>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1")
  PASSED="the app's session gave its page a user agent and a cookie, found \\
the page's own cookie, and cleared what the page kept"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \\
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the page did not load as the session's user agent: \\
ElectronApp::RunSessionCall keeps it on the session, OpenElectron must apply \\
it before the first navigation (UseUserAgent), and WebViewGuest::Navigate \\
must ask for the override"
  ;;
"1 1 0 "*)
  FAILURE="the page never had the cookie the app set: SetElectronCookie \\
must set it in the partition the app's windows load in (StorageOf)"
  ;;
"1 1 1 0 "*)
  FAILURE="cookies.get did not find both cookies for the page's URL: \\
GetElectronCookies, or ElectronCookieMatches dropped one"
  ;;
"1 1 1 1 0")
  FAILURE="THE PAGE KEPT ITS COOKIES OR localStorage AFTER clearStorageData: \\
ClearElectronStorage must clear every storage of the session's partition"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-session: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
