#!/usr/bin/env bash
# Tests which results `guard-media-services-at-rest.sh` passes.
#
# Runs the guard's own verdict block, not a copy. Key cases:
#
#   - The claim passes on no audio and no video capture service, and fails
#     on either, naming where the engine lists devices.
#   - The control passes only when it sees the audio service its listing
#     started, so the claim's none is the build's doing.
#   - A shell that never ran fails.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-media-services-at-rest.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

BLOCK="$(awk '/^FAILURE=""$/,/^esac$/' "$GUARD")"
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

# MEASURED is "<mode> <shell-ran> <audio-services> <video-capture-services>".
echo "the claim — a desk at rest"
expect "no service is the pass" "pass" "$(verdict "claim 1 0 0")"
expect "an audio service is a failure" "fail" "$(verdict "claim 1 1 0")"
expect "and names where devices are listed" "yes" \
  "$(says "claim 1 1 0" "domicile_media_devices.cc")"
expect "a video capture service is a failure" "fail" \
  "$(verdict "claim 1 0 1")"
expect "a shell that never ran is a failure" "fail" "$(verdict "claim 0 0 0")"

echo
echo "the control — the shell lists devices"
expect "an audio service is the control's pass" "pass" \
  "$(verdict "control 1 1 0")"
expect "none is the control's failure" "fail" "$(verdict "control 1 0 0")"
expect "and says the claim then means nothing" "yes" \
  "$(says "control 1 0 0" "says nothing")"
expect "a shell that never ran is the control's failure" "fail" \
  "$(verdict "control 0 1 0")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the media-services-at-rest guard blames the right end"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
