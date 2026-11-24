#!/usr/bin/env bash
# Whether a page that has never drawn stays out of the stall errors.
#
# See patch 0264. Patches 0241, 0245 and 0248 log at ERROR a shown page that
# draws nothing at its new size. On lyra every one was a page that had never
# drawn: new, empty, or embedded nowhere. Each must say so at VERBOSE and
# return before its ERROR line.
#
# Reads the series rather than a build, so it runs on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

added_to() {
  awk -v want="$1" '
    FNR == 1 { in_file = 0 }
    /^diff --git a\// { in_file = (index($0, want) > 0); next }
    !in_file { next }
    /^(\+\+\+|---) / { next }
    /^\+/ { print substr($0, 2) }
  ' "$PATCHES"/*.patch
}

host="$(added_to cc/trees/layer_tree_host.cc)"
impl="$(added_to cc/trees/layer_tree_host_impl.cc)"
widget="$(added_to content/browser/renderer_host/render_widget_host_impl.cc)"

fails=0
want() {
  if grep -qF -- "$2" <<<"$1"; then return; fi
  echo "    missing: $2"
  fails=$((fails + 1))
}

want "$host" 'if (domicile_last_presented_at_.is_null()) {'
want "$host" '<< ") has shown no frame yet, at its new surface "'
want "$impl" 'if (active_tree_->LayerListIsEmpty()) {'
want "$impl" '<< " thread has no content to send at its new surface "'
want "$widget" 'if (domicile_last_acked_size_.IsEmpty()) {'
want "$widget" '<< " has not drawn its first frame, at "'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the checks keeping a page that never drew out of the stall errors are missing"
  exit 1
fi
echo "ok: a page that never drew is no stall"
