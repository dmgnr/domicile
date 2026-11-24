#!/usr/bin/env bash
# An Electron app decides on its page's new windows, as setWindowOpenHandler
# does: the engine asks before any opens, a denied one opens nothing, and an
# allowed one is the app's window. See "New windows" in
# docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-window-open.sh /build/chromium/src
#
# WHY THIS EXISTS. The app was never asked: the engine opened its page's links
# itself, in the app's own partition, so Slack's sign-in page and Claude
# Desktop's GitHub links had none of the user's sign-ins, where the app would
# have sent them to the user's browser.
#
# Headless and software-composited like the other Electron guards: the shell
# is guard-app-module.js, the compositor stand-in guard-app-module-compositor.py,
# and a python client plays `electron-host`. It asserts:
#
#   link asked     a noopener window.open() asked the app (window_open)
#   link alone     denied, nothing opened it anyway
#   popup asked    a window.open() the page keeps asked the app too
#   popup opened   allowed, it opened as the app's window 2
#   denied closed  a held window the app denied closed: its opener sees
#                  window.closed
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
  annotate "guard-electron-window-open: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-window-open-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-window-open-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-window-open-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-window-open-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-window-open-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-window-open-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-window-open-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-window-open-app.log}"
FOR_SECONDS="${FOR_SECONDS:-120}"
PAGE_LOG="${PAGE_LOG:-/tmp/domicile-electron-window-open-page.log}"

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
  annotate "guard-electron-window-open: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-window-open: no python3, and the compositor and the app are both driven by one"
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
  --directory "$SCRIPTS/guard-electron-socket-app" >"$PAGE_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "Serving HTTP" "$PAGE_LOG" || {
  annotate_from "guard-electron-window-open: the page's server never started" "$PAGE_LOG"
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
  annotate_from "guard-electron-window-open: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
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
python3 - "$ELECTRON" "$PAGE" "$FOR_SECONDS" >"$APP_LOG" 2>&1 <<'PY'
import json, socket, sys, time

path, page, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
heard = []

def send(request):
    app.sendall((json.dumps(request) + "\n").encode())

def hear(wanted):
    """The first event, heard before or now, that matches `wanted`."""
    for event in heard:
        if wanted(event):
            return event
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        app.settimeout(max(0.1, deadline - time.monotonic()))
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

def run(call, code):
    send({"type": "execute_javascript", "window": 1, "call": call,
          "code": code, "user_gesture": True})
    return hear(lambda e: e.get("type") == "javascript_result" and
                e.get("call") == call)

def asked(query):
    return hear(lambda e: e.get("type") == "window_open" and
                e.get("url") == "%s?%s" % (page, query))

try:
    app = socket.socket(socket.AF_UNIX)
    app.settimeout(10)
    app.connect(path)
    reader = app.makefile("r", encoding="utf-8")
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0", flush=True)
    sys.exit(0)

send({"type": "hello", "version": 1, "app_id": "guard.electron",
      "partition": "persist:electron-guard", "electron_version": "45.2.1",
      "resources_path": "/opt/guard/resources"})
hear(lambda e: e["type"] in ("ready", "refused"))
send({"type": "open_window", "window": 1, "url": page})
loaded = hear(lambda e: e.get("window") == 1 and
              e["type"] in ("window_loaded", "window_refused"))
link = popup = opened = closed = None
if loaded is not None and loaded["type"] == "window_loaded":
    # As a click would: a noopener link the app denies.
    run(1, "window.open('%s?link', '_blank', 'noopener'); 1" % page)
    link = asked("link")
    if link is not None:
        send({"type": "window_open_answer", "ask": link["ask"],
              "action": "deny"})
    # A popup the page keeps, which the app allows as its window 2.
    run(2, "window.open('%s?popup', 'popup'); 2" % page)
    popup = asked("popup")
    if popup is not None:
        send({"type": "window_open_answer", "ask": popup["ask"],
              "action": "allow", "window": 2, "title": "Popup"})
        opened = hear(lambda e: e.get("window") == 2 and
                      e["type"] in ("window_opened", "window_refused"))
    # One it keeps and the app denies: the page's handle sees it closed.
    run(3, "window.denied = window.open('%s?denied', 'denied'); 3" % page)
    denied = asked("denied")
    if denied is not None:
        send({"type": "window_open_answer", "ask": denied["ask"],
              "action": "deny"})
        for call in range(4, 24):
            closed = run(call, "window.denied.closed")
            if closed is not None and closed.get("result") is True:
                break
            time.sleep(0.25)

print("measured: %d %d %d %d" % (
    link is not None,
    popup is not None,
    opened is not None and opened["type"] == "window_opened",
    closed is not None and closed.get("result") is True), flush=True)
PY
sleep 2

# The engine's side: nothing opened the denied link anyway.
ALONE="$(awk -v page="$PAGE" '
  index($0, "domicile: a <webview>'"'"'s page asked for a noopener window at " page "?link") { asked = 1 }
  index($0, "domicile: opened a browser window at " page "?link") { opened = 1 }
  END { printf "%d\n", asked && !opened }
' "$ENGINE_LOG" 2>/dev/null)"
APP="$(sed -n 's/^measured: //p' "$APP_LOG")"
# "<link-asked> <popup-asked> <popup-opened> <denied-closed>" and
# "<link-alone>", in the verdict's order.
set -- $APP
MEASURED="${1:-0} ${ALONE:-0} ${2:-0} ${3:-0} ${4:-0}"
echo
echo "measured: $MEASURED"
echo "  (link-asked link-alone popup-asked popup-opened denied-closed)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-window-open-guard.sh`
# runs this block directly.
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1")
  PASSED="an Electron page's noopener link and its popup each asked the app; \
the denied link opened nowhere, the allowed popup opened as the app's window, \
and a denied popup closed"
  ;;
"0 "*)
  FAILURE="THE APP WAS NOT ASKED ABOUT ITS PAGE'S NOOPENER LINK: patch 0239 \
asks WebViewGuest::TakeNoopenerWindow, which takes it only once OpenElectron \
called DecideWindowsWith -- the app's log says what it heard"
  ;;
"1 0 "*)
  FAILURE="A LINK THE APP DENIED OPENED ANYWAY: TakeNoopenerWindow must answer \
true, so content makes no window, and nothing but the app's answer opens one"
  ;;
"1 1 0 "*)
  FAILURE="THE APP WAS NOT ASKED ABOUT A POPUP ITS PAGE KEEPS: \
WebViewGuest::AddNewContents must hand the held page to DecideWindowsWith's \
callback, and ElectronApp send window_open"
  ;;
"1 1 1 0 "*)
  FAILURE="AN ALLOWED POPUP DID NOT OPEN AS THE APP'S WINDOW: \
ElectronApp::AnswerWindowOpen adopts the held page through ElectronDesk::Adopt \
(DeskWindows::AdoptElectron) and says window_opened"
  ;;
"1 1 1 1 0")
  FAILURE="A POPUP THE APP DENIED STAYED OPEN: dropping the held page must \
destroy its WebContents, so its opener's handle reads closed"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-window-open: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
