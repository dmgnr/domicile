#!/usr/bin/env bash
# Checks that logind owns the console and that the desktop asks logind to
# switch VTs.
#
# `Session.TakeControl` puts the VT in `K_OFF`, `KD_GRAPHICS` and
# `VT_PROCESS`, so the kernel ignores `Ctrl+Alt+F<n>` and the desktop must
# request the switch itself. A second `VT_SETMODE` silently replaces logind's
# handshake, after which logind never releases the console. Like other Wayland
# compositors, the desktop uses no VT ioctls and follows the session instead.
#
# Reads `src/` and `patches/` instead of a Chromium tree, so it is cheap
# enough to run on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine"
PATCHES="$ENGINE/patches"
DOMICILE="$ENGINE/src/ui/ozone/platform/drm/domicile"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

# Added lines only (`^+`), so context lines quoting upstream neither satisfy
# nor fail a check.
added="$(cat "$PATCHES"/*.patch 2>/dev/null | grep -a '^+' || true)"
in_patches() { case "$added" in (*"$1"*) return 0 ;; (*) return 1 ;; esac }

sources="$(cat "$DOMICILE"/drm_vt_switcher.h "$DOMICILE"/drm_vt_switcher.cc \
  2>/dev/null || true)"
in_sources() { case "$sources" in (*"$1"*) return 0 ;; (*) return 1 ;; esac }

for f in drm_vt_switcher.h drm_vt_switcher.cc drm_vt_switcher_unittest.cc; do
  if [ -f "$DOMICILE/$f" ]; then
    ok "domicile/$f exists"
  else
    fail "domicile/$f exists" "no such file under src/ui/ozone/platform/drm/domicile"
  fi
done

# Each of these takes the console from logind. `VT_SETMODE` replaces logind's
# handshake without `EBUSY`, and `VT_RELDISP` answers a signal that no longer
# arrives here.
#
# Compares added and removed counts, since a later patch can remove a line an
# earlier one added.
removed="$(cat "$PATCHES"/*.patch 2>/dev/null | grep -a '^-' || true)"
count() { printf '%s\n' "$2" | grep -a -c -F "$1" || true; }
for gone in 'open("/dev/tty' 'VT_RELDISP' 'VT_SETMODE' 'linux/vt.h'; do
  if [ "$(count "$gone" "$added")" -eq "$(count "$gone" "$removed")" ]; then
    ok "the series leaves no $gone behind"
  else
    fail "the series leaves no $gone behind" \
      "a patch adds $gone and nothing takes it out; logind owns this VT"
  fi
done

# In `src/`, refuse the include and the ioctl call. Comments about the
# handshake may still mention the names.
if grep -rql 'linux/vt.h' "$DOMICILE" 2>/dev/null; then
  fail "no domicile source reaches for the VT ioctls" \
    "something under $DOMICILE includes <linux/vt.h>"
else
  ok "no domicile source includes <linux/vt.h>"
fi

if grep -rn 'ioctl(' "$DOMICILE" 2>/dev/null | grep -q 'VT_\|KD_\|KDSET\|KDSKB'; then
  fail "no domicile source drives the console itself" \
    "a VT or KD ioctl is called under $DOMICILE"
else
  ok "no domicile source drives the console itself"
fi

# `Seat.SwitchTo(u)` switches to a VT number; `Session.Activate` cannot.
# logind's polkit policy allows `chvt` for an active session without
# authentication.
if in_sources 'SwitchTo'; then
  ok "the seat's SwitchTo is named"
else
  fail "the seat's SwitchTo is named" \
    "no SwitchTo in domicile/drm_vt_switcher.cc"
fi

# Read the seat path from the session's `Seat` property. logind answers
# `UnknownObject` for `/org/freedesktop/login1/seat/self` in some cases, and a
# hard-coded `seat0` is wrong on a multi-seat machine.
if in_sources 'SeatOfSession'; then
  ok "the seat comes off the session's own Seat property"
else
  fail "the seat comes off the session's own Seat property" \
    "nothing in domicile/drm_vt_switcher.cc reads Session.Seat"
fi

if in_sources 'constexpr char kSeatPath'; then
  fail "no seat object path is written down" \
    "domicile/drm_vt_switcher.cc spells a seat path instead of reading it"
else
  ok "no seat object path is written down"
fi

# The compositor opens no evdev nodes, so the browser process holds the only
# keyboard descriptor. `PlatformEventObserver` sees each key before anything
# can consume it.
if in_sources 'WillProcessEvent'; then
  ok "the chord is read off the platform's own event stream"
else
  fail "the chord is read off the platform's own event stream" \
    "drm_vt_switcher does not observe PlatformEventSource"
fi

if in_patches 'event_factory_ozone_.get()'; then
  ok "the DRM platform hands the switcher its event source"
else
  fail "the DRM platform hands the switcher its event source" \
    "no patch gives DrmVtSwitcher the PlatformEventSource keys arrive on"
fi

# logind switches the VT itself, so the session's `Active` property is the
# only signal that the desktop lost the console.
for member in PropertiesChanged Active; do
  if in_sources "$member"; then
    ok "the session's $member is followed"
  else
    fail "the session's $member is followed" \
      "no $member in domicile/drm_vt_switcher.cc"
  fi
done

# The switcher stops and restarts drawing through upstream's display control
# methods; logind drops and sets DRM master itself.
for seam in RelinquishDisplayControl TakeDisplayControl; do
  if in_sources "$seam"; then
    ok "$seam is what a switch drives"
  else
    fail "$seam is what a switch drives" \
      "no $seam in domicile/drm_vt_switcher.cc"
  fi
done

# Taking DRM master back is not enough. The kernel restores its own
# framebuffer when the last master leaves, so the card has been modeset by the
# console. Flipping into the old state fails, and `PageFlipWatchdog` crashes
# the GPU process. `ModesetParamsThatChange` sees unchanged connectors and
# skips the modeset, so the switcher must call `DrmModeset::Relight`.
if in_sources 'Relight'; then
  ok "the screens are lit again when the console comes back"
else
  fail "the screens are lit again when the console comes back" \
    "drm_vt_switcher never asks DrmModeset::Relight, so a VT round trip ends \
on a card nothing in this process has modeset"
fi

if in_patches 'modeset_.get());'; then
  ok "the DRM platform hands the switcher its modeset driver"
else
  fail "the DRM platform hands the switcher its modeset driver" \
    "no patch gives DrmVtSwitcher the DrmModeset it relights through"
fi

# `packages/domicile-engine/scripts/drm-unit-tests.sh` holds the minimum test count per suite,
# and both engine jobs run it.
FLOORS="$ROOT/packages/domicile-engine/scripts/drm-unit-tests.sh"
if grep -qE "^ *DrmVtSwitcherTest:[0-9]+$" "$FLOORS" 2>/dev/null; then
  ok "the DRM suite list carries a floor for the suite"
else
  fail "the DRM suite list carries a floor for the suite" \
    "no 'DrmVtSwitcherTest:<n>' in packages/domicile-engine/scripts/drm-unit-tests.sh, so the suite can stop linking and nothing says so"
fi

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
