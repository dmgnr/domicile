#!/usr/bin/env bash
# A subsurface moves in the same display frame as its window's content: each
# captured frame shows the bubble at the content it is anchored to, since the
# window's frame draws it.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/under-wayland.sh /build/chromium/src \
#     ./packages/domicile-engine/scripts/guard-scrolling-bubble.sh /build/chromium/src
#
# `domicile-test-client --scrolling-bubble` scrolls a #339966 stripe down its
# window, a step each frame, and moves a sync subsurface bubble (#C04020) onto
# the stripe in the same commit. The shell (guard-scrolling-bubble.js) draws
# the window's one `<app>`; the bubble is in the window's frame, which embeds
# it (`domicile_surface_set_children`). The compositor casts its monitor to
# PipeWire (`DOMICILE_CAST_MONITOR`), and `domicile-test-cast-reader` prints
# where both colors are in each frame. The claim: in every frame that shows
# the bubble, its top is the stripe's.
#
# Control: NEGATIVE=1 runs the client with `--late-bubble`, which moves the
# bubble to where the stripe was the frame before. The bubble must be off its
# stripe in at least one frame, so the claim's frames can show a lag.
#
# See docs/architecture/WINDOW-COMPOSITING.md#subsurfaces.
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
  annotate "guard-scrolling-bubble: no path to chromium/src was given"
  exit 1
fi

ROOT="$(cd "$SCRIPTS/../../.." && pwd)"

# `POPUP_COLOR` and `STRIPE_COLOR` in packages/domicile-test-client/src/window.rs.
BUBBLE="C04020"
STRIPE="339966"

# NEGATIVE=1 runs the control. See the header.
NEGATIVE="${NEGATIVE:-0}"
MODE="sync"
LATE=()
[ "$NEGATIVE" = "1" ] && MODE="control" && LATE=(--late-bubble)

# Frames to read: four seconds at 60 a second, the scroll's period ten times
# over.
FRAMES="${FRAMES:-240}"
# Must outlast the whole run: the client is what keeps frames coming.
CLIENT_LIVES_FOR="${CLIENT_LIVES_FOR:-600}"
FOR_SECONDS="${FOR_SECONDS:-120}"

OUT="${OUT:-out/Domicile}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
# Not any other guard's paths.
BROKER="${BROKER:-/tmp/domicile-scrolling-bubble-broker}"
PROFILE="${PROFILE:-/tmp/domicile-scrolling-bubble-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-scrolling-bubble$WHICH-engine.log}"
COMP_LOG="${COMP_LOG:-/tmp/domicile-scrolling-bubble$WHICH-compositor.log}"
FRAMES_LOG="${FRAMES_LOG:-/tmp/domicile-scrolling-bubble$WHICH-frames.log}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
COMPOSITOR="$ROOT/target/debug/domicile-compositor"
CLIENT="$ROOT/target/debug/domicile-test-client"
READER="$ROOT/target/debug/domicile-test-cast-reader"
# In /tmp, not the job's deep `$TMPDIR`: PipeWire's socket is in it, and a
# socket path has a 107-byte limit.
STAGE="$(mktemp -d /tmp/domicile-scrolling-bubble.XXXXXX)"
CLI_LOG="$STAGE/client.log"
PW_LOG="$STAGE/pipewire.log"
READER_LOG="$STAGE/reader.log"
# PipeWire's own runtime directory, so this run's daemon is the only one its
# clients find, whatever else runs on the machine.
export PIPEWIRE_RUNTIME_DIR="$STAGE/pipewire"
mkdir -p "$PIPEWIRE_RUNTIME_DIR"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -rf "$STAGE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-scrolling-bubble: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
[ -f "$CHROMIUM/$OUT/libdomicile_engine.so" ] || {
  annotate "guard-scrolling-bubble: no libdomicile_engine.so in $CHROMIUM/$OUT; build it with autoninja -C $OUT domicile_engine"
  exit 1
}
for binary in "$COMPOSITOR" "$CLIENT" "$READER"; do
  [ -x "$binary" ] || {
    annotate "guard-scrolling-bubble: no $binary; build it with cargo build -p domicile-compositor"
    exit 1
  }
done
for tool in pipewire pw-link; do
  command -v "$tool" >/dev/null || {
    skip "guard-scrolling-bubble: no $tool, and the frames are read through PipeWire"
    exit 77
  }
