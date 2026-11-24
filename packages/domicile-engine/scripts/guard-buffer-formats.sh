#!/usr/bin/env bash
# Checks that a window drawn in each 10-bit and half-float `wl_shm` format
# reaches the page in the color it drew.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/under-wayland.sh /build/chromium/src \
#     ./packages/domicile-engine/scripts/guard-buffer-formats.sh /build/chromium/src
#
# `domicile-test-client --format <format>` draws `DEEP_COLOR` (#3366CC). The
# compositor copies the frame into a GPU buffer of the same format and the
# engine imports it in its viz format. A swapped channel, a refused format or
# padding read as alpha (the formats without alpha leave it zero) shows as
# another color.
#
# The page reads back 8 bits a channel, so each channel may be off by one.
#
# The control draws an 8-bit window, which must not pass for #3366CC.
#
# Each format gets its own engine and compositor: the page embeds `app-1`, the
# first window the compositor maps.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-buffer-formats: no path to chromium/src was given"
  exit 1
fi

ROOT="$(cd "$SCRIPTS/../../.." && pwd)"

# `DEEP_COLOR` in packages/domicile-test-client/src/window.rs.
COLOR="3366CC"
FORMATS=(abgr2101010 xbgr2101010 abgr16161616f xbgr16161616f)

# NEGATIVE=1 draws one 8-bit window instead.
NEGATIVE="${NEGATIVE:-0}"
[ "$NEGATIVE" = "1" ] && FORMATS=(8-bit)

# Outlasts the polling below: the probe runs on the submit path.
CLIENT_LIVES_FOR="${CLIENT_LIVES_FOR:-300}"
LOOKS="${LOOKS:-240}"

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-buffer-formats-broker}"
PROFILE="${PROFILE:-/tmp/domicile-buffer-formats-profile}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
COMPOSITOR="$ROOT/target/debug/domicile-compositor"
CLIENT="$ROOT/target/debug/domicile-test-client"

ENGINE_LOG=$(mktemp)
COMP_LOG=$(mktemp)
CLI_LOG=$(mktemp)
DRAWN_FILE=$(mktemp)
STARTED=()
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"
LOG_COPY="${LOG_COPY:-/tmp/domicile-buffer-formats$WHICH-compositor.log}"
ENGINE_LOG_COPY="${ENGINE_LOG_COPY:-/tmp/domicile-buffer-formats$WHICH-engine.log}"
# Stops the engine, compositor and client of one format.
stop_all() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
    wait "${STARTED[@]}" 2>/dev/null
  fi
  STARTED=()
}
cleanup() {
  cp "$COMP_LOG" "$LOG_COPY" 2>/dev/null
  cp "$ENGINE_LOG" "$ENGINE_LOG_COPY" 2>/dev/null
  stop_all
  rm -f "$ENGINE_LOG" "$COMP_LOG" "$CLI_LOG" "$DRAWN_FILE"
  remove_profile "$PROFILE"
}
trap cleanup EXIT

cd "$CHROMIUM" || {
  annotate "guard-buffer-formats: $CHROMIUM is not a directory this can enter"
  exit 1
}

[ -x "$OUT/chrome" ] || {
  annotate "guard-buffer-formats: no engine at $CHROMIUM/$OUT/chrome; build it with ./scripts/build.sh"
  exit 1
}
[ -f "$OUT/libdomicile_engine.so" ] || {
  annotate "guard-buffer-formats: no libdomicile_engine.so in $CHROMIUM/$OUT; build it with autoninja -C $OUT domicile_engine"
  exit 1
}
for binary in "$COMPOSITOR" "$CLIENT"; do
  [ -x "$binary" ] || {
    annotate "guard-buffer-formats: no $binary; build it with cargo build -p domicile-compositor"
    exit 1
  }
done

