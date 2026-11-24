---
"@domicile-desktop/component-library": minor
"@domicile-desktop/manganese-bar-module-tray": patch
---

The tray's menu button opens after icons were dragged. A right click anywhere on an app's row in the tray's menu opens its menu, and `ListRow` takes `onSecondaryPress`. A pressed `ListRow` with `actions` cuts a long label short instead of pushing its actions out.
