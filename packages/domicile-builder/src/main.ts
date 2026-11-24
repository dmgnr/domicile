#!/usr/bin/env bun
// `domicile-builder (--entry <file> | --package <spec> | --evaluate <config>)
// --domicile <install> --cache <dir>`
// `domicile-builder --serve <file> --socket <path> --domicile <install>
// --cache <dir>`
//
// Builds an entry or package into a shell module, evaluates a config module
// into the compositor's JSON, or serves an entry with hot module replacement
// until stopped. Reports each step on stdout as a JSON line.
//
// Only a JSON object with a `step` field is a step. Other stdout output, such
// as a tool's warnings, is the build log, which `domicile` shows as is.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { importGraph, mergedGraph } from "./graph";
import { installedName, packageProject, prebuiltOf } from "./package";
import { line, Step } from "./progress";
import type { Manifest } from "./project";
import {
  cacheKey,
  missingPackages,
  parseManifest,
  projectOf,
  viteConfigOf,
} from "./project";

/** The built module's file name in its output directory. */
const MODULE = "shell.js";

/** The shell's declared options, beside the module, for the Settings app. */
const OPTIONS = "options.json";

const say = (step: Step): void => {
  process.stdout.write(`${line(step)}\n`);
};

/** A file's text, or `undefined` if there is no file. */
const readFile = (file: string): string | undefined =>
  existsSync(file) && statSync(file).isFile()
    ? readFileSync(file, "utf8")
    : undefined;

/** Run bun with `args` in `cwd`; throw with its stderr if it fails. */
const runBun = (cwd: string, args: readonly string[]): void => {
  const ran = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (ran.exitCode !== 0) {
    throw new Error(
      `domicile-builder: \`bun ${args.join(" ")}\` in ${cwd} failed:\n${ran.stderr.toString()}`,
    );
  }
};

/** The project's `package.json`, or `undefined` if it has none. */
const manifestOf = (project: string): Manifest | undefined => {
  const text = readFile(path.join(project, "package.json"));
  return text === undefined ? undefined : parseManifest(text);
};

/**
 * Read the import graphs of the entry and its project's vite config, and add
 * any packages the project lacks. Builds and evaluations both start here.
 */
const prepared = (entry: string) => {
  say(Step.Resolving());
  const project = projectOf(entry, existsSync);
  const config = viteConfigOf(project, existsSync);
  const graph = mergedGraph(
    [entry, ...(config === undefined ? [] : [config])].map((file) =>
      importGraph(file, readFile),
    ),
  );
  const missing = missingPackages(graph.packages, manifestOf(project));
  if (missing.length > 0) {
    say(Step.Installing(missing));
    runBun(project, ["add", "--ignore-scripts", ...missing]);
  }
  return { config, graph, project };
};

/** The cache key for what `prepared` read. */
const keyOf = (
  { graph, project }: ReturnType<typeof prepared>,
  domicile: string,
): string =>
  cacheKey(
    graph.files,
    readFile(path.join(project, "bun.lock")) ?? "",
    domicile,
  );

/** Install the dependencies `project` lists, if any. */
const installed = (project: string): void => {
  if (manifestOf(project)?.dependencies !== undefined) {
    runBun(project, ["install", "--ignore-scripts", "--frozen-lockfile"]);
  }
};

const build = async (
  entry: string,
  domicile: string,
  cache: string,
): Promise<void> => {
  const read = prepared(entry);
  const root = path.join(cache, keyOf(read, domicile));
  if (readFile(path.join(root, MODULE)) === undefined) {
    installed(read.project);
    say(Step.Bundling());
    // Imported lazily: vite takes most of a second to load, and a cached
    // build needs none of it.
    const { bundle } = await import("./bundle");
    await bundle(entry, root, domicile, read.config);
    const { extractOptions } = await import("./evaluate");
    await extractOptions(entry, path.join(root, OPTIONS), domicile);
    say(Step.Built(root, MODULE, false));
  } else {
    say(Step.Built(root, MODULE, true));
  }
};

