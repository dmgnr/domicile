#!/usr/bin/env bash
# Tests the verdict of `guard-webview-keyboard.sh`: which readings pass and
# which component a failure blames.
#
# The checks are ordered: with no chord claimed, or the browser window never
# focused, nothing else means anything. Easy to get backward:
#
#   - In the negative run, the chord firing is the failure.
#   - The shell's document seeing an ungrabbed key fails, because it
#     contradicts the comment in `WebViewGuest::PreHandleKeyboardEvent`.
#   - The shell's document seeing no key before focus moved still passes and
#     reports the missing reading. The claims are measured in the browser
#     process; a browser with no display to activate may deliver no DOM
#     events at all.
#
# Runs the verdict block from the real guard, so moving it fails here.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
GUARD="$ROOT/packages/domicile-engine/scripts/guard-webview-keyboard.sh"
[ -f "$GUARD" ] || {
  echo "no guard at $GUARD" >&2
  exit 1
}

# From `FAILURE=""` to the column-zero `fi` that ends the decision. The nested
# `fi` is indented, so the match cannot stop early.
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

# A run where every reading has its passing value; each case overrides one by
# name, which reads better than positional arguments.
verdict() { # $1 NEGATIVE, then NAME=value overrides
  (
    SAW_CLAIM=1
    SAW_PAGE=1
    SAW_FOCUS=1
    SAW_RELAY=0
    SAW_SHORTCUT=1
    SAW_RELEASE=1
    SAW_MODIFIERS=1
    SAW_HOOK=1
    SAW_SHELL_KEY=1
    SAW_DOCUMENT_KEY=0
    SAW_GUEST_KEY=0
    SAW_GUEST_CHORD=1
    SAW_PLAIN_CHORD=0
    SAW_ZOOM=1
    SAW_ZOOM_DRAWN=1
    DELIVERED=2
    SAW_ALT_UP=1
    SAW_PLAIN_UP=0
    NEGATIVE="$1"
    shift
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
  )
}

# The failure message, for cases that check which component it blames. Tests
# match a keyword, not the whole sentence.
reason() { # $1 NEGATIVE, then NAME=value overrides
  (
    SAW_CLAIM=1
    SAW_PAGE=1
    SAW_FOCUS=1
    SAW_RELAY=0
    SAW_SHORTCUT=1
    SAW_RELEASE=1
    SAW_MODIFIERS=1
    SAW_HOOK=1
    SAW_SHELL_KEY=1
    SAW_DOCUMENT_KEY=0
    SAW_GUEST_KEY=0
    SAW_GUEST_CHORD=1
    SAW_PLAIN_CHORD=0
    SAW_ZOOM=1
    SAW_ZOOM_DRAWN=1
    DELIVERED=2
    SAW_ALT_UP=1
    SAW_PLAIN_UP=0
    NEGATIVE="$1"
    shift
    for override in "$@"; do
      eval "$override"
    done
    eval "$BLOCK"
    echo "$FAILURE"
  )
}

blames() { # $1 word, then the args verdict takes
  local word="$1"
  shift
  case "$(reason "$@")" in
  *"$word"*) echo yes ;;
  *) echo no ;;
  esac
}

echo "a run that never got as far as measuring anything"
expect "no claim is a failure in the positive run" "fail" \
  "$(verdict 0 SAW_CLAIM=0)"
# The negative run must fail too: with no claim, nothing firing is also what a
# broken harness looks like.
expect "no claim is a failure in the negative run" "fail" \
  "$(verdict 1 SAW_CLAIM=0)"
expect "no claim blames the harness" "yes" \
  "$(blames "harness" 0 SAW_CLAIM=0)"
expect "an unfocused window is a failure" "fail" "$(verdict 0 SAW_FOCUS=0)"
expect "an unfocused window is a failure in the negative run too" "fail" \
  "$(verdict 1 SAW_FOCUS=0)"
expect "an unfocused window blames the harness" "yes" \
  "$(blames "harness" 0 SAW_FOCUS=0)"

echo
echo "the claim itself, which the compositor must no longer be told about"
expect "a relayed claim is a failure" "fail" "$(verdict 0 SAW_RELAY=1)"
expect "a relayed claim is a failure in the negative run too" "fail" \
  "$(verdict 1 SAW_RELAY=1)"
expect "a relayed claim names the socket" "yes" \
  "$(blames "control socket" 0 SAW_RELAY=1)"

echo
echo "the positive run — a <webview>, over which the chord must reach the shell"
expect "everything arriving is the pass" "pass" "$(verdict 0)"
# An empty window means the guest was never created. Only the positive run
# checks this; the control's <iframe> does not load the page.
expect "an empty window is a failure" "fail" "$(verdict 0 SAW_PAGE=0)"
expect "an empty window names the guest" "yes" \
  "$(blames "the guest" 0 SAW_PAGE=0)"
expect "no chord is a failure" "fail" "$(verdict 0 SAW_SHORTCUT=0)"
expect "no chord blames the hook" "yes" \
  "$(blames "PreHandleKeyboardEvent" 0 SAW_SHORTCUT=0)"
expect "no release is a failure" "fail" "$(verdict 0 SAW_RELEASE=0)"
expect "no release blames its leg back" "yes" \
  "$(blames "ShortcutReleased" 0 SAW_RELEASE=0)"
