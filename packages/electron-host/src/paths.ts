// The directories `app.getPath()` names, as Electron finds them on Linux.

import { join } from "node:path";

export type PathName =
  | "appData"
  | "crashDumps"
  | "desktop"
  | "documents"
  | "downloads"
  | "exe"
  | "home"
  | "logs"
  | "module"
  | "music"
  | "pictures"
  | "sessionData"
  | "temp"
  | "userData"
  | "videos";

export type PathsInput = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly home: string;
  readonly productName: string;
  readonly temp: string;
  /** The text of `$XDG_CONFIG_HOME/user-dirs.dirs`, if there is one. */
  readonly userDirs: string | undefined;
};

/** Each path `app.getPath()` answers before the app sets any. */
export const electronPaths = (
  input: PathsInput,
): Readonly<Record<PathName, string>> => {
  const appData = input.env.XDG_CONFIG_HOME ?? join(input.home, ".config");
  const userData = join(appData, input.productName);
  const folders = userFolders(input.userDirs, input.home);
  return {
    appData,
    crashDumps: join(userData, "Crashpad"),
    desktop: folders.DESKTOP ?? join(input.home, "Desktop"),
    documents: folders.DOCUMENTS ?? join(input.home, "Documents"),
    downloads: folders.DOWNLOAD ?? join(input.home, "Downloads"),
    exe: input.execPath,
    home: input.home,
    logs: join(userData, "logs"),
    module: input.execPath,
    music: folders.MUSIC ?? join(input.home, "Music"),
    pictures: folders.PICTURES ?? join(input.home, "Pictures"),
    sessionData: userData,
    temp: input.temp,
    userData,
    videos: folders.VIDEOS ?? join(input.home, "Videos"),
  };
};

/** `XDG_<NAME>_DIR="…"` lines of user-dirs.dirs, `$HOME` expanded. */
const userFolders = (
  text: string | undefined,
  home: string,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    (text ?? "")
      .split("\n")
      .map((line) => /^XDG_([A-Z]+)_DIR="(.*)"$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map(([, name = "", value = ""]) => [
        name,
        value.replace(/^\$HOME/, home),
      ]),
  );
