import { describe, expect, it } from "bun:test";

import type { ShowMessageBoxMessage } from "./message-boxes";
import { boxFor, createMessageBoxes } from "./message-boxes";

describe("boxFor", () => {
  it("passes the app's box on as the engine takes it", () => {
    expect(
      boxFor(3, 7, {
        buttons: ["Cancel", "Quit"],
        cancelId: 0,
        checkboxChecked: true,
        checkboxLabel: "Don't ask again",
        defaultId: 1,
        detail: "Any conversation still generating will stop.",
        message: "Quit Claude?",
        title: "Claude",
        type: "question",
      }),
    ).toEqual({
      box: 7,
      box_type: "question",
      buttons: ["Cancel", "Quit"],
      cancel_id: 0,
      checkbox_checked: true,
      checkbox_label: "Don't ask again",
      default_id: 1,
      detail: "Any conversation still generating will stop.",
      message: "Quit Claude?",
      title: "Claude",
      type: "show_message_box",
      window: 3,
    });
  });

  it("gives a box with no buttons one OK, which Enter presses", () => {
    const box = boxFor(1, 1, { message: "Saved" });

    expect([box.buttons, box.default_id, box.cancel_id]).toEqual([
      ["OK"],
      0,
      0,
    ]);
    expect(box.box_type).toBe("none");
  });

  it("finds the cancel button as Electron does when the app names none", () => {
    expect(
      boxFor(1, 1, { buttons: ["Save", "Don't Save", "&Cancel"], message: "" })
        .cancel_id,
    ).toBe(2);
    expect(
      boxFor(1, 1, { buttons: ["Yes", "No"], message: "" }).cancel_id,
    ).toBe(1);
    expect(
      boxFor(1, 1, { buttons: ["Retry", "Give Up"], message: "" }).cancel_id,
    ).toBe(0);
  });

  it("ignores a default or cancel past the buttons, as Electron does", () => {
    const box = boxFor(1, 1, {
      buttons: ["OK", "Cancel"],
      cancelId: 5,
      defaultId: 2,
      message: "",
    });

    expect([box.default_id, box.cancel_id]).toEqual([-1, 1]);
  });

  it("throws for more buttons than the engine takes", () => {
    expect(() =>
      boxFor(1, 1, {
        buttons: Array.from({ length: 17 }, (_, index) => index.toString()),
        message: "",
      }),
    ).toThrow("at most 16 buttons");
  });
});

describe("createMessageBoxes", () => {
  it("resolves each box with its own answer", async () => {
    const sent: ShowMessageBoxMessage[] = [];
    const boxes = createMessageBoxes((message) => sent.push(message));

    const first = boxes.ask(3, { message: "First?" });
    const second = boxes.ask(3, { message: "Second?" });
    boxes.hear({
      box: sent[1]?.box ?? 0,
      checkbox_checked: false,
      response: 0,
      type: "message_box_answered",
      window: 3,
    });
    boxes.hear({
      box: sent[0]?.box ?? 0,
      checkbox_checked: true,
      response: 1,
      type: "message_box_answered",
      window: 3,
    });

    expect(await first).toEqual({ checkboxChecked: true, response: 1 });
    expect(await second).toEqual({ checkboxChecked: false, response: 0 });
    expect(sent.map(({ message }) => message)).toEqual(["First?", "Second?"]);
  });

  it("rejects a box the engine can't take, sending nothing", async () => {
    const sent: ShowMessageBoxMessage[] = [];
    const boxes = createMessageBoxes((message) => sent.push(message));

    await expect(
      boxes.ask(3, { buttons: Array(17).fill("x"), message: "" }),
    ).rejects.toThrow("at most 16 buttons");
    expect(sent).toEqual([]);
  });

  it("throws for an answer to a box nothing asked", () => {
    const boxes = createMessageBoxes(() => undefined);

    expect(() => {
      boxes.hear({
        box: 9,
        checkbox_checked: false,
        response: 0,
        type: "message_box_answered",
        window: 3,
      });
    }).toThrow("which nothing asked");
  });
});

describe("boxWindow", () => {
  const window = (id: number, open: boolean, destroyed = false) => ({
    id,
    isDestroyed: () => destroyed,
    isOpen: () => open,
  });

  it("goes over the window named, else the latest with a page, else none", async () => {
    const { boxWindow } = await import("./message-boxes");
    const windows = (...all: ReturnType<typeof window>[]) => ({
      getAllWindows: () => all,
    });

    expect(
      boxWindow({ id: 1 }, windows(window(1, true), window(2, true))),
    ).toBe(1);
    expect(
      boxWindow({ id: 3 }, windows(window(2, true), window(3, false))),
    ).toBe(2);
    expect(
      boxWindow(undefined, windows(window(2, true), window(3, true, true))),
    ).toBe(2);
    expect(boxWindow({ id: 1 }, windows(window(1, false)))).toBeUndefined();
    expect(() => boxWindow({}, windows())).toThrow(TypeError);
  });
});
