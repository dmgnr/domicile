#!/usr/bin/env bash
# Checks that zooming a PDF in a <webview> zooms the document once, through
# the PDF viewer, and leaves the viewer's page at the default zoom.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-pdf-zoom.sh /build/chromium/src
#
# Chrome's PDF viewer asks `chrome.tabs.setZoomSettings` for manual zoom, then
# zooms the document on each `tabs.onZoomChange`. A desk that refuses the mode
# logs `not supported on a Domicile desk` and zooms the viewer's page as well,
# so the PDF zooms twice and the viewer's toolbar grows.
#
# The shell zooms the <webview> to 2. `guard-pdf-zoom.py` reads the page's
# devicePixelRatio, which browser zoom scales, and the viewer's own zoom.
#
# Headless, with no compositor or client.
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
  annotate "guard-pdf-zoom: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-pdf-zoom-broker}"
PROFILE="${PROFILE:-/tmp/domicile-pdf-zoom-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-pdf-zoom-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-pdf-zoom-http.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"
# What the desk answers a chrome.tabs call it refuses (kNotOnADesk).
REFUSAL="not supported on a Domicile desk"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-pdf-zoom: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-pdf-zoom: no python3, which serves the PDF and drives the shell"
  exit 77
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

TRIES=$((FOR_SECONDS * 4))

rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-pdf-after-hiding-server.py" --port 0 >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-pdf-zoom: its PDF server never came up" "$HTTP_LOG"
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-pdf-zoom: its PDF server never said which port it took" "$HTTP_LOG"
  exit 1
}
SUBJECT="http://127.0.0.1:$PORT/guard.pdf"

rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --window-size=1000,800 \
  --app="domicile://shell/?src=$SUBJECT" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-pdf-zoom.js" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

MEASURED=""
if wait_for_line "$TRIES" "GUARD attached" "$ENGINE_LOG"; then
  if DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")"; then
    MEASURED="$(python3 "$SCRIPTS/guard-pdf-zoom.py" \
      --port "$DEBUG_PORT" --tries "$((FOR_SECONDS * 2))")"
  else
    MEASURED="no-port"
  fi
fi
REFUSED="$(grep -cF -- "$REFUSAL" "$ENGINE_LOG")"

FAILURE=""
case "$REFUSED:$MEASURED" in
0:ratio=1.00\ viewer=2.00) ;;
0:viewer=absent)
  FAILURE="the PDF viewer never started: it never got its stream, or a chrome.tabs zoom call never answered it"
  ;;
0:no-port)
  FAILURE="the engine never said which debugging port it took"
  ;;
0:ratio=*\ viewer=2.00)
  FAILURE="the viewer zoomed the PDF to 2 and its page was zoomed too (${MEASURED%% *}): the guest is not in manual zoom mode, so the PDF zooms twice (tabs.setZoomSettings, WebViewGuest::SetZoomMode)"
  ;;
0:ratio=*)
  FAILURE="the viewer never zoomed the PDF to 2 ($MEASURED): tabs.onZoomChange never reached it, or setZoom zoomed nothing (WebViewGuest::ZoomTo)"
  ;;
0:)
  FAILURE="the <webview> never reported its page: the shell module did not run, or openBrowserWindow opened no window"
  ;;
*)
  FAILURE="the PDF viewer's chrome.tabs calls were refused with \"$REFUSAL\" ($REFUSED times): the desk does not take a zoom mode the viewer asks for (DeskTabsSetZoomSettingsFunction)"
  ;;
esac

echo "measured: ${MEASURED:-never asked}, refused: $REFUSED"

if [ -n "$FAILURE" ]; then
  annotate_from "guard-pdf-zoom: $FAILURE" "$ENGINE_LOG"
  echo "guard-pdf-zoom: $FAILURE" >&2
  echo "the engine's last words:" >&2
  last_words "$ENGINE_LOG" >&2
  exit 1
fi
echo "PASS: zooming a PDF zooms the document once, and the viewer's page stays at the default zoom"
