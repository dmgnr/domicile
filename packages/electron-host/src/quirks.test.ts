import { describe, expect, it } from "bun:test";

import { quirksOf } from "./quirks";

describe(quirksOf, () => {
  it("names why an app known to need Node in its pages can't run on the engine", () => {
    expect(quirksOf("signal-desktop").needsOwnElectron).toBe(
      "needs Node in its pages, which Domicile's engine doesn't run yet: its pages load libsignal and ringrtc",
    );
  });

  it("knows each app inspected for phase 2 by its package name", () => {
    for (const name of [
      "signal-desktop",
      "teams-for-linux",
      "zulip",
      "@joplin/app-desktop",
    ]) {
      expect(quirksOf(name).needsOwnElectron).toStartWith("needs Node");
    }
  });

  it("hands ChatGPT back, as it refuses to start on anything but OpenAI's Owl", () => {
    expect(quirksOf("openai-codex-electron").needsOwnElectron).toBe(
      "needs OpenAI's own build of Electron, Owl, and refuses to start on any other",
    );
  });

  it("has no quirks for an app it doesn't list", () => {
    expect(quirksOf("element-desktop")).toEqual({});
  });
});
