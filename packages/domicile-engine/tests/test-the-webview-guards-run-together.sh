#!/usr/bin/env bash
# Tests that `run-checks.sh` runs the headless webview guards concurrently.
# They share no broker, profile or log, and take free ports
# (`test-the-webview-guards-take-free-ports.sh`). Other checks stay serial, and
# the run still stops at the first failure.
#
# No more than `DOMICILE_ENGINE_CHECKS_AT_ONCE` run at once: every one starts a
# browser, and all of them at once starve each other on `crux`.
#
# When the job sets `CARD_OWNER`, every check but latency runs as noise, so
# another run's latency guard waits for it. Latency runs as none, or it would
# wait for its own run.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
ok() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

TOGETHER="webview-framing shell-local-network webview-content-script extension-installer extension-in-private
  extension-tray extension-menu extension-open-popup extension-side-panel webview-keyboard webview-escape webview-history webview-untrusted-cert webview-find
  webview-click webview-activate webview-new-window webview-window-open webview-routed-link webview-target-url webview-fullscreen webview-wake-lock webview-device-request webview-dialog webview-beforeunload webview-print webview-context-menu webview-upload
  webview-download webview-save-picker webview-tabs webview-active-tab webview-passkey-extension
  webview-popup-window windows-state webview-notifications
  webview-survives-load-shell webview-hidden webview-crash webview-private webview-app-window
  webview-partition webview-will-navigate"

# A repository with the runner and a stand-in for every engine check that
# records its start and end.
. "$ROOT/packages/domicile-engine/tests/stand-ins/engine-checks.sh"
stand_in_engine_checks "$WORK/repo"
export DOMICILE_RENDER_NODE_LOCK="$WORK/card" DOMICILE_RENDER_NODE_NOISE="$WORK/noise"
cat >"$WORK/repo/stand-in.sh" <<STUB
#!/usr/bin/env bash
date +%s.%N >"$WORK/\$1.start"
cat "$WORK"/noise/*/owner >"$WORK/\$1.noise" 2>/dev/null
case "\$1" in (guard-webview-*|guard-windows-state|guard-shell-local-network|guard-extension-installer|guard-extension-in-private|guard-extension-tray|guard-extension-menu|guard-extension-open-popup|guard-extension-side-panel) sleep 1 ;; esac
[ "\${FAIL:-}" = "\$1" ] && { echo "\$1 broke"; exit 1; }
date +%s.%N >"$WORK/\$1.end"
STUB
chmod +x "$WORK/repo/stand-in.sh"

AT_ONCE=4
check() { # FAIL=<check to fail>
  rm -f "$WORK"/*.start "$WORK"/*.end
  DOMICILE_ENGINE_CHECKS_AT_ONCE="$AT_ONCE" DOMICILE_CHECK_LOG_DIR="$WORK/logs" \
    "$WORK/repo/packages/domicile-engine/scripts/run-checks.sh" >"$WORK/out" 2>&1
}

check

# Every name above must exist and run. A missing script would silently skip
# the batch, and the timing check below would not notice.
absent=""
for g in $TOGETHER; do
  [ -e "$WORK/guard-$g.start" ] || absent="$absent $g"
done
[ -z "$absent" ] && ok "every guard named to run together ran" ||
  fail "every guard named to run together ran" "never started:$absent"

starts=""; ends=""
for g in $TOGETHER; do
  starts="$starts $(cat "$WORK/guard-$g.start" 2>/dev/null)"
  ends="$ends $(cat "$WORK/guard-$g.end" 2>/dev/null)"
done
# The most checks running at any one start.
most="$(for g in $TOGETHER; do
  echo "$(cat "$WORK/guard-$g.start") $(cat "$WORK/guard-$g.end")"
done | awk '{ start[NR] = $1; end[NR] = $2 }
  END {
    for (i = 1; i <= NR; i++) {
      n = 0
      for (j = 1; j <= NR; j++) if (start[j] <= start[i] && start[i] < end[j]) n++
      if (n > most) most = n
    }
    print most + 0
  }')"
[ "$most" -gt 1 ] &&
  ok "the webview guards and windows-state run at the same time" ||
  fail "the webview guards and windows-state run at the same time" "at most $most at once: $(cat "$WORK/out")"
[ "$most" -le "$AT_ONCE" ] &&
  ok "but no more than $AT_ONCE at once" ||
  fail "but no more than $AT_ONCE at once" "$most ran at once"

missing=""
for name in $(engine_checks); do
  grep -qE "^  $name +ok$" "$WORK/out" || missing="$missing $name"
done
[ -z "$missing" ] && ok "every engine check is reported" ||
  fail "every engine check is reported" "missing:$missing"

# Serial around the batch: the GPU guards before it, latency after it.
latency="$(cat "$WORK/guard-latency.start" 2>/dev/null)"
last_end="$(printf '%s\n' $ends | sort -n | tail -1)"
if [ -n "$latency" ] && awk "BEGIN { exit !($latency >= $last_end) }"; then
  ok "latency waits for the batch"
else
  fail "latency waits for the batch" "latency started $latency, batch ended $last_end"
fi

CARD_OWNER=engine-run-9 check
quiet_ones=""
noisy_ones=""
for name in $(engine_checks); do
  if grep -qx engine-run-9 "$WORK/$name.noise" 2>/dev/null; then
    noisy_ones="$noisy_ones $name"
  else
    quiet_ones="$quiet_ones $name"
  fi
done
[ "$quiet_ones" = " guard-latency" ] &&
  ok "every engine check but latency runs as this job's noise" ||
  fail "every engine check but latency runs as this job's noise" \
    "ran as none:$quiet_ones"
[ ! -s "$WORK/guard-latency.noise" ] &&
  ok "and latency runs beside none of it" ||
  fail "and latency runs beside none of it" "$(cat "$WORK/guard-latency.noise")"

FAIL=guard-webview-click check
grep -q "webview-click broke" "$WORK/out" &&
  ok "a failure in the batch shows its log" ||
  fail "a failure in the batch shows its log" "$(cat "$WORK/out")"
[ ! -e "$WORK/guard-latency.start" ] &&
  ok "and nothing after the batch runs" ||
  fail "and nothing after the batch runs" "latency ran"

[ "$FAILED" -eq 0 ] && { echo "all ok"; exit 0; }
echo "$FAILED failed"; exit 1
