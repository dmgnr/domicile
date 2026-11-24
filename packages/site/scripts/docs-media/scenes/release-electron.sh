# Release notes: Element, an Electron app, on the desktop's engine, with its
# menu bar under its tab.

ELEMENT="$(nix build --no-link --print-out-paths nixpkgs#element-desktop)"
# A fresh Element asks where to keep its keys before any page; this answers it.
mkdir -p "$SCENE_TMP/config/Element"
echo '{"safeStorageBackend":"basic_text"}' >"$SCENE_TMP/config/Element/electron-config.json"
desktop @domicile-desktop/manganese
# Electron apps on the engine read settings and send notifications through
# the portal frontend, which a session starts and the scene's own bus lacks.
# Domicile's backend on this bus answers it.
PORTAL="$(nix build --no-link --print-out-paths nixpkgs#xdg-desktop-portal)"
DOMICILE_SHARE="$(dirname "$(readlink -f "$DOMICILE_BIN")")/../share"
XDG_CURRENT_DESKTOP=domicile \
XDG_DESKTOP_PORTAL_DIR="$DOMICILE_SHARE/xdg-desktop-portal/portals" \
XDG_DATA_DIRS="$DOMICILE_SHARE:${XDG_DATA_DIRS:-/run/current-system/sw/share}" \
  "$PORTAL/libexec/xdg-desktop-portal" >>"$SCENE_TMP/portal.log" 2>&1 &
STARTED+=($!)
portal_up() {
  "$DBUS/bin/dbus-send" --session --print-reply --dest=org.freedesktop.DBus \
    /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
    string:org.freedesktop.portal.Desktop 2>/dev/null | grep -q 'boolean true'
}
for _ in $(seq 1 40); do
  portal_up && break
  sleep 0.25
done
if ! portal_up; then
  echo "the portal frontend never came up. It said:" >&2
  tail -40 "$SCENE_TMP/portal.log" >&2
  exit 1
fi
# In the desktop's made-up home, where the answer above is. It runs until
# Element quits, so it runs beside the scene.
HOME="$SCENE_TMP/home" XDG_CONFIG_HOME="$SCENE_TMP/config" \
  "$DOMICILE_BIN" open --electron "$ELEMENT/bin/element-desktop" \
  >>"$SCENE_TMP/apps.log" 2>&1 &
STARTED+=($!)
# Element's window is an app window, not a native one. No window in a minute
# is a broken scene: say what the app said rather than shoot an empty desktop.
element_shown() {
  "$DOMICILE_BIN" list-windows | awk 'NR > 1 && $2 != "native" { found = 1 } END { exit !found }'
}
for _ in $(seq 1 60); do
  element_shown && break
  sleep 1
done
if ! element_shown; then
  echo "Element's window never appeared. Its launch said:" >&2
  tail -60 "$SCENE_TMP/apps.log" >&2
  exit 1
fi
settle 10
shot release-electron-closed
keys -k Alt_L
settle 2
shot release-electron
