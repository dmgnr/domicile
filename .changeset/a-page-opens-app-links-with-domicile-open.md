---
"@domicile-desktop/e2e-harness": patch
"domicile": patch
---

A page's link for an app, such as Slack's `slack:` sign-in link, opens the app the desktop's prompt named. The engine's `xdg-open` is `domicile open`, as every app's is, and `domicile open` has the compositor start the app it picks, as the launcher does, so it gets the desktop's environment whoever asked.
