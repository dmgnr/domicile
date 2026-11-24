import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { desktop } from "./desktop";

const VIDEO = {
  canNextTrack: false,
  canPlay: true,
  canPreviousTrack: false,
  duration: 270,
  height: 360,
  id: "1",
  playbackRate: 1,
  playing: true,
  position: 102,
  source: null,
  width: 640,
  window: "window-1",
};

describe("pictureInPicture", () => {
  it("lists no videos until the browser says", () => {
    const { pictureInPicture } = desktop(new FakeDomicileHost().host);

    expect(pictureInPicture.videos).toEqual([]);
  });

  it("lists the videos, and says when they change", () => {
    const fake = new FakeDomicileHost();
    const { pictureInPicture } = desktop(fake.host);
    const heard: unknown[] = [];
    pictureInPicture.on("change", () => {
      heard.push(pictureInPicture.videos);
    });
    fake.set({ pictureInPictureVideos: [VIDEO] });

    expect(heard).toEqual([[VIDEO]]);
  });

  it("acts on a video, seeks it and says how big it is shown", () => {
    const fake = new FakeDomicileHost();
    const { pictureInPicture } = desktop(fake.host);
    pictureInPicture.act("1", "back-to-page");
    pictureInPicture.seek("1", 42.5);
    pictureInPicture.resize("1", 320, 180);

    expect(fake.calls).toStrictEqual([
      ["actOnPictureInPictureVideo", "1", "back-to-page"],
      ["seekPictureInPictureVideo", "1", 42.5],
      ["resizePictureInPictureVideo", "1", 320, 180],
    ]);
  });
});
