#!/usr/bin/env bash
# An Electron app's menu bar: the menu an app sets for its window is listed
# to the shell with the window, as the shell draws it under the window's tab,
# and a click on an entry there reaches the app. Its popup menus
# (`Menu.popup`) are listed and answered the same way. See "Menus" in
# docs/architecture/ELECTRON-APPS.md.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-electron-menu-bar.sh /build/chromium/src
#
# Set up as guard-electron-views.sh is, with an HTTP server of its own on
# 127.0.0.1, and a shell of its own (guard-electron-menu-bar-module.js) that
# says each window's menu and popup menu as it reads them, clicks "&Quit"
# once and chooses "&Settings" from a popup. A python client plays
# `electron-host`: it opens a window, sets a File menu holding Quit, waits for
# the click, then takes the menu away and hides the bar. Then it pops up a
# menu at a point, waits for the choice, pops up another with no point, and
# puts it away. It asserts:
#
#   ready    the socket took the hello
#   listed   the shell read the window's menu, with its flags
#   clicked  the app heard the click on Quit, by its id
#   cleared  the shell read the window with no menu and the bar's new flags
#   popped   the shell read both popups, the first at the app's point and the
#            second at the page's top left, as nothing was pressed there
#   chose    the app heard the popup's choice of Settings, by its id
#   closed   the app heard the second popup closed with nothing chosen when
#            it put it away, and the shell read the window with no popup
#
# No control run: the menu is listed only once the app sets it, and the
# cleared listing is the set one's control.
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
  annotate "guard-electron-menu-bar: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-electron-menu-bar-broker}"
COMMAND="${COMMAND:-/tmp/domicile-electron-menu-bar-command}"
ELECTRON="${ELECTRON:-/tmp/domicile-electron-menu-bar-electron}"
CONTROL="${CONTROL:-/tmp/domicile-electron-menu-bar-control}"
PROFILE="${PROFILE:-/tmp/domicile-electron-menu-bar-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-electron-menu-bar-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-electron-menu-bar-socket.log}"
APP_LOG="${APP_LOG:-/tmp/domicile-electron-menu-bar-app.log}"
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
  annotate "guard-electron-menu-bar: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-electron-menu-bar: no python3, and the compositor and the app are both driven by one"
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
  annotate_from "guard-electron-menu-bar: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 2. The engine, with the Electron socket.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-electron-menu-bar-module.js" \
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

import select
pending = [b""]

def entry(id, label, **more):
    return dict({"id": id, "type": "normal", "label": label, "enabled": True,
                 "visible": True, "checked": False}, **more)

try:
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(10)
    connection.connect(path)
except OSError as failure:
    print("no socket: %s" % failure, flush=True)
    print("measured: 0 0 0 0", flush=True)
    sys.exit(0)
connection.settimeout(None)

send({"type": "hello", "version": 1, "app_id": "guard.electron.menu",
      "partition": "persist:electron-guard-menu",
      "electron_version": "45.2.1", "resources_path": "/opt/guard/resources"})
ready = hear_until(lambda e: e["type"] in ("ready", "refused"))
send({"type": "open_window", "window": 1, "url": page})
hear_until(lambda e: e.get("type") == "window_loaded")
send({"type": "set_menu_bar", "window": 1, "visible": True,
      "auto_hide": False, "menu": [
          entry(1, "&File", type="submenu", submenu=[
              entry(2, "&New Window", accelerator="CmdOrCtrl+N"),
              entry(3, "", type="separator"),
              entry(4, "&Quit", accelerator="CmdOrCtrl+Q")])]})
clicked = hear_until(lambda e: e.get("type") == "menu_clicked" and
                     e.get("window") == 1 and e.get("command") == 4)
send({"type": "set_menu_bar", "window": 1, "visible": False,
      "auto_hide": True, "menu": None})
# The shell's listing of it is read from the engine's log.
time.sleep(2)

# A popup at a point, which the shell answers with Settings.
send({"type": "popup_menu", "window": 1, "popup": 1, "x": 12, "y": 30,
      "menu": [entry(5, "&Settings"), entry(7, "", type="separator"),
               entry(8, "&About")]})
chose = hear_until(lambda e: e.get("type") == "popup_menu_closed" and
                   e.get("popup") == 1)
