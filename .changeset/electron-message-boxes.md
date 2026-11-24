---
"domicile": minor
"@domicile-desktop/engine": minor
"@domicile-desktop/sdk": minor
---

Electron apps' message boxes reach the shell. The Electron socket asks a box over a window with `show_message_box`, and a browser window list includes the box it shows as `messageBox` (JSON), one at a time. A shell answers with `answerBrowserWindowMessageBox` (`browser.answerMessageBox` in the SDK), and the app hears `message_box_answered` with the button and the checkbox. A window that closes answers its boxes with their cancel buttons.
