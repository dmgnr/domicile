#!/usr/bin/env bash
# Whether a page whose resize is never acked is logged.
#
# See patch 0241. A widget holds every later resize until the page acks the
# last one with a frame at the new size. It must log at ERROR a shown page's wait past
# kDomicileAckWait, and the ack that ends a logged wait.
#
# Reads the series rather than a build, so it runs on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

# The lines the series adds to one file.
added_to() {
  awk -v want="$1" '
    FNR == 1 { in_file = 0 }
    /^diff --git a\// { in_file = (index($0, want) > 0); next }
    !in_file { next }
    /^(\+\+\+|---) / { next }
    /^\+/ { print substr($0, 2) }
  ' "$PATCHES"/*.patch
}

host="$(added_to content/browser/renderer_host/render_widget_host_impl.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$host" 'constexpr base::TimeDelta kDomicileAckWait = base::Seconds(2);'
want "$host" '++domicile_updates_held_;'
want "$host" 'domicile_ack_timer_.Start('
want "$host" '<< " has not acked its resize to "'
want "$host" '<< " acked its resize to "'
want "$host" 'void RenderWidgetHostImpl::DomicileStopWatchingAck() {'
want "$host" 'DomicileStopWatchingAck();'
want "$host" 'is_hidden_) {'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the logs for an unacked resize are missing"
  exit 1
fi
echo "ok: a page whose resize is never acked is logged"
