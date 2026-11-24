---
"@domicile-desktop/component-library": minor
"@domicile-desktop/manganese-window-management": patch
"@domicile-desktop/manganese": patch
---

Popups close when the desk changes under them. `PopupScene` closes every popup inside it when its `scene` key changes, and `PopupBoundary` closes its popups when its box moves. Manganese keys the scene on the overview, launcher, clipboard, each screen's workspace, fullscreen and scratchpad windows.
