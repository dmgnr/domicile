---
"domicile": minor
---

`domicile mcp --relay` serves agents on the web, such as claude.ai, through Domicile's relay at `mcp.domicile-desktop.com`, or another. The desk dials out, gets an address named for its own key, and gets its own Let's Encrypt certificate for it, so TLS ends on the desk and the relay can't read what agents say. Signing in and asking on the desktop work as with `--http`.
