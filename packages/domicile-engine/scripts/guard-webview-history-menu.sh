#!/usr/bin/env bash
# Checks `history()` lists a view's pages either side of the current one,
# nearest first, with their titles; `goToHistoryEntry()` goes to one; and
# `goToHistoryEntryInNewWindow()` opens one in a new window and leaves the view
# on its page. These back Chrome-style back and forward menus.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-history-menu.sh /build/chromium/src
#
# Runs headless with software compositing: nothing is measured in pixels.
#
# The view goes to /one, then /two, and lists its history. It goes to the back
# entry, lists again, and opens the forward entry in a new window.
#
# Asserts, in order, since each reading depends on the one before:
#
#   - the shell module ran
#   - the view showed /two, so it had a history to list
#   - the list had /one behind, titled by its page, and nothing ahead
#   - going to the back entry moved the view to /one
#   - the list then had /two ahead and nothing behind
#   - a browser window was listed, at /two
#   - the view stayed on /one
#
# NEGATIVE=1 is the control: the same view and navigations, then
# goToHistoryEntry() with an id no entry has. The view must stay on /two, so a
# view that moves on any call cannot pass.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-last-words.sh
. "$SCRIPTS/lib-last-words.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$SCRIPTS/lib-ports.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-webview-history-menu: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 goes to an entry that does not exist. See the header.
NEGATIVE="${NEGATIVE:-0}"
DRIVE="menu"
[ "$NEGATIVE" = "1" ] && DRIVE="gone"

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-history-menu-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-history-menu-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# SETTLE is the timeout for the first page; STEP for each later one, and how
# long the run watches after the call.
SETTLE_MS="${SETTLE_MS:-25000}"
STEP_MS="${STEP_MS:-8000}"

# SETTLE + three STEPs, plus engine startup, with margin for a shared machine.
FOR_SECONDS="${FOR_SECONDS:-120}"

# The fixture's /slow is unused; it only needs a value.
SLOW_SECONDS=1

WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-history-menu$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-history-menu$WHICH-http.log}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-history-menu: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-history-menu: no python3, and the pages the view has a history of are served by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

# Waits for `$2` to appear in `$3`, for `$1` quarter seconds.
wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The pages, from the history guard's server: `crux` cannot reach
#    arbitrary hosts.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-history-server.py" \
  --port 0 --slow-seconds "$SLOW_SECONDS" >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-history-menu: its page server never came up" "$HTTP_LOG"
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-history-menu: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
echo "serving the view's pages under $SITE"

# 2. The engine, on a domicile:// document: the browser binds
#    WebViewGuestHost only for that origin.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?drive=$DRIVE&src=$SITE&settle=$SETTLE_MS&step=$STEP_MS" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-history-menu.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD driving" "$ENGINE_LOG" || {
  annotate_from "guard-webview-history-menu: the shell module never ran, so nothing was ever driven" "$ENGINE_LOG"
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
echo "the shell is driving mode=$DRIVE"

# 3. The module runs the schedule and watches after the call. Wait for its
#    last line rather than a fixed time.
wait_for_line "$TRIES" "GUARD done" "$ENGINE_LOG" ||
  echo "the schedule never finished; what follows is a run cut short" >&2

saw() { # $1 pattern
  grep -qF "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

SAW_DRIVING=$(saw "GUARD driving mode=$DRIVE")
SAW_TWO=$(saw "GUARD guest-shown path=/two")
# A page's title is its path; see guard-webview-history-server.py.
SAW_LISTED=$(saw "GUARD history back=/one|/one forward=")
SAW_WENT=$(saw "GUARD first-page path=/one")
SAW_STAYED_ON_TWO=$(saw "GUARD first-page path=/two")
SAW_RELISTED=$(saw "GUARD history back= forward=/two|/two")
SAW_ASKED=$(saw "GUARD new-window url=")
SAW_ADDRESS=$(saw "GUARD new-window url=$SITE/two")
SAW_STAYED=$(saw "GUARD first-page-after path=/one")
SAW_FAILED=$(saw "GUARD failed")

echo
echo "shell=$SAW_DRIVING two=$SAW_TWO failed=$SAW_FAILED"
echo "listed=$SAW_LISTED went=$SAW_WENT stayed-on-two=$SAW_STAYED_ON_TWO relisted=$SAW_RELISTED"
echo "new window: asked=$SAW_ASKED address=$SAW_ADDRESS stayed=$SAW_STAYED"
echo

# Picks which side to blame.
# `packages/domicile-engine/tests/test-webview-history-menu-guard.sh` runs
# this block directly.
#
# Ordered by dependency: each arm assumes the readings before it held.
FAILURE=""
PASSED=""
if [ "$SAW_DRIVING" != "1" ]; then
  FAILURE="the shell module never ran, so nothing here was ever set up. This \
is the harness: the module did not load, or it threw"
elif [ "$SAW_TWO" != "1" ]; then
  FAILURE="the view never showed /two, so it had no history to list. That is \
the guest's navigation, which guard-webview-history.sh checks"
elif [ "$SAW_LISTED" != "1" ]; then
  FAILURE="THE HISTORY WAS LISTED WRONG, or not at all: history() never \
answered /one behind, titled /one, with nothing ahead. Look at the history \
line above, WebViewGuest::ListHistory and HistoryMenu"
elif [ "$NEGATIVE" = "1" ]; then
  if [ "$SAW_STAYED_ON_TWO" != "1" ]; then
    FAILURE="THE VIEW MOVED FOR AN ID NO ENTRY HAS: goToHistoryEntry() must \
do nothing then, so what the positive run reads is a view that moves on any \
call"
  else
    PASSED="the control is sharp: an id no entry has left the view on /two"
  fi
elif [ "$SAW_WENT" != "1" ]; then
  FAILURE="GOING TO THE ENTRY DID NOTHING: goToHistoryEntry() never moved the \
view to /one. Look at the element's mojo call and \
WebViewGuest::GoToHistoryEntry's id lookup"
elif [ "$SAW_RELISTED" != "1" ]; then
  FAILURE="THE LIST DID NOT FOLLOW THE PAGE: after going back, history() did \
not answer /two ahead and nothing behind. HistoryMenu splits around the last \
committed entry"
elif [ "$SAW_ASKED" != "1" ]; then
  FAILURE="THE NEW WINDOW NEVER OPENED: goToHistoryEntryInNewWindow() reached \
no window. Look at WebViewGuest::GoToHistoryEntryInNewWindow and the desk's \
OpenHistoryStep"
elif [ "$SAW_ADDRESS" != "1" ]; then
  FAILURE="THE WINDOW WAS OPENED AT THE WRONG ADDRESS: it never said /two, \
the entry asked for. TakeHistoryStep's kEntry index is where that comes from"
elif [ "$SAW_STAYED" != "1" ]; then
  FAILURE="THE VIEW MOVED: the window opened, and the view it came from left \
/one. The step must happen only in the copy"
else
  PASSED="history() listed the pages either side, goToHistoryEntry() went to \
one, and goToHistoryEntryInNewWindow() opened one in a new window"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-history-menu: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "what the server was asked for:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
