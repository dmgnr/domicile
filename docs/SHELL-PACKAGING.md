# Packaging a shell

How to build a shell into one module and ship it. Part of
[WRITING-A-SHELL.md](WRITING-A-SHELL.md).

## Bundling

`domicile ./src/index.ts` builds a shell for you
([Distributing](#distributing)), so you need none of this to run one. To ship
a built module, build it yourself with Vite. A complete project:

```
my-desktop/
  package.json
  vite.config.ts
  src/
    index.tsx (or index.ts)
    style.css
```

<!-- tab: React -->

```json
{
  "name": "my-desktop",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": {
    "@domicile-desktop/react": "next",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@types/react": "^19",
    "vite": "^8.2.2"
  }
}
```

```tsx
// src/index.tsx
/// <reference types="@domicile-desktop/react/elements" />
/// <reference types="vite/client" />
import "./style.css";

import { mount } from "@domicile-desktop/react/mount";
import { useWindows } from "@domicile-desktop/react/windows";

/** Every window side by side. */
const Desktop = () => (
  <main>
    {useWindows()
      .filter((window) => window.parent === undefined)
      .map((window) => (
        <app app-id={window.appId} key={window.appId} />
      ))}
  </main>
);

export const Shell = mount(Desktop);
```

<!-- tab: JavaScript -->

```json
{
  "name": "my-desktop",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "devDependencies": {
    "@domicile-desktop/sdk": "next",
    "vite": "^8.2.2"
  }
}
```

```ts
// src/index.ts
/// <reference types="vite/client" />
import "./style.css";

import type { Shell as ShellModule } from "@domicile-desktop/sdk/shell";

/** Every window side by side. */
export const Shell: ShellModule = (root, domicile) => {
  const main = document.createElement("main");
  root.append(main);
  const show = () => {
    const windows = (domicile.windows.list ?? []).filter(
      (window) => window.parent === undefined,
    );
    main.replaceChildren(
      ...windows.map((window) => {
        const app = document.createElement("app");
        app.setAttribute("app-id", window.appId);
        return app;
      }),
    );
  };
  show();
  domicile.windows.on("change", show);
};
```

<!-- /tabs -->

```ts
// vite.config.ts
import { defineConfig, type Plugin } from "vite";

// Domicile's document has no <link> for a stylesheet, so the CSS Vite
// extracts goes into the module as a <style>.
const cssInTheModule = (): Plugin => ({
  enforce: "post",
  generateBundle(_options, bundle) {
    const css = Object.keys(bundle).filter((name) => name.endsWith(".css"));
    const entry = Object.values(bundle).find(
      (output) => output.type === "chunk" && output.isEntry,
    );
    if (entry?.type !== "chunk") {
      return;
    }
    for (const name of css) {
      const asset = bundle[name];
      if (asset?.type === "asset") {
        entry.code = `document.head.append(Object.assign(document.createElement("style"), { textContent: ${JSON.stringify(String(asset.source))} }));\n${entry.code}`;
        delete bundle[name];
      }
    }
  },
  name: "css-in-the-module",
});

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "src/index.tsx", // src/index.ts in JavaScript
      output: { entryFileNames: "shell.js" },
      preserveEntrySignatures: "exports-only",
    },
  },
  plugins: [cssInTheModule()],
});
```

```css
/* src/style.css */
main {
  display: flex;
  gap: 8px;
  height: 100vh;
  padding: 8px;
  box-sizing: border-box;
}

app {
  flex: 1;
  border-radius: 8px;
}
```

```sh
bun install
bun run build
domicile ./dist/shell.js
```

`outDir` is up to you. The rest is required, and each fails silently without
it:

- **`input`:** a script, not an HTML file, so no HTML document is emitted.
- **`entryFileNames`:** fixed. Vite hashes it by default, and the path is what
  users pass to `domicile`.
- **`preserveEntrySignatures: "exports-only"`:** keeps the `Shell` export. An
  app build drops it, along with all code only it reaches.
- **`base: "./"`:** makes emitted URLs relative to Domicile's document.
- **`cssInTheModule`:** Vite extracts imported CSS into a separate file for a
  `<link>`, and Domicile's document has none. This repo's own version is
  [`@domicile-desktop/component-library/vite-shell`](/packages/component-library/src/vite-shell.ts).

`domicile`'s builder sets all of these itself, and resolves
`@domicile-desktop/*` and React from the running Domicile. A standalone build
bundles its own copies.

Other rules:

- **Dependencies:** the bundle must contain everything. Nothing resolves at
  run time and there is no `node_modules`. Vite's browser build does this by
  default.
- **Theme flash:** the screen stays black until `Shell` returns, and
  `domicile.theme` can be `null` for a few milliseconds. Either paint in a
  default theme and switch on the first `themechanged`, or paint in the last
  theme you saw (manganese does this) and correct on the first
  `themechanged`.

## Scripts

Domicile serves its document with `Content-Security-Policy: script-src
'self' 'wasm-unsafe-eval'`, so only files under the module's directory run.
Markup from outside (a notification body, window title or file name put in
`innerHTML`) cannot run script with the desktop.

Those files may compile WebAssembly, so a shell can be written in Rust or any
language that targets wasm. See [`examples/dioxus-shell`](/examples/dioxus-shell).

The shell is cross-origin isolated without COOP or COEP headers:
`crossOriginIsolated` is true and `SharedArrayBuffer` works, so threaded wasm
runs. Nothing it loads is checked for CORP. See
[DOMICILE-SCHEME.md](/docs/architecture/DOMICILE-SCHEME.md#cross-origin-isolation).

Refused:

- inline `<script>` elements and `on…` attributes
- `javascript:` URLs
- `eval`, `new Function` and string `setTimeout`
- `blob:` and `data:` scripts and workers

Vite's build emits none of these. A library that probes for `eval` and falls
back, such as Zod, logs one violation to the console. Styles are not
restricted, so inlined CSS and `style` attributes work.

## Distributing

A shell is a directory containing a module:

```
my-desktop/
  dist/
    shell.js
```

Ship it any way (tarball, git checkout, Nix derivation) and pass the module
path:

```sh
domicile ./my-desktop/dist/shell.js
```

- Or pass the directory, with the module named in its `package.json`, as a
  package does:

  ```json
  { "domicile": { "shell": "dist/shell.js" } }
  ```

  A directory with no `domicile.shell` is refused.
- Files next to the module are served. Nothing above its directory is.

`domicile` can also build a shell from source:

```sh
domicile ./my-desktop/src/index.ts       # an entry file
domicile my-cool-shell                   # an npm package
domicile github:me/my-cool-shell         # a repository
domicile @domicile-desktop/manganese     # Domicile's own, prebuilt
```

- `domicile load-shell` and a JSON config's `shell` take the same forms.
  Relative paths resolve from the working directory, or from the config file.
- A `.js` with no bare imports is a bundle and is served as is. So is one the
  nearest `package.json` names in `domicile.shell`. Any other `.js`, `.ts` or
  `.tsx` is an entry and is built.
- An entry's packages go in the nearest `package.json` and `bun.lock` above
  it, created next to it if there are none.
- `@domicile-desktop/*` and React always come from the running Domicile.
- The build transpiles and bundles only. For other tools (Tailwind, Panda,
  PostCSS), add a `vite.config` to the project: see
  [Build config](#build-config).
- A package with a prebuilt module declares it in `package.json` as
  `"domicile": { "shell": "dist/shell.js" }` and is served as is. Otherwise it
  is built from its entry.
- Builds are cached under `$XDG_CACHE_HOME/domicile/shells`, keyed on the
  entry's local imports, the lockfile and Domicile's install. A cache hit
  builds nothing.
- On first start, a build that takes over 500 ms runs behind a splash
  ([`shell-splash`](/packages/shell-splash/README.md)). Nothing else runs in
  its place, so a desktop never shows a shell the user did not choose.
- A failed first build is printed, or shown on the splash, and the desktop
  does not start. A failed `load-shell` prints the error and keeps the
  running shell.

## Build config

`domicile` builds an entry with Vite, transpiling and bundling only. Packages
ship their CSS prebuilt: manganese's covers all of its packages, and the
component library's components each load the library's own.

To add a tool, put a `vite.config` in the entry's project (the directory with
its `package.json`, or the entry's own directory). For Tailwind:

```ts
// vite.config.ts
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [tailwindcss()] });
```

```css
/* style.css, imported by the entry */
@import "tailwindcss";
```

### Panda with manganese's tokens

`css()` from `@domicile-desktop/manganese/css` only names classes. To get
rules for your own calls, run Panda with manganese's config:

```sh
bun add -d @pandacss/dev@1 @domicile-desktop/manganese
```

```ts
// panda.config.ts
import manganese from "@domicile-desktop/manganese/panda.config";
import { defineConfig } from "@pandacss/dev";

export default defineConfig({
  ...manganese,
  importMap: "@domicile-desktop/manganese",
  include: ["./*.tsx"],
  outdir: "styled-system",
  preflight: false,
});
```

```ts
// vite.config.ts
import panda from "@pandacss/dev/postcss";
import { defineConfig } from "vite";

export default defineConfig({
  css: { postcss: { plugins: [panda({ cwd: import.meta.dirname })] } },
});
```

```css
/* style.css, imported by the entry */
@layer reset, base, tokens, recipes, utilities;
```

- Install the manganese version your Domicile runs. Its config sets the class
  name hashing, so a different version can name classes differently.
- `include` lists your files; keep `node_modules` out of it.
- The [builder's tests](/packages/domicile-builder/fixtures/panda-shell) build
  this setup.

### What the builder adds

- The config's plugins and settings apply. `domicile` sets the output
  ([Bundling](#bundling)) and resolves `@domicile-desktop/*` and React from
  the running Domicile, over the config's own settings.
- Packages the config imports are installed like the entry's.
- The cache key covers the config and the files it imports. A file a tool
  reads by name, such as `panda.config.ts`, is not covered: edit the entry to
  rebuild.

Users of your shell never run `domicile-compositor` and do not need a config
file.
