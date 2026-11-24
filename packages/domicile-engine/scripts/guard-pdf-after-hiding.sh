#!/usr/bin/env bash
# Checks that a PDF's page is drawn again after its <webview> is hidden and
# shown, as when a person switches away from its tab and back.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-pdf-after-hiding.sh /build/chromium/src
#
# Chrome's PDF viewer is a cross-origin frame, and the PDF's page is drawn by
# its child frame. Hidden, the viewer throttles that child, which drops what
# it painted. Shown again, the viewer un-throttles it at once (patch 0214);
# otherwise it stays blank until its geometry changes.
#
# The shell draws one browser window on the PDF and `guard-pdf-after-hiding.py`
# counts the page's white pixels before the box is hidden and after it is
# shown again.
#
# Headless and software-composited like the other <webview> guards.
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
  annotate "guard-pdf-after-hiding: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-pdf-after-hiding-broker}"
PROFILE="${PROFILE:-/tmp/domicile-pdf-after-hiding-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-pdf-after-hiding-engine.log}"
HTTP_LOG="${HTTP_LOG:-/tmp/domicile-pdf-after-hiding-http.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-pdf-after-hiding: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-pdf-after-hiding: no python3, which serves the PDF and drives the shell"
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

# 1. The PDF, on its own server: `crux` reaches no arbitrary host.
rm -f "$HTTP_LOG"
python3 "$SCRIPTS/guard-pdf-after-hiding-server.py" --port 0 >"$HTTP_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "serving" "$HTTP_LOG" || {
  annotate_from "guard-pdf-after-hiding: its PDF server never came up" "$HTTP_LOG"
  exit 1
}
PORT="$(served_port "$HTTP_LOG")" || {
  annotate_from "guard-pdf-after-hiding: its PDF server never said which port it took" "$HTTP_LOG"
  exit 1
}
# No toolbar or sidebar: the page is the only white on screen.
SUBJECT="http://127.0.0.1:$PORT/guard.pdf%23toolbar=0%26navpanes=0"

# 2. The engine. `src` goes last: it is a URL.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --window-size=1000,800 \
  --app="domicile://shell/?src=$SUBJECT" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-pdf-after-hiding.js" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# 3. Hide and show the window, counting the page's pixels either side.
MEASURED=""
if wait_for_line "$TRIES" "GUARD attached" "$ENGINE_LOG"; then
  if DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")"; then
    MEASURED="$(python3 "$SCRIPTS/guard-pdf-after-hiding.py" \
      --port "$DEBUG_PORT" --tries "$((FOR_SECONDS * 2))")"
  else
    MEASURED="no-port"
  fi
fi

FAILURE=""
case "$MEASURED" in
before=0)
  FAILURE="the PDF's page never drew, before anything was hidden: the viewer did not start, or the server's PDF never reached it"
  ;;
before=*\ after=*)
  BEFORE="${MEASURED#before=}"
  BEFORE="${BEFORE%% *}"
  AFTER="${MEASURED##*after=}"
  if [ "$((AFTER * 2))" -lt "$BEFORE" ]; then
    FAILURE="the PDF went blank after its <webview> was hidden and shown again ($AFTER white pixels, $BEFORE before): the viewer frame left the page's frame throttled, so it drew nothing (LocalFrame::WasShown, patch 0214)"
  fi
  ;;
no-port)
  FAILURE="the engine never said which debugging port it took"
  ;;
*)
  FAILURE="the <webview> never reported its page: the shell module did not run, or openBrowserWindow opened no window"
  ;;
esac

echo "measured: ${MEASURED:-never asked}"

if [ -n "$FAILURE" ]; then
  annotate_from "guard-pdf-after-hiding: $FAILURE" "$ENGINE_LOG"
  echo "guard-pdf-after-hiding: $FAILURE" >&2
  echo "the engine's last words:" >&2
  last_words "$ENGINE_LOG" >&2
  exit 1
fi
echo "PASS: a PDF's page draws again after its <webview> is hidden and shown"
