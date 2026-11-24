#!/usr/bin/env bash
# Checks a private <webview> and a private browser window keep their storage
# apart from the user's, and lose it once every private page closes.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-private.sh /build/chromium/src
#
# Headless and software-composited: nothing is measured in pixels.
#
# A `<webview private>` and a window from `openPrivateBrowserWindow` get their
# page from the default private profile, off the record (WebViewGuest's
# ContextFor, BrowserProfileRegistry::ContextOf). A cookie set there must not
# reach the user's pages.
#
# Asserts, in order (each only meaningful if the previous holds):
#
#   the shell ran and the setter loaded     the cookie was set
#   a reader on the setter's side has it    the cookie was stored, so its
#                                           absence elsewhere means something
#   a reader on the other side does not     the claim
#   the window is listed with `isPrivate`   the shell can tell
#   the window's page has the cookie        the window is on the setter's side
#   a private reader opened after every     private data lasts only while a
#   private page closed does not have it    private page is open
#
# NEGATIVE=1 sets the cookie in an ordinary <webview> and opens an ordinary
# window. The private reader must not see it, and the window must not be
# listed as private, so a run where every page shares one cookie jar, or where
# every window says private, cannot pass.
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
  annotate "guard-webview-private: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 sets the cookie on the ordinary side. See the header.
NEGATIVE="${NEGATIVE:-0}"

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-private-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-private-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# Time for the shell to load, make five guests and load a page in each.
# Generous because every step is asynchronous and the machine is shared.
FOR_SECONDS="${FOR_SECONDS:-90}"

WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-private$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-private$WHICH-http.log}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-private: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-private: no python3, and the pages are served by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"
mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The setter and reader pages.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-private-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-private: its page server never came up" "$HTTP_LOG"
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-private: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
PRIVATE=1
[ "$NEGATIVE" = "1" ] && PRIVATE=0
echo "setting a cookie at $SITE/set, private=$PRIVATE"

# 2. The engine, on a domicile:// document, because the browser binds
#    WebViewGuestHost only for that origin.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?site=$SITE&private=$PRIVATE" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-private.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# 3. Wait for the last reader, or a crash. The pages report to the server's
#    log: content does not log a private page's console. The `after` reader
#    loads only once every other page has reported.
TRIES=$((FOR_SECONDS * 4))
for _ in $(seq 1 "$TRIES"); do
  grep -qF "GUARD read as=after " "$HTTP_LOG" 2>/dev/null && break
  grep -qF "Received signal" "$ENGINE_LOG" 2>/dev/null && break
  sleep 0.25
done

saw() { # $1 pattern, $2 log
  grep -qF "$1" "$2" && echo 1 || echo 0
}

SAW_SHELL=$(saw "GUARD shell-loaded" "$ENGINE_LOG")
SAW_SET=$(saw "GUARD set-loaded" "$HTTP_LOG")
SAW_CRASH=$(saw "Received signal" "$ENGINE_LOG")
SAW_NORMAL=$(saw "GUARD read as=normal " "$HTTP_LOG")
NORMAL_HAS=$(saw "GUARD read as=normal cookie=seen=1" "$HTTP_LOG")
SAW_PRIVATE=$(saw "GUARD read as=private " "$HTTP_LOG")
PRIVATE_HAS=$(saw "GUARD read as=private cookie=seen=1" "$HTTP_LOG")
SAW_WINDOW=$(saw "GUARD window id=" "$ENGINE_LOG")
WINDOW_PRIVATE=$(saw "private=true" "$ENGINE_LOG")
SAW_WINDOW_READ=$(saw "GUARD read as=window " "$HTTP_LOG")
WINDOW_HAS=$(saw "GUARD read as=window cookie=seen=1" "$HTTP_LOG")
SAW_CLOSED=$(saw "GUARD closed-private" "$ENGINE_LOG")
SAW_AFTER=$(saw "GUARD read as=after " "$HTTP_LOG")
AFTER_HAS=$(saw "GUARD read as=after cookie=seen=1" "$HTTP_LOG")
SAW_ENDED=$(saw "domicile: ended private browsing" "$ENGINE_LOG")
# WebViewGuest's own line for a private guest. Diagnostic only.
SAW_MADE=$(saw "domicile: made a private guest" "$ENGINE_LOG")

echo
echo "shell=$SAW_SHELL set=$SAW_SET crash=$SAW_CRASH made-private=$SAW_MADE"
echo "normal: read=$SAW_NORMAL has=$NORMAL_HAS"
echo "private: read=$SAW_PRIVATE has=$PRIVATE_HAS"
echo "window: listed=$SAW_WINDOW private=$WINDOW_PRIVATE read=$SAW_WINDOW_READ has=$WINDOW_HAS"
echo "after: closed=$SAW_CLOSED ended=$SAW_ENDED read=$SAW_AFTER has=$AFTER_HAS"
echo

