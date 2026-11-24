---
"@domicile-desktop/engine": minor
"domicile": minor
---

The night light now works on a monitor driven in HDR. A gamma ramp there would bend the PQ curve the panel decodes, so the monitor keeps an identity ramp and the night light becomes a color matrix viz applies in linear light (`domicile_displays_set_color_matrix`). `wlr-gamma-control` clients get `failed` on such a monitor, since their ramps assume SDR.
