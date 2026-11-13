#!/usr/bin/env bash
# Tests which results `guard-pdf-scaled-text.sh` passes, and that the series
# draws the PDF viewer's snapshot filtered.
#
# Runs the guard's own verdict block, not a copy. Key cases:
#
#   - Even lines pass; lines that lost half their ink fail, naming patch 0210.
#   - Lines that never showed up, or a shell that never loaded, fail.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine"
GUARD="$ENGINE/scripts/guard-pdf-scaled-text.sh"
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
    # shellcheck disable=SC2034 # read by the eval below
    MEASURED="$1"
    # shellcheck disable=SC2034
    MAX_SPREAD="1.3"
    eval "$BLOCK"
    case "$FAILURE" in
    "") echo pass ;;
    *"patch 0210"*) echo "fail: 0210" ;;
    *never*) echo "fail: never" ;;
    *) echo "fail: $FAILURE" ;;
    esac
  )
}

expect "even lines pass" "pass" "$(verdict 'lines=40 spread=1.04')"
expect "the limit passes" "pass" "$(verdict 'lines=40 spread=1.30')"
expect "lines that lost half their ink fail" "fail: 0210" "$(verdict 'lines=40 spread=2.00')"
expect "no lines fail" "fail: never" "$(verdict 'lines=0')"
expect "a shell that never loaded fails" "fail: never" "$(verdict '')"

PATCH="$(grep -al '^+++ b/pdf/pdf_view_web_plugin.cc' "$ENGINE"/patches/*.patch)"
# shellcheck disable=SC2086 # one path per patch
if [ -n "$PATCH" ] &&
  grep -aqF '+                    SkSamplingOptions(SkFilterMode::kLinear,' $PATCH; then
  printf '  ok    %s\n' "the viewer's snapshot is drawn filtered"
else
  printf '  FAIL  %s\n' "no patch draws the viewer's snapshot filtered"
  FAILED=$((FAILED + 1))
fi

[ "$FAILED" -eq 0 ] || exit 1
