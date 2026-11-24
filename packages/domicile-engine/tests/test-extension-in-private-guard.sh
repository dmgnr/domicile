#!/usr/bin/env bash
# Asserts the private-window extension guard's verdict: which answers pass,
# and which end each failure blames.
#
# Runs the verdict block from `guard-extension-in-private.sh` itself, as
# `test-extension-installer-guard.sh` does. A run whose list never crossed the
# socket must fail whatever the probe read, as must a control that saw nothing
# because nothing was sent.
#
# Also checks what the guard cannot check at runtime: its color and id match
# the fixture extension's, and its profiles match what the compositor writes
# and the engine reads.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPTS="$ROOT/packages/domicile-engine/scripts"
GUARD="$SCRIPTS/guard-extension-in-private.sh"
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

# Prints pass or fail, not the message, which may be reworded.
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

# Whether the failure message contains `$2`; the end it blames matters.
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

# MEASURED is "<run> <probe status> <whether the list was sent>".
echo "the claim — the private profile turns the fixture on, and the private page is marked"
expect "sent and marked is a pass" "pass" "$(verdict "allowed 0 1")"
expect "sent and unmarked is a failure" "fail" "$(verdict "allowed 1 1")"
expect "and blames the profile" "yes" "$(says "allowed 1 1" "profile")"
expect "never sent is a failure" "fail" "$(verdict "allowed 1 0")"
expect "and blames the control channel" "yes" \
  "$(says "allowed 1 0" "control channel")"
expect "marked though never sent is a failure" "fail" \
  "$(verdict "allowed 0 0")"
expect "nothing measured is a failure" "fail" "$(verdict "allowed 2 1")"
expect "and blames the harness" "yes" "$(says "allowed 2 1" "harness")"
expect "an unusable probe fails" "fail" "$(verdict "allowed 3 1")"
expect "and a killed one does not pass either" "fail" \
  "$(verdict "allowed 137 1")"

echo
echo "the control — the same extension, a private profile that turns on nothing"
expect "sent, drawn and unmarked is the pass" "pass" "$(verdict "control 1 1")"

# Inverted: a mark is the failure.
expect "a mark the profile did not ask for is a failure" "fail" \
  "$(verdict "control 0 1")"
expect "and says extensions run in private pages unasked" "yes" \
  "$(says "control 0 1" "unasked")"
expect "unmarked but never sent is a failure" "fail" \
  "$(verdict "control 1 0")"
expect "a guest that never drew is a failure" "fail" \
  "$(verdict "control 2 1")"
expect "an unusable probe fails the control" "fail" "$(verdict "control 3 1")"

echo
echo "a run that measured nothing at all"
expect "an empty measurement is a failure" "fail" "$(verdict "")"
expect "and so is a mode nobody runs" "fail" "$(verdict "elephant 0 1")"

echo
echo "the fixture"
FIXTURE="$SCRIPTS/guard-extension-in-private-extension"
COLOR="$(sed -n 's/^readonly COLOR="\([0-9A-F]\{6\}\)"$/\1/p' "$GUARD")"
expect "the guard names its color" "yes" \
  "$([ -n "$COLOR" ] && echo yes || echo no)"
expect "and the content script paints it" "yes" \
  "$(grep -qi "#$COLOR" "$FIXTURE/content.js" 2>/dev/null && echo yes || echo no)"
ID="$(sed -n 's/^readonly ID="\([a-p]\{32\}\)"$/\1/p' "$GUARD")"
KEY="$(sed -n 's/^ *"key": "\([^"]*\)",$/\1/p' "$FIXTURE/manifest.json")"
MADE="$(printf '%s' "$KEY" | base64 -d 2>/dev/null | sha256sum | cut -c1-32 | tr '0-9a-f' 'a-p')"
expect "the guard names an id" "yes" "$([ -n "$ID" ] && echo yes || echo no)"
expect "and it is the one the fixture's key makes" "$ID" "$MADE"

# The compositor's spelling, from the wire fixture `domicile-protocol` is
# tested against. If the stand-in spells the profiles differently, the engine
# drops the message and the guard blames the profile.
WIRE="$ROOT/packages/domicile-protocol/wire/host-messages.jsonl"
expect "the wire's browser_profiles line turns extensions on by id" "yes" \
  "$(grep -q '"type":"browser_profiles",.*"private":true' "$WIRE" &&
    grep -q '"type":"browser_profiles",.*"extensions":\["[a-p]\{32\}"\]' "$WIRE" &&
    echo yes || echo no)"
expect "and the stand-in sends them as that type" "yes" \
  "$(grep -q '"type": "browser_profiles"' \
    "$SCRIPTS/guard-extension-installer-compositor.py" 2>/dev/null &&
    echo yes || echo no)"
expect "and the guard spells a profile as the wire does" "yes" \
  "$(grep -qF '\"default_private_profile\": \"private\"' "$GUARD" &&
    grep -qF '\"private\": true, \"extensions\": $PRIVATE_EXTENSIONS' "$GUARD" &&
    echo yes || echo no)"
CHANNEL="$ROOT/packages/domicile-engine/src/components/domicile/browser/control_channel.cc"
PROFILES="$ROOT/packages/domicile-engine/src/components/domicile/browser/browser_profiles.cc"
expect "and the engine reads them" "yes" \
  "$(grep -q '"browser_profiles"' "$CHANNEL" &&
    grep -q 'FindList("profiles")' "$PROFILES" &&
    grep -q 'Find("extensions")' "$PROFILES" &&
    echo yes || echo no)"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "the private-window extension guard's verdict names the right end in every case"
  exit 0
fi
echo "$FAILED case(s) wrong" >&2
exit 1