done

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -aqF -- "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. PipeWire, with no session manager: the guard links the reader itself.
rm -f "$PW_LOG"
pipewire >"$PW_LOG" 2>&1 &
STARTED+=($!)
for _ in $(seq 1 100); do
  [ -S "$PIPEWIRE_RUNTIME_DIR/pipewire-0" ] && break
  sleep 0.05
done
[ -S "$PIPEWIRE_RUNTIME_DIR/pipewire-0" ] || {
  annotate_from "guard-scrolling-bubble: pipewire made no socket" "$PW_LOG"
  exit 1
}

# 2. The engine on the guard's shell.
export XDG_RUNTIME_DIR="$RUNTIME"
COMP_SOCK="$RUNTIME/domicile-scrolling-bubble.sock"
fresh_broker
rm -f "$COMP_SOCK" "$COMP_SOCK.session" "$ENGINE_LOG" "$COMP_LOG" "$FRAMES_LOG"
rm -rf "$PROFILE"; mkdir -p "$PROFILE"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=wayland \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module=guard-scrolling-bubble.js \
  --domicile-control-socket="$COMP_SOCK" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size=1024,768 \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

for _ in $(seq 1 240); do [ -S "$BROKER" ] && break; sleep 0.5; done
[ -S "$BROKER" ] || {
  annotate_from "guard-scrolling-bubble: the engine never opened its broker socket at $BROKER" "$ENGINE_LOG"
  last_words "$ENGINE_LOG" >&2
  exit 1
}

# 3. The compositor, casting its one monitor: nested, that is the engine's
#    window.
LD_LIBRARY_PATH="$CHROMIUM/$OUT${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
RUST_LOG="${RUST_LOG:-info,domicile_compositor=debug}" \
DOMICILE_CAST_MONITOR=domicile-0 \
  "$COMPOSITOR" \
    --chrome-socket "$COMP_SOCK" \
    --session "$COMP_SOCK.session" \
    --engine-socket "$BROKER" >"$COMP_LOG" 2>&1 &
COMP=$!
STARTED+=("$COMP")

# The host announces windows only after the shell agrees the protocol, so a
# client started earlier is announced to nobody.
wait_for_line 360 "chrome agreed the protocol" "$COMP_LOG" || {
  annotate_from "guard-scrolling-bubble: the shell never joined the compositor" "$COMP_LOG"
  tail -20 "$COMP_LOG" >&2
  exit 1
}
# Only the apps' display: under `under-wayland.sh` another is the host's.
CLIENT_DISPLAY=$(grep -a "apps connect here" "$COMP_LOG" | grep -aoE "wayland-[0-9]+" | head -1)
[ -n "$CLIENT_DISPLAY" ] || {
  annotate_from "guard-scrolling-bubble: the compositor never named its Wayland display" "$COMP_LOG"
  exit 1
}

# 4. The client: its window and the bubble over it.
rm -f "$CLI_LOG"
echo "driving domicile-test-client --scrolling-bubble"
WAYLAND_DISPLAY="$CLIENT_DISPLAY" timeout "$CLIENT_LIVES_FOR" \
  "$CLIENT" --title scrolling --scrolling-bubble "${LATE[@]}" >"$CLI_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
# The window's `<app>` is on the page.
for _ in $(seq 1 "$TRIES"); do
  [ "$(grep -ac "GUARD drawn" "$ENGINE_LOG")" -ge 1 ] && break
  sleep 0.25
done
wait_for_line "$TRIES" "cast ready" "$COMP_LOG" || {
  annotate_from "guard-scrolling-bubble: the compositor never said its monitor cast was ready" "$COMP_LOG"
  grep -aE "cast|PipeWire|capture" "$COMP_LOG" | tail -12 | sed 's/^/  /' >&2
  exit 1
}

# 5. The reader, linked to the cast.
rm -f "$READER_LOG"
timeout "$FOR_SECONDS" "$READER" "$FRAMES" "$BUBBLE" "$STRIPE" >"$FRAMES_LOG" 2>"$READER_LOG" &
READING=$!
STARTED+=("$READING")
for _ in $(seq 1 100); do
  pw-link -i 2>/dev/null | grep -q "domicile-test-cast-reader:" && break
  sleep 0.05
done
pw-link "domicile-cast:capture_1" "domicile-test-cast-reader:input_1" ||
  echo "pw-link could not link the cast to the reader; the verdict says what that cost" >&2
