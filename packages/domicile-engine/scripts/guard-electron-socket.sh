#!/usr/bin/env bash
# The Electron socket: an app's `electron-host` says hello, opens a window,
# hears it load and take its title, and closes it. See
# docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-socket.sh /build/chromium/src
#
# Headless and software-composited like the other <webview> guards. The page
# is served over http by python's http.server. The shell
# is guard-app-module.js, which draws every browser window, and the
# compositor stand-in is guard-app-module-compositor.py. A python client plays
# `electron-host` and asserts:
#
#   ready              the socket was bound and took the hello
#   window_opened      the window opened as an app window of the app
#   window_loaded      its page finished loading
#   title_changed      its page's title reached the app
#   walked             page_state listed its page's history, with its
#                      renderer's pid, and go_to_index went back in it
#   found              find_in_page found the page's one "window", and
#                      found_in_page said so
#   window_closed      destroy_window closed it, and the app heard
#   chrome:// refused  the control: a page the app may not open stays shut
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
# The shell's window, and so the app window's page: find_in_page searches only
# a page with something on screen, and a headless window has no size unless
# it is given one.
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-electron-socket: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-socket-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-socket-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-socket-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-socket-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-socket-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-socket-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-socket-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-socket-app.log}"
FOR_SECONDS="${FOR_SECONDS:-120}"
PAGE_LOG="${PAGE_LOG:-/tmp/domicile-electron-socket-page.log}"

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
  annotate "guard-electron-socket: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-socket: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-socket: the page's server never started" "$PAGE_LOG"
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
  annotate_from "guard-electron-socket: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the Electron socket.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --window-size="$WIDTH,$HEIGHT" \
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
    connection.sendall((json.dumps(request) + "\n").encode())

def hear_until(wanted):
    """Reads events until one matches `wanted` or time runs out."""
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

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0 0 0 0 0", flush=True)
    sys.exit(0)
reader = connection.makefile("r", encoding="utf-8")

send({"type": "hello", "version": 1, "app_id": "guard.electron",
      "partition": "persist:electron-guard",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "open_window", "window": 1, "url": page})
opened = hear_until(lambda e: e.get("window") == 1 and
                    e["type"] in ("window_opened", "window_refused"))
loaded = hear_until(lambda e: e == {"type": "window_loaded", "window": 1}) \
    if opened and opened["type"] == "window_opened" else None
titled = any(e == {"type": "title_changed", "window": 1,
                   "title": "Electron guard"} for e in heard) or \
    hear_until(lambda e: e.get("type") == "title_changed" and
               e.get("title") == "Electron guard") is not None
def state_of(window, entries, index):
    """A page_state of `window` with `entries` entries, showing `index`."""
    return lambda e: (e.get("type") == "page_state" and
                      e.get("window") == window and
                      len(e.get("entries", [])) == entries and
                      e.get("index") == index and not e.get("loading") and
                      e.get("pid", 0) > 0)

second = page + "?second"
walked = None
if loaded is not None:
    send({"type": "load_url", "window": 1, "url": second})
    if hear_until(state_of(1, 2, 1)) is not None:
        send({"type": "go_to_index", "window": 1, "index": 0})
        walked = hear_until(state_of(1, 2, 0))
found = None
if walked is not None:
    send({"type": "find_in_page", "window": 1, "request": 1,
          "text": "window", "forward": True, "find_next": False,
          "match_case": False})
    found = hear_until(lambda e: e.get("type") == "found_in_page" and
                       e.get("window") == 1)
send({"type": "destroy_window", "window": 1})
closed = hear_until(lambda e: e == {"type": "window_closed", "window": 1})
send({"type": "open_window", "window": 2, "url": "chrome://settings"})
control = hear_until(lambda e: e.get("window") == 2)

print("measured: %d %d %d %d %d %d %d %d" % (
    ready is not None and ready["type"] == "ready",
    opened is not None and opened["type"] == "window_opened",
    loaded is not None,
    bool(titled),
    closed is not None,
    control is not None and control["type"] == "window_refused",
    walked is not None and
    walked["entries"][0]["url"] == page and
    walked["entries"][1]["url"] == second,
    found is not None and found["request"] == 1 and
    found["matches"] == 1 and found["active_match_ordinal"] == 1),
    flush=True)
PY

MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
echo
echo "measured: $MEASURED"
echo "  (ready opened loaded titled closed chrome-refused walked found)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-socket-guard.sh`
# runs this block directly. MEASURED is "<ready> <opened> <loaded> <titled>
# <closed> <chrome-refused> <walked> <found>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1 1 1 1")
  PASSED="an Electron app's window opened over the Electron socket, loaded, \
took its title, listed its history and went back in it, found a word in its \
page, and closed, and a chrome:// page was refused"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello: it was not \
bound (--domicile-electron-socket, StartElectronSocket in StartDesk), or it \
refused the hello -- the app's log says which"
  ;;
"1 0 "*)
  FAILURE="the window did not open: DeskWindows::OpenElectron found no \
shell, or the socket refused it -- the app's log has the answer"
  ;;
"1 1 0 "*)
  FAILURE="the window's page never said it loaded: DeskWindows' Watch did not \
report DocumentOnLoadCompletedInPrimaryMainFrame, or the page did not load"
  ;;
"1 1 1 0 "*)
  FAILURE="the page's title never reached the app: ElectronApp::Listed did \
not hear the desk's listing change"
  ;;
"1 1 1 1 0 "*)
  FAILURE="destroy_window did not close the window, or the app never heard: \
CloseBrowserWindow, or the listing that drops it"
  ;;
"1 1 1 1 1 1 1 0")
  FAILURE="find_in_page never answered with the page's one match: \
ElectronPage::FindInPage, or DidReceiveFindReply and found_in_page, which \
says only a search's final reply. Chromium finds nothing in a page with no \
size, so check the engine log's \"an Electron page heard\" sizes -- the \
app's log has what it heard"
  ;;
"1 1 1 1 1 1 0 "*)
  FAILURE="the page's history never reached the app, or go_to_index did not \
go back in it: ElectronPage::ReportState (NavigationEntryCommitted, \
DidStopLoading) and page_state, or ElectronPage::GoToIndex -- the app's log \
has every page_state it heard"
  ;;
"1 1 1 1 1 0 "*)
  FAILURE="A CHROME:// PAGE WAS NOT REFUSED AS ITS WINDOW'S: \
ParseElectronRequest must refuse every scheme but http and https, and \
ElectronApp send that as window_refused for the window, or the app never \
hears why its load failed -- the app's log shows what it heard"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-socket: $FAILURE" "$ENGINE_LOG"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
