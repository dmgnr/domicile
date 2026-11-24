import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Err, Ok } from "@cprussin/option-result";

import { extractAsar } from "./asar";
import { writeAsar } from "./asar-fixture";

const scratch = () => mkdtemp(join(tmpdir(), "electron-host-asar-"));

describe(extractAsar, () => {
  it("writes every file, nested directories included", async () => {
    const dir = await scratch();
    const archive = join(dir, "app.asar");
    await writeAsar(archive, {
      "lib/deep/x.js": { content: "x" },
      "main.js": { content: "console.log(1);" },
      "package.json": { content: `{"main":"main.js"}` },
    });

    expect(await extractAsar(archive, join(dir, "out"))).toEqual(
      Ok(join(dir, "out")),
    );
    expect(await readFile(join(dir, "out/package.json"), "utf8")).toBe(
      `{"main":"main.js"}`,
    );
    expect(await readFile(join(dir, "out/main.js"), "utf8")).toBe(
      "console.log(1);",
    );
    expect(await readFile(join(dir, "out/lib/deep/x.js"), "utf8")).toBe("x");
  });

  it("keeps executable files executable", async () => {
    const dir = await scratch();
    const archive = join(dir, "app.asar");
    await writeAsar(archive, {
      "bin/tool": { content: "#!/bin/sh", executable: true },
    });

    await extractAsar(archive, join(dir, "out"));
    expect((await stat(join(dir, "out/bin/tool"))).mode & 0o111).toBe(0o111);
  });

  it("copies unpacked files from beside the archive", async () => {
    const dir = await scratch();
    const archive = join(dir, "app.asar");
    await writeAsar(archive, {
      "main.js": { content: "packed" },
      "native/addon.node": { content: "binary", unpacked: true },
    });

    await extractAsar(archive, join(dir, "out"));
    expect(await readFile(join(dir, "out/native/addon.node"), "utf8")).toBe(
      "binary",
    );
    expect(await readFile(join(dir, "out/main.js"), "utf8")).toBe("packed");
  });

  it("leaves out an unpacked file its package pruned, as Electron only fails reading it", async () => {
    // nixpkgs deletes other platforms' prebuilt modules from ChatGPT's
    // app.asar.unpacked, leaving the archive's header naming them.
    const dir = await scratch();
    const archive = join(dir, "app.asar");
    await writeAsar(archive, {
      "main.js": { content: "packed" },
      "prebuilds/darwin-arm64/addon.node": { content: "mac", unpacked: true },
      "prebuilds/linux-x64/addon.node": { content: "linux", unpacked: true },
    });
    await rm(join(`${archive}.unpacked`, "prebuilds/darwin-arm64"), {
      recursive: true,
    });

    expect(await extractAsar(archive, join(dir, "out"))).toEqual(
      Ok(join(dir, "out")),
    );
    expect(
      await readFile(join(dir, "out/prebuilds/linux-x64/addon.node"), "utf8"),
    ).toBe("linux");
    expect(
      await stat(join(dir, "out/prebuilds/darwin-arm64/addon.node")).catch(
        () => undefined,
      ),
    ).toBeUndefined();
  });

  it("refuses a file that is not an archive", async () => {
    const dir = await scratch();
    const archive = join(dir, "app.asar");
    await writeFile(archive, "not an archive at all");

    expect(await extractAsar(archive, join(dir, "out"))).toEqual(
      Err(`${archive} is not an asar archive`),
    );
  });
});
