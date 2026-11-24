import { describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Err } from "@cprussin/option-result";

import { writeAsar } from "./asar-fixture";
import { mirrorResources } from "./mirror";

const install = async () => {
  const dir = await mkdtemp(join(tmpdir(), "electron-host-mirror-"));
  const resources = join(dir, "install/resources");
  await writeAsar(join(resources, "app.asar"), {
    "main.js": { content: "one" },
  });
  await mkdir(join(resources, "bin"), { recursive: true });
  await writeFile(join(resources, "icon.png"), "png");
  await writeFile(join(resources, "../app-binary"), "elf");
  return { cache: join(dir, "cache"), resources };
};

describe(mirrorResources, () => {
  it("extracts each archive to a directory and links the rest", async () => {
    const { cache, resources } = await install();

    const mirror = (await mirrorResources(resources, cache)).unwrapOr("");
    expect(await readFile(join(mirror, "app.asar/main.js"), "utf8")).toBe(
      "one",
    );
    expect(await readlink(join(mirror, "icon.png"))).toBe(
      join(resources, "icon.png"),
    );
    expect(await readlink(join(mirror, "bin"))).toBe(join(resources, "bin"));
  });

  it("links what sits beside the resources, so paths up from them resolve", async () => {
    const { cache, resources } = await install();

    const mirror = (await mirrorResources(resources, cache)).unwrapOr("");
    expect(await readlink(join(mirror, "../app-binary"))).toBe(
      join(resources, "../app-binary"),
    );
  });

  it("reuses the mirror while the archives are unchanged", async () => {
    const { cache, resources } = await install();
    const first = (await mirrorResources(resources, cache)).unwrapOr("");
    await writeFile(join(first, "app.asar/main.js"), "touched");

    const second = (await mirrorResources(resources, cache)).unwrapOr("");
    expect(second).toBe(first);
    expect(await readFile(join(second, "app.asar/main.js"), "utf8")).toBe(
      "touched",
    );
  });

  it("makes a new mirror when an archive changes", async () => {
    const { cache, resources } = await install();
    const first = (await mirrorResources(resources, cache)).unwrapOr("");
    await writeAsar(join(resources, "app.asar"), {
      "main.js": { content: "updated" },
    });

    const second = (await mirrorResources(resources, cache)).unwrapOr("");
    expect(second).not.toBe(first);
    expect(await readFile(join(second, "app.asar/main.js"), "utf8")).toBe(
      "updated",
    );
  });

  it("reports an archive it can't read", async () => {
    const { cache, resources } = await install();
    await writeFile(join(resources, "broken.asar"), "nope");

    expect(await mirrorResources(resources, cache)).toEqual(
      Err(`${join(resources, "broken.asar")} is not an asar archive`),
    );
  });
});
