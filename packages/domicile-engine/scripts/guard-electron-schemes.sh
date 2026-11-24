#!/usr/bin/env bash
# Electron apps' own schemes, registered as the engine starts: started with
# --domicile-electron-schemes naming guard: as standard, secure and
# supporting fetch(), the engine says so in its answer to hello, and a page
# the app serves at guard://app/ has the origin guard://app, is a secure
# context, fetch()es its own files, and loads a picture from this machine with
# no Local Network Access prompt. A scheme nobody registered has no origin.
# See "Requests" in docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-schemes.sh /build/chromium/src
#
# Set up as guard-electron-protocol.sh is. A python client plays
# `electron-host`: it handles guard: in the app's own session, serves
# guard-electron-schemes-app/ for guard://app/, and asserts:
#
#   ready     the socket took the hello, naming guard: with its privileges
#   origin    the page's origin is guard://app (standard)
#   secure    the page is a secure context (secure)
#   fetched   the page's fetch("data.txt") read what the app served
#             (supportFetchAPI, and the subresource reached the app)
#   local     the page's <img> from http://127.0.0.1 loaded: an app's own
#             scheme is classed loopback (patch 0238), not public, so Local
#             Network Access holds nothing. Headless Chrome denies every
#             prompt, so a held request is a broken picture.
#             guard-shell-local-network.sh's control shows LNA is live.
#   control   a URL in plain:, which nobody registered, has no origin
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
  annotate "guard-electron-schemes: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-schemes-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-schemes-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-schemes-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-schemes-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-schemes-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-schemes-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-schemes-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-schemes-app.log}"
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
  annotate "guard-electron-schemes: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-schemes: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-schemes: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
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
  --domicile-electron-schemes="guard:standard,secure,supportFetchAPI" \
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
python3 - "$ELECTRON" "$FOR_SECONDS" "$SCRIPTS/guard-electron-schemes-app" \
  >"$APP_LOG" 2>&1 <<'PY'
import base64, json, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

path, seconds, root = sys.argv[1], float(sys.argv[2]), sys.argv[3]
heard = []

class Picture(BaseHTTPRequestHandler):
    """A picture on this machine, for the page's Local Network Access check."""

    def do_GET(self):  # noqa: N802 - the name is BaseHTTPRequestHandler's
        body = (b'<svg xmlns="http://www.w3.org/2000/svg" width="1" '
                b'height="1"/>')
        self.send_response(200)
        self.send_header("content-type", "image/svg+xml")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 - the base's name
        print("picture server: " + format % args, flush=True)

pictures = ThreadingHTTPServer(("127.0.0.1", 0), Picture)
threading.Thread(target=pictures.serve_forever, daemon=True).start()
picture = "http://127.0.0.1:%d/picture" % pictures.server_address[1]

def send(request):
    connection.sendall((json.dumps(request) + "\n").encode())

def respond(number, body, content_type):
    send({"type": "protocol_response", "request": number, "status": 200,
          "headers": [["content-type", content_type]],
          "body": base64.b64encode(body).decode()})

def answer(event):
    """Serves a page's request as the app's protocol handler would."""
    number, url = event["request"], event["url"].split("?")[0]
    if url == "guard://app/index.html":
        with open(root + "/index.html", "rb") as page_file:
            respond(number, page_file.read(), "text/html")
    elif url == "guard://app/data.txt":
        respond(number, b"fetched", "text/plain")
    else:
        send({"type": "protocol_response", "request": number,
              "error": "nothing here"})

def hear_until(wanted):
    """Reads events until one matches `wanted` or time runs out, answering
    each protocol request on the way."""
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
        if event.get("type") == "protocol_request":
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

send({"type": "hello", "version": 1, "app_id": "guard.electron.schemes",
      "partition": "persist:electron-guard-schemes",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "handle_protocol", "session": "", "scheme": "guard"})
send({"type": "open_window", "window": 1,
      "url": "guard://app/index.html?picture=" + picture})
done = hear_until(lambda e: e.get("type") == "title_changed" and
                  e.get("window") == 1 and
                  e.get("title", "").startswith("done|"))

# "done|<origin>|<secure context>|<what fetch read>|<the picture>|
#  <plain:'s origin>"
words = (done or {}).get("title", "").split("|") + ["", "", "", "", ""]
listed = (ready or {}).get("schemes") == [
    {"scheme": "guard",
     "privileges": ["standard", "secure", "supportFetchAPI"]}]
print("measured: %d %d %d %d %d %d" % (
    ready is not None and ready["type"] == "ready" and listed,
    words[1] == "guard://app",
    words[2] == "true",
    words[3] == "fetched",
    words[4] == "loaded",
    done is not None and words[5] == "null"),
    flush=True)
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready origin secure fetched local control)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-schemes-guard.sh`
# runs this block directly. MEASURED is "<ready> <origin> <secure> <fetched>
# <local> <control>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1 1")
  PASSED="the engine registered guard: as it started, said so to the app, \
and the app's page at guard://app/ had that origin, was a secure context, \
fetch()ed its own files and loaded a picture from this machine, while plain:, which nobody registered, had no origin"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello, or its ready \
did not name guard: with standard, secure and supportFetchAPI: \
ElectronSchemesIn must read --domicile-electron-schemes \
(components/domicile/common/electron_schemes.h) and ElectronReady must name \
what it read -- guard-electron-socket.sh is the guard for the socket itself"
  ;;
"1 0 "*)
  FAILURE="THE PAGE AT guard://app/ HAD NO guard://app ORIGIN: the scheme was \
not registered as standard. ChromeContentClient::AddAdditionalSchemes must \
add it (patch 0222), in this process and every child, which \
AppendExtraCommandLineSwitches must hand the switch to -- or the page never \
loaded (guard-electron-protocol.sh is the guard for that)"
  ;;
"1 1 0 "*)
  FAILURE="the page at guard://app/ was not a secure context: \
ChromeContentClient::AddAdditionalSchemes must add guard: to secure_schemes \
(patch 0222)"
  ;;
"1 1 1 0 "*)
  FAILURE="the page's fetch(\"data.txt\") read nothing: Blink refuses fetch() \
in a scheme ChromeContentRendererClient::RenderThreadStarted did not register \
as supporting it (patch 0222), or the request never reached the app \
(AddElectronSubresourceLoaderFactories) -- the app's log has what it heard"
  ;;
"1 1 1 1 0 "*)
  FAILURE="THE PAGE AT guard://app/ COULD NOT LOAD A PICTURE FROM THIS \
MACHINE: Local Network Access read the app's page as public and held the \
request. ChromeContentBrowserClient::DetermineAddressSpaceFromURL must class \
an app's own scheme loopback (patch 0238), as it does the shell's -- or the \
picture server was never asked; the app's log says which"
  ;;
"1 1 1 1 1 0")
  FAILURE="PLAIN:, WHICH NOBODY REGISTERED, HAD AN ORIGIN: the engine \
registers schemes nobody named, so this guard measures nothing"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-schemes: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