# One with no point, which the shell leaves up until the app puts it away.
send({"type": "popup_menu", "window": 1, "popup": 2,
      "menu": [entry(6, "&Stay")]})
time.sleep(1)
send({"type": "close_popup_menu", "window": 1, "popup": 2})
closed = hear_until(lambda e: e.get("type") == "popup_menu_closed" and
                    e.get("popup") == 2)
time.sleep(1)

print("measured: %d %d %d %d" % (
    ready is not None and ready["type"] == "ready", clicked is not None,
    chose is not None and chose.get("command") == 5,
    closed is not None and closed.get("command") == 0),
    flush=True)
server.shutdown()
PY

APP_MEASURED="$(sed -n 's/^measured: //p' "$APP_LOG")"
LISTED=0
grep -qF "GUARD menu id=1 visible=true auto=false &File>&New Window,,&Quit" \
  "$ENGINE_LOG" && LISTED=1
CLEARED=0
grep -qF "GUARD menu id=1 none visible=false auto=true" "$ENGINE_LOG" &&
  CLEARED=1
POPPED=0
grep -qF "GUARD popup id=1 at=12,30 &Settings,,&About" "$ENGINE_LOG" &&
  grep -qF "GUARD popup id=1 at=0,0 &Stay" "$ENGINE_LOG" && POPPED=1
read -r READY CLICKED CHOSE PUT_AWAY <<<"${APP_MEASURED:-0 0 0 0}"
CLOSED=0
[ "$PUT_AWAY" = 1 ] &&
  [ "$(grep -o 'GUARD popup id=1 [^"]*' "$ENGINE_LOG" | tail -1)" = \
    "GUARD popup id=1 none" ] && CLOSED=1
MEASURED="$READY $LISTED $CLICKED $CLEARED $POPPED $CHOSE $CLOSED"
echo
echo "measured: $MEASURED"
echo "  (ready listed clicked cleared popped chose closed)"

# Which end to blame. `packages/domicile-engine/tests/test-electron-menu-bar-guard.sh`
# runs this block directly. MEASURED is "<ready> <listed> <clicked> <cleared>
# <popped> <chose> <closed>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"1 1 1 1 1 1 1")
  PASSED="the app's menu was listed with its window, a click on it reached \\
the app, and taking it away was listed too; its popup menus were listed where \\
they go, and the choice and the close reached the app"
  ;;
"0 "*)
  FAILURE="the Electron socket did not take the app's hello -- \\
guard-electron-socket.sh is the guard for that"
  ;;
"1 0 "*)
  FAILURE="the shell never read the app's menu: DeskWindows::SetMenuBar \\
must list the menu with its window, and DomicileBrowserWindow.menu give it"
  ;;
"1 1 0 "*)
  FAILURE="THE APP NEVER HEARD THE CLICK ON ITS MENU: clickBrowserWindowMenu \\
must reach the window's ElectronPage, and the app hear menu_clicked"
  ;;
"1 1 1 0 "*)
  FAILURE="the shell kept the app's menu after the app took it away: \\
SetMenuBar must relist the window with no menu and the bar's new flags"
  ;;
"1 1 1 1 0 "*)
  FAILURE="the shell never read the app's popup menus where they go: \\
DeskWindows::ShowPopupMenu must list them with the window \\
(PopupMenuListing, at the app's x and y or the last press), and \\
DomicileBrowserWindow.popupMenu give them"
  ;;
"1 1 1 1 1 0 "*)
  FAILURE="THE APP NEVER HEARD WHAT WAS CHOSEN FROM ITS POPUP MENU: \\
answerBrowserWindowPopupMenu must reach DeskWindows::AnswerPopupMenu, and \\
the app hear popup_menu_closed with the entry's id"
  ;;
"1 1 1 1 1 1 0")
  FAILURE="putting a popup menu away never reached the app, or the shell \\
kept it: ClosePopupMenu must answer it with 0, relist the window with no \\
popup, and the app hear popup_menu_closed"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-electron-menu-bar: $FAILURE" "$ENGINE_LOG"
echo "what the shell read of the menus:" >&2
grep -F "GUARD menu" "$ENGINE_LOG" >&2 || echo "  nothing" >&2
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the app heard:" >&2
tail -20 "$APP_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
