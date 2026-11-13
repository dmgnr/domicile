#!/usr/bin/env bash
# Tests the verdict of `guard-webview-video-picture-in-picture.sh`: which
# readings pass and which component a failure blames.
#
# The checks are ordered: picture-in-picture only means something once the
# shell drew the window and its video played. Key cases:
#
#   - A refused request blames WebViewGuest::EnterPictureInPicture.
#   - An entered video the shell never heard blames ShowInactive.
#   - A close that never paused blames kClose, and a listing that stays
#     blames Hide.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-video-picture-in-picture.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

# From `FAILURE=""` to the column-zero `fi` that ends the decision.
BLOCK="$(awk '/^FAILURE=""$/,/^fi$/' "$GUARD")"
[ -n "$BLOCK" ] || {
  echo "no verdict block in $GUARD — its markers moved. Fix this test with it." >&2
  exit 1
}

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

# Runs the block with every reading at its passing value; each case overrides
# one. Prints "pass", "fail" or "neither", then the failure on the next line.
judge() { # NAME=value overrides
  (
    SAW_SHELL=1
    SAW_REPORT=1
    SAW_APIS=1
    SAW_WINDOW=1
    SAW_PLAYING=1
    SAW_ENTERED=1
    SAW_LISTED=1
    SAW_LEFT_PAUSED=1
    SAW_UNLISTED=1
    for override in "$@"; do
      eval "$override"
    done
    eval "$BLOCK"
    if [ -n "$PASSED" ]; then
      echo "pass"
    elif [ -n "$FAILURE" ]; then
      echo "fail"
    else
      echo "neither"
    fi
    echo "$FAILURE"
  )
}

verdict() { judge "$@" | head -1; }

blames() { # $1 word, then the args judge takes
  local word="$1"
  shift
  case "$(judge "$@" | tail -n +2)" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

echo "a run that never got as far as picture-in-picture"
expect "a shell that never ran blames the harness" "yes" \
  "$(blames "harness" SAW_SHELL=0)"
expect "no window blames openBrowserWindow" "yes" \
  "$(blames "openBrowserWindow" SAW_WINDOW=0)"
expect "a video that never played passes nothing" "fail" \
  "$(verdict SAW_PLAYING=0)"
expect "and blames the canvas stream" "yes" \
  "$(blames "canvas stream" SAW_PLAYING=0)"

echo
echo "the claim"
expect "every step seen is the pass" "pass" "$(verdict)"
expect "a refused request blames EnterPictureInPicture" "yes" \
  "$(blames "EnterPictureInPicture" SAW_ENTERED=0)"
expect "an unheard video blames ShowInactive" "yes" \
  "$(blames "ShowInactive" SAW_LISTED=0)"
expect "a close that never paused blames kClose" "yes" \
  "$(blames "kClose" SAW_LEFT_PAUSED=0)"
expect "a listing that stays blames Hide" "yes" \
  "$(blames "Hide" SAW_UNLISTED=0)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the video picture-in-picture guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
