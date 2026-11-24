#!/usr/bin/env bash
# Tests the verdict block of `guard-shell-web-apis.sh`: which side it blames
# and what it passes.
#
# The block is read from the real script. The control's second leg passes
# on an absent color, but only after its first leg found one.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-shell-web-apis.sh"
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

says() { # $1 MEASURED, $2 what the failure must contain
  (
    MEASURED="$1"
    eval "$BLOCK"
    case "$FAILURE" in
    *"$2"*) echo yes ;;
    *) echo no ;;
    esac
  )
}

echo "the claim — the shell asking about notifications and reading /cors"
expect "found is a pass" "pass" "$(verdict "granted 0")"
expect "absent is a failure" "fail" "$(verdict "granted 1")"
expect "absent names the patch" "yes" "$(says "granted 1" "0105")"
expect "and the fetch" "yes" "$(says "granted 1" "/cors")"
expect "and the isolation" "yes" \
  "$(says "granted 1" "IsCrossOriginIsolatedOrigin")"
expect "nothing drawn is a failure" "fail" "$(verdict "granted 2")"
expect "nothing drawn blames the harness" "yes" "$(says "granted 2" "harness")"
expect "an unusable probe fails" "fail" "$(verdict "granted 3")"

echo
echo "the control — a box painted unasked, then one waiting on /no-cors"
expect "shown then held is the pass" "pass" "$(verdict "control 0 1")"
expect "no-cors read too is a failure" "fail" "$(verdict "control 0 0")"
expect "and says a fetch reads whatever it is pointed at" "yes" \
  "$(says "control 0 0" "whatever it is pointed at")"
expect "a first leg that saw nothing fails, however right the second looks" \
  "fail" "$(verdict "control 1 1")"
expect "and so does one whose second leg found it" "fail" \
  "$(verdict "control 1 0")"
expect "a first leg that measured nothing fails" "fail" "$(verdict "control 2 1")"
expect "a second leg that measured nothing fails" "fail" "$(verdict "control 0 2")"
expect "an unusable probe fails the second leg" "fail" "$(verdict "control 0 3")"

echo
echo "a run that measured nothing at all"
expect "an empty measurement is a failure" "fail" "$(verdict "")"
expect "and so is a mode nobody runs" "fail" "$(verdict "elephant 0")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the shell's web APIs guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
