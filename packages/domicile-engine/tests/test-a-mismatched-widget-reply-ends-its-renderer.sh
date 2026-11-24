#!/usr/bin/env bash
# Whether a blink.mojom.Widget reply to the wrong request ends its renderer.
#
# See patch 0230 for why such a reply hangs its page. The series must report
# it as a bad message in the name-mismatch branch of
# InterfaceEndpointClient::HandleValidatedMessage, and nowhere else.
#
# Reads the series rather than a build, so it runs on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATCHES="$ROOT/packages/domicile-engine/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

# The lines the series adds to interface_endpoint_client.cc.
added="$(
  awk '
    FNR == 1 { in_file = 0 }
    /^diff --git a\// { in_file = ($0 ~ /bindings\/lib\/interface_endpoint_client[.]cc$/); next }
    !in_file { next }
    /^(\+\+\+|---) / { next }
    /^\+/ { print substr($0, 2) }
  ' "$PATCHES"/*.patch
)"

# The one call, and the line it must follow: the name-mismatch log.
calls="$(grep -c 'DomicileReportRefusedWidgetResponse(message' <<<"$added")"
after_mismatch="$(grep -A1 -F '<< pending_response->request_message_name;' <<<"$added" |
  grep -c 'DomicileReportRefusedWidgetResponse(message')"

if grep -qF 'message->NotifyBadMessage(why);' <<<"$added" &&
  grep -qF 'interface_name == "blink.mojom.Widget"' <<<"$added" &&
  [ "$calls" -eq 1 ] && [ "$after_mismatch" -eq 1 ]; then
  echo "  ok    a mismatched Widget reply ends its renderer"
else
  echo "  FAIL  a mismatched Widget reply ends its renderer"
  echo "    want one bad-message report, in the name-mismatch branch; found"
  echo "    $calls report(s), $after_mismatch after the mismatch log."
  exit 1
fi
