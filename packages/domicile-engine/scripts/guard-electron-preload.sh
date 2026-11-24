#!/usr/bin/env bash
# An Electron window's preload and IPC: the preload runs in its own world
# before the page's scripts and exposes an API with contextBridge, the page's
# ipcRenderer.send and invoke reach the app over the Electron socket, and the
# app's webContents.send reaches the page; ipcRenderer.sendSync waits for the
# app's answer, and message ports carry messages both ways. See
# docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-preload.sh /build/chromium/src
#
# Set up as guard-electron-preload.sh is. A python client plays
# `electron-host`, opens window 1 with guard-electron-preload-app/preload.js,
# and asserts:
#
#   ready        the socket took the hello
#   preloaded    the page found the preload's API before its own script ran
#   isolated     the page sees neither `require` nor the preload's globals, and
#                cannot replace the exposed API
#   invoked      ipcRenderer.invoke reached the app and its reply came back
#   synced       ipcRenderer.sendSync returned the app's reply to the page
#   delivered    the app's ipc_send reached the page's ipcRenderer listener
#   ported       a port the app posted, and one the preload posted, each
#                carried a message to the preload and its answer back
#   unpreloaded  the control: window 2, opened without a preload, has no API
#   shaped       the preload's electron module has Electron's webFrame (its own
#                top, by frameToken; insertCSS and removeInsertedCSS),
#                webUtils and crashReporter, process.isMainFrame, the
#                hello's Electron and resources in process,
#                process.argv has the window's additionalArguments, and
#                process is an EventEmitter that says loaded,
#                document-start and document-end
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
  annotate "guard-electron-preload: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-preload-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-preload-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-preload-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-preload-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-preload-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-preload-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-preload-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-preload-app.log}"
FOR_SECONDS="${FOR_SECONDS:-120}"
PAGE_LOG="${PAGE_LOG:-/tmp/domicile-electron-preload-page.log}"

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
  annotate "guard-electron-preload: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-preload: no python3, and the compositor and the app are both driven by one"
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

# 0. The app's page, over http: content loads no file: URL in a guest.
rm -f "$PAGE_LOG"
python3 -u -m http.server 0 --bind 127.0.0.1 \
  --directory "$SCRIPTS/guard-electron-preload-app" >"$PAGE_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "Serving HTTP" "$PAGE_LOG" || {
  annotate_from "guard-electron-preload: the page's server never started" "$PAGE_LOG"
  exit 1
}
PORT="$(sed -n 's/.*port \([0-9]*\).*/\1/p' "$PAGE_LOG" | head -1)"
PAGE="http://127.0.0.1:$PORT/index.html"

# 1. The compositor's end of the control socket.
rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-app-module-compositor.py" --socket "$CONTROL" \
  >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-electron-preload: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
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
python3 - "$ELECTRON" "$PAGE" "$FOR_SECONDS" \
  "$SCRIPTS/guard-electron-preload-app/preload.js" >"$APP_LOG" 2>&1 <<'PY'
import json, socket, sys, time

path, page, seconds, preload_path = (
    sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4])
with open(preload_path, encoding="utf-8") as preload_file:
    preload = preload_file.read()
heard = []

def send(request):
    connection.sendall((json.dumps(request) + "\n").encode())

def hear_until(wanted):
    """Reads events until one matches `wanted` or time runs out. Answers each
    invoke of "double" on the way, as an ipcMain handler would."""
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
        if event.get("type") == "ipc_invoke" and event.get("channel") == "double":
            send({"type": "ipc_reply", "invoke": event["invoke"],
                  "result": event["args"][0] * 2})
        if (event.get("type") == "ipc_send_sync" and
                event.get("channel") == "triple"):
            send({"type": "ipc_reply", "invoke": event["invoke"],
                  "result": event["args"][0] * 3})
        if wanted(event):
            return event
    return None

def message(window, channel):
    return lambda e: (e.get("type") == "ipc_message" and
                      e.get("window") == window and
                      e.get("channel") == channel)

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0 0 0 0 0 0", flush=True)
    sys.exit(0)
reader = connection.makefile("r", encoding="utf-8")

send({"type": "hello", "version": 1, "app_id": "guard.electron",
      "partition": "persist:electron-guard",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "open_window", "window": 1, "url": page, "preload": preload,
      "arguments": ["--guard-argument=1"]})
said = hear_until(message(1, "page"))
seen = said["args"][0] if said and said.get("args") else {}
answered = hear_until(message(1, "answered"))
shaped = hear_until(message(1, "shaped"))
synced = hear_until(message(1, "synced"))
send({"type": "ipc_send", "window": 1, "channel": "ping", "args": ["back"]})
pinged = hear_until(lambda e: e.get("type") == "title_changed" and
                    e.get("window") == 1 and e.get("title") == "pinged back")

def on_port(name):
    return lambda e: (e.get("type") == "port_message" and
                      e.get("window") == 1 and e.get("port") == name)

# The app's port: posted to the page, then a number on it.
send({"type": "ipc_post", "window": 1, "channel": "port", "message": None,
      "ports": ["m1"]})
