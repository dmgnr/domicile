---
"@domicile-desktop/ci": patch
---

A pull request's engine run is no longer canceled as stale when the branch moves only outside the engine's paths, such as the docs media bot's retake commit. That run builds the same engine, and canceling it restarted a cold compile hours in.
