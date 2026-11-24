---
"@domicile-desktop/engine": minor
"domicile": minor
"@domicile-desktop/sdk": minor
"@domicile-desktop/component-library": minor
"@domicile-desktop/manganese-bar-module-sharing": minor
"@domicile-desktop/manganese": minor
---

An agent let reach the entire desktop can be remembered, and comes in without asking from then on. A running agent's reach can be changed from the bar, and Settings › Agents lists every agent connected or remembered, to stop or forget. `domicile list-agents`, `stop-agent` and `forget-agent` do the same. The SDK adds `PortalAnswer.Agent(reach, remember)`, `PortalAnswer.Change()`, the dialog's `current` and `remembered`, `portals.changeAgent`, `portals.agents` and `portals.forgetAgent`; `AgentDialog` draws the Remember switch and the change dialog, and the capturing indicator and Manganese's bar a Change button.
