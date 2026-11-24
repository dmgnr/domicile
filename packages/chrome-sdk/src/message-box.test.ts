import { describe, expect, it } from "bun:test";

import { messageBox } from "./message-box";

const written = (box: Record<string, unknown> = {}) =>
  JSON.stringify({
    buttons: ["Cancel", "Quit"],
    cancelId: 0,
    checkboxChecked: false,
    checkboxLabel: "Don't ask again",
    defaultId: 1,
    detail: "Any conversation still generating will stop.",
    message: "Quit Claude?",
    title: "Claude",
    type: "question",
    ...box,
  });

describe("messageBox", () => {
  it("reads the box the engine lists", () => {
    expect(messageBox(written())).toEqual({
      buttons: ["Cancel", "Quit"],
      cancelButton: 0,
      checkbox: "Don't ask again",
      checkboxChecked: false,
      defaultButton: 1,
      detail: "Any conversation still generating will stop.",
      kind: "question",
      message: "Quit Claude?",
      title: "Claude",
    });
  });

  it("reads no default and no checkbox as undefined", () => {
    const box = messageBox(written({ checkboxLabel: "", defaultId: -1 }));
    expect(box.defaultButton).toBeUndefined();
    expect(box.checkbox).toBeUndefined();
  });

  it("throws for a box with no buttons", () => {
    expect(() => messageBox(written({ buttons: [] }))).toThrow();
  });

  it("throws for a default past the buttons", () => {
    expect(() => messageBox(written({ defaultId: 2 }))).toThrow(RangeError);
  });

  it("throws for a cancel past the buttons", () => {
    expect(() => messageBox(written({ cancelId: 2 }))).toThrow(RangeError);
  });

  it("throws for a kind the engine does not send", () => {
    expect(() => messageBox(written({ type: "fancy" }))).toThrow();
  });
});
