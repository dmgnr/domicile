#!/usr/bin/env bash
# An Electron app's webRequest listeners: the app listens in its own
# session, and its window's page's requests to the network meet them as in
# Electron. onBeforeRequest cancels one request and redirects another,
# onBeforeSendHeaders adds a header the server then sees, onHeadersReceived
# adds a header the page then reads, and onCompleted hears how a request
# went. See "Requests" in docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-web-request.sh /build/chromium/src
#
# Set up as guard-electron-protocol.sh is, with an HTTP server of its own on
# 127.0.0.1 in place of the network. A python client plays `electron-host`,
# and asserts:
#
#   ready       the socket took the hello
#   canceled   the page's fetch of /blocked failed: onBeforeRequest
#               canceled it
#   redirected  the page's fetch of /moved read /landed: onBeforeRequest
#               redirected it
#   sent        the server saw the header onBeforeSendHeaders added
#   received    the page read the header onHeadersReceived added
#   told        onCompleted heard /echo, from window 1, as an xhr; and
#               onBeforeRequest heard the page itself as its mainFrame
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
  annotate "guard-electron-web-request: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-web-request-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-web-request-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-web-request-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-web-request-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-web-request-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-web-request-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-web-request-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-web-request-app.log}"
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
  annotate "guard-electron-web-request: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-web-request: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-web-request: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
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
python3 - "$ELECTRON" "$FOR_SECONDS" "$SCRIPTS/guard-electron-web-request-app" \
  >"$APP_LOG" 2>&1 <<'PY'
import http.server, json, socket, sys, threading, time

path, seconds, root = sys.argv[1], float(sys.argv[2]), sys.argv[3]
heard = []
seen_headers = []

class Server(http.server.BaseHTTPRequestHandler):
    """The network: the page, and what each of its fetches reads."""
    def do_GET(self):
        if self.path == "/index.html":
            with open(root + "/index.html", "rb") as page_file:
                self.answer(page_file.read(), "text/html")
        elif self.path == "/echo":
            seen_headers.append(self.headers.get("x-guard", "none"))
            self.answer(self.headers.get("x-guard", "none").encode(),
                        "text/plain")
        elif self.path in ("/landed", "/plain", "/blocked", "/moved"):
            self.answer(self.path[1:].encode(), "text/plain")
        else:
            self.send_error(404)

    def answer(self, body, content_type):
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = "http://127.0.0.1:%d" % server.server_address[1]

def send(request):
    connection.sendall((json.dumps(request) + "\n").encode())

def answer(event):
    """Answers a waiting event as the app's listeners would."""
    reply = {"type": "web_request_answer", "ask": event["ask"]}
    url = event["url"]
    if event["event"] == "before_request" and url == origin + "/blocked":
        reply["cancel"] = True
    elif event["event"] == "before_request" and url == origin + "/moved":
        reply["redirect_url"] = origin + "/landed"
    elif event["event"] == "before_send_headers" and url == origin + "/echo":
        reply["request_headers"] = (event["request_headers"] +
                                    [["x-guard", "from-app"]])
    elif event["event"] == "headers_received" and url == origin + "/plain":
        reply["response_headers"] = (event["response_headers"] +
                                     [["x-from-app", "yes"]])
    send(reply)

def hear_until(wanted):
    """Reads events until one matches `wanted` or time runs out, answering
    each waiting event on the way."""
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
        if event.get("type") == "web_request" and "ask" in event:
            answer(event)
        if wanted(event):
            return event
    return None

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0 0 0", flush=True)
    sys.exit(0)
reader = connection.makefile("r", encoding="utf-8")

send({"type": "hello", "version": 1, "app_id": "guard.electron.web.request",
      "partition": "persist:electron-guard-web-request",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "web_request_listen", "session": "",
      "events": ["before_request", "before_send_headers",
                 "headers_received", "completed"]})
send({"type": "open_window", "window": 1, "url": origin + "/index.html"})
done = hear_until(lambda e: e.get("type") == "title_changed" and
                  e.get("window") == 1 and
                  e.get("title", "").startswith("done|"))

# "done|<echo>|<blocked>|<moved>|<plain's x-from-app>"
words = (done or {}).get("title", "").split("|") + ["", "", "", ""]
def event_of(name, url, resource_type):
    return any(e.get("type") == "web_request" and e.get("event") == name and
               e.get("url") == origin + url and e.get("window") == 1 and
               e.get("resource_type") == resource_type for e in heard)
print("measured: %d %d %d %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    words[2] == "blocked",
    words[3] == "landed",
    words[1] == "from-app" and seen_headers == ["from-app"],
    words[4] == "yes",
    event_of("completed", "/echo", "xhr") and
    event_of("before_request", "/index.html", "mainFrame")),
    flush=True)
server.shutdown()
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready canceled redirected sent received told)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-web-request-guard.sh`
# runs this block directly. MEASURED is "<ready> <canceled> <redirected>
# <sent> <received> <told>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1 1")
  PASSED="the app's webRequest listeners canceled one request, redirected \
another, added a header the server saw and one the page read, and heard \
each request's events, the page's own as its mainFrame"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 1 1 1 1")
  FAILURE="THE PAGE LOADED /blocked ALTHOUGH THE APP CANCELED IT: \
ElectronWebRequestLoader::AfterBeforeRequest must fail a canceled request \
with ERR_BLOCKED_BY_CLIENT"
  ;;
"1 0 0 0 0 "*)
  FAILURE="none of the app's listeners changed anything: the page's \
network loads never reached ElectronWebRequestLoader \
(ElectronURLLoaderFactory, which ProxyElectronNetworkLoads puts in front of \
them, must start one when the session listens), or the page never loaded \
-- the app's log has what it heard"
  ;;
"1 1 0 "*)
  FAILURE="the page's fetch of /moved did not read /landed: the redirect \
onBeforeRequest asked for never reached the page, or the page's follow did \
not start a new request (ElectronWebRequestLoader::RedirectFromTheApp and \
FollowRedirect)"
  ;;
"1 1 1 0 "*)
  FAILURE="the server never saw the header onBeforeSendHeaders added: \
ElectronWebRequestLoader::AfterBeforeSendHeaders must start the request \
with the app's headers"
  ;;
"1 1 1 1 0 "*)
  FAILURE="the page never read the header onHeadersReceived added: \
ElectronWebRequestLoader::AfterHeadersReceived must replace the response's \
headers before the page has them"
  ;;
"1 1 1 1 1 0")
  FAILURE="the app never heard /echo complete from window 1 as an xhr, or \
the page itself as its mainFrame: ElectronWebRequestLoader::Details and \
Tell, ElectronApp::SendWebRequest's window number, or ResourceTypeOf"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-web-request: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
