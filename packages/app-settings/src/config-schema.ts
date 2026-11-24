// The config as the form shows it: the SDK's Zod schema, generated from the
// `domicile-config` crate, with its defaults. The crate is the source of
// truth. The host checks every write against it, so this schema only has to
// read.

import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import type {
  displayConfigSchema,
  displayPlacementSchema,
  keymapSchema,
  profileSchema,
  transformSchema,
} from "@domicile-desktop/sdk/config-schema";
import { configSchema } from "@domicile-desktop/sdk/config-schema";
import { z } from "zod";

import type { ConfigDocument } from "./config-document";

/** The default for `files.omit`: hidden paths. */
export const DEFAULT_OMIT = configSchema.parse({}).files.omit;

/** Every setting, with the compositor's defaults filled in. */
export type Settings = z.infer<typeof configSchema>;

/** A profile, which arranges the monitors that are plugged in. */
export type Profile = z.infer<typeof profileSchema>;

/** One of `input.keyboard.keymaps`, with xkb's defaults filled in. */
export type Keymap = z.infer<typeof keymapSchema>;

/** A display a profile places. */
export type Placement = z.infer<typeof displayPlacementSchema>;

/** A display described outright. */
export type Display = z.infer<typeof displayConfigSchema>;

/** Which way up a monitor is. */
export type Transform = z.infer<typeof transformSchema>;

/** Reads `document`'s settings, or says where it does not fit the schema. */
export const readSettings = (
  document: ConfigDocument,
): Result<Settings, string> => {
  const read = configSchema.safeParse(document);
  return read.success ? Ok(read.data) : Err(z.prettifyError(read.error));
};
