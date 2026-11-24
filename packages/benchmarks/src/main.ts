import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { markdown, parseRun, summarize } from "./summary";

/**
 * Summarizes every run's JSON under the directory given, recursively: prints
 * markdown tables and writes `summary.json` beside the runs.
 */
const [directory] = process.argv.slice(2);
if (directory === undefined) {
  throw new Error("usage: main.ts <directory of run JSON>");
}

const runs = readdirSync(directory, { encoding: "utf8", recursive: true })
  .filter((file) => file.endsWith(".run.json"))
  .toSorted()
  .map((file) => parseRun(readFileSync(join(directory, file), "utf8")));

if (runs.length === 0) {
  throw new Error(`no *.run.json under ${directory}`);
}

const rows = summarize(runs);
writeFileSync(join(directory, "summary.json"), JSON.stringify(rows, null, 2));
// biome-ignore lint/suspicious/noConsole: the summary is the output
console.log(markdown(rows));
