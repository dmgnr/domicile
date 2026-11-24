// A copy of an Electron install's `resources/` that Bun can load an app from:
// archives extracted, everything else linked.

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Result } from "@cprussin/option-result";
import { Ok } from "@cprussin/option-result";

import { extractAsar } from "./asar";

/**
 * The mirror of `resources` under `cache`, made if missing. Each `*.asar` in
 * `resources` is extracted to a directory of the same name, and every other
 * entry is a symlink. The install directory holding `resources` is mirrored
 * the same way one level up, so a path the app builds with `..` resolves.
 *
 * Mirrors are keyed by the archives' paths, sizes and times, so an updated app
 * gets a new mirror and an unchanged one reuses its old one.
 *
 * @returns The mirrored `resources` directory, or why an archive couldn't be
 *   read.
 */
export const mirrorResources = async (
  resources: string,
  cache: string,
): Promise<Result<string, string>> => {
  const archives = (await readdir(resources)).filter((name) =>
    name.endsWith(".asar"),
  );
  const root = join(cache, await mirrorKey(resources, archives));
  const mirror = join(root, basename(resources));
  return (await exists(root))
    ? Ok(mirror)
    : (await buildMirror(resources, archives, `${root}.partial`)).mapAsync(
        async () => {
          await rename(`${root}.partial`, root);
          return mirror;
        },
      );
};

const mirrorKey = async (resources: string, archives: readonly string[]) => {
  const stamps = await Promise.all(
    archives.map(async (name) => {
      const { mtimeMs, size } = await stat(join(resources, name));
      return { mtimeMs, name, size };
    }),
  );
  return createHash("sha256")
    .update(JSON.stringify({ resources, stamps }))
    .digest("hex")
    .slice(0, 32);
};

const buildMirror = async (
  resources: string,
  archives: readonly string[],
  root: string,
): Promise<Result<string, string>> => {
  await rm(root, { force: true, recursive: true });
  const install = dirname(resources);
  const mirror = join(root, basename(resources));
  await mkdir(mirror, { recursive: true });
  await linkEntries(install, root, [basename(resources)]);
  await linkEntries(resources, mirror, archives);
  return extractAll(resources, archives, mirror);
};

const linkEntries = async (
  from: string,
  to: string,
  skip: readonly string[],
) => {
  const names = (await readdir(from)).filter((name) => !skip.includes(name));
  await Promise.all(
    names.map((name) => symlink(join(from, name), join(to, name))),
  );
};

const extractAll = async (
  resources: string,
  archives: readonly string[],
  mirror: string,
): Promise<Result<string, string>> => {
  let outcome: Result<string, string> = Ok(mirror);
  for (const name of archives) {
    outcome = await outcome.andThenAsync(async () =>
      (await extractAsar(join(resources, name), join(mirror, name))).map(
        () => mirror,
      ),
    );
  }
  return outcome;
};

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    } else {
      throw error;
    }
  }
};
