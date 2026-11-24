import { describe, expect, it } from "bun:test";

import type { ChooserAnswer, ChooserMethod, ChooserOptions } from "./dialog";
import { createDialog, openOptions, saveOptions } from "./dialog";
import type { MessageBoxOptions } from "./message-boxes";

const bytes = (path: string) => [...Buffer.from(`${path}\0`)];

/** `/home/me/Documents` is a folder; anything else isn't. */
const isDirectory = (path: string) => path === "/home/me/Documents";

/** A dialog module whose portal answers `answer`, writing down each call. */
const setUp = (answer: ChooserAnswer) => {
  const asked: [ChooserMethod, string, ChooserOptions][] = [];
  const printed: string[] = [];
  const boxes: [unknown, MessageBoxOptions][] = [];
  const dialog = createDialog({
    askMessageBox: (window, options) => {
      boxes.push([window, options]);
      return Promise.resolve({ checkboxChecked: true, response: 1 });
    },
    choose: (...call) => {
      asked.push(call);
      return Promise.resolve(answer);
    },
    chooseSync: (...call) => {
      asked.push(call);
      return answer;
    },
    isDirectory,
    printError: (text) => printed.push(text),
  });
  return { asked, boxes, dialog, printed };
};

describe("openOptions", () => {
  it("asks for one file by default", () => {
    expect(openOptions({}, isDirectory)).toEqual({
      directory: ["b", false],
      multiple: ["b", false],
    });
  });

  it("turns Electron's properties, label and filters into the portal's", () => {
    expect(
      openOptions(
        {
          buttonLabel: "Attach",
          filters: [
            { extensions: ["png", "jpg"], name: "Images" },
            { extensions: ["*"], name: "All Files" },
          ],
          properties: ["openDirectory", "multiSelections"],
        },
        isDirectory,
      ),
    ).toEqual({
      accept_label: ["s", "Attach"],
      directory: ["b", true],
      filters: [
        "a(sa(us))",
        [
          [
            "Images",
            [
              [0, "*.png"],
              [0, "*.jpg"],
            ],
          ],
          ["All Files", [[0, "*"]]],
        ],
      ],
      multiple: ["b", true],
    });
  });

  it("starts in the default path's folder, or the folder it names", () => {
    expect(
      openOptions({ defaultPath: "/home/me/Documents" }, isDirectory)
        .current_folder,
    ).toEqual(["ay", bytes("/home/me/Documents")]);
    expect(
      openOptions({ defaultPath: "/home/me/notes.txt" }, isDirectory)
        .current_folder,
    ).toEqual(["ay", bytes("/home/me")]);
  });
});

describe("saveOptions", () => {
  it("splits a default path into the folder and the name", () => {
    expect(
      saveOptions({ defaultPath: "/home/me/notes.txt" }, isDirectory),
    ).toEqual({
      current_folder: ["ay", bytes("/home/me")],
      current_name: ["s", "notes.txt"],
    });
  });

  it("takes a bare name as the name, and a folder as the folder", () => {
    expect(saveOptions({ defaultPath: "notes.txt" }, isDirectory)).toEqual({
      current_name: ["s", "notes.txt"],
    });
    expect(
      saveOptions({ defaultPath: "/home/me/Documents" }, isDirectory),
    ).toEqual({ current_folder: ["ay", bytes("/home/me/Documents")] });
  });
});

describe("dialog", () => {
  it("answers an open dialog with the paths chosen", async () => {
    const { asked, dialog } = setUp({
      response: 0,
      uris: ["file:///home/me/a%20b.png", "file:///home/me/c.png"],
    });

    expect(await dialog.showOpenDialog({ title: "Attach" })).toEqual({
      canceled: false,
      filePaths: ["/home/me/a b.png", "/home/me/c.png"],
    });
    expect(asked[0]?.slice(0, 2)).toEqual(["OpenFile", "Attach"]);
  });

  it("takes the window first, as Electron does", async () => {
    const { asked, dialog } = setUp({ response: 0, uris: [] });

    await dialog.showOpenDialog({ id: 1 }, { title: "Attach" });
    await dialog.showSaveDialog({ id: 1 }, {});

    expect(asked.map(([method, title]) => [method, title])).toEqual([
      ["OpenFile", "Attach"],
      ["SaveFile", "Save"],
    ]);
  });

  it("says when the user canceled", async () => {
    const { dialog } = setUp({ response: 1, uris: [] });

    expect(await dialog.showOpenDialog({})).toEqual({
      canceled: true,
      filePaths: [],
    });
    expect(await dialog.showSaveDialog({})).toEqual({
      canceled: true,
      filePath: "",
    });
    expect(dialog.showOpenDialogSync({})).toBeUndefined();
    expect(dialog.showSaveDialogSync({})).toBeUndefined();
  });

  it("answers a save dialog with the path chosen", async () => {
    const { dialog } = setUp({
      response: 0,
      uris: ["file:///home/me/notes.txt"],
    });

    expect(await dialog.showSaveDialog({ defaultPath: "notes.txt" })).toEqual({
      canceled: false,
      filePath: "/home/me/notes.txt",
    });
    expect(dialog.showSaveDialogSync({})).toBe("/home/me/notes.txt");
    expect(dialog.showOpenDialogSync({})).toEqual(["/home/me/notes.txt"]);
  });

  it("writes an error box out", () => {
    const { dialog, printed } = setUp({ response: 1, uris: [] });

    dialog.showErrorBox("Oops", "It broke");
    expect(printed).toEqual(["Oops\nIt broke"]);
  });

  it("asks a message box over the window named, or none", async () => {
    const { boxes, dialog } = setUp({ response: 1, uris: [] });
    const window = { id: 3 };

    expect(await dialog.showMessageBox(window, { message: "Quit?" })).toEqual({
      checkboxChecked: true,
      response: 1,
    });
    await dialog.showMessageBox({ message: "Hi" });

    expect(boxes).toEqual([
      [window, { message: "Quit?" }],
      [undefined, { message: "Hi" }],
    ]);
  });

  it("refuses a message box it would have to block for, naming why", () => {
    const { dialog } = setUp({ response: 1, uris: [] });

    expect(() => dialog.showMessageBoxSync({ message: "Hi" })).toThrow(
      "use dialog.showMessageBox",
    );
  });
});