wait "$READING"
echo "the reader stopped with $? after $(grep -c '^frame ' "$FRAMES_LOG") frame(s)"

# How many frames came, how many show the bubble, at how many stripe tops,
# and in how many the bubble is not at the stripe: more than a pixel of
# rounding from its top, or with no stripe at all.
#
# `packages/domicile-engine/tests/test-scrolling-bubble-guard.sh` runs this function directly.
measure() { # the reader's frames
  awk -v bubble="#$BUBBLE" -v stripe="#$STRIPE" '
    /^frame / {
      frames++
      at_bubble = ""
      at_stripe = ""
      for (i = 1; i < NF; i++) {
        if ($(i + 1) != "at") continue
        split($(i + 2), place, ",")
        if ($i == bubble) at_bubble = place[2]
        if ($i == stripe) at_stripe = place[2]
      }
      if (at_bubble == "") next
      with++
      if (at_stripe == "") { off++; next }
      if (!(at_stripe in seen)) { seen[at_stripe] = 1; tops++ }
      apart = at_bubble - at_stripe
      if (apart < -1 || apart > 1) off++
    }
    END { print frames + 0, with + 0, tops + 0, off + 0 }
  ' "$1"
}

MEASURED="$MODE $(measure "$FRAMES_LOG")"
echo
echo "measured: $MEASURED"
echo "  (mode frames with-the-bubble stripe-tops off)"

# Which end to blame. `packages/domicile-engine/tests/test-scrolling-bubble-guard.sh` runs this block
# directly. MEASURED is "<mode> <frames> <with> <tops> <off>".
FAILURE=""
PASSED=""
read -r MODE_READ FRAMES_READ WITH TOPS OFF <<<"$MEASURED"
if [ "${MODE_READ:-}" != "sync" ] && [ "${MODE_READ:-}" != "control" ]; then
  FAILURE="there is no measurement here this guard can place ($MEASURED): \
the run did not get as far as reading, or ran a mode this guard does not know"
elif [ "$FRAMES_READ" -eq 0 ]; then
  FAILURE="the cast sent no frame: the reader was never linked, or the \
compositor captured nothing (the reader's and the compositor's logs say which)"
elif [ "$WITH" -lt 60 ]; then
  FAILURE="only $WITH of $FRAMES_READ captured frames show the bubble, too \
few to say it keeps up: the window's frame did not draw it, or the client \
never opened it"
elif [ "$TOPS" -lt 5 ]; then
  FAILURE="the window did not scroll in the captured frames: its stripe was \
at $TOPS place(s), so no frame could show a lag"
elif [ "$MODE_READ" = "sync" ] && [ "$OFF" -gt 0 ]; then
  FAILURE="THE BUBBLE LAGGED: in $OFF of $WITH captured frames the bubble is \
not at its window's stripe. The window's frame showed the subsurface a \
frame apart from the content it was committed with"
elif [ "$MODE_READ" = "sync" ]; then
  PASSED="in all $WITH captured frames with the bubble, it is at its \
window's stripe, $TOPS places down the scroll"
elif [ "$OFF" -eq 0 ]; then
  FAILURE="the control moved its bubble a frame late, yet it was at its \
stripe in all $WITH frames, so the guard cannot see a lag"
else
  PASSED="the control is sharp: a bubble moved a frame late is off its \
stripe in $OFF of $WITH captured frames"
fi

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-scrolling-bubble: $FAILURE" "$COMP_LOG"
echo "the frames, first and last:" >&2
head -5 "$FRAMES_LOG" | sed 's/^/  /' >&2
tail -5 "$FRAMES_LOG" | sed 's/^/  /' >&2
echo "the reader said:" >&2
tail -10 "$READER_LOG" | sed 's/^/  /' >&2
echo "the page said:" >&2
grep -aE "GUARD|domicile:" "$ENGINE_LOG" | tail -12 | cut -c1-200 | sed 's/^/  /' >&2
echo "the engine's last words:" >&2
last_words "$ENGINE_LOG" >&2
echo "the compositor's last words:" >&2
grep -aE "cast|engine|frame sink|subsurface|ERROR|WARN" "$COMP_LOG" | tail -30 | sed 's/^/  /' >&2
echo "the client said:" >&2
tail -5 "$CLI_LOG" | sed 's/^/  /' >&2
exit 1
