#!/usr/bin/env bash
# Checks the shared libinput keyboard adapter keeps Chromium's key pipeline.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
python3 - "$root" <<'CHECK'
from pathlib import Path
import sys
engine = Path(sys.argv[1]) / "packages/domicile-engine"
folder = engine / "src/ui/events/ozone/evdev/domicile"
header_path = folder / "libinput_keyboard_event_converter.h"
source_path = folder / "libinput_keyboard_event_converter.cc"
header = header_path.read_text() if header_path.exists() else ""
source = source_path.read_text() if source_path.exists() else ""
added = "\n".join(line[1:] for patch in sorted((engine / "patches").glob("*.patch"))
                  for line in patch.read_text().splitlines()
                  if line.startswith("+") and not line.startswith("+++"))
checks = {
    "libinput keyboards inherit Chromium's keyboard state and filters": ": public EventConverterEvdevImpl" in header,
    "the shared context owns keyboard subscriptions": "SetEventHandler" in source and "RemoveDevice" in source,
    "native keys reach the existing key pipeline": "LibInputKeyboardKey" in source and "ProcessEvents(base::span_from_ref(key))" in source,
    "disabled keyboards do not deliver new keys": "IsEnabled()" in source,
    "keyboard adapters never start a competing raw reader": "EventConverterEvdevImpl::Start" not in source and "EventConverterEvdev::Start" not in source and "WatchFileDescriptor" not in source and "read(" not in source,
    "factory start and stop dispatch through the adapter": "virtual void Start();" in added and "virtual void Stop();" in added,
    "native keyboard behavior tests run in the DRM suite": "LibInputKeyboardPathTest:2" in (engine / "scripts/drm-unit-tests.sh").read_text(),
    "device routing behavior tests run in the DRM suite": "EventDeviceInfoTest:31" in (engine / "scripts/drm-unit-tests.sh").read_text(),
}
for label, satisfied in checks.items():
    print(f"{'ok' if satisfied else 'FAIL'} {label}")
sys.exit(0 if all(checks.values()) else 1)
CHECK
