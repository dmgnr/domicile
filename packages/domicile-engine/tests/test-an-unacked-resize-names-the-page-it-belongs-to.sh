#!/usr/bin/env bash
# Whether a page whose resize is never acked names the page it belongs to.
#
# See patch 0253. 0241's line named the widget only by its frame sink, which
# no renderer line mentions, so a widget that never drew could not be told
# from one that froze, nor matched to its renderer's lines. The line must name
# the renderer's pid, the widget's kind, its page's kind and its page's URL.
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

want "$host" 'std::string RenderWidgetHostImpl::DomicileDescribeWidget() const {'
want "$host" '? GetProcess()->GetProcess().Pid()'
want "$host" '<< "). It is " << DomicileDescribeWidget()'
want "$host" 'frame_tree_->is_guest()'
want "$host" 'frame_tree_->root()->current_url().possibly_invalid_spec()'

if [ "$fails" -gt 0 ]; then
  echo "FAIL: $fails of the lines naming an unacked widget's page are missing"
  exit 1
fi
echo "ok: an unacked resize names the page it belongs to"
