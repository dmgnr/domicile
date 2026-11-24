---
"domicile": patch
"@domicile-desktop/engine": patch
---

Fix the lock screen not getting typed keys when a window had the keyboard as the desk locked. Locking now gives the keyboard to the page, and the engine keeps every key on the page while locked, logging an error if a window still has the keyboard.
