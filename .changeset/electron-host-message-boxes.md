---
"@domicile-desktop/electron-host": minor
---

`dialog.showMessageBox` shows an Electron app's message box over its window, drawn by the shell, and resolves with the user's answer and checkbox. With no window named it goes over the app's most recent one; with none open it rejects. `showMessageBoxSync` still throws, as it can't wait for the shell.
