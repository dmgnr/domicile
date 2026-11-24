#!/usr/bin/env bash
# An Electron app's protocol handlers: a window opens at a file: URL its app
# serves, the page's file: subresources come from the app too, in one piece
# or streamed, and the page's https requests go to the app when its session
# handles https, with their bodies. A session that does not handle file:
# opens no file: window. See "Requests" in docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-protocol.sh /build/chromium/src
#
# Set up as guard-electron-preload.sh is. A python client plays
# `electron-host`: it handles file: and https in the app's own session,
# serves guard-electron-protocol-app/ for file:///guard-app/, answers
# https://guard.test/ itself (no network), and asserts:
#
#   ready        the socket took the hello
#   served       window 1 opened at file:///guard-app/index.html, which the app
#                served
#   streamed     the page's data.js came from the app in pieces
#   intercepted  the page's https://guard.test/api.js came from the app, not
#                the network
#   echoed       the page's fetch POST reached the app with its body, and the
#                app's answer reached the page
#   refused      the control: a window in a session that does not handle file:
#                is refused, not opened
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
  annotate "guard-electron-protocol: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-protocol-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-protocol-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-protocol-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-protocol-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-protocol-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-protocol-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-protocol-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-protocol-app.log}"
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
  annotate "guard-electron-protocol: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-protocol: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-protocol: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
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
python3 - "$ELECTRON" "$FOR_SECONDS" "$SCRIPTS/guard-electron-protocol-app" \
  >"$APP_LOG" 2>&1 <<'PY'
import base64, json, os, socket, sys, time

path, seconds, root = sys.argv[1], float(sys.argv[2]), sys.argv[3]
heard = []
echoed_body = []

def send(request):
    connection.sendall((json.dumps(request) + "\n").encode())

def respond(number, body, content_type, extra=()):
    send({"type": "protocol_response", "request": number, "status": 200,
          "headers": [["content-type", content_type]] + list(extra),
          "body": base64.b64encode(body).decode()})

def answer(event):
    """Serves a page's request as the app's protocol handlers would."""
    number, url = event["request"], event["url"]
    if url.startswith("file:///guard-app/data.js"):
        # In pieces: a streamed response, then its body twice, then its end.
        send({"type": "protocol_response", "request": number, "status": 200,
              "headers": [["content-type", "text/javascript"]],
              "stream": True})
        for piece in (b"window.data = 'stre", b"amed';"):
            send({"type": "protocol_data", "request": number,
                  "data": base64.b64encode(piece).decode()})
        send({"type": "protocol_end", "request": number})
    elif url.startswith("file:///guard-app/"):
        name = os.path.basename(url[len("file:///guard-app/"):]) or "index.html"
        try:
            with open(os.path.join(root, name), "rb") as page_file:
                respond(number, page_file.read(), "text/html")
        except OSError:
            send({"type": "protocol_response", "request": number,
                  "error": "no file " + name})
    elif url == "https://guard.test/api.js":
        respond(number, b"window.api = 'intercepted';", "text/javascript")
    elif url == "https://guard.test/echo":
        body = base64.b64decode(event.get("body", ""))
        echoed_body.append(body)
        respond(number, (event["method"] + " ").encode() + body, "text/plain",
                [["access-control-allow-origin", "*"]])
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

def titled(window, prefix):
    return lambda e: (e.get("type") == "title_changed" and
                      e.get("window") == window and
                      e.get("title", "").startswith(prefix))

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0 0 0", flush=True)
    sys.exit(0)
reader = connection.makefile("r", encoding="utf-8")

send({"type": "hello", "version": 1, "app_id": "guard.electron.protocol",
      "partition": "persist:electron-guard-protocol",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "handle_protocol", "session": "", "scheme": "file"})
send({"type": "handle_protocol", "session": "", "scheme": "https"})
send({"type": "open_window", "window": 1,
      "url": "file:///guard-app/index.html"})
done = hear_until(titled(1, "done|"))
send({"type": "open_window", "window": 2,
      "url": "file:///guard-app/index.html", "session": "other"})
refused = hear_until(lambda e: e.get("window") == 2 and
                     e.get("type") in ("window_refused", "window_opened"))

# "done|<data.js's>|<api.js's>|<the echo>"
words = (done or {}).get("title", "").split("|") + ["", "", ""]
served = any(e.get("type") == "protocol_request" and
             e.get("url") == "file:///guard-app/index.html" for e in heard)
print("measured: %d %d %d %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    served and done is not None,
    words[1] == "streamed",
    words[2] == "intercepted",
    words[3] == "POST hi" and echoed_body == [b"hi"],
    refused is not None and refused["type"] == "window_refused"),
    flush=True)
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready served streamed intercepted echoed refused)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-protocol-guard.sh`
# runs this block directly. MEASURED is "<ready> <served> <streamed>
# <intercepted> <echoed> <refused>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1 1")
  PASSED="an Electron window opened at a file: URL its app served, its \
subresources came from the app whole and streamed, its https requests went \
to the app with their bodies, and a session that does not handle file: \
opened no file: window"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the window never loaded the page the app served: content kept \
file: out of the guest (MayGuestLoadUnsafeScheme, patch 0221), the \
navigation never reached the app (ElectronNavigationLoaderFactory), or the \
response never reached the page (ElectronURLLoader::Respond) -- the app's \
log has what it heard"
  ;;
"1 1 0 "*)
  FAILURE="the streamed data.js never ran: the page's file: subresources \
did not reach the app (AddElectronSubresourceLoaderFactories, which must \
replace content's file: loader), or the streamed body was lost \
(ElectronApp::ReceiveData, ElectronURLLoader::Data and End)"
  ;;
"1 1 1 0 "*)
  FAILURE="THE PAGE'S HTTPS REQUEST WENT TO THE NETWORK although its session \
handles https: ProxyElectronNetworkLoads must front the page's network \
loads (WillCreateURLLoaderFactory, patch 0221)"
  ;;
"1 1 1 1 0 "*)
  FAILURE="the page's fetch POST did not reach the app with its body, or \
the app's answer did not reach the page: ElectronURLLoader::ReadBody, or \
the response's CORS headers -- the app's log has what it heard"
  ;;
"1 1 1 1 1 0")
  FAILURE="A SESSION THAT DOES NOT HANDLE FILE: OPENED A FILE: WINDOW: \
ElectronApp::Opens must refuse a scheme the window's session does not handle"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-protocol: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
