// Stubs, for the coverage checks: a member whose whole body answers one
// constant, as `() => false`, an answer that doesn't depend on anything.
// Each is a decision written down in `stubs.json`, a lie or honest, with
// why; a preload's are named "preload <module>.<member>".

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const VALUE =
  /(false|true|!0|!1|null|undefined|void 0|-?\d+(?:\.\d+)?|""|''|\[\]|\{\}|\(\{\}\))/
    .source;

/** A function's transpiled source that only answers a constant. */
export const CONSTANT = new RegExp(
  String.raw`^(?:\([^)]*\)|[\w$]+)\s*=>\s*(?:${VALUE}|\{\s*(?:return\b\s*(?:${VALUE})?\s*;?)?\s*\})$`,
);

/**
 * stubs.json: each member that answers a constant, under `lies` when an app
 * acts on a wrong answer, or `honest` when the answer is right on Domicile,
 * each with why.
 */
const StubDecisions = z.object({
  honest: z.record(z.string(), z.string()),
  lies: z.record(z.string(), z.string()),
});

/** The stubs stubs.json decides, for the preload's or the main process's. */
export const decidedStubs = async (preload: boolean) => {
  const decided = StubDecisions.parse(
    JSON.parse(await readFile(join(import.meta.dir, "stubs.json"), "utf8")),
  );
  const ours = (name: string) => name.startsWith("preload ") === preload;
  return {
    honest: Object.keys(decided.honest).filter(ours),
    lies: Object.keys(decided.lies).filter(ours),
  };
};
