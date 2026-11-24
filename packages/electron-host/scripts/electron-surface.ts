// Writes `src/electron/surface.ts`: every module, method and property a
// Linux Electron app can reach in the main process, from the `electron.d.ts`
// of the newest release of each Electron major, from the latest down to
// `MAJORS` before the one `src/electron/version.ts` names, and of that one:
// an app calls what its own Electron has, older or newer.
//
//   bun scripts/electron-surface.ts
//
// `surface.test.ts` holds the host's `electron` to it, so an app can never
// again find a plain `undefined` where Electron has an API. See "Every API"
// in docs/architecture/ELECTRON-APPS.md.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ELECTRON_VERSION } from "../src/electron/version";

/** Electron's modules for Linux, as `lib/browser/api/module-list.ts` has them. */
const NOT_ON_LINUX = new Set([
  "inAppPurchase",
  "pushNotifications",
  "ShareMenu",
]);

/** Members every EventEmitter has, which `node:events` gives. */
const EMITTER = new Set([
  "addListener",
  "emit",
  "off",
  "on",
  "once",
  "removeAllListeners",
  "removeListener",
]);

/** How many majors before `ELECTRON_VERSION`'s the surface covers too. */
const MAJORS = 12;

/** Compares two `x.y.z` versions, as for a sort. */
const compare = (a: string, b: string) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i += 1) {
    const difference = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * The newest stable release of each major from Electron's latest down to
 * `MAJORS` before `ELECTRON_VERSION`'s, and `ELECTRON_VERSION` itself: an
 * app may ship on any of them.
 */
const versions = async () => {
  const response = await fetch("https://registry.npmjs.org/electron");
  if (!response.ok) {
    throw new Error(`npm answered ${response.status} for electron's releases`);
  }
  const { versions: all } = (await response.json()) as {
    versions: Record<string, unknown>;
  };
  const floor = Number(ELECTRON_VERSION.split(".")[0]) - MAJORS;
  const newest = new Map<number, string>();
  for (const version of Object.keys(all)) {
    const major = Number(version.split(".")[0]);
    const best = newest.get(major);
    if (
      /^\d+\.\d+\.\d+$/.test(version) &&
      major >= floor &&
      (best === undefined || compare(version, best) > 0)
    ) {
      newest.set(major, version);
    }
  }
  return [...new Set([...newest.values(), ELECTRON_VERSION])].sort((a, b) =>
    compare(b, a),
  );
};

const fetchTypes = async (version: string) => {
  const dir = await mkdtemp(join(tmpdir(), "electron-surface-"));
  const tarball = join(dir, "electron.tgz");
  const response = await fetch(
    `https://registry.npmjs.org/electron/-/electron-${version}.tgz`,
  );
  if (!response.ok) {
    throw new Error(`npm answered ${response.status} for electron ${version}`);
  }
  await writeFile(tarball, new Uint8Array(await response.arrayBuffer()));
  const tar = Bun.spawnSync([
    "tar",
    "-xzf",
    tarball,
    "-C",
    dir,
    "package/electron.d.ts",
  ]);
  if (tar.exitCode !== 0) {
    throw new Error(`tar failed: ${tar.stderr.toString()}`);
  }
  return readFile(join(dir, "package/electron.d.ts"), "utf8");
};

/** The text of the block that `header` opens, up to its closing brace. */
const block = (types: string, header: string) => {
  const start = types.indexOf(`\n  ${header}`);
  if (start === -1) {
    throw new Error(`electron.d.ts has no ${header}`);
  }
  return types.slice(start, types.indexOf("\n  }\n", start));
};

/**
 * A module's members: on Linux, and the methods Electron has only elsewhere,
 * which it leaves on Linux as calls that do nothing.
 */
type Members = { methods: string[]; properties: string[]; elsewhere: string[] };

/** What electron.d.ts says of a member only the main process has. */
const MAIN_ONLY = /only available in the main process/;

/**
 * The members a block declares for Linux, `static` ones or the rest, and in
 * a `renderer` without those only the main process has. A member's
 * platforms are in the `@platform` of the comment right before its first
 * declaration.
 */
const membersOf = (
  text: string,
  statics: boolean,
  renderer = false,
): Members => {
  const methods = new Set<string>();
  const properties = new Set<string>();
  const notLinux = new Set<string>();
  const elsewhere = new Set<string>();
  const mainOnly = new Set<string>();
  const seen = new Set<string>();
  const pattern = statics
    ? /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*)?\n {4}static (?:readonly )?(\w+)(\(|\??:)/g
    : /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*)?\n {4}(?:readonly )?(\w+)(\(|\??:)/g;
  for (const [, doc = "", name = "", kind] of text.matchAll(pattern)) {
    if (EMITTER.has(name) || name === "constructor") {
      continue;
    }
    if (!seen.has(name)) {
      seen.add(name);
      const platforms = /@platform ([\w,]+)/.exec(doc)?.[1];
      if (platforms !== undefined && !platforms.split(",").includes("linux")) {
        notLinux.add(name);
      }
      if (renderer && MAIN_ONLY.test(doc)) {
        mainOnly.add(name);
      }
    }
    if (mainOnly.has(name)) {
      continue;
    }
    if (notLinux.has(name)) {
      if (kind === "(") {
        elsewhere.add(name);
      }
      continue;
    }
    (kind === "(" ? methods : properties).add(name);
  }
  return {
    elsewhere: [...elsewhere].filter((name) => !methods.has(name)).sort(),
    methods: [...methods].sort(),
    properties: [...properties].sort(),
  };
};

/** The classes whose objects an app gets, and the one each extends. */
const INSTANCES: Record<string, string | undefined> = {
  BaseWindow: undefined,
  BrowserView: undefined,
  BrowserWindow: "BaseWindow",
  Cookies: undefined,
  Debugger: undefined,
  DownloadItem: undefined,
  Menu: undefined,
  MenuItem: undefined,
  MessagePortMain: undefined,
  NativeImage: undefined,
  NavigationHistory: undefined,
  Notification: undefined,
  ServiceWorkers: undefined,
  Session: undefined,
  Tray: undefined,
  UtilityProcess: undefined,
  View: undefined,
  WebContents: undefined,
  WebContentsView: "View",
  WebFrameMain: undefined,
  WebRequest: undefined,
};

/**
 * The main process's event emitters, as electron.d.ts declares each, and
 * the one each extends: an app's objects and the modules it listens to.
 */
const EMITTERS: Record<string, string | undefined> = {
  App: undefined,
  AutoUpdater: undefined,
  BaseWindow: undefined,
  BrowserWindow: "BaseWindow",
  ClientRequest: undefined,
  Cookies: undefined,
  Debugger: undefined,
  DownloadItem: undefined,
  Extensions: undefined,
  IncomingMessage: undefined,
  Menu: undefined,
  MessagePortMain: undefined,
  NativeTheme: undefined,
  Notification: undefined,
  PowerMonitor: undefined,
  Screen: undefined,
  ServiceWorkers: undefined,
  Session: undefined,
  SystemPreferences: undefined,
  Tray: undefined,
  UtilityProcess: undefined,
  View: undefined,
  WebContents: undefined,
  WebContentsView: "View",
  WebFrameMain: undefined,
};

/**
 * The emitter `name`'s block, a class or an interface, or nothing in an
 * Electron from before it.
 */
const emitterBlock = (types: string, name: string) => {
  if (types.includes(`\n  interface ${name} `)) {
    return block(types, `interface ${name} `);
  }
  return types.includes(`\n  class ${name} `)
    ? block(types, `class ${name} `)
    : "";
};

/**
 * The events a block declares for Linux, by the `@platform` of the comment
 * right before each `on(event: …)`.
 */
const eventsOf = (text: string) => {
  const events = new Set<string>();
  const pattern =
    /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*)?\n {4}on\(event: '([\w-]+)'/g;
  for (const [, doc = "", name = ""] of text.matchAll(pattern)) {
    const platforms = /@platform ([\w,]+)/.exec(doc)?.[1];
    if (platforms === undefined || platforms.split(",").includes("linux")) {
      events.add(name);
    }
  }
  return [...events];
};

const merge = (known: Members | undefined, found: Members): Members =>
  known === undefined
    ? found
    : {
        elsewhere: [
          ...new Set([...known.elsewhere, ...found.elsewhere]),
        ].sort(),
        methods: [...new Set([...known.methods, ...found.methods])].sort(),
        properties: [
          ...new Set([...known.properties, ...found.properties]),
        ].sort(),
      };

type Surface = Record<string, Members & { kind: "object" | "class" }>;

/** `found` folded into `into`, a module at a time. */
const mergeSurface = (into: Surface, found: Surface) => {
  for (const [name, members] of Object.entries(found)) {
    const known = into[name];
    into[name] =
      known === undefined
        ? members
        : { kind: known.kind, ...merge(known, members) };
  }
};

const instances: Record<string, Members> = {};
const events: Record<string, string[]> = {};
const surface: Surface = {};
const preload: Surface = {};
let preloadProcess: Members | undefined;
const covered = await versions();
for (const version of covered) {
  const types = await fetchTypes(version);
  for (const [name, parent] of Object.entries(INSTANCES)) {
    let found = membersOf(block(types, `class ${name} `), false);
    if (parent !== undefined) {
      found = merge(found, membersOf(block(types, `class ${parent} `), false));
    }
    instances[name] = merge(instances[name], found);
  }
  for (const [name, parent] of Object.entries(EMITTERS)) {
    const found = [
      ...eventsOf(emitterBlock(types, name)),
      ...(parent === undefined ? [] : eventsOf(emitterBlock(types, parent))),
    ];
    events[name] = [...new Set([...(events[name] ?? []), ...found])].sort();
  }
  mergeSurface(surface, surfaceOf(types, ["Main", "Common"]));
  mergeSurface(preload, surfaceOf(types, ["Renderer", "Common"], true));
  // What Electron adds to Node's process, which a preload gets too.
  preloadProcess = merge(
    preloadProcess,
    membersOf(block(types, "interface Process "), false, true),
  );
}

/** The modules that `namespaces` of electron.d.ts export. */
function surfaceOf(types: string, namespaces: string[], renderer = false) {
  const exports = namespaces.flatMap((namespace) => [
    ...block(types, `namespace ${namespace} {`).matchAll(
      /\n {4}(const|class) (\w+): ?(typeof )?(\w+)?/g,
    ),
    ...block(types, `namespace ${namespace} {`).matchAll(
      /\n {4}(class) (\w+) extends Electron\.(\w+)/g,
    ),
  ]);
  const surface: Surface = {};
  for (const match of exports) {
    const [, keyword, name = ""] = match;
    if (NOT_ON_LINUX.has(name) || name in surface) {
      continue;
    }
    if (keyword === "const" && match[3] === undefined) {
      // `const app: App`: an object with the interface's members.
      const iface = match[4] ?? "";
      const text = types.includes(`\n  interface ${iface} `)
        ? block(types, `interface ${iface} `)
        : block(types, `class ${iface} `);
      surface[name] = { kind: "object", ...membersOf(text, false, renderer) };
    } else if (keyword === "const") {
      // `const session: typeof Session`: the class's statics.
      surface[name] = {
        kind: "object",
        ...membersOf(block(types, `class ${match[4]} `), true, renderer),
      };
    } else {
      surface[name] = {
        kind: "class",
        ...membersOf(block(types, `class ${name} `), true, renderer),
      };
    }
  }
  return surface;
}

const sortedOf = (modules: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(modules).sort(([a], [b]) => a.localeCompare(b)),
  );
await writeFile(
  join(import.meta.dir, "../src/electron/surface.ts"),
  `// GENERATED by scripts/electron-surface.ts from the electron.d.ts of Electron
// ${covered.join(", ")}.
// electron-surface.yml runs it weekly; run it again after moving
// \`ELECTRON_VERSION\`. Don't edit this.
//
// Every module a Linux Electron app can require in its main process, and for
// each its methods and properties on Linux, an object's own or a class's
// statics, and the methods it has only on macOS or Windows (\`elsewhere\`).

export const ELECTRON_SURFACE = ${JSON.stringify(sortedOf(surface), null, 2)} as const;

// The members of the objects an app gets: its windows, pages, sessions and
// the rest, with what each class extends.
export const ELECTRON_INSTANCES = ${JSON.stringify(
    sortedOf(instances),
    null,
    2,
  )} as const;

// The events each of the main process's emitters has on Linux, with those of
// what it extends (\`events.test.ts\`).
export const ELECTRON_EVENTS = ${JSON.stringify(sortedOf(events), null, 2)} as const;

// Every module a preload can require, sandboxed or with Node, and what
// Electron adds to its \`process\`: what the engine's preload bootstrap
// answers (\`preload-coverage.test.ts\`).
export const ELECTRON_PRELOAD = ${JSON.stringify(sortedOf(preload), null, 2)} as const;

export const ELECTRON_PRELOAD_PROCESS = ${JSON.stringify(preloadProcess, null, 2)} as const;
`,
);
