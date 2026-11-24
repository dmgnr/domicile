import { describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTrash } from "./trash";

const NOW = new Date(2026, 10, 23, 9, 5, 7);

/** A home with its trash, and a trash that keeps what it's given there. */
const setUp = async (deviceOf?: (path: string) => Promise<number>) => {
  const root = await mkdtemp(join(tmpdir(), "electron-host-trash-"));
  const homeTrash = join(root, "home/.local/share/Trash");
  await mkdir(join(root, "home"), { recursive: true });
  const trashItem = createTrash({
    homeTrash,
    now: () => NOW,
    uid: 1000,
    ...(deviceOf === undefined ? {} : { deviceOf }),
  });
  return { homeTrash, root, trashItem };
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe(createTrash, () => {
  it("moves a file into the home trash with its trash info", async () => {
    const { homeTrash, root, trashItem } = await setUp();
    const file = join(root, "home/my report.txt");
    await Bun.write(file, "hi");

    await trashItem(file);

    expect(await exists(file)).toBe(false);
    expect(await readFile(join(homeTrash, "files/my report.txt"), "utf8")).toBe(
      "hi",
    );
    expect(
      await readFile(join(homeTrash, "info/my report.txt.trashinfo"), "utf8"),
    ).toBe(
      `[Trash Info]\nPath=${root.split("/").map(encodeURIComponent).join("/")}/home/my%20report.txt\nDeletionDate=2026-11-23T09:05:07\n`,
    );
  });

  it("keeps an earlier item of the same name", async () => {
    const { homeTrash, root, trashItem } = await setUp();
    const file = join(root, "home/a");
    await Bun.write(file, "one");
    await trashItem(file);
    await Bun.write(file, "two");

    await trashItem(file);

    expect((await readdir(join(homeTrash, "files"))).sort()).toEqual([
      "a",
      "a.2",
    ]);
    expect(await readFile(join(homeTrash, "files/a.2"), "utf8")).toBe("two");
    expect(await exists(join(homeTrash, "info/a.2.trashinfo"))).toBe(true);
  });

  it("trashes a directory whole", async () => {
    const { homeTrash, root, trashItem } = await setUp();
    await Bun.write(join(root, "home/dir/inner"), "x");

    await trashItem(join(root, "home/dir"));

    expect(await readFile(join(homeTrash, "files/dir/inner"), "utf8")).toBe(
      "x",
    );
  });

  it("trashes a file on another device in its top directory's trash, relative to it", async () => {
    const { root, trashItem } = await setUp(async (path) =>
      path.startsWith(`${root}/mnt`) ? 2 : 1,
    );
    const file = join(root, "mnt/photos/cat.png");
    await Bun.write(file, "meow");

    await trashItem(file);

    const trash = join(root, "mnt/.Trash-1000");
    expect(await readFile(join(trash, "files/cat.png"), "utf8")).toBe("meow");
    expect(await readFile(join(trash, "info/cat.png.trashinfo"), "utf8")).toBe(
      "[Trash Info]\nPath=photos/cat.png\nDeletionDate=2026-11-23T09:05:07\n",
    );
    expect((await lstat(trash)).mode & 0o777).toBe(0o700);
  });

  it("uses the administrator's sticky .Trash on another device, in the user's own directory", async () => {
    const { root, trashItem } = await setUp(async (path) =>
      path.startsWith(`${root}/mnt`) ? 2 : 1,
    );
    await mkdir(join(root, "mnt/.Trash"), { recursive: true });
    await chmod(join(root, "mnt/.Trash"), 0o1777);
    await Bun.write(join(root, "mnt/cat.png"), "meow");

    await trashItem(join(root, "mnt/cat.png"));

    expect(
      await readFile(join(root, "mnt/.Trash/1000/files/cat.png"), "utf8"),
    ).toBe("meow");
  });

  it("takes its trash info back when the item can't move", async () => {
    const { root, trashItem } = await setUp(async (path) =>
      path.startsWith(`${root}/mnt`) ? 2 : 1,
    );
    await mkdir(join(root, "mnt"));

    // The top directory itself can't move into the trash inside it.
    await expect(trashItem(join(root, "mnt"))).rejects.toThrow();

    expect(await readdir(join(root, "mnt/.Trash-1000/info"))).toEqual([]);
  });

  it("refuses what isn't there, as Electron does", async () => {
    const { root, trashItem } = await setUp();

    expect(trashItem(join(root, "home/nothing"))).rejects.toThrow("ENOENT");
  });
});
