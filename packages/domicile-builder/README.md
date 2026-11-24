# @domicile-desktop/builder

Builds a shell module from a user's TypeScript or JavaScript file, so a desktop
can be configured without a project or build step. See
[SHELL-PACKAGING.md](../../docs/SHELL-PACKAGING.md#distributing) and
[THE-DOMICILE-BINARY.md](../../docs/architecture/THE-DOMICILE-BINARY.md#domicile-builds-shells-nothing-else).

## Usage

```sh
domicile-builder (--entry <file> | --package <spec> | --evaluate <config>) \
  --domicile <install> --cache <dir>
domicile-builder --serve <file> --socket <path> --domicile <install> --cache <dir>
```

- **`--entry`**: build a local file, such as `~/.config/domicile/domicile.tsx`.
- **`--package`**: install an npm or `github:` package into its own project
  under the cache. Use the module its `package.json` names in
  `"domicile": { "shell": "…" }`, or build its entry.
- **`--evaluate`**: run a config module and write every export except `Shell`
  and `options` as the compositor's JSON config.
- **`--serve`**: serve a local file with Vite's dev server on the unix socket
  `--socket`, for `domicile dev`, until stopped. Updates go out over
  requests, since the shell's page cannot open a WebSocket
  ([DOMICILE-SCHEME.md](../../docs/architecture/DOMICILE-SCHEME.md#dev-server)).
- **`--domicile`**: Domicile's install, laid out like this repo:
  `packages/shell-manganese` with its `node_modules` and `styled-system`.

## Output

Each step is one JSON line on stdout. Other stdout lines are tool logs.

```json
{"step":"resolving"}
{"packages":["date-fns"],"step":"installing"}
{"step":"bundling"}
{"cached":false,"module":"shell.js","root":"<cache>/<key>","step":"built"}
{"cached":false,"config":"<cache>/configs/<key>.json","step":"evaluated"}
{"module":"domicile-dev-shell.js","socket":"<socket>","step":"serving"}
```

`serving` comes once the dev server listens; it then runs until stopped.

On failure it prints `{"step":"failed","why":"…"}` and exits non-zero.

## Build steps

| Step | Module |
|---|---|
| Read every local file and package the entry and the project's `vite.config` import | `src/graph.ts` |
| Find the project (nearest `package.json` above the entry, else the entry's directory). `bun add --ignore-scripts` imports it doesn't list | `src/project.ts`, `src/main.ts` |
| Key the cache on the files, lockfile and Domicile install. A cache hit takes under a second | `src/project.ts` |
| Bundle with vite: transpile and bundle only, CSS imports included. The project's `vite.config`, if any, adds its plugins; the shell's output settings override it. `@domicile-desktop/*` and React resolve from Domicile's install. Packages ship their CSS prebuilt | `src/bundle.ts` |
| Write the entry's `options` export to `options.json` beside `shell.js`, for the Settings app. Runs the entry in Bun only if it exports `options` | `src/evaluate.ts` |

## Test

```sh
bun run test:unit    # src/bundle.test.ts builds against this checkout
bun run test:types
```
