// Writes `config.schema.json` from `domicile-config`'s Rust types, and
// `src/config.ts` (its types) and `src/config-schema.ts` (its Zod schema) from
// that schema.
//
//   bun run generate                                                   # in packages/chrome-sdk
//   bun codegen/generate-config.ts <schema path> <ts path> <zod path>  # somewhere else
//
// Needs `cargo`. `tests/test-config-types-match-the-schema.sh` checks both files
// are current.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { parseRootSchema } from "./json-schema";
import { jsonSchemaToTypeScript } from "./json-schema-to-typescript";
import { jsonSchemaToZod } from "./json-schema-to-zod";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SDK = path.join(ROOT, "packages/chrome-sdk");
const SCHEMA_TARGET = path.join(SDK, "config.schema.json");
const TS_TARGET = path.join(SDK, "src/config.ts");
const ZOD_TARGET = path.join(SDK, "src/config-schema.ts");
const BIOME = path.join(ROOT, "node_modules/.bin/biome");

const HEADER = [
  "Generated from `config.schema.json` by `codegen/generate-config.ts`. Do not",
  "edit. Change `packages/domicile-config` and run `bun run generate` in",
  "`packages/chrome-sdk`.",
  "",
  "The config's sections, for a TypeScript config module's exports:",
  "",
  '  import type { OutputConfig } from "@domicile-desktop/sdk/config";',
  "  export const output: OutputConfig = { max_scale: 1 };",
  "",
  "See `docs/SHELL-CONFIG.md`.",
];

const ZOD_HEADER = [
  "Generated from `config.schema.json` by `codegen/generate-config.ts`. Do not",
  "edit. Change `packages/domicile-config` and run `bun run generate` in",
  "`packages/chrome-sdk`.",
  "",
  "The config's Zod schema: it reads a config as the compositor does, filling",
  "in every default and refusing every key the compositor refuses.",
];

const generate = (
  schemaOut: string,
  typescriptOut: string,
  zodOut: string,
): void => {
  const schema = formatted(SCHEMA_TARGET, ["check", "--write"], rustSchema());
  writeFileSync(schemaOut, schema);
  const root = parseRootSchema(JSON.parse(schema));
  const typescript = jsonSchemaToTypeScript(root, { header: HEADER });
  writeFileSync(typescriptOut, formatted(TS_TARGET, ["format"], typescript));
  const zod = jsonSchemaToZod(root, { header: ZOD_HEADER });
  writeFileSync(zodOut, formatted(ZOD_TARGET, ["check", "--write"], zod));
};

/** The schema `schemars` derives from `domicile_config::Config`. */
const rustSchema = (): string => {
  const cargo = Bun.spawnSync(
    ["cargo", "run", "-q", "-p", "domicile-config", "--example", "schema"],
    { cwd: ROOT },
  );
  if (cargo.exitCode === 0) {
    return cargo.stdout.toString();
  } else {
    throw new Error(`cargo failed: ${cargo.stderr.toString()}`);
  }
};

/** `text` as `biome check` wants it at `target`. */
const formatted = (
  target: string,
  command: readonly string[],
  text: string,
): string => {
  const biome = Bun.spawnSync(
    [BIOME, ...command, `--stdin-file-path=${target}`],
    { cwd: ROOT, stdin: new TextEncoder().encode(text) },
  );
  if (biome.exitCode === 0) {
    return biome.stdout.toString();
  } else {
    throw new Error(
      `biome ${command.join(" ")} failed: ${biome.stderr.toString()}`,
    );
  }
};

generate(
  process.argv[2] ?? SCHEMA_TARGET,
  process.argv[3] ?? TS_TARGET,
  process.argv[4] ?? ZOD_TARGET,
);
