#!/usr/bin/env bash
# A page in a <webview> has none of the APIs whose only UI is a Chrome sheet or
# window (patch 0183 and domicile_chrome_dialogs.cc).
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-webview-chrome-sheets.sh /build/chromium/src
#
# Headless with software compositing, like guard-webview-click.sh: nothing here
# is measured in pixels, and nothing is pressed.
#
# Payment Request asks with a Chrome sheet, and picture-in-picture video floats
# in a Chrome window. The engine turns both off, so a site falls back to its
# own forms, and a video has no picture-in-picture button. FedCM ("Sign in
# with") asks the shell instead: see guard-webview-sign-in-with.sh.
#
# The page is guard-webview-chrome-sheets-server.py's: /probe reads what it
# has and sends it to /report, which the server prints.
#
# Assertions, in order; each is meaningful only if the previous one holds:
#
#   the shell page ran               or nothing was set up
#   the page reported                the guest was made, attached and
#                                     navigated, and the page's script ran
#   the probe sees APIs              navigator.credentials and document
#                                     picture-in-picture are there, so an
#                                     absent API is the engine's doing and
#                                     not the probe's (the control)
#   no Payment Request               PaymentRequest is undefined
#   no picture-in-picture video      document.pictureInPictureEnabled is false
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
  annotate "guard-webview-chrome-sheets: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-webview-chrome-sheets-broker}"
PROFILE="${PROFILE:-/tmp/domicile-webview-chrome-sheets-profile}"
WIDTH="${WIDTH:-1024}"
HEIGHT="${HEIGHT:-768}"

# Height of the shell's strip in CSS pixels.
#
# Not `STRIP`: `nix develop .#full` exports `STRIP=strip`. See
# guard-webview-external-app.sh.
STRIP_HEIGHT="${STRIP_HEIGHT:-64}"

# Time for the shell to load and its guest to attach and navigate, and for
# the page's report.
FOR_SECONDS="${FOR_SECONDS:-90}"

ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-webview-chrome-sheets-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-webview-chrome-sheets-http.log}"

# What the server writes for the page's report and for nothing else. The
# `GUARD` prefix keeps the server's `serving /probe and /report` banner from
# matching, which would end the wait before the page reported.
REPORT_LINE="GUARD report "

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-webview-chrome-sheets: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-webview-chrome-sheets: no python3, and the page in the window is served by one"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

# Waits for `$2` to appear in `$3`, for `$1` quarter-seconds.
wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The pages: one local server, because `crux` cannot reach arbitrary hosts.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-webview-chrome-sheets-server.py" --port 0 \
  >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-webview-chrome-sheets: its page server never came up" "$HTTP_LOG"
  echo "the server said:" >&2
  tail -20 "$HTTP_LOG" >&2
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-webview-chrome-sheets: its page server never said which port it took" "$HTTP_LOG"
  exit 1
}
SITE="http://127.0.0.1:$PORT"
WALK="src=$SITE/probe"
echo "walking $WALK"

# 2. The engine, on a domicile:// document, because the browser binds
#    WebViewGuestHost for that origin only.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/?strip=$STRIP_HEIGHT&$WALK" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-webview-chrome-sheets.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size="$WIDTH,$HEIGHT" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD shell-loaded" "$ENGINE_LOG" || {
  annotate_from "guard-webview-chrome-sheets: the shell page never ran, so nothing here was ever set up" "$ENGINE_LOG"
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
echo "the shell is up, with a <webview> under a ${STRIP_HEIGHT}px strip"

# 3. The page's report.
wait_for_line "$TRIES" "$REPORT_LINE" "$HTTP_LOG" ||
  echo "the page never reported" >&2

saw() { # $1 pattern
  grep -qF -- "$1" "$HTTP_LOG" && echo 1 || echo 0
}

SAW_SHELL=$(grep -qF "GUARD shell-loaded" "$ENGINE_LOG" && echo 1 || echo 0)
SAW_REPORT=$(saw "$REPORT_LINE")
SAW_APIS=$(grep -F "$REPORT_LINE" "$HTTP_LOG" | grep -F "credentials=object" |
  grep -qF "docpip=object" && echo 1 || echo 0)
SAW_NO_PAYMENT=$(saw "payment=undefined")
SAW_NO_PIP=$(saw "pip=false")

echo
grep -F "$REPORT_LINE" "$HTTP_LOG" || true
echo "shell=$SAW_SHELL report=$SAW_REPORT apis=$SAW_APIS"
echo "no payment=$SAW_NO_PAYMENT no pip=$SAW_NO_PIP"
echo

# The verdict: names the component to blame. Checks run in dependency order.
# `packages/domicile-engine/tests/test-webview-chrome-sheets-guard.sh` runs this block directly.
FAILURE=""
PASSED=""
if [ "$SAW_SHELL" != "1" ]; then
  FAILURE="the shell page never ran, so nothing here was set up. This is the \
harness: the module did not load, or it threw, and the engine log has its \
console"
elif [ "$SAW_REPORT" != "1" ]; then
  FAILURE="the page never reported. That is the guest: it was not made, \
attached or navigated, or the page's script never ran"
elif [ "$SAW_APIS" != "1" ]; then
  FAILURE="the page has no navigator.credentials or document \
picture-in-picture, so an absent API here means nothing. The probe is wrong, \
or the page is not a secure context"
elif [ "$SAW_NO_PAYMENT" != "1" ]; then
  FAILURE="the page has PaymentRequest, whose only UI is Chrome's sheet. \
OverrideWebPreferences did not turn payment_request_enabled off (Blink reads \
that setting for PaymentRequest, over --disable-blink-features)"
elif [ "$SAW_NO_PIP" != "1" ]; then
  FAILURE="the page has picture-in-picture video, which Chrome floats in a \
window of its own. OverrideWebPreferences did not turn \
picture_in_picture_enabled off"
else
  PASSED="a page in a <webview> has no Payment Request and no \
picture-in-picture video, and keeps the APIs around them"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-webview-chrome-sheets: $FAILURE"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "the server said:" >&2
tail -20 "$HTTP_LOG" >&2
exit 1
