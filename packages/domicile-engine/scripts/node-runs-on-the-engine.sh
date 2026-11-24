#!/usr/bin/env bash
# Checks that the build's `node` is Electron's Node on the engine's own V8 and
# BoringSSL, with the V8 settings Node needs. See "Phase 2" in
# docs/architecture/ELECTRON-APPS.md and src/build/args/domicile_node.gn.
#
# - **Node is the version NODE_PIN names**, and `process.versions.v8` is the
#   V8 in the checkout: a `node` built against its own V8 would report
#   another.
# - **Its crypto is BoringSSL with Electron's patches**: `ripemd160`, which
#   only Electron's BoringSSL patch exposes, hashes as it should. Its control
#   is a digest no build has, which must throw, so the check can see one
#   missing.
# - **Promise hooks are on** (`v8_enable_javascript_promise_hooks`): an
#   `AsyncLocalStorage` value survives an `await`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "$ROOT/packages/domicile-engine/scripts/lib-engine-guard.sh"
require_engine_out

NODE="$ENGINE_OUT/node"
[ -x "$NODE" ] || {
  annotate "the build produced no node in $ENGINE_OUT; build third_party/electron_node:node"
  exit 1
}

VERSION_H="$ENGINE_DIR/v8/include/v8-version.h"
# As V8 writes its version: a patch level of 0 is left off.
v8="$(for part in MAJOR_VERSION MINOR_VERSION BUILD_NUMBER PATCH_LEVEL; do
  sed -n "s/^#define V8_$part \([0-9]*\)$/\1/p" "$VERSION_H"
done | paste -sd. | sed 's/^\([0-9]*\.[0-9]*\.[0-9]*\)\.0$/\1/')"
[ -n "$v8" ] || {
  annotate "cannot read V8's version from $VERSION_H"
  exit 1
}

want_node="$(sed -n 's/^version //p' "$ROOT/packages/domicile-engine/node/NODE_PIN")"

out="$("$NODE" - "$want_node" "$v8" <<'JS' 2>&1
const [want_node, v8] = process.argv.slice(2);
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const failures = [];
const check = (what, ok) => { if (!ok) failures.push(what); };

check(`Node should be ${want_node} and is ${process.versions.node}`,
  process.versions.node === want_node);
// The engine's V8 reports its embedder string after a dash, if any.
check(`Node should run the engine's V8 ${v8} and runs ${process.versions.v8}`,
  process.versions.v8.split("-")[0] === v8);
check("ripemd160 hashes as it should",
  crypto.createHash("ripemd160").update("").digest("hex") ===
    "9c1185a5c5e9fc54612808977ee8f548b2258d31");
let threw = false;
try { crypto.createHash("no-such-digest"); } catch { threw = true; }
check("the control: a digest no build has throws", threw);

const storage = new AsyncLocalStorage();
storage.run("kept", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  check("AsyncLocalStorage keeps its value across an await",
    storage.getStore() === "kept");
  if (failures.length) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
  console.log(`Node ${process.versions.node} on V8 ${process.versions.v8}`);
});
JS
)" || {
  annotate "the engine's node failed: $(printf '%s' "$out" | tr '\n' ';')"
  exit 1
}
echo "$out"
