#!/usr/bin/env bash
# Tests how the scrolling bubble guard reads captured frames and which results
# it passes.
#
# Runs the guard's own `measure` function and verdict block, not copies. Key
# cases: a bubble at its stripe in every frame passes, one frame off fails the
# claim and passes the control, and a run that captured too little or never
# scrolled fails either way.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-scrolling-bubble.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

COLORS="$(grep -E '^(BUBBLE|STRIPE)="[0-9A-F]{6}"$' "$GUARD")"
MEASURE="$(awk '/^measure\(\) \{/,/^\}$/' "$GUARD")"
BLOCK="$(awk '/^FAILURE=""$/,/^fi$/' "$GUARD")"
if [ "$(echo "$COLORS" | wc -l)" -ne 2 ] || [ -z "$MEASURE" ] || [ -z "$BLOCK" ]; then
  echo "no colors, measure function or verdict block in $GUARD — its markers moved. Fix this test with it." >&2
  exit 1
fi
eval "$COLORS"
eval "$MEASURE"

FAILED=0
expect() {
  local what="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n    wanted: %s\n    got:    %s\n' "$what" "$want" "$got"
    FAILED=$((FAILED + 1))
  fi
}

# Frames as the cast reader prints them, given `top bubble-top` pairs; `-` is
# a color that is nowhere.
frames() {
  local stripe bubble
  while read -r stripe bubble; do
    printf 'frame 1024x768 80 48 32 255'
    case "$bubble" in
    -) printf ' #C04020 nowhere' ;;
    *) printf ' #C04020 at 200,%s 80x40' "$bubble" ;;
    esac
    case "$stripe" in
    -) printf ' #339966 nowhere\n' ;;
    *) printf ' #339966 at 0,%s 320x40\n' "$stripe" ;;
    esac
  done
}

# `count` frames scrolling 8 pixels each, the bubble `lag` frames behind.
scrolling() { # count lag
  local frame
  for frame in $(seq "$2" $(($1 + $2 - 1))); do
    echo "$(((frame % 25) * 8)) $((((frame - $2) % 25) * 8))"
  done | frames
}

measured() { # frames on stdin
  local log
  log="$(mktemp)"
  cat >"$log"
  measure "$log"
  rm -f "$log"
}

echo "reading frames"
expect "a bubble at its stripe in every frame is never off" "100 100 25 0" \
  "$(scrolling 100 0 | measured)"
expect "a bubble a frame behind is off in every frame" "100 100 25 100" \
  "$(scrolling 100 1 | measured)"
expect "a pixel of rounding is not off" "1 1 1 0" \
  "$(echo "40 41" | frames | measured)"
expect "frames without the bubble are not counted together" "3 1 1 0" \
  "$(printf '8 -\n16 -\n24 24\n' | frames | measured)"
expect "a bubble with no stripe under it is off" "1 1 0 1" \
  "$(echo "- 24" | frames | measured)"
expect "lines that are not frames are not read" "0 0 0 0" \
  "$(echo "reader state: Streaming" | measured)"

verdict() { # $1 MEASURED
  (
    MEASURED="$1"
    eval "$BLOCK"
    if [ -n "$PASSED" ]; then
      echo "pass"
    elif [ -n "$FAILURE" ]; then
      echo "fail"
    else
      echo "neither"
    fi
  )
}

says() { # $1 MEASURED, $2 what the sentence must contain
  case "$(
    MEASURED="$1"
    eval "$BLOCK"
    echo "$FAILURE"
  )" in
  *"$2"*) echo yes ;;
  *) echo no ;;
  esac
}

# MEASURED is "<mode> <frames> <together> <tops> <off>".
echo
echo "the claim — the window's frame draws its subsurface"
expect "every frame at its stripe is the pass" "pass" "$(verdict "sync 240 200 25 0")"
expect "one frame off is a failure" "fail" "$(verdict "sync 240 200 25 1")"
expect "and says the bubble lagged" "yes" "$(says "sync 240 200 25 1" "LAGGED")"

echo
echo "the control — the client moves its bubble a frame late"
expect "a frame off is the control's pass" "pass" "$(verdict "control 240 200 25 3")"
expect "no frame off is the control's failure" "fail" "$(verdict "control 240 200 25 0")"
expect "and says the guard cannot see a lag" "yes" \
  "$(says "control 240 200 25 0" "cannot see a lag")"

echo
echo "a run that measured too little"
expect "no frames is a failure" "fail" "$(verdict "sync 0 0 0 0")"
expect "and says the cast sent none" "yes" "$(says "sync 0 0 0 0" "no frame")"
expect "too few frames with both is a failure" "fail" "$(verdict "sync 240 10 10 0")"
expect "a window that did not scroll is a failure" "fail" "$(verdict "control 240 200 1 3")"
expect "and says so" "yes" "$(says "control 240 200 1 3" "did not scroll")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"
expect "and so is a mode nobody runs" "fail" "$(verdict "elephant 240 200 25 0")"

if [ "$FAILED" -eq 0 ]; then
  echo "the scrolling bubble guard reads frames and names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
