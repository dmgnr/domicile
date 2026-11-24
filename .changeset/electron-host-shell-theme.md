---
"@domicile-desktop/electron-host": minor
---

Electron apps get `shell` and `nativeTheme`. `shell.openExternal` and `shell.openPath` open links and files with `domicile open`, and `shell.showItemInFolder` opens the item's folder. `nativeTheme` follows the desktop's color scheme and contrast from the settings portal, and an app's `themeSource` overrides `shouldUseDarkColors`. The host now needs the desktop's session bus, and says so when `DBUS_SESSION_BUS_ADDRESS` is not set.
