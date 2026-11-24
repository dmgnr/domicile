#!/usr/bin/env bash
# Checks the patch series makes the browser ignore shutdown signals after the
# first, instead of putting their default action back.
#
# A session end sends the engine at least two SIGTERMs: systemd signals every
# process in the session, and the launcher signals the engine too. Upstream's
# handler puts `SIG_DFL` back after the first, so the second killed the browser
# part way through `SessionEnding()`, before it wrote the clean-exit beacon.
# Every start then counted a crash. `guard-clean-exit.sh` checks a build.
#
# Reads the patches, not a Chromium tree, so it runs in the shell group.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

# The lines the series adds and removes in the shutdown signal handlers.
changed="$(awk '
  /^diff --git a\// { in_file = ($0 ~ /shutdown_signal_handlers_posix\.cc$/) }
  in_file && /^[-+][^-+]/ { print }
' "$PATCHES"/*.patch 2>/dev/null)"

failed=0
check() { # description, pattern
  case "$changed" in
    (*"$2"*) echo "  ok    $1" ;;
    (*) echo "  FAIL  $1"; echo "    no patch line holds: $2"; failed=$((failed + 1)) ;;
  esac
}

check 'the default action is no longer put back' '-  action.sa_handler = SIG_DFL;'
check 'later shutdown signals are ignored' '+  action.sa_handler = SIG_IGN;'
check 'all three shutdown signals are ignored' '+  for (int shutdown_signal : {SIGTERM, SIGINT, SIGHUP}) {'

if [ "$failed" -gt 0 ]; then
  echo "$failed failed"
  exit 1
fi
echo "all ok"
