---
"domicile": patch
---

Web agents' calls through the relay no longer wait ~40 ms on each TCP acknowledgment: the relay, the desk and `domicile mcp --http` set `TCP_NODELAY`.
