---
"domicile": minor
---

`domicile mcp --http <address>` serves the Model Context Protocol over Streamable HTTP, for agents that connect to a URL. They sign in with OAuth, which `domicile mcp` serves itself, by entering a code the desktop shows in a notification; each session still asks on the desktop before it uses anything, and ends after 30 minutes unused.
