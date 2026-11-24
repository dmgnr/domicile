#!/usr/bin/env bash
# Checks spelling in a browser window: a misspelled word's context menu carries
# it and the dictionary's suggestions, a suggestion replaces it, and "Add to
# dictionary" stops it being misspelled.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-spellcheck.sh /build/chromium/src
#
# Headless and software-composited, like guard-webview-context-menu.sh.
#
# Chrome checks spelling with the Hunspell dictionaries beside the engine
# (patch 0246), which it never downloads, so a suggestion here means the build
# put them there and Chrome loaded one. A fresh profile checks in en-US, the
# engine's language, with no config.
#
# Assertions, in order (each depends on the one before):
# - the shell page ran, and the page loaded in the window
# - the engine found its dictionary: it never logged a missing one
# - a right click on "recieve" handed the shell a menu with the word and
#   "receive" among its suggestions
# - replaceMisspelling("receive") replaced it in the page
# - a right click on "zorblax" handed the shell that word
# - after "add-to-dictionary", a right click on it hands over no misspelling
#
# Control (NEGATIVE=1): the field has `spellcheck="false"`. The first menu must
# carry no misspelling.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$SCRIPTS/lib-ports.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-webview-spellcheck: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 serves the field that is not checked. See the header.
NEGATIVE="${NEGATIVE:-0}"

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-spellcheck-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-spellcheck-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# The field fills the window, one 80px line per word, from the top left.
WORD_X=40
FIRST_Y=40
SECOND_Y=120

FOR_SECONDS="${FOR_SECONDS:-90}"

WHICH=""
if [ "$NEGATIVE" = "1" ]; then
  WHICH="-negative"
fi
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-spellcheck$WHICH-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-spellcheck$WHICH-http.log}"
CLICK_LOG="${CLICK_LOG:-/tmp/domicile-webview-spellcheck$WHICH-mouse.log}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-spellcheck: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-spellcheck: no python3, and the page in the window and the clicks are both driven by one"
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

# 1. The page.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-spellcheck-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-spellcheck: its page server never came up" "$HTTP_LOG"
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-spellcheck: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
SRC="$SITE/page"
[ "$NEGATIVE" = "1" ] && SRC="$SITE/page%3Funchecked"
echo "serving two misspelled words at $SRC"

# 2. The engine, on a domicile:// document. `--lang` pins the profile's first
#    dictionary to en-US whatever the runner's locale.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --lang=en-US \
  --app="domicile://shell/?src=$SRC" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-spellcheck.js" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
ENGINE=$!
STARTED+=("$ENGINE")

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" || {
  annotate_from "guard-webview-spellcheck: the shell page never ran, so nothing here was ever set up" "$ENGINE_LOG"
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")" || {
  annotate_from "guard-webview-spellcheck: the engine never said which debugging port it took" "$ENGINE_LOG"
  exit 1
}

wait_for_line "$TRIES" "GUARD page-loaded" "$ENGINE_LOG" ||
  echo "nothing ever loaded in the window" >&2
sleep 3

press() { # $1 y, $2 button
  python3 "$SCRIPTS/guard-webview-click-mouse.py" \
    --port "$DEBUG_PORT" --x "$WORD_X" --y "$1" --button "$2" \
    >>"$CLICK_LOG" 2>&1 ||
    echo "a $2 click at y=$1 could not be driven; see $CLICK_LOG" >&2
}

# 3. Focus the field, and give Blink's idle checker time to mark its words
#    once the dictionary has loaded. A menu only carries a word already
#    marked.
rm -f "$CLICK_LOG"
press "$FIRST_Y" left
sleep 6

# 4. The three menus, each acted on by the shell module. Fixed waits, because
#    the control's reading is an absence.
press "$FIRST_Y" right
sleep 4
press "$SECOND_Y" right
sleep 4
press "$SECOND_Y" right
sleep 3

