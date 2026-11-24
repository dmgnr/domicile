---
"domicile": minor
"@domicile-desktop/e2e-harness": patch
---

Add `domicile configure-display <display> <change>...`, which changes a monitor's mode, scale, position, rotation, adaptive sync, HDR and SDR white, or turns it on or off, until the desktop restarts, like `swaymsg output`. `reset` goes back to the config. The changes are laid over the profile that matches the plugged-in monitors, so a hotplug or a config edit keeps them.
