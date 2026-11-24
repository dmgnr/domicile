---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/e2e-harness": patch
---

Add `domicile list-inputs [--json]`, which prints each keyboard, pointer and touch device the desktop reads: its kind, how it is attached, its USB or Bluetooth ids and its name. The engine reports the devices through a new `input_devices` callback.
