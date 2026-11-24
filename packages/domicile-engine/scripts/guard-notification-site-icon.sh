#!/usr/bin/env bash
# Checks that a site's notification carries the site's favicon as its
# application icon, in place of the browser's logo (patch 0239).
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-notification-site-icon.sh /build/chromium/src
#
# WHY THIS EXISTS. Chrome's Linux bridge sends its own logo as every
# notification's application icon. The desktop draws a site's notification
# with that logo whenever the page gives no icon of its own, so every site
# looked like the browser.
#
# Headless, on a private bus. guard-notification-window-server.py is the
# notification server, and serves a page whose favicon is solid red and
# that notifies every half second. The shell opens that page in an app
# window. Passes when a Notify's application icon is red at its center: the
# favicon is recorded once the page has loaded, so the first may still
# carry the logo.
#
# NEGATIVE=1 is the control: the same page with no favicon. Its icons must
# never be red, so a red icon is the favicon and not something else.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-last-words.sh
. "$SCRIPTS/lib-last-words.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-ports.sh
. "$SCRIPTS/lib-ports.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-notification-site-icon: no path to chromium/src was given"
  exit 1
fi

NEGATIVE="${NEGATIVE:-0}"

# How long the engine has to start, open the window and notify.
FOR_SECONDS="${FOR_SECONDS:-60}"

OUT="${OUT:-out/Domicile}"
# Not any other guard's paths: CI runs the guards in one job.
BROKER="${BROKER:-/tmp/domicile-notification-site-icon-broker}"
PROFILE="${PROFILE:-/tmp/domicile-notification-site-icon-profile}"
BUS="${BUS:-/tmp/domicile-notification-site-icon-bus}"
BUS_CONFIG="${BUS_CONFIG:-/tmp/domicile-notification-site-icon-bus.conf}"
SERVER_LOG="${SERVER_LOG:-/tmp/domicile-notification-site-icon-server.log}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-notification-site-icon-engine.log}"

# How many notifications the page sends, half a second apart.
TIMES="${TIMES:-20}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
  rm -f "$BUS" "$BUS_CONFIG"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-notification-site-icon: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
for tool in dbus-daemon python3; do
  command -v "$tool" >/dev/null || {
    skip "guard-notification-site-icon: no $tool here; run inside nix develop .#full"
    exit 77
  }
done

# No <servicedir>: a notification daemon installed on the host must not be
# started in the server's place.
cat >"$BUS_CONFIG" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$BUS</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*"/>
    <allow own="*"/>
    <allow receive_sender="*"/>
  </policy>
</busconfig>
EOF

wait_for_line() { # $1 seconds, $2 pattern, $3 file
  for _ in $(seq 1 $(($1 * 4))); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# 1. The bus, and the server on it.
rm -f "$BUS"
dbus-daemon --config-file="$BUS_CONFIG" --nofork --nopidfile >/dev/null 2>&1 &
STARTED+=($!)
for _ in $(seq 1 40); do
  [ -S "$BUS" ] && break
  sleep 0.25
done
[ -S "$BUS" ] || {
  annotate "guard-notification-site-icon: the private bus never came up at $BUS"
  exit 1
}
export DBUS_SESSION_BUS_ADDRESS="unix:path=$BUS"

rm -f "$SERVER_LOG"
python3 "$SCRIPTS/guard-notification-window-server.py" --port 0 >"$SERVER_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 15 "serving" "$SERVER_LOG"
PORT="$(served_port "$SERVER_LOG")" || {
  annotate_from "guard-notification-site-icon: the server never said which port it took" "$SERVER_LOG"
  tail -20 "$SERVER_LOG" >&2
  exit 1
}
# A host without a port, as real sites have: the favicon database finds a
# site's favicon by host, and a host with a port matches none. The engine
# maps it to the server and treats it as secure, since only a secure context
# may notify.
SITE="http://notifying.test"
wait_for_line 15 "took org.freedesktop.Notifications" "$SERVER_LOG" || {
  annotate_from "guard-notification-site-icon: the server never took org.freedesktop.Notifications" "$SERVER_LOG"
  exit 1
}

# 2. The engine. The site may notify: a site's own setting, which patch
#    0105's reset of the default to ask leaves alone.
fresh_broker
rm -rf "$PROFILE"
mkdir -p "$PROFILE/Default"
printf '{"profile":{"content_settings":{"exceptions":{"notifications":{"%s:80,*":{"setting":1}}}}}}\n' \
  "$SITE" >"$PROFILE/Default/Preferences"

if [ "$NEGATIVE" = "1" ]; then
  LEG="bare"
  FAVICON="none"
else
  LEG="favicon"
  FAVICON="red"
fi
SUMMARY="from-a-site"

rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --disable-gpu \
  --host-resolver-rules="MAP notifying.test:80 127.0.0.1:$PORT" \
  --unsafely-treat-insecure-origin-as-secure="$SITE" \
  --app="domicile://shell/?site=$SITE&favicon=$FAVICON&times=$TIMES" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-notification-site-icon.js" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

# 3. The reading: the application icons the leg's notifications carried.
#
#   site    one was red: the site's favicon
#   logo    all were another picture: the browser's logo
#   bare    none named a picture at all
#   silent  the server was never sent one
if ! wait_for_line "$FOR_SECONDS" "ICON $SUMMARY " "$SERVER_LOG"; then
  READING="silent"
else
  # Every notification the page sends, or a red one, whichever is first.
  for _ in $(seq 1 $((FOR_SECONDS * 4))); do
    grep -qF "ICON $SUMMARY red" "$SERVER_LOG" && break
    [ "$(grep -cF "ICON $SUMMARY " "$SERVER_LOG")" -ge "$TIMES" ] && break
    sleep 0.25
  done
  if grep -qF "ICON $SUMMARY red" "$SERVER_LOG"; then
    READING="site"
  elif grep -qF "ICON $SUMMARY other" "$SERVER_LOG"; then
    READING="logo"
  else
    READING="bare"
  fi
fi
MEASURED="$LEG $READING"

echo
echo "measured: $MEASURED"

# packages/domicile-engine/tests/test-notification-site-icon-guard.sh runs this block directly.
FAILURE=""
PASSED=""
case "$MEASURED" in
"favicon site")
  PASSED="a site's notification carries the site's favicon as its \
application icon, so the desktop draws the site and not the browser"
  ;;
"favicon logo")
  FAILURE="a site with a favicon notified with another application icon, \
the browser's logo, so the desktop draws the browser (patch 0239)"
  ;;
"favicon bare" | "bare bare")
  FAILURE="a site's notification named no application icon at all: the \
bridge wrote no picture file. Not the favicon's doing"
  ;;
"favicon silent" | "bare silent")
  FAILURE="the page's notification never reached the server: the window did \
not open, the site was not allowed to notify, or the bridge did not connect. \
This is the harness, not the icon"
  ;;
"bare logo")
  PASSED="the control is sharp: a site with no favicon keeps the browser's \
logo, so the claim's red icon is the favicon"
  ;;
"bare site")
  FAILURE="a site with no favicon notified with a red application icon, so \
red is not the favicon's and the claim measures nothing"
  ;;
*)
  FAILURE="there is no measurement here of any kind ($MEASURED)"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate "guard-notification-site-icon: $FAILURE"
echo "the engine's last words ($ENGINE_LOG):" >&2
last_words "$ENGINE_LOG" >&2
echo "what the server heard ($SERVER_LOG):" >&2
tail -20 "$SERVER_LOG" >&2
exit 1
