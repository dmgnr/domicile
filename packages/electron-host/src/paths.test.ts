import { describe, expect, it } from "bun:test";

import { electronPaths } from "./paths";

const home = "/home/me";

describe(electronPaths, () => {
  it("puts the app's data in the config home, under its product name", () => {
    const paths = electronPaths({
      env: {},
      execPath: "/usr/libexec/domicile/bun",
      home,
      productName: "Claude",
      temp: "/tmp",
      userDirs: undefined,
    });

    expect(paths).toMatchObject({
      appData: "/home/me/.config",
      crashDumps: "/home/me/.config/Claude/Crashpad",
      exe: "/usr/libexec/domicile/bun",
      home,
      logs: "/home/me/.config/Claude/logs",
      sessionData: "/home/me/.config/Claude",
      temp: "/tmp",
      userData: "/home/me/.config/Claude",
    });
  });

  it("follows XDG_CONFIG_HOME", () => {
    const paths = electronPaths({
      env: { XDG_CONFIG_HOME: "/data/config" },
      execPath: "/bin/bun",
      home,
      productName: "Claude",
      temp: "/tmp",
      userDirs: undefined,
    });

    expect(paths.userData).toBe("/data/config/Claude");
  });

  it("reads the user's folders from user-dirs.dirs, with the usual names when it says nothing", () => {
    const paths = electronPaths({
      env: {},
      execPath: "/bin/bun",
      home,
      productName: "Claude",
      temp: "/tmp",
      userDirs: `# written by xdg-user-dirs-update\nXDG_DOWNLOAD_DIR="$HOME/Incoming"\nXDG_MUSIC_DIR="/srv/music"\n`,
    });

    expect(paths).toMatchObject({
      desktop: "/home/me/Desktop",
      documents: "/home/me/Documents",
      downloads: "/home/me/Incoming",
      music: "/srv/music",
      pictures: "/home/me/Pictures",
      videos: "/home/me/Videos",
    });
  });
});
