---
"@domicile-desktop/engine": minor
"domicile": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/manganese-bar-module-tray": minor
---

Extensions work in every browser profile. An extension the user installs from the Web Store or loads unpacked in one profile is installed in every other, starting on (off in a private profile) and switchable in each, and one they uninstall leaves them all. The tray shows the actions of the focused page's profile's extensions and opens their popups in that profile, so an extension switched on only in another profile, such as 1Password in a work profile, has its icon, popup and sign-in there. The SDK adds `extensions.setProfile`, and each action and popup request carries its `profile`.
