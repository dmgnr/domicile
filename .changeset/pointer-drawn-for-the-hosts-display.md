---
"@domicile-desktop/engine": patch
"domicile": patch
---

On a console, the pointer is drawn for the display the desk's host is on once the displays settle after a change, such as an undock. A hotplug could leave it drawn for a display that was gone, at scale 1. The journal now says which display the pointer is drawn for, when the theme loads, when a cursor is Chromium's own, and when a cursor change reaches no window.
