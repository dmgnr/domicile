---
"domicile": patch
---

`domicile load-shell` serves a prebuilt JavaScript shell as it is even when its text reads like an import, such as `"Turn on notifications from 'fixture'"`. It now parses the module and reads only its real imports.
