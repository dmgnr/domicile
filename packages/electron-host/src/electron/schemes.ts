// The stand-in for Electron's `protocol.registerSchemesAsPrivileged`. The
// engine registers an app's own schemes only as it starts, from the schemes
// apps registered on earlier runs, so a scheme it lacks is kept for the next
// start and the app runs on its own Electron this time. See "Requests" in
// docs/architecture/ELECTRON-APPS.md.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { CustomScheme } from "./protocol";

/** One of the apps' own schemes the engine registered, as `ready` names it. */
export type RegisteredScheme = {
  readonly scheme: string;
  readonly privileges: readonly string[];
};

/**
 * The privileges the engine grants, by Electron's names. Electron's
 * `stream`, `codeCache` and `allowServiceWorkers` aren't granted yet, so an
 * app asking for them is not held back for them.
 */
const GRANTED = [
  "standard",
  "secure",
  "bypassCSP",
  "corsEnabled",
  "supportFetchAPI",
] as const;

/** Schemes Electron's own Chromium already has, which an app may name. */
const BUILT_IN = new Set(["http", "https", "file"]);

/**
 * Schemes the engine or the web gives a meaning, which no app may register.
 * Matches `IsElectronHandleableScheme` in
 * components/domicile/common/electron_schemes.cc.
 */
const RESERVED = new Set([
  "about",
  "blob",
  "chrome",
  "chrome-error",
  "chrome-extension",
  "chrome-native",
  "chrome-search",
  "chrome-untrusted",
  "data",
  "devtools",
  "domicile",
  "filesystem",
  "googlechrome",
  "intent",
  "isolated-app",
  "javascript",
  "view-source",
  "ws",
  "wss",
]);

/** Whether the engine can register `scheme` for an app. */
const registrable = (scheme: string) =>
  /^[a-z][a-z0-9+.-]*$/.test(scheme) && !RESERVED.has(scheme);

/** The privileges the engine grants that `scheme` asks for. */
const asked = (scheme: CustomScheme): string[] =>
  GRANTED.filter((privilege) => scheme.privileges?.[privilege] === true);

/**
 * The record of apps' schemes, as `domicile` reads it at the desktop's start:
 * each app's package name, then its schemes and the privileges each asked
 * for. Matches `electron_schemes` in packages/domicile-launch.
 */
const record = z.record(
  z.string(),
  z.array(z.object({ privileges: z.array(z.string()), scheme: z.string() })),
);

/**
 * Electron's `protocol.registerSchemesAsPrivileged` for the app `app`, its
 * package name, on an engine that registered `registered`.
 *
 * A scheme the engine lacks, or lacks a privilege of, is added to the record
 * at `recordPath`, and `refuse` gives up on the app, which then runs on its
 * own Electron until the desktop starts again. A scheme no app may register
 * is refused without being kept.
 */
export const createSchemeRegistration = ({
  app,
  recordPath,
  refuse,
  registered,
}: {
  readonly app: string;
  readonly recordPath: string;
  readonly refuse: (why: string) => never;
  readonly registered: readonly RegisteredScheme[];
}) => {
  const engineHas = (scheme: CustomScheme) => {
    const found = registered.find(({ scheme: name }) => name === scheme.scheme);
    return (
      found !== undefined &&
      asked(scheme).every((privilege) => found.privileges.includes(privilege))
    );
  };

  return (schemes: CustomScheme[]) => {
    const missing = schemes.filter(
      (scheme) => !BUILT_IN.has(scheme.scheme) && !engineHas(scheme),
    );
    const unregistrable = missing.find(({ scheme }) => !registrable(scheme));
    if (unregistrable !== undefined) {
      refuse(
        `this app registers ${unregistrable.scheme}:, which Domicile's engine keeps for itself`,
      );
    } else if (missing.length > 0) {
      keep(recordPath, app, missing);
      refuse(
        `this app registers ${missing.map(({ scheme }) => `${scheme}:`).join(", ")}, which Domicile's engine registers only as the desktop starts. It's kept for the next start; until then the app runs on its own Electron`,
      );
    }
  };
};

/** Adds `schemes` to `app`'s in the record at `path`. */
const keep = (path: string, app: string, schemes: CustomScheme[]) => {
  const kept = readRecord(path);
  const theirs = new Map(
    (kept[app] ?? []).map((scheme) => [scheme.scheme, scheme] as const),
  );
  for (const scheme of schemes) {
    const before = theirs.get(scheme.scheme)?.privileges ?? [];
    theirs.set(scheme.scheme, {
      privileges: [...new Set([...before, ...asked(scheme)])],
      scheme: scheme.scheme,
    });
  }
  kept[app] = [...theirs.values()];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`);
};

/** The record at `path`, empty when there is none yet. */
const readRecord = (path: string): z.infer<typeof record> => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    } else {
      throw error;
    }
  }
  return record.parse(JSON.parse(text));
};
