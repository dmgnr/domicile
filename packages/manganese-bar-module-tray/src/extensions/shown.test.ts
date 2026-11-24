import { describe, expect, it } from "bun:test";
import type { Extension } from "@domicile-desktop/sdk/extension";

import { popupShown } from "./shown";

const ID = "abcdefghijklmnopabcdefghijklmnop";

const extension: Extension = {
  badgeColor: "#00000000",
  badgeText: "",
  enabled: true,
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id: ID,
  name: "Blocker",
  popup: `chrome-extension://${ID}/popup.html`,
  profile: "default",
  title: "Blocker",
};

describe("popupShown", () => {
  it("is whether the one asked for is a popup the tray is drawing", () => {
    // What the keyboard follows, so it has to be what is drawn: a popup whose
    // extension was disabled or dropped while it was open is no panel at all.
    expect(popupShown([extension], ID)).toBe(true);
    expect(popupShown([extension], undefined)).toBe(false);
    expect(popupShown([], ID)).toBe(false);
    expect(popupShown([{ ...extension, enabled: false }], ID)).toBe(false);
  });

  it("draws a popup its extension asked for, though the action names none", () => {
    expect(popupShown([{ ...extension, popup: undefined }], ID)).toBe(true);
  });
});
