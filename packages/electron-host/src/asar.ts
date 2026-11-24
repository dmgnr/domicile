// Extracts an Electron asar archive to a directory, unpacked files included.

import { chmod, copyFile, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import { z } from "zod";

/**
 * Writes every file in `archive` under `destination`. Files the archive marks
 * unpacked are copied from `<archive>.unpacked/`, where Electron keeps them.
 */
export const extractAsar = async (
  archive: string,
  destination: string,
): Promise<Result<string, string>> => {
  const handle = await open(archive, "r");
  try {
    const header = await readHeader(handle, archive);
    return await header.mapAsync(async ({ dataOffset, root }) => {
      await writeDirectory(handle, dataOffset, root, archive, "", destination);
      return destination;
    });
  } finally {
    await handle.close();
  }
};

type FileHandle = Awaited<ReturnType<typeof open>>;

type FileEntry = {
  readonly executable?: boolean | undefined;
  readonly offset?: string | undefined;
  readonly size: number;
  readonly unpacked?: boolean | undefined;
};

type DirectoryEntry = {
  readonly files: Readonly<Record<string, FileEntry | DirectoryEntry>>;
};

const fileEntry = z.object({
  executable: z.boolean().optional(),
  integrity: z.unknown().optional(),
  offset: z.string().optional(),
  size: z.number(),
  unpacked: z.boolean().optional(),
});

const directoryEntry: z.ZodType<DirectoryEntry> = z.lazy(() =>
  z.object({
    files: z.record(z.string(), z.union([directoryEntry, fileEntry])),
    unpacked: z.boolean().optional(),
  }),
);

/**
 * The archive's file tree and where file data starts. The archive opens with
 * two Chromium pickles: one holding the header pickle's size, then the header
 * pickle, whose payload is the tree as a JSON string.
 */
const readHeader = async (
  handle: FileHandle,
  archive: string,
): Promise<Result<{ root: DirectoryEntry; dataOffset: number }, string>> => {
  const sizePickle = await readAt(handle, 0, 8);
  const headerSize = sizePickle.length === 8 ? sizePickle.readUInt32LE(4) : 0;
  const isSizePickle =
    sizePickle.length === 8 && sizePickle.readUInt32LE(0) === 4;
  const headerPickle = isSizePickle
    ? await readAt(handle, 8, headerSize)
    : Buffer.alloc(0);
  const json =
    headerPickle.length >= 8 && headerPickle.length === headerSize
      ? headerPickle
          .subarray(8, 8 + headerPickle.readInt32LE(4))
          .toString("utf8")
      : "";
  const tree = directoryEntry.safeParse(parseJson(json));
  return tree.success
    ? Ok({ dataOffset: 8 + headerSize, root: tree.data })
    : Err(`${archive} is not an asar archive`);
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    } else {
      throw error;
    }
  }
};

const writeDirectory = async (
  handle: FileHandle,
  dataOffset: number,
  directory: DirectoryEntry,
  archive: string,
  path: string,
  destination: string,
): Promise<void> => {
  await mkdir(join(destination, path), { recursive: true });
  for (const [name, entry] of Object.entries(directory.files)) {
    const child = join(path, name);
    if ("files" in entry) {
      await writeDirectory(
        handle,
        dataOffset,
        entry,
        archive,
        child,
        destination,
      );
    } else {
      await writeFileEntry(
        handle,
        dataOffset,
        entry,
        archive,
        child,
        destination,
      );
    }
  }
};

const writeFileEntry = async (
  handle: FileHandle,
  dataOffset: number,
  entry: FileEntry,
  archive: string,
  path: string,
  destination: string,
) => {
  const target = join(destination, path);
  const mode = entry.executable === true ? 0o755 : 0o644;
  if (entry.unpacked === true) {
    try {
      await copyFile(join(`${archive}.unpacked`, path), target);
    } catch (error) {
      // A package may prune what it doesn't need from the unpacked files
      // (nixpkgs drops other platforms' prebuilt modules from ChatGPT's),
      // leaving the header naming them. Electron fails only a read of one,
      // so the mirror leaves it out and the read fails the same way.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  } else if (entry.offset === undefined) {
    throw new Error(`${archive}: ${path} has no offset and is not unpacked`);
  } else {
    await writeFile(
      target,
      await readAt(handle, dataOffset + Number(entry.offset), entry.size),
    );
  }
  await chmod(target, mode);
};

const readAt = async (handle: FileHandle, position: number, length: number) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};
