#!/usr/bin/env bash
# Checks that a site's notification carries the site's favicon as its
# application icon.
#
# Chrome's Linux bridge sent its own logo as every notification's application
# icon, so the desktop drew a site that gives no icon of its own as the
# browser.
#
# Reads the patches, not a Chromium tree, so it runs in the shell group.
# `guard-notification-site-icon.sh` checks the same on a built engine.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine"
PATCHES="$ENGINE/patches"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

BRIDGE="$(grep -al '^+++ b/chrome/browser/notifications/notification_platform_bridge_linux.cc' "$PATCHES"/*.patch)"
# shellcheck disable=SC2086 # one path per patch
if [ -n "$BRIDGE" ] && grep -aq '^+.*favicons->GetRawFaviconForPageURL(' $BRIDGE &&
  grep -aq '^+.*site_icon.is_valid() ? site_icon.bitmap_data' $BRIDGE; then
  ok "the bridge draws a site's notification with the site's favicon"
else
  fail "the bridge draws a site's notification with the site's favicon" \
    "no patch has NotificationPlatformBridgeLinuxImpl look up the site's favicon and write it in place of the logo"
fi

if grep -qx '  guard-notification-site-icon' "$ENGINE/scripts/run-checks.sh"; then
  ok "test:engine runs guard-notification-site-icon.sh"
else
  fail "test:engine runs guard-notification-site-icon.sh" \
    "run-checks.sh does not list guard-notification-site-icon"
fi

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
