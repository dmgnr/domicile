---
"@domicile-desktop/sdk": minor
"domicile": minor
"@domicile-desktop/engine": minor
---

The SDK's `Display` gains `hdr` (`unsupported`, `off` or `on`), `peakLuminance` (the panel's peak in cd/m², zero when its EDID reports none) and `sdrWhite` (the white SDR content is shown at while HDR is on), so a shell can offer HDR only on the monitors that take it.
