---
"@domicile-desktop/sdk": minor
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/app-settings": patch
---

A display profile can drive a monitor in HDR (HDR10) with `hdr: true`, and set how bright ordinary content's white is there with `sdr_white` (203 cd/m² by default). It is off by default and used only where the monitor's EDID takes PQ and its connector scans out in 10 bits. The SDK's config types gain both fields, and Settings reads profiles that set them instead of refusing them.
