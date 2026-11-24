#!/usr/bin/env bash
# Tests that the desktop lights its displays again after a suspend.
#
# logind treats a suspend differently from a VT switch. Only VT paths pause
# devices or drop DRM master, so across a suspend the evdev descriptors stay
# open, master is kept, and the session stays `Active`.
#
# The GPU resumes with its CRTCs reset, and the connectors report the same
# panels and modes. The hardware no longer holds what the driver confirmed
# before the sleep, so on resume the driver forgets it and modesets every
# display.
#
# logind broadcasts `PrepareForSleep(b)` on `org.freedesktop.login1.Manager`:
# `true` going down, `false` on return. It sends `false` even after a failed
# sleep.
#
# Needs no Chromium tree: it reads `src/` and `patches/`, so it runs in the
# shell group on every push.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ENGINE="$ROOT/packages/domicile-engine"
PATCHES="$ENGINE/patches"
DOMICILE="$ENGINE/src/ui/ozone/platform/drm/domicile"
[ -d "$PATCHES" ] || { echo "no patch series at $PATCHES" >&2; exit 1; }

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n    %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }

# Added lines only (`^+`), so upstream code quoted as context does not count.
added="$(cat "$PATCHES"/*.patch 2>/dev/null | grep -a '^+' || true)"
in_patches() { case "$added" in (*"$1"*) return 0 ;; (*) return 1 ;; esac }

sleeper="$(cat "$DOMICILE"/drm_sleep.h "$DOMICILE"/drm_sleep.cc 2>/dev/null || true)"
in_sleeper() { case "$sleeper" in (*"$1"*) return 0 ;; (*) return 1 ;; esac }

modeset="$(cat "$DOMICILE"/drm_modeset.h "$DOMICILE"/drm_modeset.cc 2>/dev/null || true)"
in_modeset() { case "$modeset" in (*"$1"*) return 0 ;; (*) return 1 ;; esac }

for f in drm_sleep.h drm_sleep.cc drm_sleep_unittest.cc; do
  if [ -f "$DOMICILE/$f" ]; then
    ok "domicile/$f exists"
  else
    fail "domicile/$f exists" "no such file under src/ui/ozone/platform/drm/domicile"
  fi
done

# `PrepareForSleep` is a machine-wide broadcast from the manager, not the
# session, so this path needs no `GetSessionByPID`.
for named in PrepareForSleep org.freedesktop.login1.Manager /org/freedesktop/login1; do
  if in_sleeper "$named"; then
    ok "the sleeper names $named"
  else
    fail "the sleeper names $named" "nothing in domicile/drm_sleep.cc says $named"
  fi
done

# `PrepareForSleep`'s body is a plain `b`, not a variant like the
# `Session.Active` property. The property reader would pop nothing and the
# desktop would never light again.
if in_sleeper 'PopVariantOfBool'; then
  fail "the signal's body is read as a signal's" \
    "domicile/drm_sleep.cc reads PrepareForSleep through the property reader"
else
  ok "the signal's body is read as a signal's"
fi

# logind keeps master across a suspend, so dropping it would give the display
# away, and taking it back is a round trip that can only fail.
for refused in RelinquishDisplayControl TakeDisplayControl; do
  if in_sleeper "$refused"; then
    fail "a sleep does not move DRM master" \
      "domicile/drm_sleep.cc calls $refused; logind leaves master alone across a suspend"
  else
    ok "a sleep does not move DRM master ($refused)"
  fi
done

# The wake must force a modeset: the hardware reports what it did before, so
# hotplug handling sees nothing to do.
if in_sleeper 'Relight'; then
  ok "the wake asks for a relight"
else
  fail "the wake asks for a relight" "domicile/drm_sleep.cc never asks anything to light again"
fi

if in_modeset 'void DrmModeset::Relight'; then
  ok "the modeset driver has a relight to ask for"
else
  fail "the modeset driver has a relight to ask for" \
    "no DrmModeset::Relight in domicile/drm_modeset.cc"
fi

# `ModesetParamsThatChange` compares against what the hardware last
# confirmed. Clearing that is what forces the modeset.
if in_modeset 'confirmed_.clear()'; then
  ok "a relight forgets what the hardware confirmed"
else
  fail "a relight forgets what the hardware confirmed" \
    "DrmModeset::Relight leaves confirmed_ in place, so the hotplug guard eats the resume"
fi

# Wired in by a patch because `ozone_platform_drm.cc` is upstream's.
for wired in 'DrmSleep' 'domicile/drm_sleep.cc'; do
  if in_patches "$wired"; then
    ok "a patch carries $wired"
  else
    fail "a patch carries $wired" "no patch in the series adds $wired"
  fi
done

# `packages/domicile-engine/scripts/drm-unit-tests.sh` holds the per-suite test count floors.
# Both engine.yml and engine-drm-probe.yml run it.
FLOORS="$ROOT/packages/domicile-engine/scripts/drm-unit-tests.sh"
if grep -qE "^ *DrmSleepTest:[0-9]+$" "$FLOORS" 2>/dev/null; then
  ok "the DRM suite list carries a floor for the suite"
else
  fail "the DRM suite list carries a floor for the suite" \
    "no 'DrmSleepTest:<n>' in packages/domicile-engine/scripts/drm-unit-tests.sh, so the suite can stop linking and nothing says so"
fi

if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED failed"
  exit 1
fi
echo "all ok"
