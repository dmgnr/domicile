---
"@domicile-desktop/sdk": minor
"domicile": minor
"@domicile-desktop/app-settings": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/component-library": minor
---

Browser profiles have an order. The config's `browser.order` lists profile ids, and the profiles it leaves out follow by id. The compositor sends the profiles in that order, so the profile menu and Settings list them that way.

Settings' Profiles page moves a profile up or down. After its swatches, a color well takes any color, and the swatches now include the theme's cyan.

In the profile menu, middle-clicking a profile opens the page in a new window of that profile, using `ListRow`'s new `onMiddlePress`. The profile button writes its name in black on light colors, where white would be hard to read.
