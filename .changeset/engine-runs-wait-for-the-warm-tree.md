---
"@domicile-desktop/ci": patch
---

An engine build that finds the Chromium tree at its pin held now waits for it rather than taking a tree at another pin and rebuilding Chromium from scratch. It still takes the other tree once its wait runs out, or when another run is already waiting.