send({"type": "port_post", "window": 1, "port": "m1", "data": 1})
from_mine = hear_until(on_port("m1"))
# The preload's port: it posted one as the page started.
posted = hear_until(lambda e: e.get("type") == "ipc_post" and
                    e.get("window") == 1 and e.get("channel") == "mine")
theirs = (posted or {}).get("ports") or [""]
send({"type": "port_post", "window": 1, "port": theirs[0], "data": 5})
from_theirs = hear_until(on_port(theirs[0]))
send({"type": "open_window", "window": 2, "url": page})
control = hear_until(lambda e: e.get("type") == "title_changed" and
                     e.get("window") == 2 and e.get("title") == "no preload")

print("measured: %d %d %d %d %d %d %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    said is not None,
    seen == {"require": "undefined", "secret": "undefined", "kept": True,
             "emitted": 7},
    answered is not None and answered.get("args") == [4],
    synced is not None and synced.get("args") == [9],
    pinged is not None,
    from_mine is not None and from_mine.get("data") == 2 and
    posted is not None and posted.get("message") == "a port" and
    from_theirs is not None and from_theirs.get("data") == 50,
    control is not None,
    shaped is not None and shaped.get("args") == [{
        "argv": True, "crash": "kept", "electron": "45.2.1",
        "mainFrame": True, "resources": "/opt/guard/resources",
        "routingId": True, "token": True,
        "top": True, "webUtils": "function", "zoom": 1,
        "heard": ["loaded", "document-start", "document-end"],
        "styled": True, "unstyled": True}]), flush=True)
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready preloaded isolated invoked synced delivered ported unpreloaded shaped)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-preload-guard.sh`
# runs this block directly. MEASURED is "<ready> <preloaded> <isolated>
# <invoked> <synced> <delivered> <ported> <unpreloaded> <shaped>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1 1 1 1 1")
  PASSED="an Electron window's preload ran before its page in its own world, \
its exposed API reached the app with send, invoke and sendSync, the app's \
send reached the page, ports carried messages both ways, a window \
without a preload had none, and the preload had Electron's webFrame, \
webUtils, crashReporter, the window's additionalArguments and process's \
document events"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the page never sent what it saw: the preload did not run before \
the page's script (ElectronPage::ReadyToCommitNavigation must send Preload, \
ElectronPreload::RunAtDocumentStart run it), contextBridge did not expose \
the API, or ipcRenderer.send did not reach the app (ElectronFrameHost Send, \
ElectronApp::PageSent) -- the engine's log has any console error"
  ;;
"1 1 0 "*)
  FAILURE="THE PAGE SAW INTO THE PRELOAD'S WORLD, or could replace its API: \
the preload must run in its own isolated world and ExposeAcrossWorlds define \
a read-only, permanent copy, or ipcRenderer.emit did not reach the preload's \
own listener (the bootstrap in electron_preload.cc) -- the app's log has what \
the page saw"
  ;;
"1 1 1 0 "*)
  FAILURE="ipcRenderer.invoke never came back with the app's reply: \
ElectronApp::PageInvoked, ipc_reply, or ElectronPreload::Answered and the \
bootstrap's settle"
  ;;
"1 1 1 1 0 "*)
  FAILURE="ipcRenderer.sendSync never returned the app's reply: \
ElectronFrameHost SendSync, ElectronApp::PageInvoked's ipc_send_sync, or \
ElectronPreload::SendSync"
  ;;
"1 1 1 1 1 0 "*)
  FAILURE="the app's ipc_send never reached the page's listener: \
ElectronPageOf, ElectronPage::Deliver, or ElectronPreload::Deliver"
  ;;
"1 1 1 1 1 1 0 "*)
  FAILURE="a message port did not carry a message both ways: ipc_post and \
ElectronPage::DeliverPost, the bootstrap's relay, port_post and \
ElectronPreload::DeliverToPort, or ElectronFrameHost PostToPort -- the app's \
log has what it heard"
  ;;
"1 1 1 1 1 1 1 0 "*)
  FAILURE="A WINDOW OPENED WITHOUT A PRELOAD GOT ONE, or its page never \
loaded: ElectronPage must send Preload only for its own window, and only \
when the app gave one"
  ;;
"1 1 1 1 1 1 1 1 0")
  FAILURE="the preload's electron module is not shaped as Electron's: \
webFrame (its frameToken, top, insertCSS and removeInsertedCSS, \
getZoomFactor), webUtils, crashReporter or process.isMainFrame in the \
bootstrap in electron_preload.cc, process.versions.electron or \
process.resourcesPath without the hello's (ElectronHello, ElectronPage, \
Preload's app), process.argv without the window's \
\"arguments\" (ElectronOpenWindow, ElectronPage, Preload's arguments), or \
process not saying loaded, document-start and document-end (the bootstrap's \
emitter, ElectronPreload::RunAtDocumentEnd from RunScriptsAtDocumentEnd in \
patch 0218) -- \
the app's log has what the preload saw"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-preload: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
