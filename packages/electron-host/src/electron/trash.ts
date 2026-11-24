// `shell.trashItem`: the freedesktop.org trash spec, as the desktop's file
// manager keeps it
// (https://specifications.freedesktop.org/trash-spec/latest/). An item on the
// home trash's device goes there; one on another goes to the trash at the top
// of its own device, so trashing never copies.

import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

/** The device `path` is on. */
const deviceOfPath = async (path: string) => (await lstat(path)).dev;

export type TrashDependencies = {
  /** `$XDG_DATA_HOME/Trash`. */
  readonly homeTrash: string;
  readonly uid: number;
  readonly now: () => Date;
  readonly deviceOf?: typeof deviceOfPath;
};

/** Electron's `shell.trashItem`, keeping trashed items per the spec. */
export const createTrash =
  ({ deviceOf = deviceOfPath, homeTrash, now, uid }: TrashDependencies) =>
  async (path: string) => {
    const item = resolve(path);
    const device = await deviceOf(item);
    const home = device === (await deviceOf(await existing(homeTrash)));
    const top = home ? undefined : await topOf(item, device, deviceOf);
    const trash = top === undefined ? homeTrash : await topTrash(top, uid);
    await mkdir(join(trash, "files"), { mode: 0o700, recursive: true });
    await mkdir(join(trash, "info"), { mode: 0o700, recursive: true });
    const name = await claimName(
      trash,
      basename(item),
      trashInfo(top === undefined ? item : relative(top, item), now()),
    );
    try {
      await rename(item, join(trash, "files", name));
    } catch (error) {
      // The info names an item that never came: take it back, then fail.
      await rm(join(trash, "info", `${name}.trashinfo`));
      throw error;
    }
  };

/** `path`, or the nearest directory above it that exists. */
const existing = async (path: string): Promise<string> =>
  (await stat(path).then(() => true, unlessCode("ENOENT", false)))
    ? path
    : existing(dirname(path));

/** The top directory of `device`, the mount `item` is on. */
const topOf = async (
  item: string,
  device: number,
  deviceOf: typeof deviceOfPath,
): Promise<string> => {
  const parent = dirname(item);
  return parent === item || (await deviceOf(parent)) !== device
    ? item
    : topOf(parent, device, deviceOf);
};

/**
 * The trash under `top`: the administrator's `.Trash/$uid` when `.Trash` is
 * a sticky directory, else the user's own `.Trash-$uid`.
 */
const topTrash = async (top: string, uid: number) => {
  const shared = await lstat(join(top, ".Trash")).then(
    (found) => found.isDirectory() && (found.mode & 0o1000) !== 0,
    unlessCode("ENOENT", false),
  );
  if (shared) {
    return join(top, ".Trash", String(uid));
  } else {
    const own = join(top, `.Trash-${uid}`);
    await mkdir(own, { mode: 0o700, recursive: true });
    return own;
  }
};

/**
 * Writes `info` as the trash info of a name no item in `trash` has, `base`
 * or `base.2` and on, creating it so no other trasher takes the same name.
 */
const claimName = async (
  trash: string,
  base: string,
  info: string,
  count = 1,
): Promise<string> => {
  const name = count === 1 ? base : `${base}.${count}`;
  const file = await open(join(trash, "info", `${name}.trashinfo`), "wx").catch(
    unlessCode("EEXIST", undefined),
  );
  if (file === undefined) {
    return claimName(trash, base, info, count + 1);
  } else {
    try {
      await file.writeFile(info);
    } finally {
      await file.close();
    }
    return name;
  }
};

/** The spec's trash info: where the item was, and when it was trashed. */
const trashInfo = (path: string, at: Date) =>
  [
    "[Trash Info]",
    `Path=${path.split("/").map(encodeURIComponent).join("/")}`,
    `DeletionDate=${localTime(at)}`,
    "",
  ].join("\n");

/** `at` as the spec's local `YYYY-MM-DDThh:mm:ss`. */
const localTime = (at: Date) => {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
};

/** A rejection handler answering `answer` for a `code` error, rethrowing others. */
const unlessCode =
  <T>(code: string, answer: T) =>
  (error: unknown): T => {
    if (error instanceof Error && "code" in error && error.code === code) {
      return answer;
    } else {
      throw error;
    }
  };
