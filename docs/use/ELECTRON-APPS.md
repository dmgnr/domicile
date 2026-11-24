# Electron apps

Electron apps, such as Slack, Element and Claude, can run on the
browser built into the desktop instead of the copy of Chromium each one
bundles. Then:

- Their menus sit under the window's tabs. Press Alt to show a hidden one.
- Their questions and warnings open over their window, in the desktop's style.
- Closing one sends it to the tray, as it would on its own.

Apps you don't list run on their own Chromium, as on any desktop.

## Turn it on

List the apps by their desktop file's name:

```json
{
  "electron": {
    "apps": ["slack.desktop", "element-desktop.desktop"]
  }
}
```

The launcher, links and notifications then start them on the desktop's
browser. An app already running stays as it is until you quit it.

To try an app once without listing it, run
`domicile open --electron slack.desktop`.

## Good to know

- **Sign in again.** An app starts with nothing saved the first time it runs
  here.
- **A few apps still use their own Chromium.** Signal, Joplin, Teams for Linux
  and Zulip start on their own Chromium until each is checked here, and a
  notification says so. ChatGPT always does: it only starts on OpenAI's own
  Chromium.
- **An app may run on its own Chromium once.** An app that brings a new kind
  of link the first time it runs here starts on its own Chromium, and on the
  desktop's from your next login.
