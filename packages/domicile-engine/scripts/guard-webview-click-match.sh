#!/usr/bin/env bash
# Checks that a <webview> clicks the first element in its page that matches a
# CSS selector, in the page's document rather than the shell's.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-click-match.sh /build/chromium/src
#
# - The shell clicks `body` in the guest page, which logs each mousedown it
#   hears. It also clicks `[`, which must throw a SyntaxError.
# - Headless: the click is the page's events, not input the desk draws.
# - Control (`NEGATIVE=1`): click `body > video`, which the page has none of.
#   It must answer false and the page hear no press, or the positive run's
#   press proves nothing.
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
  annotate "guard-webview-click-match: no path to chromium/src was given"
  exit 1
fi

NEGATIVE="${NEGATIVE:-0}"
SELECTOR="body"
WANT=true
[ "$NEGATIVE" = "1" ] && SELECTOR="body%20%3E%20video" && WANT=false

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-click-match-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-click-match-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"
FOR_SECONDS="${FOR_SECONDS:-90}"

# A run and its control keep separate logs so a failure can compare them.
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-click-match$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-click-match$WHICH-http.log}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-click-match: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-click-match: no python3, and the page in the window is served by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The page a browser window shows.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-guest-page.py" --port 0 >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-click-match: its page server never came up" "$HTTP_LOG"
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-click-match: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SUBJECT="http://127.0.0.1:$PORT/page"

# 2. The engine, showing the shell module as a domicile:// document.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?src=$SUBJECT&selector=$SELECTOR" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-click-match.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" ||
  echo "the shell page never ran" >&2
for _ in $(seq 1 "$TRIES"); do
  grep -qE "GUARD (clicked|never-clicked|threw)" "$ENGINE_LOG" 2>/dev/null && break
  sleep 0.25
done

saw() { # $1 pattern
  grep -qF "$1" "$ENGINE_LOG" && echo 1 || echo 0
}
# What `GUARD clicked matched=` says, or nothing.
clicked() {
  grep -o "GUARD clicked matched=[a-z]*" "$ENGINE_LOG" | head -1 | cut -d= -f2
}

SAW_SHELL=$(saw "GUARD shell-loaded")
SAW_BAD_SELECTOR=$(saw "GUARD bad-selector name=SyntaxError")
CLICKED="$(clicked)"
# The press the page heard, which only the click sends: the guard drives no
# input.
SAW_PRESS=$(saw "GUARD guest-mousedown")

echo
echo "shell=$SAW_SHELL bad selector refused=$SAW_BAD_SELECTOR"
echo "selector=$SELECTOR clicked=$CLICKED (want $WANT) page heard a press=$SAW_PRESS"
echo

# The verdict. `packages/domicile-engine/tests/test-webview-count-matches-guard.sh` runs this block.
FAILURE=""
PASSED=""
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran: the harness did not load the module, or \
it threw"
elif [ "$SAW_BAD_SELECTOR" != "1" ]; then
  FAILURE="clickMatch(\"[\") did not throw a SyntaxError: \
HTMLWebViewElement::clickMatch took a selector that does not parse"
elif [ -z "$CLICKED" ]; then
  FAILURE="clickMatch() never answered: the element has no clickMatch, or \
WebViewGuest.ClickMatch gave no answer. The engine log has the shell's last \
reason"
elif [ "$CLICKED" != "$WANT" ]; then
  FAILURE="clickMatch answered $CLICKED where the page's match says $WANT: \
ClickMatchScript in page_matches.cc did not look for the selector it was given"
elif [ "$NEGATIVE" = "1" ] && [ "$SAW_PRESS" = "1" ]; then
  FAILURE="the page heard a press with nothing to click: the press came from \
somewhere other than ClickMatchScript, so the positive run's proves nothing"
elif [ "$NEGATIVE" = "1" ]; then
  PASSED="a selector the page has none of clicks nothing"
elif [ "$SAW_PRESS" != "1" ]; then
  FAILURE="clickMatch answered true but the page heard no mousedown: \
ClickMatchScript's events never reached the page's document"
else
  PASSED="the page's body is clicked, and the page hears the press"
fi
if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-click-match: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
