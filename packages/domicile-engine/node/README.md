# Electron's Node

The Node.js that Electron embeds, which the engine builds as Electron does:
against the engine's own V8 and BoringSSL. Electron apps that put Node in
their pages need it. See "Phase 2" in
[`docs/architecture/ELECTRON-APPS.md`](../../../docs/architecture/ELECTRON-APPS.md).

- `NODE_PIN`: the Node commit Electron's DEPS names.
- `patches/node`: Electron's patches to Node, including the GN build files.
- `patches/v8`: Electron's patches to V8, for Node's promise hooks and
  startup snapshot.
- `patches/boringssl`: Electron's patches to BoringSSL, for the digests and
  ciphers Node's crypto offers.

Each directory's `.patches` gives the order. They are Electron's, under its
license, `LICENSE.electron`, with three changes: their messages and
comments use American spelling, `build_add_gn_build_files.patch` also links
Chromium's zstd compressor, which Node's zlib binding uses, and patches
named `domicile_*` are the engine's own, last in the order. Carry these over
when moving to Electron's next patches. `.github/scripts/engine-node.sh` puts
them into the Chromium checkout after `apply.sh`, and
`src/build/args/domicile_node.gn` builds Node. `src/electron/` holds the few
targets and scripts Node's build reads from Electron's own tree.

## Moving to Electron's next Node

Take `node_version` from Electron's `DEPS` and the commit its tag names, then
copy Electron's `patches/node`, `patches/v8` and `patches/boringssl` over
these, from the same Electron commit. Electron moves its patches with its
Chromium, so take them from an Electron whose Chromium is close to the
engine's pin.
