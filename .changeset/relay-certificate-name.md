---
"domicile": patch
"@domicile-desktop/app-settings": minor
---

The desk's certificate request through the relay names only the desk's address. It had carried rcgen's default subject, "rcgen self signed cert", which Let's Encrypt refuses, so Connect from the web never got ready. A failed request now tries again after 2 minutes, doubling up to an hour, and **Try again** in Settings › Agents tries at once.
