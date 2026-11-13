import { describe, expect, it } from "bun:test";
import type { DomicilePictureInPictureVideo } from "@domicile-desktop/sdk/domicile-host";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { PictureInPictureFloats } from "./PictureInPictureFloats";

const WORKSPACE = { height: 1040, width: 1920, x: 0, y: 40 };

const VIDEO: DomicilePictureInPictureVideo = {
  canNextTrack: false,
  canPlay: true,
  canPreviousTrack: false,
  duration: 270,
  height: 360,
  id: "1",
  playbackRate: 1,
  playing: true,
  position: 102,
  width: 640,
  window: "7",
};

/** The floats over `fake`'s desktop, with `video` listed. */
const floating = (video: DomicilePictureInPictureVideo = VIDEO) => {
  const fake = new FakeDomicileHost();
  const asked: string[] = [];
  const view = render(
    <PictureInPictureFloats
      pictureInPicture={fake.domicile.pictureInPicture}
      shown
      workspaceFor={(window) => {
        asked.push(window);
        return WORKSPACE;
      }}
    />,
  );
  act(() => {
    fake.set({ pictureInPictureVideos: [video] });
  });
  return { asked, fake, ...view };
};

const shown = (container: HTMLElement): Element => {
  const app = container.querySelector("app[picture-in-picture]");
  if (app === null) {
    throw new Error("test: no video is shown");
  }
  return app;
};

describe("PictureInPictureFloats", () => {
  it("shows nothing before a video is listed", () => {
    const fake = new FakeDomicileHost();
    const { container } = render(
      <PictureInPictureFloats
        pictureInPicture={fake.domicile.pictureInPicture}
        shown
        workspaceFor={() => WORKSPACE}
      />,
    );

    expect(container.querySelector("app")).toBeNull();
  });

  it("shows a video in the bottom-right corner of its window's screen, in its shape", () => {
    const { asked, container } = floating();
    const float = shown(container).parentElement;

    expect(shown(container).getAttribute("picture-in-picture")).toBe("1");
    expect(asked).toEqual(["7"]);
    expect(float?.style.inlineSize).toBe("480px");
    expect(float?.style.blockSize).toBe("270px");
    expect(float?.style.insetInlineStart).toBe(
      `${(1920 - 24 - 480).toString()}px`,
    );
  });

  it("moves with a drag, and stays on its screen", () => {
    const { container } = floating();
    const float = shown(container).parentElement;
    const controls = shown(container).nextElementSibling;
    if (float === null || !(controls instanceof HTMLElement)) {
      throw new Error("test: the float has no controls");
    }
    Object.assign(controls, {
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
      setPointerCapture: () => undefined,
    });
    fireEvent.pointerDown(controls, {
      buttons: 1,
      clientX: 1500,
      clientY: 900,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 1000,
      clientY: 5000,
      pointerId: 1,
    });
    // Ends the drag, so its listeners on `window` do not outlive the test.
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(float.style.insetInlineStart).toBe(
      `${(1920 - 24 - 480 - 500).toString()}px`,
    );
    expect(float.style.insetBlockStart).toBe(`${(1080 - 270).toString()}px`);
  });

  it("tells the page how big its video is shown", () => {
    const { fake } = floating();

    expect(fake.calls).toContainEqual([
      "resizePictureInPictureVideo",
      "1",
      480,
      270,
    ]);
  });

  it("shows nothing while hidden, such as on the lock screen", () => {
    const fake = new FakeDomicileHost();
    fake.set({ pictureInPictureVideos: [VIDEO] });
    const { container } = render(
      <PictureInPictureFloats
        pictureInPicture={fake.domicile.pictureInPicture}
        shown={false}
        workspaceFor={() => WORKSPACE}
      />,
    );

    expect(container.querySelector("app")).toBeNull();
  });

  it("goes when the video leaves picture-in-picture", () => {
    const { container, fake } = floating();
    act(() => {
      fake.set({ pictureInPictureVideos: [] });
    });

    expect(container.querySelector("app")).toBeNull();
  });

  it("sends the page back to its tab, or closes it", () => {
    const { fake } = floating();
    fireEvent.click(screen.getByRole("button", { name: "Back to tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(fake.calls).toContainEqual([
      "actOnPictureInPictureVideo",
      "1",
      "back-to-page",
    ]);
    expect(fake.calls).toContainEqual([
      "actOnPictureInPictureVideo",
      "1",
      "close",
    ]);
  });

  it("pauses a playing video and plays a paused one", () => {
    const { fake } = floating();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => {
      fake.set({ pictureInPictureVideos: [{ ...VIDEO, playing: false }] });
    });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));

    expect(fake.calls).toContainEqual([
      "actOnPictureInPictureVideo",
      "1",
      "pause",
    ]);
    expect(fake.calls).toContainEqual([
      "actOnPictureInPictureVideo",
      "1",
      "play",
    ]);
  });

  it("offers the tracks only when the site does", () => {
    floating();

    expect(screen.queryByRole("button", { name: "Previous track" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next track" })).toBeNull();
  });

  it("skips tracks the site offers", () => {
    const { fake } = floating({
      ...VIDEO,
      canNextTrack: true,
      canPreviousTrack: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Previous track" }));
    fireEvent.click(screen.getByRole("button", { name: "Next track" }));

    expect(fake.calls).toContainEqual([
      "actOnPictureInPictureVideo",
      "1",
      "previous-track",
    ]);
    expect(fake.calls).toContainEqual([
      "actOnPictureInPictureVideo",
      "1",
      "next-track",
    ]);
  });

  it("shows how far the video is", () => {
    floating({ ...VIDEO, playing: false });

    expect(screen.getByText("1:42 / 4:30")).toBeDefined();
  });

  it("shows no progress for a live stream", () => {
    floating({ ...VIDEO, duration: 0 });

    expect(screen.queryByText(/\//u)).toBeNull();
  });
});
