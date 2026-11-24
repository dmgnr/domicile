---
"domicile": minor
---

A monitor driven in HDR now describes itself to `wp_color_management_v1` clients as HDR10 (BT.2020 with PQ, its SDR white as reference, and its panel's black and peak as the target), instead of sRGB. A window prefers the description of the monitor holding most of it, and its client hears `preferred_changed` when the window moves to a monitor in a different mode or that monitor goes into or out of HDR; each output object hears `image_description_changed` then too.
