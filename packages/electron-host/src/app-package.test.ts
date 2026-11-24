import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Err, Ok } from "@cprussin/option-result";

import { readAppPackage } from "./app-package";

const appWith = async (manifest: string) => {
  const dir = await mkdtemp(join(tmpdir(), "electron-host-package-"));
  await writeFile(join(dir, "package.json"), manifest);
  return dir;
};

describe(readAppPackage, () => {
  it("reads the app's name, product name, version and main", async () => {
    const app = await appWith(
      `{"name":"@ant/desktop","productName":"Claude","version":"5.1.0","main":".vite/build/index.pre.js","desktopName":"com.anthropic.Claude.desktop"}`,
    );

    expect(await readAppPackage(app)).toEqual(
      Ok({
        appId: "com.anthropic.Claude",
        main: join(app, ".vite/build/index.pre.js"),
        name: "@ant/desktop",
        productName: "Claude",
        version: "5.1.0",
      }),
    );
  });

  it("names the product after the package and starts at index.js without them, as Electron does", async () => {
    const app = await appWith(`{"name":"notes","version":"1.0.0"}`);

    expect(await readAppPackage(app)).toEqual(
      Ok({
        appId: "notes",
        main: join(app, "index.js"),
        name: "notes",
        productName: "notes",
        version: "1.0.0",
      }),
    );
  });

  it("refuses a manifest with no name", async () => {
    const app = await appWith(`{"version":"1.0.0"}`);

    expect(await readAppPackage(app)).toEqual(
      Err(`${join(app, "package.json")} has no name or version`),
    );
  });
});
