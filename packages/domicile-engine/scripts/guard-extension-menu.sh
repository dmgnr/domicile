#!/usr/bin/env bash
# Every installed extension in the shell's menu, switched off and on,
# configured and kept, through `installedExtensions` and its three calls.
#
#   nix develop .#full --command \
#     ./packages/domicile-engine/scripts/guard-extension-menu.sh /build/chromium/src
#
# WHY THIS EXISTS. A shell's tray menu lists every extension, switched on or
# off, and changes them through the browser: ExtensionTray's InstalledChanged,
# SetEnabled, Configure and Uninstall. None of it is a page's to fake.
#
# Headless, with guard-extension-installer.sh's stand-in for the compositor
# naming guard-extension-tray.sh's fixture as `unpacked`, and its config
# setting the fixture's `file_access`.
#
# WHAT IT ASSERTS. That the shell heard `installedextensionschanged` with the
# fixture switched on, installed by the config, a PNG icon, `fileAccess` named
# as the config's and no private-window setting, which a private browser
# profile's switches replace; that configureExtension() refuses
# `fileAccess`, which the config sets, and uninstallExtension(), since the
# config installed it, each with an OperationError; and that
# setExtensionEnabled() switches it off, dropping its action from
# `extensions`, and back on.
#
# HOW IT CAN FAIL. NEGATIVE=1 runs the control: the list empty. The shell must
# still hear `installedextensionschanged` with no fixture in it, and
# setExtensionEnabled() of the fixture must be refused -- so the claim's row
# and changes are the browser's.
set -u

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=packages/domicile-engine/scripts/lib-annotate.sh
. "$SCRIPTS/lib-annotate.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-last-words.sh
. "$SCRIPTS/lib-last-words.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-profile.sh
. "$SCRIPTS/lib-profile.sh"
# shellcheck source=packages/domicile-engine/scripts/lib-broker.sh
. "$SCRIPTS/lib-broker.sh"

CHROMIUM="${1:-}"
if [ -z "$CHROMIUM" ]; then
  annotate "guard-extension-menu: no path to chromium/src was given"
  exit 1
fi

NEGATIVE="${NEGATIVE:-0}"

# guard-extension-tray.sh's fixture. `packages/domicile-engine/tests/test-extension-menu-guard.sh`
# holds the id to it.
readonly ID="cobncddhpfhclknjbapgflpohofecjhg"

EXTENSION="$SCRIPTS/guard-extension-tray-extension"

FOR_SECONDS="${FOR_SECONDS:-60}"

OUT="${OUT:-out/Domicile}"
BROKER="${BROKER:-/tmp/domicile-extension-menu-broker}"
CONTROL="${CONTROL:-/tmp/domicile-extension-menu-control}"
PROFILE="${PROFILE:-/tmp/domicile-extension-menu-profile}"
ENGINE_LOG="${ENGINE_LOG:-/tmp/domicile-extension-menu-engine.log}"
SOCKET_LOG="${SOCKET_LOG:-/tmp/domicile-extension-menu-socket.log}"

