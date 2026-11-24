#!/usr/bin/env bash
# Checks that the shell starts dedicated and shared workers, classic and
# module, from scripts beside it.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-shell-workers.sh /build/chromium/src
#
# The browser fetches a worker's main script itself, through the factories
# `RegisterNonNetworkWorkerMainResourceURLLoaderFactories` returns, not the
# page's. Without domicile:// there (patch 0226) every worker aborts with
# net::ERR_ABORTED while fetch() of the same file works. Each worker imports a
# second script, so a reply also covers the worker's own subresource loads.
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
  annotate "guard-shell-workers: no path to chromium/src was given"
  exit 1
fi

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-workers-broker}"
PROFILE="${PROFILE:-/tmp/domicile-workers-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-workers-engine.log}"
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
  annotate "guard-shell-workers: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}

fresh_broker; rm -rf "$PROFILE"; mkdir -p "$PROFILE"

rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --app="domicile://shell/" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-shell-workers.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# No early exit when it never comes: the verdict below says why, with the
# engine's log.
for _ in $(seq 1 $((FOR_SECONDS * 4))); do
  grep -qF "GUARD workers " "$ENGINE_LOG" 2>/dev/null && break
  sleep 0.25
done

# The closing quote is Chromium's and keeps the match on the message: see
# guard-windows-state.sh.
SAID=$(grep -oE '"GUARD workers [^"]*"' "$ENGINE_LOG" | head -1)

FAILURE=""
case "$SAID" in
'"GUARD workers classic=replied module=replied shared=replied shared-module=replied"')
  ;;
'"GUARD workers '*)
  FAILURE="a worker from the shell's root did not reply ($SAID): the browser has no domicile:// loader for a worker's main script (RegisterNonNetworkWorkerMainResourceURLLoaderFactories, patch 0226), or none for its imports (RegisterNonNetworkSubresourceURLLoaderFactories, patch 0008)"
  ;;
*)
  FAILURE="the shell never ran, or ran and never said so: DomicileShell did not run the module, or the module was refused"
  ;;
esac

echo "shell: $SAID"

if [ -n "$FAILURE" ]; then
  annotate_from "guard-shell-workers: $FAILURE" "$ENGINE_LOG"
  echo "guard-shell-workers: $FAILURE" >&2
  echo "the engine said:" >&2
  tail -40 "$ENGINE_LOG" >&2
  exit 1
fi
echo "PASS: the shell starts dedicated and shared workers, classic and module, and each loads its own import"
