import { describe, expect, it } from "bun:test";
import { None, Some } from "@cprussin/option-result";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import type { Spawned } from "@domicile-desktop/system-apps/fake-desktop";
import { fakeDesktop } from "@domicile-desktop/system-apps/fake-desktop";

import { appSearch } from "./app-search";

const entry = (name: string, more = ""): string =>
  `[Desktop Entry]\nType=Application\nName=${name}\nExec=${name.toLowerCase()} %F\n${more}`;

/** A desktop whose data home is `/home`, with nothing else installed. */
const desktop = (argv: readonly string[]): Spawned => {
  expect(argv).toStrictEqual(["env", "-0"]);
  return {
    code: 0,
    stderr: "",
    stdout: "XDG_DATA_HOME=/home\0XDG_DATA_DIRS=/nowhere\0",
  };
};

/** Bookmark icons a test says are already found. */
const knownIcons = (icons: Readonly<Record<string, string>>) => {
  const asked: string[][] = [];
  return {
    asked,
    icons: {
      icon: (url: string) => {
        const icon = icons[url];
        return icon === undefined ? None<string>() : Some(icon);
      },
      lookFor: (urls: readonly string[]) => {
        asked.push([...urls]);
        return Promise.resolve();
      },
    },
  };
};

/** A config with `theme` as its icon theme, or none. */
const configured = (theme?: string) => () => Promise.resolve(theme);

describe("appSearch", () => {
  it("offers what is installed and not omitted, with its pictures", async () => {
    const system = fakeDesktop(
      {
        "/home/applications/browser.desktop": entry("Browser"),
        "/home/applications/editor.desktop": entry(
          "Editor",
          "Icon=editor\nX-Domicile-Preview=/home/editor-preview.svg\n",
        ),
        "/home/editor-preview.svg": "svg",
        "/home/icons/hicolor/48x48/apps/editor.png": "png",
      },
      desktop,
    );
    const apps = appSearch(
      system,
      { bookmarks: [], omit: ["browser.desktop"] },
      configured(),
      knownIcons({}).icons,
    );

    expect(await apps.opening()).toStrictEqual({
      apps: [
        {
          command: ["editor"],
          comment: "",
          icon: "data:image/png;base64,cG5n",
          id: "editor.desktop",
          name: "Editor",
          preview: "data:image/svg+xml;base64,c3Zn",
        },
      ],
      bookmarks: [],
    });
  });

  it("draws icons from the config's icon theme", async () => {
    const system = fakeDesktop(
      {
        "/home/applications/editor.desktop": entry("Editor", "Icon=editor\n"),
        "/home/icons/hicolor/48x48/apps/editor.png": "png",
        "/home/icons/Papirus/48x48/apps/editor.svg": "papirus",
        "/home/icons/Papirus/index.theme":
          "[Icon Theme]\nDirectories=48x48/apps\n[48x48/apps]\nSize=48\nContext=Applications\n",
      },
      desktop,
    );
    const apps = appSearch(
      system,
      { bookmarks: [], omit: [] },
      configured("Papirus"),
      knownIcons({}).icons,
    );

    expect((await apps.opening()).apps.map(({ icon }) => icon)).toStrictEqual([
      "data:image/svg+xml;base64,cGFwaXJ1cw==",
    ]);
  });

  it("matches the query against applications and bookmarks", async () => {
    const system = fakeDesktop(
      {
        "/home/applications/calculator.desktop": entry("Calculator"),
        "/home/applications/editor.desktop": entry("Editor"),
      },
      desktop,
    );
    const apps = appSearch(
      system,
      {
        bookmarks: [
          { name: "Calendar", url: "https://calendar.example" },
          { name: "Mail", url: "https://mail.example" },
        ],
        omit: [],
      },
      configured(),
      knownIcons({ "https://calendar.example": "data:calendar" }).icons,
    );

    const found = await apps.search("cal");

    expect(found.apps.map(({ name }) => name)).toStrictEqual(["Calculator"]);
    expect(found.bookmarks).toStrictEqual([
      {
        icon: "data:calendar",
        name: "Calendar",
        url: "https://calendar.example",
      },
    ]);
  });

  it("looks for every bookmark's icon on each search", async () => {
    const lookup = knownIcons({});
    const apps = appSearch(
      fakeDesktop({}, desktop),
      {
        bookmarks: [{ name: "Mail", url: "https://mail.example" }],
        omit: [],
      },
      configured(),
      lookup.icons,
    );

    await apps.search("x");

    expect(lookup.asked).toStrictEqual([["https://mail.example"]]);
  });

  it("offers a web app as an application that opens its one window, drawn with its site's icon", async () => {
    const lookup = knownIcons({ "https://sms.example/": "data:sms" });
    const apps = appSearch(
      fakeDesktop(
        { "/home/applications/editor.desktop": entry("Editor") },
        desktop,
      ),
      { bookmarks: [], omit: [] },
      configured(),
      lookup.icons,
      [{ appId: "sms", name: "SMS", url: "https://sms.example/" }],
    );

    const found = await apps.search("sm");

    expect(found.apps).toStrictEqual([
      {
        command: [
          "domicile",
          "open",
          "--app",
          "--id",
          "sms",
          "--reuse",
          "focus",
          "https://sms.example/",
        ],
        comment: "",
        icon: "data:sms",
        id: "web-app:sms",
        name: "SMS",
        preview: undefined,
      },
    ]);
    expect(lookup.asked).toStrictEqual([["https://sms.example/"]]);
  });

  it("opens a web app in the browser profile it names", async () => {
    const apps = appSearch(
      fakeDesktop({}, desktop),
      { bookmarks: [], omit: [] },
      configured(),
      knownIcons({}).icons,
      [
        {
          appId: "mail",
          name: "Mail",
          profile: "work",
          url: "https://mail.example/",
        },
      ],
    );

    const found = await apps.search("mail");

    expect(found.apps.map(({ command }) => command)).toStrictEqual([
      [
        "domicile",
        "open",
        "--app",
        "--id",
        "mail",
        "--reuse",
        "focus",
        "--profile",
        "work",
        "https://mail.example/",
      ],
    ]);
  });

  it("reads what is installed again on opening, and only then", async () => {
    const files: Record<string, string> = {
      "/home/applications/editor.desktop": entry("Editor"),
    };
    const system = fakeDesktop(files, desktop);
    const apps = appSearch(
      system,
      { bookmarks: [], omit: [] },
      configured(),
      knownIcons({}).icons,
    );
    await apps.opening();

    files["/home/applications/paint.desktop"] = entry("Paint");
    const typed = await apps.search("");
    const reopened = await apps.opening();

    expect(typed.apps.map(({ name }) => name)).toStrictEqual(["Editor"]);
    expect(reopened.apps.map(({ name }) => name)).toStrictEqual([
      "Editor",
      "Paint",
    ]);
  });

  it("fails when the desktop refuses to read", async () => {
    const apps = appSearch(
      fakeDesktop(
        { "/home/applications": { fails: SystemErrorKind.Locked } },
        desktop,
      ),
      { bookmarks: [], omit: [] },
      configured(),
      knownIcons({}).icons,
    );

    await expect(apps.opening()).rejects.toThrow(
      "could not read the installed applications: /home/applications",
    );
  });
});
