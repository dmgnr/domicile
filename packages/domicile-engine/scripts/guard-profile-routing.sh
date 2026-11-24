#!/usr/bin/env bash
# A browser window taken to another profile's site moves there, in place.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-profile-routing.sh /build/chromium/src
#
# Headless and software-composited like the other <webview> guards. It reads
# the shell's and the page's console lines and the browser's own from the
# engine's log, so it needs no pixels and no client.
#
# WHY THIS EXISTS. The config's `browser.sites` puts a site in a profile, and
# the engine moves a page there when the user takes it to that site
# (docs/architecture/BROWSER-PROFILES.md): the window keeps its id and place,
# and a new page in the other profile takes its old one's place. The shell's
# <webview> shows that new page only because the browser tells it to ask for
# the window again (WebViewGuestClient.Replaced); when that fails the window
# goes blank or keeps the old page, with nothing in the list to say so.
#
# The stand-in compositor sends profiles `default` and `work`, with
# `localhost` in `work`. The shell opens one window at 127.0.0.1, which no
# site names, draws it, and sets the <webview>'s `src` to the same page at
# localhost, as the address bar does. Asserted:
#
#   the shell page ran           or nothing was set up
#   the page loaded at 127.0.0.1 a window was opened where routing put it
#   the shell navigated          then settled
#   the browser moved the window `moved browser window N to browser profile
#                                work` in its log
#   the list says `work`         the window's profile, as the shell hears it
#   attached twice               once at first, and once for the new page
#   visible at localhost         the new page's last state
#
# HOW IT CAN FAIL. NEGATIVE=1 runs the control: the same profiles with no
# sites. The same navigation must keep the window in `default`, attached once,
# with the page at localhost visible -- so the claim's move is the sites'.
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
  annotate "guard-profile-routing: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 names no sites. See the header.
NEGATIVE="${NEGATIVE:-0}"
MODE="routed"
SITES='{"localhost": "work"}'
[ "$NEGATIVE" = "1" ] && MODE="unrouted" && SITES='{}'

OUT="${OUT:-out/Domicile}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
BROKER="${BROKER:-/tmp/domicile-profile-routing$WHICH-broker}"
CONTROL="${CONTROL:-/tmp/domicile-profile-routing$WHICH-control}"
PROFILE="${PROFILE:-/tmp/domicile-profile-routing$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-profile-routing$WHICH-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-profile-routing$WHICH-socket.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-profile-routing$WHICH-http.log}"
FOR_SECONDS="${FOR_SECONDS:-90}"
# Without a size the headless window's viewport is empty, so the <webview> is
# out of it and its page reads `hidden`.
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"
# How long the shell waits after the first page shows, and after navigating,
# so each load and attach has landed before the next step.
SETTLE_MS="${SETTLE_MS:-3000}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-profile-routing: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-profile-routing: no python3, which serves the page and the compositor's end of the socket"
  exit 77
}

fresh_broker
rm -f "$CONTROL"
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The page, on its own server like every <webview> guard's: `crux` reaches
#    no arbitrary host.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-profile-routing-server.py" --port 0 >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-profile-routing: its page server never came up" "$HTTP_LOG"
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-profile-routing: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}

# 2. The compositor's end, with the profiles and the sites.
PROFILES="{\"profiles\": [\
{\"id\": \"default\", \"name\": \"Default\", \"color\": \"#0d9488\", \
\"private\": false, \"extensions\": null}, \
{\"id\": \"work\", \"name\": \"Work\", \"color\": \"#d97706\", \
\"private\": false, \"extensions\": null}, \
{\"id\": \"private\", \"name\": \"Private\", \"color\": \"#a78bfa\", \
\"private\": true, \"extensions\": null}], \
\"default_profile\": \"default\", \"default_private_profile\": \"private\", \
\"sites\": $SITES}"
rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-extension-installer-compositor.py" \
  --socket "$CONTROL" --browser-profiles "$PROFILES" >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-profile-routing: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

# 3. The engine. The addresses go last: they are URLs, whose own `?` and `&`
#    an encoded `:` and `/` keep out of the shell's.
FROM="http%3A%2F%2F127.0.0.1%3A$PORT%2Fpage"
TO="http%3A%2F%2Flocalhost%3A$PORT%2Fpage"
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --window-size="$WIDTH,$HEIGHT" \
  --app="domicile://shell/?settle=$SETTLE_MS&from=$FROM&to=$TO" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-profile-routing.js" \
  --domicile-control-socket="$CONTROL" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# 4. Wait for the shell to settle after navigating.
TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD settled" "$ENGINE_LOG" ||
  echo "the shell never settled; the verdict below says what that means" >&2

