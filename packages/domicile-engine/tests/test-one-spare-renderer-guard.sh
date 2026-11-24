#!/usr/bin/env bash
# Tests which results `guard-one-spare-renderer.sh` passes.
#
# Runs the guard's own verdict block, not a copy. Key cases:
#
#   - The claim passes when the engine as built keeps as many renderers as
#     with one spare asked for, and fails on more, naming the patch.
#   - The control passes only on exactly one more, so the claim's match is
#     the build's doing.
#   - A shell that never ran fails.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-one-spare-renderer.sh"
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

# MEASURED is "<mode> <shell-ran> <renderers> <renderers-with-one-spare>".
echo "the claim — the engine as built"
expect "as many as with one spare is the pass" "pass" "$(verdict "claim 1 7 7")"
expect "one more is a failure" "fail" "$(verdict "claim 1 8 7")"
expect "and names the patch" "yes" "$(says "claim 1 8 7" "patch 0242")"
expect "a shell that never ran is a failure" "fail" "$(verdict "claim 0 0 0")"

echo
echo "the control — two spares asked for"
expect "one more is the control's pass" "pass" "$(verdict "control 1 8 7")"
expect "the same count is the control's failure" "fail" \
  "$(verdict "control 1 7 7")"
expect "and says the count then means nothing" "yes" \
  "$(says "control 1 7 7" "says nothing")"
expect "two more is the control's failure too" "fail" \
  "$(verdict "control 1 9 7")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the one-spare-renderer guard blames the right end"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
