#!/usr/bin/env bash
# `domicile-session.target` wants `xdg-desktop-autostart.target`, and a
# target is ordered after what it wants unless told otherwise. Each
# `~/.config/autostart` entry's generated unit is ordered after
# `graphical-session.target`, which the session target comes before. Without
# an explicit order between the session and the autostart target that is a
# cycle, and systemd breaks it by dropping the autostart target: no autostart
# entry starts, the keyring's among them. This loads the installed target
# beside stand-ins for systemd's own units and one generated autostart entry,
# and asks `systemd-analyze verify` for a cycle.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TARGET="$ROOT/packages/distro/share/domicile-session.target"
[ -f "$TARGET" ] || { echo "no $TARGET" >&2; exit 1; }
if ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "  SKIP: no systemd-analyze to verify the session's user units"
  exit 77
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
UNITS="$WORK/units"
mkdir -p "$UNITS/xdg-desktop-autostart.target.wants" "$WORK/run"
chmod 700 "$WORK/run"
cp "$TARGET" "$UNITS/"
# As systemd ships them.
printf '[Unit]\nDescription=Current graphical user session\nRefuseManualStart=yes\nStopWhenUnneeded=yes\n' \
  >"$UNITS/graphical-session.target"
printf '[Unit]\nDescription=Session services which should run early\nRefuseManualStart=yes\nStopWhenUnneeded=yes\n' \
  >"$UNITS/graphical-session-pre.target"
printf '[Unit]\nDescription=Startup of XDG autostart applications\nPartOf=graphical-session.target\n' \
  >"$UNITS/xdg-desktop-autostart.target"
# As systemd-xdg-autostart-generator writes one.
printf '[Unit]\nDescription=An autostart entry\nPartOf=graphical-session.target\nAfter=graphical-session.target\n[Service]\nExecStart=/bin/true\n' \
  >"$UNITS/app-entry@autostart.service"
ln -s ../app-entry@autostart.service "$UNITS/xdg-desktop-autostart.target.wants/"

OUT="$(XDG_RUNTIME_DIR="$WORK/run" SYSTEMD_UNIT_PATH="$UNITS:" \
  systemd-analyze verify --user "$UNITS/domicile-session.target" 2>&1)"
if printf '%s\n' "$OUT" | grep -q 'ordering cycle'; then
  printf '  FAIL  the session target and the autostart entries form an ordering cycle\n'
  printf '%s\n' "$OUT" | sed 's/^/    /'
  exit 1
fi
printf '  ok    the session starts the autostart entries with no ordering cycle\n'
