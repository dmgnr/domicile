---
"@domicile-desktop/engine": minor
"domicile": minor
"@domicile-desktop/sdk": major
"@domicile-desktop/distro": minor
"@domicile-desktop/app-settings": minor
"@domicile-desktop/manganese-bar-module-tray": minor
"@domicile-desktop/manganese": minor
"@domicile-desktop/e2e-harness": patch
---

Private windows are a private browser profile's: its extension switches say what runs there. The config's `extensions.settings.<id>.private` is gone, and a config that sets it is refused; so are the SDK's `inPrivate` on installed extensions and in `configureExtension()`, and the Settings app's and tray's "Allow in private windows". The tray now shows the extensions of the last focused page's browser profile ("Extensions in Work"): its icons are those switched on there, and its switches switch them in that profile, locked where the config sets them.
