---
"@domicile-desktop/animated-properties": patch
"@domicile-desktop/app-history": patch
"@domicile-desktop/component-library": patch
"@domicile-desktop/manganese-bar-module-downloads": patch
"@domicile-desktop/manganese-notifications": patch
"@domicile-desktop/manganese-window-management": patch
"@domicile-desktop/shell-splash": patch
---

Loading skeletons in History and the splash's dot grid move with transforms, and shadows that fade in fade on their own layer, so they no longer repaint every frame. A check fails on new animations of properties the compositor cannot run.