# The verdict. `packages/domicile-engine/tests/test-webview-private-guard.sh` runs this block
# directly.
#
# The setter's side is private in the run and ordinary in the control.
FAILURE=""
PASSED=""
SAME_HAS="$PRIVATE_HAS"
OTHER_HAS="$NORMAL_HAS"
WANT_PRIVATE=1
[ "$NEGATIVE" = "1" ] && {
  SAME_HAS="$NORMAL_HAS"
  OTHER_HAS="$PRIVATE_HAS"
  WANT_PRIVATE=0
}
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was ever set up. This is \
the harness: the module did not load, or it threw, and the engine log has its \
console"
elif [ "$SAW_CRASH" = "1" ]; then
  FAILURE="a process dumped a signal. A private guest's page comes from the \
off-the-record profile while its owner is in the user's, so suspect content's \
inner WebContents attach across browser contexts first. Read the dumped stack"
elif [ "$SAW_SET" != "1" ]; then
  FAILURE="the setter's page never loaded, so no cookie was set and nothing \
was measured. That is the guest: it was not made, not attached, or not \
navigated"
elif [ "$SAW_NORMAL" != "1" ] || [ "$SAW_PRIVATE" != "1" ]; then
  FAILURE="a reader's page never loaded, so a missing cookie there is no \
reading. The shell starts both readers on the setter's \
domicile-page-change; see guard-webview-private.js"
elif [ "$SAME_HAS" != "1" ]; then
  FAILURE="a reader on the setter's side does not have the cookie, so it was \
never stored where that side reads, and its absence on the other side means \
nothing. That is the setter's Set-Cookie, or the setter and reader are not in \
one profile"
elif [ "$OTHER_HAS" = "1" ]; then
  FAILURE="THE COOKIE CROSSED: a reader on the other side of the private \
line has it. A private page and an ordinary one share storage, so private \
browsing keeps nothing apart. Check WebViewGuest::CreateAndAttach uses \
BrowserWindowHost::ContextFor for a <webview private>"
elif [ "$SAW_WINDOW" != "1" ]; then
  FAILURE="the opened browser window never reached the shell's list. That is \
DeskWindows::Make, BrowserWindowsClient, or DomicileHost's \
browserwindowschanged"
elif [ "$WINDOW_PRIVATE" != "$WANT_PRIVATE" ]; then
  FAILURE="the window's isPrivate is wrong (wanted $WANT_PRIVATE), so the \
shell would draw a private window as ordinary or the reverse. That is \
DeskWindows::List or DomicileBrowserWindow"
elif [ "$SAW_WINDOW_READ" != "1" ]; then
  FAILURE="the window's page never loaded, so its cookie is no reading. That \
is the window's attach to the shell's <webview window>"
elif [ "$WINDOW_HAS" != "1" ]; then
  FAILURE="the window's page does not have the setter's cookie, so the window \
is not on the side it was opened on. Check the host's ContextFor picks the \
private profile for a private window"
elif [ "$SAW_CLOSED" != "1" ] || [ "$SAW_AFTER" != "1" ]; then
  FAILURE="the reader opened after every private page closed never loaded, \
so whether private data outlives its pages was not measured. The shell closes \
them once each page goes to #reported; see guard-webview-private.js"
elif [ "$AFTER_HAS" = "1" ] && [ "$SAW_ENDED" != "1" ]; then
  FAILURE="private browsing never ended after the last private page closed, \
so a new private page still has the old cookie. Check WebViewGuest's \
destructor reports PrivatePageClosed and BrowserProfileRegistry's \
PrivatePages reaches zero"
elif [ "$AFTER_HAS" = "1" ]; then
  FAILURE="private browsing ended, but a new private page still has the old \
cookie, so it was made in the ending off-the-record profile. Check \
BrowserProfileRegistry::ContextOf finishes the ending profile first"
elif [ "$NEGATIVE" = "1" ]; then
  PASSED="the control is sharp: a cookie set in an ordinary <webview> reaches \
an ordinary reader and window and not a private reader, and the window is not \
listed as private"
else
  PASSED="a cookie set in a private <webview> reaches a private reader and a \
private window, never an ordinary reader, and is gone once every private page \
closes; the window is listed as private"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-private: $FAILURE"
echo "what the engine died of, if it did:" >&2
grep -n -A45 -E "FATAL|Check failed|Received signal" "$ENGINE_LOG" | head -150 >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "what the server was asked for:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
