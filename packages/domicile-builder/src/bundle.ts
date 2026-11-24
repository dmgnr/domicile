// Builds a user's shell entry into a module against Domicile's install.

import path from "node:path";

import { shellBuild } from "@domicile-desktop/component-library/vite-shell";
import type { Plugin } from "vite";
import { build } from "vite";

/** Imports resolved from Domicile's install instead of the user's project. */
const FROM_DOMICILE = /^(@domicile-desktop\/[^/]+|react|react-dom)(\/.*)?$/;

/** The manganese package directory in a Domicile install. */
export const manganeseIn = (domicile: string): string =>
  path.join(domicile, "packages", "shell-manganese");

/**
 * Bundle `entry` into `out/shell.js`, with its `Shell` export and styles.
 *
 * Domicile's packages and React resolve from `domicile`, not the project. This
 * gives the user's code and manganese one shared React, and keeps the SDK's
 * protocol in step with the running Domicile.
 *
 * Without `config`, the build transpiles and bundles only; packages ship
 * their CSS prebuilt. With the project's vite `config`, its plugins and
 * settings apply, and the shell's output settings here override its own.
 */
export const bundle = async (
  entry: string,
  out: string,
  domicile: string,
  config?: string,
): Promise<void> => {
  const shell = shellBuild({ entry });
  await build({
    base: "./",
    build: { ...shell.build, emptyOutDir: true, outDir: out },
    configFile: config ?? false,
    logLevel: "error",
    plugins: [fromDomicile(domicile), ...shell.plugins],
    root: path.dirname(entry),
  });
};

/**
 * Resolve the user's imports of Domicile's packages and React from Domicile's
 * install. Imports inside Domicile's own packages resolve normally.
 */
export const fromDomicile = (domicile: string): Plugin => {
  const manganese = manganeseIn(domicile);
  const anchor = path.join(manganese, "src", "index.tsx");
  const ours = `${path.join(domicile, "packages")}${path.sep}`;
  return {
    enforce: "pre",
    name: "domicile:from-domicile",
    resolveId(source, importer) {
      if (!FROM_DOMICILE.test(source) || importer?.startsWith(ours)) {
        return null;
      } else if (source === "@domicile-desktop/manganese") {
        return anchor;
      } else {
        return this.resolve(source, anchor, { skipSelf: true });
      }
    },
  };
};
