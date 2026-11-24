---
"domicile": minor
"@domicile-desktop/engine": minor
---

An Electron app's windows load through its sessions and protocol handlers. `open_window` names a window's session, a partition inside the app's own. `handle_protocol` and `unhandle_protocol` send a session's requests for a scheme to the app as `protocol_request`, which the app answers with `protocol_response` (a whole body, a file, or a stream of `protocol_data` ending in `protocol_end`). A window opens a `file:` URL, or one in the app's own scheme, once its session handles that scheme, which is how `loadFile` works; `http` and `https` go to the network unless the session handles them. See docs/architecture/ELECTRON-APPS.md.
