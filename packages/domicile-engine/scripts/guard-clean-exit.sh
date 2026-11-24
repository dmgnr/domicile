#!/usr/bin/env bash
# Checks that the engine records a clean exit when a session end sends it two
# SIGTERMs.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-clean-exit.sh /build/chromium/src
#
# At a session end systemd signals every process in the session, and the
# launcher signals the engine too. Upstream Chromium dies on the second
# SIGTERM, part way through `SessionEnding()`, before it writes the clean-exit
# beacon, so the next start counts a crash. Patch 0259 ignores the second. The
# beacon is the profile's `Variations` file.
#
# Control: NEGATIVE=1 sends SIGKILL instead. The beacon must say the engine did
# not exit cleanly, which proves the guard reads it.
#
# Headless, with no compositor or client.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-clean-exit: no path to chromium/src was given"
  exit 1
fi

NEGATIVE="${NEGATIVE:-0}"
WHICH=""
[ "$NEGATIVE" = "1" ] && WHICH="-negative"

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-clean-exit$WHICH-broker}"
PROFILE="${PROFILE:-/tmp/domicile-clean-exit$WHICH-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-clean-exit$WHICH-engine.log}"
FOR_SECONDS="${FOR_SECONDS:-60}"
# Longer than `EndSession()`'s ten-second wait for its writes.
TO_EXIT_SECONDS="${TO_EXIT_SECONDS:-20}"

ENGINE=""
cleanup() {
  if [ -n "$ENGINE" ]; then
    kill -KILL "$ENGINE" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-clean-exit: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}

fresh_broker
rm -rf "$PROFILE"; mkdir -p "$PROFILE"

# The beacon's value, `true`, `false`, or empty while there is no file.
beacon() {
  python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as beacon:
        said = json.load(beacon)
except (FileNotFoundError, json.JSONDecodeError):
    sys.exit(0)
print(json.dumps(said.get("user_experience_metrics.stability.exited_cleanly")))
' "$PROFILE/Variations"
}

rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-clean-exit.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
ENGINE=$!

# Up, and the beacon says a run is in progress. No early exit when either never
# comes: the verdict below says why, with the engine's log.
for _ in $(seq 1 $((FOR_SECONDS * 4))); do
  grep -qF "GUARD clean-exit ready" "$ENGINE_LOG" 2>/dev/null \
    && [ "$(beacon)" = "false" ] && break
  sleep 0.25
done
STARTED="$(beacon)"

case "$NEGATIVE" in
1) kill -KILL "$ENGINE" ;;
# Back to back, as a session end sends them.
*) kill -TERM "$ENGINE"; kill -TERM "$ENGINE" ;;
esac

# A hung engine is killed, and its status says so.
( sleep "$TO_EXIT_SECONDS"; kill -KILL "$ENGINE" 2>/dev/null ) &
WATCHDOG=$!
wait "$ENGINE"
STATUS=$?
kill "$WATCHDOG" 2>/dev/null
ENGINE=""
ENDED="$(beacon)"

echo "beacon at start: ${STARTED:-none}; at the end: ${ENDED:-none}; exit status: $STATUS"

FAILURE=""
if ! grep -qF "GUARD clean-exit ready" "$ENGINE_LOG"; then
  FAILURE="the shell never ran, or ran and never said so"
elif [ "$STARTED" != "false" ]; then
  FAILURE="the beacon never said a run was in progress (${STARTED:-no Variations file}), so it measures nothing"
elif [ "$NEGATIVE" = "1" ]; then
  [ "$ENDED" = "false" ] \
    || FAILURE="the control failed: after SIGKILL the beacon says $ENDED, so the guard cannot tell a crash from a clean exit"
elif [ "$STATUS" != "0" ] || [ "$ENDED" != "true" ]; then
  FAILURE="two SIGTERMs did not end the engine cleanly (exit status $STATUS, 137 if still running after ${TO_EXIT_SECONDS}s; exited_cleanly $ENDED): patch 0259 is missing, so every session end counts as a crash"
fi

if [ -n "$FAILURE" ]; then
  annotate_from "guard-clean-exit$WHICH: $FAILURE" "$ENGINE_LOG"
  echo "guard-clean-exit$WHICH: $FAILURE" >&2
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
fi
case "$NEGATIVE" in
1) echo "PASS (control): after SIGKILL the beacon says the engine did not exit cleanly" ;;
*) echo "PASS: two SIGTERMs end the engine cleanly" ;;
esac
