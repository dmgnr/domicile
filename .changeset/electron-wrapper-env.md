---
"domicile": patch
---

`domicile open --electron` gives the app what its wrapper scripts set, such as a preloaded library, programs on `PATH` and extra flags, so an app wrapped by its package (as nixpkgs wraps Element and Claude) runs on the engine as it would on its own Electron.
