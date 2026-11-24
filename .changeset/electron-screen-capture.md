---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/electron-host": minor
---

Electron apps can share the screen. `desktopCapturer.getSources` gives one source the desktop's share picker stands for, as Electron does under Wayland, and a page's `getUserMedia()` with `chromeMediaSource: "desktop"` opens that picker, with the source's sound when asked. `session.setDisplayMediaRequestHandler` is accepted, and `getDisplayMedia()` opens the same picker, as Electron's `useSystemPicker` does.
