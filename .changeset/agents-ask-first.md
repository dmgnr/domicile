---
"@domicile-desktop/engine": minor
"domicile": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/component-library": minor
"@domicile-desktop/manganese-bar-module-sharing": minor
"@domicile-desktop/manganese": minor
---

An agent asks before it drives the desktop. `domicile mcp`'s first tool call runs `domicile agent`, which puts an `agent` dialog to the shell: the entire desktop, or only the windows the user checks. Every tool call after is checked against the answer, and the agent is listed as an `agent` capturing session, with what it did last, until it disconnects or the user stops it. The SDK parses them as `PortalKind.Agent`, `PortalAnswer.Agent` and `CapturingKind.Agent`; `<PortalDialogs />` draws the dialog and takes `omitAgents`; Manganese's bar shows each agent as a violet pill with a Stop button.