# Whether the shell ran, the first page loaded at 127.0.0.1, the shell
# navigated and settled, the browser moved the window, the window's last
# profile as listed (`none` for none), how many times the browser attached the
# window, and the last state of the page at localhost (`none` for none).
READ="$(awk '
  /GUARD shell-loaded/ { shell = 1 }
  /GUARD page-loaded at=127\.0\.0\.1/ { first = 1 }
  /GUARD navigated/ { navigated = 1 }
  /GUARD settled/ { settled = 1 }
  /domicile: moved browser window [0-9]+ to browser profile work/ { moved = 1 }
  match($0, /GUARD profile=[a-z0-9-]*/) {
    profile = substr($0, RSTART + 14, RLENGTH - 14)
  }
  /domicile: attached browser window/ { attaches++ }
  match($0, /GUARD state=[a-z]+ at=localhost/) {
    state = substr($0, RSTART + 12, RLENGTH - 12 - 13)
  }
  END {
    printf "%d %d %d %d %s %d %s\n", shell, first, (navigated && settled),
      moved, (profile == "" ? "none" : profile), attaches,
      (state == "" ? "none" : state)
  }' "$ENGINE_LOG" 2>/dev/null)"

MEASURED="$MODE $READ"
echo
echo "measured: $MEASURED"
echo "  (mode shell first-page navigated-and-settled moved profile attaches last-state-at-localhost)"

# Which end to blame. `packages/domicile-engine/tests/test-profile-routing-guard.sh`
# runs the reading and this block directly.
FAILURE=""
PASSED=""
case "$MEASURED" in
"routed 1 1 1 1 work 2 visible")
  PASSED="a browser window taken to another profile's site moved there in \
place: the list says its new profile, its <webview> was given the new page, \
and that page shows"
  ;;
"unrouted 1 1 1 0 default 1 visible")
  PASSED="the control is sharp: with no sites, the same navigation left the \
window in the default profile, attached once, with the page at localhost \
shown -- so the claim's move is the sites'"
  ;;
"routed 0 "* | "unrouted 0 "*)
  FAILURE="the shell page never ran, so nothing here was set up: the module \
did not load, or it threw, and the engine log has its console"
  ;;
"routed 1 0 "* | "unrouted 1 0 "*)
  FAILURE="the first page never loaded at 127.0.0.1: openBrowserWindow opened \
no window, or opened it somewhere that did not load it, or the list never \
reached the shell"
  ;;
"routed 1 1 0 "* | "unrouted 1 1 0 "*)
  FAILURE="the shell never navigated and settled: its <webview> never \
reported the first page, so the window was not attached at first"
  ;;
"routed 1 1 1 0 "*)
  FAILURE="THE BROWSER NEVER MOVED THE WINDOW: the navigation to localhost, a \
site the config puts in profile work, stayed in the default profile. The \
stand-in's profiles reached the browser ('sent the browser profiles'), so the \
routing throttle did not see the navigation as the user's \
(IsUserNavigation), or routing did not put localhost in work \
(ProfileForUrl, RouteNavigation), or the host refused the move \
(DeskWindows::Reopen logs why)"
  ;;
"routed 1 1 1 1 default "* | "routed 1 1 1 1 none "*)
  FAILURE="the browser moved the window but the list never said work: the \
new page was not listed under the window's id, or its profile was not read \
from its context (BrowserProfileRegistry::IdOf)"
  ;;
"routed 1 1 1 1 work 1 "*)
  FAILURE="THE WINDOW MOVED BUT ITS <webview> NEVER SHOWED THE NEW PAGE: the \
browser attached the window once, so the element was not told its page was \
replaced, or did not ask again from a new placeholder \
(WebViewGuest::Replaced, HTMLWebViewElement::Replaced)"
  ;;
"routed 1 1 1 1 work "*)
  FAILURE="the window moved and was attached again, but the page at \
localhost was not visible at the end: the new page did not load, or it was \
attached and not shown (AttachWindowTo's WasShown)"
  ;;
"unrouted 1 1 1 1 "*)
  FAILURE="the window moved with no sites at all, so something other than \
the config's sites moves pages, and the claim proves nothing"
  ;;
"unrouted "*)
  FAILURE="the control's window, which nothing should move, was not left in \
the default profile, attached once and shown at localhost, so the claim says \
nothing about routing"
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED) -- \
the run did not get as far as reading"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-profile-routing: $FAILURE" "$ENGINE_LOG"
echo "the compositor stand-in said:" >&2
tail -20 "$SOCKET_LOG" >&2
echo "the shell's and the page's steps and the browser's moves, in order:" >&2
grep -E "GUARD |domicile: (attached|moved|browser window)" "$ENGINE_LOG" >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