saw() { # $1 pattern
  grep -qF "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

SAW_SHELL=$(saw "GUARD shell-loaded")
SAW_PAGE=$(saw "GUARD page-loaded")
# The browser's own line, from patch 0246.
SAW_MISSING=$(saw "domicile: the engine has no spelling dictionary for ")
SAW_FIRST=$(saw "GUARD context-menu n=1 ")
SAW_FIRST_WORD=$(saw "GUARD context-menu n=1 misspelled=recieve suggestions=")
SAW_SUGGESTED=0
grep -E "GUARD context-menu n=1 misspelled=recieve suggestions=(.*,)?receive(,|$)" \
  "$ENGINE_LOG" >/dev/null && SAW_SUGGESTED=1
SAW_REPLACED=$(saw "GUARD page-text receive|zorblax")
SAW_SECOND_WORD=$(saw "GUARD context-menu n=2 misspelled=zorblax suggestions=")
SAW_ADDED=$(saw "GUARD context-menu n=3 misspelled= suggestions=")

echo
echo "shell=$SAW_SHELL page=$SAW_PAGE missing-dictionary=$SAW_MISSING"
echo "the first menu: any=$SAW_FIRST word=$SAW_FIRST_WORD suggested=$SAW_SUGGESTED replaced=$SAW_REPLACED"
echo "the second menu: word=$SAW_SECOND_WORD; the third, after adding it: none=$SAW_ADDED"
echo "the menus the shell got:"
grep -F "GUARD context-menu" "$ENGINE_LOG" || true
echo

# Decided here, in a block `packages/domicile-engine/tests/test-webview-spellcheck-guard.sh` runs
# directly.
FAILURE=""
PASSED=""
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was ever set up. This is \
the harness: the module did not load, or it threw, and the engine log has its \
console"
elif [ "$SAW_PAGE" != "1" ]; then
  FAILURE="nothing ever loaded in the window, so there was no field to check. \
That is the guest: it was not made, not attached, or not navigated"
elif [ "$SAW_FIRST" != "1" ]; then
  FAILURE="the shell got no menu for the right click on the first word. That \
is this harness or the context menu itself, which guard-webview-context-menu.sh \
covers"
elif [ "$NEGATIVE" = "1" ]; then
  if [ "$SAW_FIRST_WORD" = "1" ]; then
    FAILURE="the control's field has spellcheck=\"false\" and its menu \
carried a misspelled word anyway: the menu reports words the page asked not \
to check"
  else
    PASSED="the control is sharp: a field that is not checked hands the shell \
a menu with no misspelled word"
  fi
elif [ "$SAW_MISSING" = "1" ]; then
  FAILURE="the engine has no dictionary for en-US beside it: the build's \
domicile_dictionaries target did not copy //third_party/hunspell_dictionaries \
into dictionaries/, or patch 0246's DIR_APP_DICTIONARIES points elsewhere"
elif [ "$SAW_FIRST_WORD" != "1" ]; then
  FAILURE="the menu over \"recieve\" carried no misspelled word. Either \
Chrome checked no spelling (SpellcheckService, the profile's prefs) or the \
word never reached the menu (AsWebViewContextMenu, the element's \
misspelledWord)"
elif [ "$SAW_SUGGESTED" != "1" ]; then
  FAILURE="the menu over \"recieve\" carried the word without \"receive\" \
among its suggestions: AsWebViewContextMenu or the element's \
spellingSuggestions"
elif [ "$SAW_REPLACED" != "1" ]; then
  FAILURE="replaceMisspelling(\"receive\") left the page's text as it was: \
the element's ReplaceMisspelling or WebViewGuest::ReplaceMisspelling"
elif [ "$SAW_SECOND_WORD" != "1" ]; then
  FAILURE="the menu over \"zorblax\" did not carry it, though the first word's \
did. This is likely the press point on the second line"
elif [ "$SAW_ADDED" != "1" ]; then
  FAILURE="after \"add-to-dictionary\", \"zorblax\" was still misspelled: \
WebViewGuest's kAddToDictionary or AddToDictionary in domicile_spellcheck.cc"
else
  PASSED="a misspelled word's menu carried the dictionary's suggestions, one \
replaced the word, and \"Add to dictionary\" stopped another being \
misspelled, with the dictionaries beside the engine"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-spellcheck: $FAILURE"
echo "the engine's last words:" >&2
tail -40 "$ENGINE_LOG" >&2
echo "what the clicks did:" >&2
tail -20 "$CLICK_LOG" >&2
echo "what the server was asked for:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