/**
 * Serve `entry` on `socket` with hot module replacement until the process is
 * stopped. Vite's dependency cache is kept per project under `cache`.
 */
const serveEntry = async (
  entry: string,
  socket: string,
  domicile: string,
  cache: string,
): Promise<void> => {
  const { config, project } = prepared(entry);
  installed(project);
  const { DEV_MODULE, serve } = await import("./serve");
  const serving = await serve({
    cache: path.join(
      cache,
      "dev",
      createHash("sha256").update(project).digest("hex").slice(0, 16),
    ),
    config,
    domicile,
    entry,
    project,
    socket,
  });
  say(Step.Serving(socket, DEV_MODULE));
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      serving.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
};

/** Evaluate the config module `config` into the JSON the compositor reads. */
const evaluateConfig = async (
  config: string,
  domicile: string,
  cache: string,
): Promise<void> => {
  const read = prepared(config);
  const out = path.join(cache, "configs", `${keyOf(read, domicile)}.json`);
  if (readFile(out) === undefined) {
    installed(read.project);
    mkdirSync(path.dirname(out), { recursive: true });
    const { evaluate } = await import("./evaluate");
    await evaluate(config, out, domicile);
    say(Step.Evaluated(out, false));
  } else {
    say(Step.Evaluated(out, true));
  }
};

/**
 * Install `spec` into its own project, then use its prebuilt module or build
 * its entry.
 */
const buildPackage = async (
  spec: string,
  domicile: string,
  cache: string,
): Promise<void> => {
  say(Step.Resolving());
  const project = packageProject(cache, spec);
  if (manifestOf(project)?.dependencies === undefined) {
    say(Step.Installing([spec]));
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "package.json"), "{}\n");
    runBun(project, ["add", "--ignore-scripts", spec]);
  }
  const name = installedName(manifestOf(project) ?? {});
  const installed = path.join(project, "node_modules", name);
  const prebuilt = prebuiltOf(
    readFile(path.join(installed, "package.json")) ?? "{}",
  );
  if (prebuilt === undefined) {
    await build(Bun.resolveSync(name, project), domicile, cache);
  } else {
    const module = path.join(installed, prebuilt);
    say(Step.Built(path.dirname(module), path.basename(module), true));
  }
};

const { values } = parseArgs({
  options: {
    cache: { type: "string" },
    domicile: { type: "string" },
    entry: { type: "string" },
    evaluate: { type: "string" },
    package: { type: "string" },
    serve: { type: "string" },
    socket: { type: "string" },
  },
});
const {
  cache,
  domicile,
  entry,
  evaluate: config,
  package: spec,
  serve: served,
  socket,
} = values;

/** Start what the arguments ask for, or `undefined` if they are invalid. */
const asked = (): Promise<void> | undefined => {
  const asking = [entry, spec, config, served].filter(
    (one) => one !== undefined,
  );
  if (
    domicile === undefined ||
    cache === undefined ||
    asking.length !== 1 ||
    (served === undefined) !== (socket === undefined)
  ) {
    return undefined;
  } else if (served !== undefined && socket !== undefined) {
    return serveEntry(
      path.resolve(served),
      path.resolve(socket),
      path.resolve(domicile),
      path.resolve(cache),
    );
  } else if (config !== undefined) {
    return evaluateConfig(
      path.resolve(config),
      path.resolve(domicile),
      path.resolve(cache),
    );
  } else if (entry !== undefined) {
    return build(
      path.resolve(entry),
      path.resolve(domicile),
      path.resolve(cache),
    );
  } else if (spec === undefined) {
    return undefined;
  } else {
    return buildPackage(spec, path.resolve(domicile), path.resolve(cache));
  }
};

const building = asked();
if (building === undefined) {
  say(
    Step.Failed(
      "usage: domicile-builder (--entry <file> | --package <spec> | --evaluate <config> | --serve <file> --socket <path>) --domicile <install> --cache <dir>",
    ),
  );
  process.exit(2);
}
await building.catch((failure: unknown) => {
  say(
    Step.Failed(failure instanceof Error ? failure.message : String(failure)),
  );
  process.exit(1);
});
