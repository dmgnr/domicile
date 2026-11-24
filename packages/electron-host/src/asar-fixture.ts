// Writes asar archives for tests, in the layout `@electron/asar` packs.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A file in a fixture archive. */
export type FixtureFile = {
  readonly content: string;
  readonly executable?: boolean;
  /** Kept beside the archive in `<archive>.unpacked/`, as `asar --unpack` does. */
  readonly unpacked?: boolean;
};

/** Writes `files` (keyed by path inside the archive) as an asar at `archive`. */
export const writeAsar = async (
  archive: string,
  files: Readonly<Record<string, FixtureFile>>,
): Promise<void> => {
  const root: DirectoryEntry = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [path, file] of Object.entries(files)) {
    const data = Buffer.from(file.content);
    const entry: FileEntry = file.unpacked
      ? { size: data.length, unpacked: true }
      : { offset: String(offset), size: data.length };
    placeEntry(
      root,
      path,
      file.executable ? { ...entry, executable: true } : entry,
    );
    if (file.unpacked) {
      const target = join(`${archive}.unpacked`, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    } else {
      chunks.push(data);
      offset += data.length;
    }
  }
  await mkdir(dirname(archive), { recursive: true });
  await writeFile(archive, Buffer.concat([header(root), ...chunks]));
};

type FileEntry = {
  readonly executable?: true;
  readonly offset?: string;
  readonly size: number;
  readonly unpacked?: true;
};

type DirectoryEntry = {
  readonly files: Record<string, FileEntry | DirectoryEntry>;
};

const placeEntry = (root: DirectoryEntry, path: string, entry: FileEntry) => {
  const parts = path.split("/");
  const name = parts.pop();
  if (name === undefined) {
    throw new Error(`empty fixture path`);
  } else {
    const directory = parts.reduce<DirectoryEntry>((parent, part) => {
      const existing = parent.files[part];
      const next =
        existing !== undefined && "files" in existing
          ? existing
          : { files: {} };
      parent.files[part] = next;
      return next;
    }, root);
    directory.files[name] = entry;
  }
};

/** The size pickle and the header pickle, as Chromium's `Pickle` lays them out. */
const header = (root: DirectoryEntry): Buffer => {
  const json = Buffer.from(JSON.stringify(root));
  const padded = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle]);
};
