#!/usr/bin/env bash
# The engine starts no audio or video capture service until something lists
# or uses media devices.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-media-services-at-rest.sh /build/chromium/src
#
# Headless and software-composited. It reads the engine's processes, so it
# needs no pixels and no client.
#
# Why: the engine used to list cameras and microphones at startup, so that a
# shell's or Settings' first `media_devices` found them. Listing starts
# Chromium's audio service, which then stays up for the whole session, ~35 MiB
# for a desk that never records. The engine now lists them on the first ask,
# and answers that ask once the list arrives. Chrome's dictation listed
# microphones as each tab opened; patch 0244 leaves it off.
#
# The shell loads and does nothing for SETTLE_SECONDS. No fake devices: with
# --use-fake-device-for-media-stream, listing starts no audio service, so
# neither mode would see one. Asserted:
#
#   the shell page ran    or nothing was set up
#   none at rest          no audio and no video capture service is running
#
# Control: NEGATIVE=1 has the shell list devices itself
# (navigator.mediaDevices.enumerateDevices()), which starts the audio service.
# It must be seen, so the claim's none is the build's doing and not a missed
# process.
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
  annotate "guard-media-services-at-rest: no path to chromium/src was given"
  exit 1
fi

# NEGATIVE=1 has the shell list devices. See the header.
NEGATIVE="${NEGATIVE:-0}"
MODE="claim"
LIST="0"
if [ "$NEGATIVE" = "1" ]; then
  MODE="control"
  LIST="1"
fi

OUT="${OUT:-out/Domicile}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
BROKER="${BROKER:-/tmp/domicile-media-services-at-rest$WHICH-broker}"
PROFILE="${PROFILE:-/tmp/domicile-media-services-at-rest$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-media-services-at-rest$WHICH-engine.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"
# Long enough for a listing started at startup to have started its services.
SETTLE_SECONDS="${SETTLE_SECONDS:-10}"

BROWSER=""
cleanup() {
  [ -n "$BROWSER" ] && kill "$BROWSER" 2>/dev/null
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-media-services-at-rest: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}

saw() { # $1 pattern
  grep -qF -- "$1" "$ENGINE_LOG" && echo 1 || echo 0
}

# Every process under the browser, its children's children too. Read from
# /proc, which needs no tool beside bash.
descendants() { # $1 pid
  local stat pid rest parent
  for stat in /proc/[0-9]*/stat; do
    read -r pid rest <"$stat" 2>/dev/null || continue
    # The name in parentheses can hold spaces; the parent follows its ")".
    rest="${rest##*) }"
    parent="${rest#* }"
    parent="${parent%% *}"
    if [ "$parent" = "$1" ]; then
      echo "$pid"
      descendants "$pid"
    fi
  done
}

# How many of the browser's processes run service $1.
running() { # $1 utility sub-type
  local pid count=0
  for pid in $(descendants "$BROWSER"); do
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null |
      grep -qF -- "--utility-sub-type=$1" && count=$((count + 1))
  done
  echo "$count"
}

fresh_broker
rm -rf "$PROFILE"
mkdir -p "$PROFILE"
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --window-size=1024,768 \
  --app="domicile://shell/?list=$LIST" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-media-services-at-rest.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
BROWSER=$!
for _ in $(seq 1 $((FOR_SECONDS * 4))); do
  grep -qF "GUARD shell-loaded" "$ENGINE_LOG" 2>/dev/null && break
  sleep 0.25
done
sleep "$SETTLE_SECONDS"
AUDIO="$(running audio.mojom.AudioService)"
VIDEO="$(running video_capture.mojom.VideoCaptureService)"

MEASURED="$MODE $(saw "GUARD shell-loaded") $AUDIO $VIDEO"
echo
echo "measured: $MEASURED"
echo "  (mode shell-ran audio-services video-capture-services)"

# Which end to blame. `packages/domicile-engine/tests/test-media-services-at-rest-guard.sh`
# runs this block directly. MEASURED is
# "<mode> <shell-ran> <audio-services> <video-capture-services>".
FAILURE=""
PASSED=""
read -r _ _ AUDIO VIDEO <<<"$MEASURED"
case "$MEASURED" in
"claim 0 "* | "control 0 "*)
  FAILURE="the shell page never ran, so nothing here was set up: the module \
did not load, or it threw, and the engine log has its console"
  ;;
"claim 1 0 0")
  PASSED="a desk at rest runs no audio or video capture service"
  ;;
"claim 1 "*)
  FAILURE="A DESK AT REST RAN $AUDIO AUDIO AND $VIDEO VIDEO CAPTURE \
SERVICE(S) though nothing listed or used a device: each holds memory for the \
whole session. Something lists media devices at startup or as a tab opens; \
the engine lists them only on the first ask (domicile_media_devices.cc), and \
leaves Chrome's dictation, which listed them per tab, off (patch 0244)"
  ;;
"control 1 "*)
  if [ "$AUDIO" -gt 0 ]; then
    PASSED="the control is sharp: a shell that lists devices starts the audio \
service, and this guard sees it"
  else
    FAILURE="the control listed devices and no audio service was seen, so the \
claim's none says nothing"
  fi
  ;;
*)
  FAILURE="there is no measurement here this guard can place ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-media-services-at-rest: $FAILURE" "$ENGINE_LOG"
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
exit 1