STARTED=()
cleanup() {
  if [ ${#STARTED[@]} -gt 0 ]; then
    kill "${STARTED[@]}" 2>/dev/null
    wait "${STARTED[@]}" 2>/dev/null
  fi
  remove_profile "$PROFILE"
}
trap cleanup EXIT

[ -x "$CHROMIUM/$OUT/chrome" ] || {
  annotate "guard-extension-menu: no engine at $CHROMIUM/$OUT/chrome; build it with ./packages/domicile-engine/scripts/build.sh"
  exit 1
}
command -v python3 >/dev/null || {
  skip "guard-extension-menu: no python3, and the compositor's end of the socket is served by one"
  exit 77
}

wait_for_line() { # $1 tries, $2 pattern, $3 file
  for _ in $(seq 1 "$1"); do
    grep -qF "$2" "$3" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

fresh_broker
rm -f "$CONTROL"
rm -rf "$PROFILE"
mkdir -p "$PROFILE"

# 1. The compositor's end, naming the fixture and setting its file access --
#    or, for the control, nothing.
if [ "$NEGATIVE" = "1" ]; then
  NAMED=()
else
  NAMED=(--unpacked "$EXTENSION" --settings "{\"$ID\": {\"file_access\": false}}")
fi
rm -f "$SOCKET_LOG"
python3 "$SCRIPTS/guard-extension-installer-compositor.py" \
  --socket "$CONTROL" ${NAMED[@]+"${NAMED[@]}"} >"$SOCKET_LOG" 2>&1 &
STARTED+=($!)
wait_for_line 240 "listening on" "$SOCKET_LOG" || {
  annotate_from "guard-extension-menu: the compositor stand-in never listened on $CONTROL" "$SOCKET_LOG"
  tail -20 "$SOCKET_LOG" >&2
  exit 1
}

# 2. The engine. A real window, as guard-extension-tray.sh's.
rm -f "$ENGINE_LOG"
"$CHROMIUM/$OUT/chrome" \
  --ozone-platform=headless \
  --ozone-override-screen-size=1024,768 \
  --window-size=1024,768 \
  --disable-gpu \
  --app="domicile://shell/?expect=$ID&control=$NEGATIVE" \
  --domicile-shell-root="$SCRIPTS" \
  --domicile-shell-module="guard-extension-menu.js" \
  --domicile-control-socket="$CONTROL" \
  --no-sandbox --password-store=basic --no-first-run --disable-component-update \
  --user-data-dir="$PROFILE" \
  --enable-logging=stderr --log-level=0 \
  --domicile-broker-socket="$BROKER" >"$ENGINE_LOG" 2>&1 &
STARTED+=($!)

TRIES=$((FOR_SECONDS * 4))
wait_for_line "$TRIES" '"GUARD listening"' "$ENGINE_LOG" ||
  echo "the shell module never said it was listening; the verdict below says what that means" >&2

# 3. The wait: the claim ends switched back on, the control refused. Either
#    stops at a failed call.
for _ in $(seq 1 "$TRIES"); do
  grep -qE '"GUARD (on|refused|failed )' "$ENGINE_LOG" 2>/dev/null && break
  sleep 0.25
done

# A moment for anything already dispatched to be written out.
sleep 1

# THE READINGS, each anchored on the quote Chromium puts after a console
# message -- see guard-windows-state.sh for why.
saw() { # $1 fixed string
  grep -qF -- "$1" "$ENGINE_LOG" 2>/dev/null && echo 1 || echo 0
}

SENT=0
grep -qF "sent the extensions" "$SOCKET_LOG" 2>/dev/null && SENT=1
HEARD=$(saw '"GUARD installed count=')
if [ "$NEGATIVE" = "1" ]; then
  # Any row for the fixture at all: an empty list must leave none.
  ROW=$(saw '"GUARD row ')
  MEASURED="control $SENT $HEARD $ROW $(saw '"GUARD refused"')"
else
  ROW=$(saw '"GUARD row enabled=true fromConfig=true icon=true configured=fileAccess"')
  MEASURED="menu $SENT $HEARD $ROW $(saw '"GUARD private"') $(saw '"GUARD locked"') $(saw '"GUARD kept"') $(saw '"GUARD off"') $(saw '"GUARD on"')"
fi

echo
echo "measured: $MEASURED"
echo "what the shell said:"
grep -F '"GUARD ' "$ENGINE_LOG" | tail -12 || true

# WHICH END TO BLAME. `packages/domicile-engine/tests/test-extension-menu-guard.sh` runs this block
# directly. MEASURED is "menu <sent> <heard> <row> <private> <locked> <kept>
# <off> <on>", or "control <sent> <heard> <row> <refused>".
FAILURE=""
PASSED=""
case "$MEASURED" in
"menu 1 1 1 1 1 1 1 1")
  PASSED="the shell heard the fixture as the config installed it, with no \
private-window setting, was refused the config's file access and the uninstall, and \
switched it off, dropping its action, and back on"
  ;;
"menu 0 "*)
  FAILURE="the list was never sent: the browser did not connect to the \
compositor stand-in, so nothing was installed"
  ;;
"menu 1 0 "*)
  FAILURE="the shell heard no installedextensionschanged at all, so \
ExtensionTray did not bind, or bound and never sent InstalledChanged on \
SetClient"
  ;;
"menu 1 1 0 "*)
  FAILURE="the shell heard the installed extensions, but never the fixture as \
the config leaves it -- on, from the config, a PNG icon, fileAccess as the \
config's. The GUARD lines above say what did arrive"
  ;;
"menu 1 1 1 0 "*)
  FAILURE="the fixture's row still has inPrivate, which a private browser \
profile's switches replace: DomicileInstalledExtension, or SettingsOf"
  ;;
"menu 1 1 1 1 0 "*)
  FAILURE="configureExtension() of fileAccess, which the config sets, was not \
refused with an OperationError: SetByConfig, or ConfiguredSettingsOf"
  ;;
"menu 1 1 1 1 1 0 "*)
  FAILURE="uninstallExtension() of the config's extension was not refused \
with an OperationError: UninstallFrom, or the answer's error lost on the way \
back"
  ;;
"menu 1 1 1 1 1 1 0 "*)
  FAILURE="setExtensionEnabled(false) did not switch the fixture off, or its \
action stayed in extensions: SetExtensionEnabledIn, or an unload that sent no \
lists"
  ;;
"menu 1 1 1 1 1 1 1 0")
  FAILURE="setExtensionEnabled(true) did not switch the fixture back on with \
its action"
  ;;
"control 1 1 0 1")
  PASSED="the control is sharp: an empty list left the fixture out of the \
installed extensions the shell did hear, and switching it was refused -- so \
the claim's row and changes are the browser's"
  ;;
"control 0 "*)
  FAILURE="the list was never sent in the control, so its empty list answers \
nothing"
  ;;
"control 1 0 "*)
  FAILURE="the control heard no installedextensionschanged, so the fixture's \
absence from it is not a reading"
  ;;
"control 1 1 1 "*)
  FAILURE="the fixture was installed with an empty list, so the engine \
installed an extension it was not told to, or the profile was not fresh"
  ;;
"control 1 1 0 0")
  FAILURE="switching an extension that is not installed was not refused with \
an OperationError, so the claim's refusals prove nothing"
  ;;
*)
  FAILURE="there is no measurement here of any kind ($MEASURED) -- the run did \
not get as far as reading, or ran a leg this guard does not know"
  ;;
esac

if [ -n "$PASSED" ]; then
  echo "PASS: $PASSED"
  exit 0
fi

annotate_from "guard-extension-menu: $FAILURE" "$ENGINE_LOG"
echo "the compositor stand-in said:" >&2
tail -20 "$SOCKET_LOG" >&2
echo "the engine's last words ($ENGINE_LOG):" >&2
last_words "$ENGINE_LOG" >&2
exit 1
