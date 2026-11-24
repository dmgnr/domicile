#!/usr/bin/env bash
# Tests which end the Electron schemes guard blames and which results it
# passes.
#
# Runs the verdict block from `guard-electron-schemes.sh` itself, not a copy,
# like the other guards' tests. Key cases: a page with no origin in its
# app's scheme, a picture from this machine held by Local Network Access, and
# a scheme nobody registered that has an origin, are failures
# even when everything else worked.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-electron-schemes.sh"
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

# MEASURED is "<ready> <origin> <secure> <fetched> <local> <control>".
echo "the claim — an app's own scheme is registered as the engine starts"
expect "a standard, secure, fetchable scheme is the pass" \
  "pass" "$(verdict "1 1 1 1 1 1")"
expect "a ready that does not name the scheme is a failure" "fail" \
  "$(verdict "0 1 1 1 1 1")"
expect "and names where the switch is read" "yes" \
  "$(says "0 1 1 1 1 1" "ElectronSchemesIn")"
expect "a page with no origin in its scheme is a failure" "fail" \
  "$(verdict "1 0 0 0 0 1")"
expect "and names the scheme registration and the child processes" "yes" \
  "$(says "1 0 0 0 0 1" "AppendExtraCommandLineSwitches")"
expect "a page that is not a secure context is a failure" "fail" \
  "$(verdict "1 1 0 1 1 1")"
expect "and names secure_schemes" "yes" "$(says "1 1 0 1 1 1" "secure_schemes")"
expect "a fetch() that read nothing is a failure" "fail" \
  "$(verdict "1 1 1 0 1 1")"
expect "and names the renderer's registration" "yes" \
  "$(says "1 1 1 0 1 1" "RenderThreadStarted")"
expect "a picture from this machine that did not load is a failure" "fail" \
  "$(verdict "1 1 1 1 0 1")"
expect "and names the address space" "yes" \
  "$(says "1 1 1 1 0 1" "DetermineAddressSpaceFromURL")"

echo
echo "the control — a scheme nobody registered"
expect "one with an origin is a failure" "fail" "$(verdict "1 1 1 1 1 0")"
expect "and says the guard measures nothing" "yes" \
  "$(says "1 1 1 1 1 0" "measures nothing")"
expect "an empty measurement is a failure" "fail" "$(verdict "")"

[ "$FAILED" -eq 0 ] && echo "all ok"
exit "$FAILED"
