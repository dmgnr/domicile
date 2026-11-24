#!/usr/bin/env bash
# Runs the DRM platform's gtest cases in ozone_unittests, plus the evdev suites
# linked there (`ScrollAcceleratorTest`, `FlingTrackerTest` and `WheelTicksTest`;
# see packages/domicile-engine/tests/test-a-fast-scroll-goes-further.sh,
# packages/domicile-engine/tests/test-a-flick-on-a-page-glides.sh and
# packages/domicile-engine/tests/test-a-mouse-goes-through-libinput.sh; and the `AbsoluteMouse*`
# suites of patch 0123; `TypingGuardTest`, see
# packages/domicile-engine/tests/test-a-touchpad-rests-while-typing.sh;
# `EvdevWarpTest`, patch 0195), the native
# input lifecycle suites, `WaylandPointerTest` and
# `WaylandKeyboardWithoutKeymapTest` (see
# packages/domicile-engine/tests/test-modifiers-wait-for-a-keymap.sh), and three
# headless suites, `HeadlessDeskTest`, `HeadlessDeskInputTest` and
# `HeadlessDeskCursorsTest` (see
# docs/architecture/A-HEADLESS-DESKTOP.md).
#
#   ./packages/domicile-engine/scripts/drm-unit-tests.sh        # the suites this fork wrote
#   ./packages/domicile-engine/scripts/drm-unit-tests.sh all    # and upstream's, on the probe
#
# Shared by engine.yml and engine-drm-probe.yml so the floors live in one
# place.
#
# One floor per suite: `--gtest_filter` matching nothing exits 0, so a suite
# that stopped linking would otherwise pass. Floors, not exact counts, so
# adding a case does not fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/packages/domicile-engine/scripts/lib-engine-guard.sh"
require_engine_out

# `all` also runs upstream's cases, which catch the fork breaking
# `OzonePlatformDrm`; the probe uses it. The default runs only the fork's
# suites, which is cheaper.
WHOLE_SUITE="${1:-ours}"
case "$WHOLE_SUITE" in
  (ours|all) ;;
  (*) echo "usage: $(basename "$0") [all]" >&2; exit 2 ;;
esac

SUITES=(
  DrmScreenTest:47
  DrmModesetTest:41
  DrmVtSwitcherTest:20
  DrmSleepTest:2
  DrmFullscreenTest:4
  DrmInputDevicesTest:27
  DrmInputOpensTest:17
  DrmInputControllerTest:7
  DrmCursorFactoryTest:5
  DrmCursorFactoryThemeTest:9
  DrmCursorTintTest:4
  DrmClipboardTest:12
  DrmEdidSerialTest:18
  DrmConnectorNameTest:6
  DrmPointerCrossingTest:20
  DrmPointerConfinementTest:6
  DrmPointerTargetsTest:6
  DrmDeskInputTest:6
  DrmCanvasTest:7
  DrmNoGbmModesetTest:1
  GbmPixmapScanoutTest:3
  ScrollAcceleratorTest:13
  FlingTrackerTest:5
  LibInputKeyboardPathTest:2
  InputDeviceOpenCancellationTest:3
  ActiveScrollAxesTest:3
  EventDeviceInfoTest:31
  InputSettingsTest:7
  TypingGuardTest:15
  EvdevWarpTest:2
  WheelTicksTest:3
  AbsoluteMouseDeviceTest:2
  AbsoluteMouseConverterTest:7
  WaylandPointerTest:19
  WaylandPointerGesturesTest:2
  WaylandKeyboardWithoutKeymapTest:1
  HeadlessDeskTest:6
  HeadlessDeskInputTest:10
  HeadlessDeskCursorsTest:4
  DrmColorCommitTest:3
  DrmCursorHotspotTest:2
  DrmPageFlipTimeoutTest:10
  DrmDamageClipsTest:3
  DrmInputMethodTest:13
  DeskInputMethodTest:4
)

cd "$ENGINE_OUT"

filter=""
for suite_and_floor in "${SUITES[@]}"; do
  suite="${suite_and_floor%%:*}"
  floor="${suite_and_floor##*:}"
  filter="$filter${filter:+:}$suite.*"
  count=$(./ozone_unittests --gtest_filter="$suite.*" --gtest_list_tests |
    grep -cE '^  ' || true)
  echo "$count $suite cases (floor $floor)"
  [ "$count" -ge "$floor" ] || {
    annotate "only $count $suite cases; the suite was renamed or did not link"
    exit 1
  }
done

if [ "$WHOLE_SUITE" = all ]; then
  ./ozone_unittests
else
  ./ozone_unittests --gtest_filter="$filter"
fi
