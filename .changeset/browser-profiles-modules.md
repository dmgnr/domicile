---
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
"domicile": minor
"@domicile-desktop/react": minor
"@domicile-desktop/system-apps": minor
"@domicile-desktop/manganese-launcher": minor
"@domicile-desktop/manganese-notifications": minor
"@domicile-desktop/manganese-inbox-gmail": minor
"@domicile-desktop/manganese-inbox-google-messages": minor
"@domicile-desktop/manganese-bar-module-gmail": minor
"@domicile-desktop/manganese-window-management": minor
"@domicile-desktop/manganese": minor
---

Gmail and Messages inboxes, the Gmail bar module and launcher bookmarks take a `profile`, the browser profile they open in, so two Gmail accounts can live in two profiles. A site's app window is now in a browser profile, its site's by default, and `domicile open --app --profile <id>`, `browser.openApp(url, { profile })` and `browser.fetch(url, { profile })` pick one.