expect "no modifiers is a failure" "fail" "$(verdict 0 SAW_MODIFIERS=0)"

echo
echo "the open question — where an ungrabbed key ends up"
expect "a key that never reached the guest's hook is a failure" "fail" \
  "$(verdict 0 SAW_HOOK=0)"
expect "a key that never reached the guest's hook decides nothing" "yes" \
  "$(blames "not decided" 0 SAW_HOOK=0)"
# Inverted: both seeing the key means the shell's keys work over a browser
# window, but it still fails because the documented behavior would be wrong.
expect "a key that reached both is a failure" "fail" \
  "$(verdict 0 SAW_DOCUMENT_KEY=1)"
expect "a key that reached both points at where the answer is written down" \
  "yes" "$(blames "in its own comment" 0 SAW_DOCUMENT_KEY=1)"
# A harness that delivered no key to the shell's document before focus moved
# cannot measure the absence after it. The other claims still hold, so this
# passes and reports the missing reading.
expect "no key before focus is still a pass" "pass" \
  "$(verdict 0 SAW_SHELL_KEY=0)"
expect "no key before focus is checked after the readings it cannot excuse" \
  "fail" "$(verdict 0 SAW_SHELL_KEY=0 SAW_SHORTCUT=0)"

echo
echo "a chord the page left alone — what a browser window's Ctrl+R is"
expect "a chord never handed back is a failure" "fail" \
  "$(verdict 0 SAW_GUEST_CHORD=0)"
expect "a chord never handed back blames the guest's delegate" "yes" \
  "$(blames "HandleKeyboardEvent" 0 SAW_GUEST_CHORD=0)"
# Privacy: handing back plain keys would copy every keystroke, passwords
# included, into the shell's document.
expect "a plain key handed back is a failure" "fail" \
  "$(verdict 0 SAW_PLAIN_CHORD=1)"
expect "a plain key handed back names what it copies" "yes" \
  "$(blames "keystroke" 0 SAW_PLAIN_CHORD=1)"

echo
echo "keys delivered to the page, which the shell hears without their keys"
expect "a lone Alt never handed back is a failure" "fail" \
  "$(verdict 0 SAW_ALT_UP=0)"
expect "a lone Alt never handed back blames the guest's delegate" "yes" \
  "$(blames UnhandledModifierUp 0 SAW_ALT_UP=0)"
expect "a plain key's release handed back is a failure" "fail" \
  "$(verdict 0 SAW_PLAIN_UP=1)"
expect "a plain key's release handed back names what it copies" "yes" \
  "$(blames password 0 SAW_PLAIN_UP=1)"
expect "no lone Alt is not the control's business" "pass" \
  "$(verdict 1 SAW_SHORTCUT=0 SAW_ALT_UP=0)"

expect "no key delivered is a failure" "fail" "$(verdict 0 DELIVERED=0)"
expect "no key delivered blames the delegate" "yes" \
  "$(blames "KeyDelivered" 0 DELIVERED=0)"
# A claimed chord is the shell's own key, not typing in the page.
expect "the claimed chord delivered is a failure" "fail" \
  "$(verdict 0 DELIVERED=3)"
expect "the claimed chord delivered names the chord" "yes" \
  "$(blames "claimed chord" 0 DELIVERED=3)"
expect "no key delivered is not the control's business" "pass" \
  "$(verdict 1 SAW_SHORTCUT=0 DELIVERED=0)"

echo
echo "the zoom the first handed-back chord asks for"
expect "no zoom reported is a failure" "fail" "$(verdict 0 SAW_ZOOM=0)"
expect "no zoom reported blames the report" "yes" \
  "$(blames "ReportZoom" 0 SAW_ZOOM=0)"
# The element reports a zoom the page never draws: HostZoomMap holds a level
# the guest's widget did not apply.
expect "a zoom the page never drew is a failure" "fail" \
  "$(verdict 0 SAW_ZOOM_DRAWN=0)"
expect "a zoom the page never drew names the widget" "yes" \
  "$(blames "widget" 0 SAW_ZOOM_DRAWN=0)"
expect "no zoom is not the control's business" "pass" \
  "$(verdict 1 SAW_SHORTCUT=0 SAW_GUEST_CHORD=0 SAW_ZOOM=0 SAW_ZOOM_DRAWN=0)"

echo
echo "the negative run — an <iframe>, over which nothing may fire"
expect "no chord is the pass" "pass" "$(verdict 1 SAW_SHORTCUT=0)"
expect "a chord is the failure" "fail" "$(verdict 1)"
expect "a chord says there is no guest to have matched it" "yes" \
  "$(blames "no guest" 1)"
# An <iframe> receives every key, so the positive run's failures are normal in
# the control.
expect "an empty window is not the control's business" "pass" \
  "$(verdict 1 SAW_SHORTCUT=0 SAW_PAGE=0)"
expect "the modifiers are not the control's business" "pass" \
  "$(verdict 1 SAW_SHORTCUT=0 SAW_MODIFIERS=0)"
expect "an ungrabbed key reaching the document is not the control's business" \
  "pass" "$(verdict 1 SAW_SHORTCUT=0 SAW_DOCUMENT_KEY=1)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the keyboard guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
