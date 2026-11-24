#!/usr/bin/env bash
# A key typed at a locked desk stays on the page, even when the compositor
# says a window has the keyboard.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-locked-keys-stay-on-the-page.sh /build/chromium/src
#
# WHY THIS EXISTS. The engine takes each key the page does not stop and sends
# it to the window that has the keyboard. The compositor drops every key sent
# for a client while the desk is locked. A desk that locked with a window
# holding the keyboard took each key from the lock screen's field and sent it
# to be dropped, so the passphrase reached nothing. See docs/LOCK.md.
#
# WHAT IT ASSERTS. With the desk locked and `term` holding the keyboard, a
# typed `a` lands in the page's focused field, no `key` for `term` is written
# down the socket, `domicile-key-delivered` does not fire, and the engine logs
# an error naming `term`: a window should never have the keyboard there.
#
# HOW IT CAN FAIL. NEGATIVE=1 is the control: the same desk, unlocked. The key
# must go to `term` and not into the field, or the field typing proves nothing.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$SCRIPTS/lib-ports.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

NAME="guard-locked-keys-stay-on-the-page"
CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "$NAME: no path to chromium/src was given"
  exit 1
fi

NEGATIVE="${NEGATIVE:-0}"
WHICH=""
UNLOCKED_FLAG=()
if [ "$NEGATIVE" = "1" ]; then
  WHICH="-unlocked"
  UNLOCKED_FLAG=(--unlocked)
fi

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-locked-keys-broker}"
CONTROL="${CONTROL:-/tmp/domicile-locked-keys-control}"
PROFILE="${PROFILE:-/tmp/domicile-locked-keys-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-locked-keys$WHICH-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-locked-keys$WHICH-socket.log}"
DRIVE_LOG="${DRIVE_LOG:-/tmp/domicile-locked-keys$WHICH-drive.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "$NAME: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "$NAME: no python3, and the compositor's end of the control socket and the key are both driven by one"
  exit 77
}

fresh_broker
rm -f "$CONTROL"; rm -rf "$PROFILE"; mkdir -p "$PROFILE"

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/$NAME-compositor.py" --socket "$CONTROL" "${UNLOCKED_FLAG[@]}" \
  >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "$NAME: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  exit 1
}

rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="$NAME.js" \
  --domicile-control-socket="$CONTROL" \
  --remote-debugging-port=0 \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --window-size=1024,768 \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" "GUARD ready" "$ENGINE_LOG" || {
  annotate_from "$NAME: the shell never saw the window holding the keyboard and the lock state" "$ENGINE_LOG"
  tail -40 "$ENGINE_LOG" >&2
  exit 1
}
DEBUG_PORT="$(devtools_port "$PROFILE" "$TRIES")" || {
  annotate_from "$NAME: the engine never said which debugging port it took" "$ENGINE_LOG"
  exit 1
}

rm -f "$DRIVE_LOG"
python3 "$SCRIPTS/$NAME-drive.py" --port "$DEBUG_PORT" >"$DRIVE_LOG" 2>&1 || {
  annotate_from "$NAME: the key could not be driven" "$DRIVE_LOG"
  exit 1
}
sleep 2

# The closing quote is Chromium's and keeps each match on the message: see
# guard-windows-state.sh.
PAGE=$(grep -oE '"GUARD [a-z-]+[^"]*"' "$ENGINE_LOG" | tr '\n' ' ')
# The stand-in prints the browser's JSON as it came; match the key press for
# `term` whatever the field order.
SENT_TO_TERM=$(SOCKET_LOG="$SOCKET_LOG" python3 - <<'PY'
import json, os
count = 0
with open(os.environ["SOCKET_LOG"], encoding="utf-8") as log:
    for line in log:
        if line.startswith("said: "):
            try:
                message = json.loads(line[len("said: "):])
            except ValueError:
                continue
            if message.get("type") == "key" and message.get("app_id") == "term" and message.get("pressed"):
                count += 1
print(count)
PY
)

FAILURE=""
if [ "$NEGATIVE" = "1" ]; then
  if ! grep -qF '"GUARD ready locked=false"' "$ENGINE_LOG"; then
    FAILURE="the control's desk was not unlocked ($PAGE)"
  elif [ "$SENT_TO_TERM" != "1" ]; then
    FAILURE="on an unlocked desk the key was sent to term $SENT_TO_TERM times where once was owed, so the window never had the keyboard and the locked run proves nothing ($PAGE)"
  elif grep -qF '"GUARD typed' "$ENGINE_LOG"; then
    FAILURE="on an unlocked desk the key typed into the page's field too, so the field typing proves nothing ($PAGE)"
  fi
else
  if ! grep -qF '"GUARD ready locked=true"' "$ENGINE_LOG"; then
    FAILURE="the desk was not locked ($PAGE)"
  elif [ "$SENT_TO_TERM" != "0" ]; then
    FAILURE="the locked desk sent the key to term $SENT_TO_TERM times, taking it from the lock screen ($PAGE)"
  elif ! grep -qF '"GUARD typed a"' "$ENGINE_LOG"; then
    FAILURE="the key typed at the locked desk never reached the page's focused field ($PAGE)"
  elif grep -qF '"GUARD key-delivered"' "$ENGINE_LOG"; then
    FAILURE="the locked desk fired domicile-key-delivered for term ($PAGE)"
  elif ! grep -qF 'the desk is locked but window "term" has the keyboard' "$ENGINE_LOG"; then
    FAILURE="the engine kept the key on the page without saying a window had the keyboard on a locked desk ($PAGE)"
  fi
fi

echo "page: $PAGE"

if [ -n "$FAILURE" ]; then
  annotate_from "$NAME: $FAILURE" "$ENGINE_LOG"
  echo "$NAME: $FAILURE" >&2
  echo "the compositor stand-in said:" >&2
  tail -40 "$SOCKET_LOG" >&2
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
fi
if [ "$NEGATIVE" = "1" ]; then
  echo "PASS (control): on an unlocked desk the key goes to the window with the keyboard"
else
  echo "PASS: a locked desk's key stays on the page"
fi