# Whether `RRGGBB` $1 is within one of #$COLOR in every channel.
near_the_color() {
  local drawn="$1" i want got
  for i in 0 2 4; do
    want=$((16#${COLOR:$i:2}))
    got=$((16#${drawn:$i:2}))
    [ $((got - want)) -le 1 ] && [ $((want - got)) -le 1 ] || return 1
  done
}

# Starts an engine, a compositor and a client drawing in format $1, and
# writes to $DRAWN_FILE the last color the engine drew at the window's center: the first
# near #$COLOR, or the last seen when none is.
draw_in() {
  local format="$1" sock
  : >"$ENGINE_LOG"; : >"$COMP_LOG"; : >"$CLI_LOG"
  fresh_broker
  rm -rf "$PROFILE"; mkdir -p "$PROFILE"

  "$OUT/chrome" \
    --ozone-platform=wayland \
    --no-sandbox --password-store=basic --no-first-run --disable-component-update \
    --user-data-dir="$PROFILE" \
    --window-size=1024,768 \
    --domicile-shell-root="$SCRIPTS" \
    --enable-logging=stderr --log-level=0 \
    --domicile-broker-socket="$BROKER" \
    "domicile://shell/spike-page.html?app=app-1" >"$ENGINE_LOG" 2>&1 &
  STARTED+=($!)

  for _ in $(seq 1 120); do [ -S "$BROKER" ] && break; sleep 0.5; done
  [ -S "$BROKER" ] || {
    echo "the page never asked to embed" >&2
    return 1
  }

  export XDG_RUNTIME_DIR="$RUNTIME"
  sock="$RUNTIME/domicile-buffer-formats.sock"
  rm -f "$sock" "$sock.session"
  LD_LIBRARY_PATH="$CHROMIUM/$OUT${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  RUST_LOG="${RUST_LOG:-info,domicile_compositor=debug}" \
  DOMICILE_SPIKE_CENTER=1 \
    "$COMPOSITOR" \
      --chrome-socket "$sock" \
      --session "$sock.session" \
      --engine-socket "$BROKER" \
      --expect-a-page no >"$COMP_LOG" 2>&1 &
  STARTED+=($!)

  for _ in $(seq 1 120); do
    grep -q "chrome protocol socket up" "$COMP_LOG" 2>/dev/null && break
    sleep 0.5
  done
  grep -q "chrome protocol socket up" "$COMP_LOG" 2>/dev/null || {
    echo "the compositor never bound its chrome socket" >&2
    return 1
  }
  local display
  display=$(grep -oE "wayland-[0-9]+" "$COMP_LOG" | head -1)

  local asked=(--title "$format")
  [ "$format" = "8-bit" ] || asked+=(--format "$format")
  WAYLAND_DISPLAY="${display:-wayland-1}" timeout "$CLIENT_LIVES_FOR" \
    "$CLIENT" "${asked[@]}" >"$CLI_LOG" 2>&1 &
  STARTED+=($!)

  local drawn="" client_drew=""
  for _ in $(seq 1 "$LOOKS"); do
    drawn=$(grep -aoE "engine drew #FF[0-9A-F]{6}" "$COMP_LOG" | tail -1 | grep -oE "[0-9A-F]{6}$")
    if [ -n "$drawn" ] && near_the_color "$drawn"; then
      break
    fi
    # The 8-bit window alternates its two colors (`COLORS`); either is a draw.
    case "$drawn" in 203050|305080) client_drew="$drawn" ;; esac
    [ "$format" = "8-bit" ] && [ -n "$client_drew" ] && { drawn="$client_drew"; break; }
    sleep 1
  done
  echo "$drawn" >"$DRAWN_FILE"
}

for format in "${FORMATS[@]}"; do
  echo "drawing #$COLOR in $format"
  # Not in a subshell: `STARTED` must reach `stop_all`.
  : >"$DRAWN_FILE"
  draw_in "$format"
  DRAWN=$(cat "$DRAWN_FILE")
  stop_all
  if [ -z "$DRAWN" ]; then
    # The compositor's complaints and the client's own last words, last so
    # they survive the annotation's cut, rather than the probe's lines, which
    # only say nothing was drawn.
    {
      grep -aE " (WARN|ERROR) " "$COMP_LOG"
      sed 's/^/client: /' "$CLI_LOG"
    } >"$DRAWN_FILE"
    annotate_from "guard-buffer-formats: the engine never drew a $format window" "$DRAWN_FILE"
    exit 1
  fi
  echo "the engine drew #$DRAWN"
  if [ "$NEGATIVE" = "1" ]; then
    if near_the_color "$DRAWN"; then
      annotate "guard-buffer-formats negative control: an 8-bit window passed for #$COLOR"
      exit 1
    fi
    echo "PASS: negative control: correct, an 8-bit window is not #$COLOR"
    exit 0
  fi
  near_the_color "$DRAWN" || {
    annotate "guard-buffer-formats: a $format window shows as #$DRAWN, not #$COLOR"
    exit 1
  }
done
echo "PASS: a window in each of ${FORMATS[*]} is on the page in its own color"
