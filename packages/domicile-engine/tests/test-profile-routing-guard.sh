#!/usr/bin/env bash
# Tests how `guard-profile-routing.sh` reads the engine's log and which results
# it passes.
#
# Runs the guard's own reading and verdict blocks, not copies. Key cases:
#
#   - A window moved to `work`, attached twice and shown at localhost passes.
#   - A move the <webview> never followed fails, and names the element.
#   - A navigation nothing moved fails the claim and passes the control.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-profile-routing.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

READING="$(awk '/^READ="\$\(awk/,/"\$ENGINE_LOG" 2>\/dev\/null\)"$/' "$GUARD")"
BLOCK="$(awk '/^FAILURE=""$/,/^esac$/' "$GUARD")"
[ -n "$READING" ] && [ -n "$BLOCK" ] || {
  echo "no reading or verdict block in $GUARD — its markers moved. Fix this test with it." >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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

# Writes a log with one line per argument: `attach` and `move` as the browser
# logs them, anything else as a console line from the shell or the page.
log() { # lines...
  for line in "$@"; do
    case "$line" in
    attach)
      printf '[1:1:INFO:web_view_guest.cc(882)] domicile: attached browser window 1 to a <webview>.\n'
      ;;
    move)
      printf '[1:1:INFO:domicile_browser_windows.cc(470)] domicile: moved browser window 1 to browser profile work.\n'
      ;;
    *)
      printf '[1:1:INFO:CONSOLE(7)] "GUARD %s", source: http://127.0.0.1:9/page (7)\n' "$line"
      ;;
    esac
  done >"$WORK/engine.log"
}

reads() { # lines...
  log "$@"
  (
    ENGINE_LOG="$WORK/engine.log"
    eval "$READING"
    echo "$READ"
  )
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

echo "reading the log"
expect "a window moved to work and shown again" "1 1 1 1 work 2 visible" \
  "$(reads shell-loaded profile=default attach "page-loaded at=127.0.0.1" \
    "state=visible at=127.0.0.1" attached navigated move profile=work \
    "state=hidden at=127.0.0.1" attach "page-loaded at=localhost" \
    "state=visible at=localhost" settled)"
expect "the old page going hidden last is not the new page's state" \
  "1 1 1 1 work 2 visible" \
  "$(reads shell-loaded profile=default attach "page-loaded at=127.0.0.1" \
    attached navigated move profile=work attach "page-loaded at=localhost" \
    "state=visible at=localhost" "state=hidden at=127.0.0.1" settled)"
expect "a navigation nothing moved" "1 1 1 0 default 1 visible" \
  "$(reads shell-loaded profile=default attach "page-loaded at=127.0.0.1" \
    attached navigated "page-loaded at=localhost" \
    "state=visible at=localhost" settled)"
expect "a shell that never settled did not finish" "1 1 0 0 default 1 none" \
  "$(reads shell-loaded profile=default attach "page-loaded at=127.0.0.1" \
    attached navigated)"
expect "an empty log reads nothing" "0 0 0 0 none 0 none" "$(reads)"

# MEASURED is "<mode> <shell> <first> <steps> <moved> <profile> <attaches>
# <last>".
echo
echo "the claim — localhost is in work"
expect "moved, listed, attached twice and shown is the pass" "pass" \
  "$(verdict "routed 1 1 1 1 work 2 visible")"
expect "never moved is a failure" "fail" \
  "$(verdict "routed 1 1 1 0 default 1 visible")"
expect "and names the routing throttle" "yes" \
  "$(says "routed 1 1 1 0 default 1 visible" "IsUserNavigation")"
expect "moved but attached once is a failure" "fail" \
  "$(verdict "routed 1 1 1 1 work 1 none")"
expect "and names the element" "yes" \
  "$(says "routed 1 1 1 1 work 1 none" "HTMLWebViewElement::Replaced")"
expect "moved but listed in default is a failure" "fail" \
  "$(verdict "routed 1 1 1 1 default 2 visible")"
expect "moved and attached but hidden is a failure" "fail" \
  "$(verdict "routed 1 1 1 1 work 2 hidden")"
expect "a shell that never ran is a failure" "fail" \
  "$(verdict "routed 0 0 0 0 none 0 none")"

echo
echo "the control — no sites"
expect "unmoved, attached once and shown is the control's pass" "pass" \
  "$(verdict "unrouted 1 1 1 0 default 1 visible")"
expect "a move with no sites is the control's failure" "fail" \
  "$(verdict "unrouted 1 1 1 1 work 2 visible")"
expect "and says the claim then proves nothing" "yes" \
  "$(says "unrouted 1 1 1 1 work 2 visible" "proves nothing")"
expect "a page never shown is the control's failure" "fail" \
  "$(verdict "unrouted 1 1 1 0 default 1 none")"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the profile-routing guard reads its log and blames the right end"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
