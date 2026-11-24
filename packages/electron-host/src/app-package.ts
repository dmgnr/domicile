// The app's package.json: what Electron reads to name and start an app.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import { z } from "zod";

export type AppPackage = {
  /**
   * The app's desktop id: its `desktopName` without `.desktop`, else its
   * `name`. Its windows carry it, so the desktop matches them to the app.
   */
  readonly appId: string;
  /** The script to run, absolute. */
  readonly main: string;
  readonly name: string;
  /** What the app is called: its `productName`, else its `name`. */
  readonly productName: string;
  readonly version: string;
};

const manifest = z.object({
  desktopName: z.string().optional(),
  main: z.string().default("index.js"),
  name: z.string(),
  productName: z.string().optional(),
  version: z.string(),
});

/** Reads `package.json` in the app directory `app`. */
export const readAppPackage = async (
  app: string,
): Promise<Result<AppPackage, string>> => {
  const path = join(app, "package.json");
  const parsed = manifest.safeParse(JSON.parse(await readFile(path, "utf8")));
  return parsed.success
    ? Ok({
        appId:
          parsed.data.desktopName?.replace(/\.desktop$/, "") ??
          parsed.data.name,
        main: join(app, parsed.data.main),
        name: parsed.data.name,
        productName: parsed.data.productName ?? parsed.data.name,
        version: parsed.data.version,
      })
    : Err(`${path} has no name or version`);
};
