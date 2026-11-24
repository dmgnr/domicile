import { describe, expect, it } from "bun:test";

import { desktopCapturer } from "./desktop-capturer";

describe("desktopCapturer.getSources", () => {
  it("gives one screen source the desktop's picker stands for", async () => {
    const sources = await desktopCapturer.getSources({
      thumbnailSize: { height: 150, width: 150 },
      types: ["window", "screen"],
    });

    expect(sources).toHaveLength(1);
    const [source] = sources;
    expect(source?.id).toBe("screen:0:0");
    expect(source?.name).toBe("Screen or window");
    expect(source?.thumbnail.isEmpty()).toBe(true);
    expect(source?.appIcon).toBeNull();
    expect(source?.display_id).toBe("");
  });

  it("gives a window source when only windows are asked for", async () => {
    const [source] = await desktopCapturer.getSources({ types: ["window"] });

    expect(source?.id).toBe("window:0:0");
    expect(source?.name).toBe("Window");
  });

  it("rejects a call with no types, as Electron does", async () => {
    await expect(desktopCapturer.getSources({ types: [] })).rejects.toThrow(
      "takes `types`",
    );
  });
});
