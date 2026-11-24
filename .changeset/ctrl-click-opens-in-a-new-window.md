---
"@domicile-desktop/component-library": minor
"@domicile-desktop/manganese-window-management": patch
---

A Ctrl+click opens in a new window wherever a middle click does: Back, Forward, the pages in their menus, and the profiles in the profile menu.

- `@domicile-desktop/component-library/new-tab-click`: `newTabClick(onOpen, onOpenInNew)` gives `onClick` and `onAuxClick` handlers that call `onOpenInNew` for a middle click or a Ctrl+click, as a link opens in a new tab.
- `ListRow`'s `onMiddlePress` is `onPressInNew`, and takes a Ctrl+click too.
