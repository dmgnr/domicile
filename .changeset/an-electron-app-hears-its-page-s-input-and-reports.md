---
"@domicile-desktop/engine": minor
"@domicile-desktop/electron-host": minor
"domicile": minor
---

An Electron app's `webContents` hears its page: `console-message`, `preload-error`, `unresponsive` and `responsive`, HTML fullscreen, media and sound (`audio-state-changed`, `isCurrentlyAudible`), favicons, `update-target-url`, `zoom-changed`, `did-change-theme-color`, `cursor-changed`, `preferred-size-changed` and `content-bounds-updated`. `before-input-event` and `before-mouse-event` can cancel the page's input, `input-event` hears it, and `sendInputEvent` sends it. `setAudioMuted`, `setUserAgent` and `setIgnoreMenuShortcuts` act on the page instead of doing nothing.
