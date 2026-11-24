// The shell for guard-shell-hmr.sh, served from `domicile-builder --serve`.
// The guard copies it to `shell.js` beside a `label.js` that exports `label`.
//
// It logs to the console, which the engine writes to its log:
//
//   GUARD ran id=<id> label=<label>      this module ran; <id> is new each run
//   GUARD updated id=<id> label=<label>  Vite swapped `label.js` in place
//
// An update that keeps <id> kept this module's state. A reload runs the
// module again, with a new <id>.

import { label } from "./label.js";

const id = Math.random().toString(36).slice(2, 10);
let shown = label;

if (import.meta.hot === undefined) {
  throw new Error(
    "guard-shell-hmr: import.meta.hot is undefined, so this module was not " +
      "served by Vite's dev server",
  );
}

import.meta.hot.accept("./label.js", (updated) => {
  shown = updated.label;
  console.log(`GUARD updated id=${id} label=${shown}`);
});

// Domicile's document calls this once the module loads.
export const HostShell = () => {
  console.log(`GUARD ran id=${id} label=${shown}`);
};
