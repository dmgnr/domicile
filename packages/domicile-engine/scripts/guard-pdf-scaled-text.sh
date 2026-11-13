#!/usr/bin/env bash
# Checks that a PDF's thin lines survive being drawn smaller than the viewer
# rendered them.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-pdf-scaled-text.sh /build/chromium/src
#
# The viewer renders a page bitmap at the device scale and draws it into the
# page. On a desk with monitors at several densities, cc rasters that bitmap
# smaller for each lower-density monitor (DISPLAY-TILINGS.md). Drawn with
# nearest-neighbor sampling, as upstream does, a downscale drops whole
# columns, so thin strokes in text vanish (patch 0210).
#
# The shell scales the PDF's <iframe> to 0.8, as a 1.2 monitor beside a 1.5
# one does. `guard-pdf-scaled-text.py` measures how evenly forty equal lines
# keep their ink.
#
# Headless, at device scale 1.5, with no compositor or client. HOME is a
# directory this makes, so domicile://home/ serves only its fixture.
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
  annotate "guard-pdf-scaled-text: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-pdf-scaled-text-broker}"
PROFILE="${PROFILE:-/tmp/domicile-pdf-scaled-text-profile}"
HOME_DIR="${HOME_DIR:-/tmp/domicile-pdf-scaled-text-home}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-pdf-scaled-text-engine.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"
FIXTURE="guard-pdf-scaled-text.pdf"
# Most ink one line may keep over another. A filtered downscale keeps them
# within a few percent; nearest-neighbor halves some.
MAX_SPREAD="1.3"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-pdf-scaled-text: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-pdf-scaled-text: no python3, and the viewer is asked by one"
  exit 77
}

fresh_broker; rm -rf "$PROFILE" "$HOME_DIR"; mkdir -p "$PROFILE" "$HOME_DIR"
cp "$SCRIPTS/$FIXTURE" "$HOME_DIR/$FIXTURE"

rm -f "$ENGINE_LOG"
HOME="$HOME_DIR" "$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --force-device-scale-factor=1.5 \
  --window-size=1000,800 \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-pdf-scaled-text.js" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
LOADED=""
for _ in $(seq 1 "$TRIES"); do
  if grep -qF "GUARD pdf-frame-loaded" "$ENGINE_LOG" 2>/dev/null; then
    LOADED=1
    break
  fi
  sleep 0.25
done

MEASURED=""
if [ -n "$LOADED" ]; then
  if DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")"; then
    MEASURED="$(python3 "$SCRIPTS/guard-pdf-scaled-text.py" \
      --port "$DEBUG_PORT" --tries "$((FOR_SECONDS * 2))")"
  else
    MEASURED="no-port"
  fi
fi

FAILURE=""
case "$MEASURED" in
lines=40\ spread=*)
  SPREAD="${MEASURED#*spread=}"
  if ! awk -v got="$SPREAD" -v max="$MAX_SPREAD" 'BEGIN { exit !(got <= max) }'; then
    FAILURE="thin lines lost ink unevenly when the PDF was drawn at 0.8 (spread $SPREAD, at most $MAX_SPREAD): the viewer's bitmap was downscaled nearest-neighbor, which drops strokes in text (patch 0210)"
  fi
  ;;
lines=*)
  FAILURE="the PDF's lines never showed up in the shell's screenshot"
  ;;
no-port)
  FAILURE="the engine never said which debugging port it took"
  ;;
*)
  FAILURE="the shell's <iframe> never loaded: DomicileShell did not run the module, or domicile://home/ refused the PDF"
  ;;
esac

echo "measured: ${MEASURED:-never asked}"

if [ -n "$FAILURE" ]; then
  annotate_from "guard-pdf-scaled-text: $FAILURE" "$ENGINE_LOG"
  echo "guard-pdf-scaled-text: $FAILURE" >&2
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
fi
echo "PASS: a PDF drawn smaller keeps its thin lines"
