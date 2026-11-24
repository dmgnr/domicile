import { describe, expect, it } from "bun:test";
import { PICTURE_IN_PICTURE_SHOWN_EVENT } from "@domicile-desktop/sdk/desktop/picture-in-picture";
import type { DomicilePictureInPictureVideo } from "@domicile-desktop/sdk/domicile-host";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Rect } from "../rect";
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
  source: null,
  width: 640,
  window: "7",
};

// Where window 7's page is drawn, and where its video was in it.
const PAGE = { height: 900, width: 1200, x: 200, y: 100 };
const SOURCE = new DOMRectReadOnly(100, 50, 640, 360);

/** The floats over `fake`'s desktop, with `video` listed. */
const floating = (
  video: DomicilePictureInPictureVideo = VIDEO,
  pageFor: (window: string) => Rect | undefined = (window) =>
    window === "7" ? PAGE : undefined,
) => {
  const fake = new FakeDomicileHost();
  const asked: string[] = [];
  const view = render(
    <PictureInPictureFloats
      pageFor={pageFor}
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

/** Says `container`'s video was drawn, as the engine does. */
const drawn = (container: HTMLElement): void => {
  fireEvent(shown(container), new Event(PICTURE_IN_PICTURE_SHOWN_EVENT));
};

/** The float around `container`'s video. */
const floatOf = (container: HTMLElement): HTMLElement => {
  const float = shown(container).closest<HTMLElement>(
    "[data-picture-in-picture]",
  );
  if (float === null) {
    throw new Error("test: the video has no float");
  }
  return float;
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
        pageFor={() => PAGE}
        pictureInPicture={fake.domicile.pictureInPicture}
        shown
        workspaceFor={() => WORKSPACE}
      />,
    );

    expect(container.querySelector("app")).toBeNull();
  });

  it("shows a video in the bottom-right corner of its window's screen, in its shape", () => {
    const { asked, container } = floating();
    const float = shown(container).closest<HTMLElement>(
      "[data-picture-in-picture]",
    );

    expect(shown(container).getAttribute("picture-in-picture")).toBe("1");
    expect(asked).toEqual(["7"]);
    expect(float?.style.inlineSize).toBe("480px");
    expect(float?.style.blockSize).toBe("270px");
    expect(float?.style.insetInlineStart).toBe(
      `${(1920 - 24 - 480).toString()}px`,
    );
  });

  it("takes the video's shape once the page says its size", () => {
    const { container, fake } = floating({ ...VIDEO, height: 0, width: 0 });
    act(() => {
      fake.set({ pictureInPictureVideos: [VIDEO] });
    });
    const float = shown(container).closest<HTMLElement>(
      "[data-picture-in-picture]",
    );

    expect(float?.style.inlineSize).toBe("480px");
    expect(float?.style.blockSize).toBe("270px");
    expect(float?.style.insetBlockStart).toBe(
      `${(40 + 1040 - 24 - 270).toString()}px`,
    );
  });

  it("moves with a drag, and stays on its screen", () => {
    const { container } = floating();
    const float = shown(container).closest<HTMLElement>(
      "[data-picture-in-picture]",
    );
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
        pageFor={() => PAGE}
        pictureInPicture={fake.domicile.pictureInPicture}
        shown={false}
        workspaceFor={() => WORKSPACE}
      />,
    );

    expect(container.querySelector("app")).toBeNull();
  });

  it("fades where it is when the video leaves picture-in-picture, then goes", () => {
    const { container, fake } = floating();
    act(() => {
      fake.set({ pictureInPictureVideos: [] });
    });
    const float = floatOf(container);
    expect(float.getAttribute("data-motion")).toBe("leaving");

    fireEvent.animationEnd(float);
    expect(container.querySelector("app")).toBeNull();
  });

  it("sends the page back to its tab, or closes it, at once without a page", () => {
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

  it("moves the video to where its progress bar is moved", async () => {
    const { fake } = floating({ ...VIDEO, playing: false });
    act(() => {
      screen.getByRole("slider", { name: "Position" }).focus();
    });
    await userEvent.keyboard("{ArrowRight}");

    expect(fake.calls).toContainEqual(["seekPictureInPictureVideo", "1", 103]);
  });

  it("does not move when its progress bar is pressed", () => {
    const { container } = floating({ ...VIDEO, playing: false });
    const float = shown(container).closest<HTMLElement>(
      "[data-picture-in-picture]",
    );
    fireEvent.pointerDown(screen.getByRole("slider", { name: "Position" }), {
      buttons: 1,
      clientX: 1500,
      clientY: 1000,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      buttons: 1,
      clientX: 1000,
      clientY: 500,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(float?.style.insetInlineStart).toBe(
      `${(1920 - 24 - 480).toString()}px`,
    );
  });

  it("shows no progress for a live stream", () => {
    floating({ ...VIDEO, duration: 0 });

    expect(screen.queryByText(/\//u)).toBeNull();
  });

  it("shows nothing until its video is drawn", () => {
    const { container } = floating({ ...VIDEO, source: SOURCE });

    expect(floatOf(container).getAttribute("data-motion")).toBe("waiting");
  });

  it("grows out of where the video was in its page once it is drawn", () => {
    const { container } = floating({ ...VIDEO, source: SOURCE });
    drawn(container);
    const float = floatOf(container);

    // From (300, 150), 640 wide, to its corner box at (1416, 786), 480 wide.
    expect(float?.style.getPropertyValue("--pip-x")).toBe("-1116px");
    expect(float?.style.getPropertyValue("--pip-y")).toBe("-636px");
    expect(float?.style.getPropertyValue("--pip-scale")).toBe(
      (640 / 480).toString(),
    );
    expect(float?.getAttribute("data-motion")).toBe("growing");
  });

  it("appears in place when its page is drawn nowhere", () => {
    const { container } = floating(
      { ...VIDEO, source: SOURCE },
      () => undefined,
    );
    drawn(container);
    const float = floatOf(container);

    expect(float?.style.getPropertyValue("--pip-x")).toBe("");
    expect(float?.getAttribute("data-motion")).toBeNull();
  });

  it("waits for the video's size to grow in its shape", () => {
    const { container, fake } = floating({
      ...VIDEO,
      height: 0,
      source: SOURCE,
      width: 0,
    });
    expect(container.querySelector("app")).toBeNull();

    act(() => {
      fake.set({ pictureInPictureVideos: [{ ...VIDEO, source: SOURCE }] });
    });
    drawn(container);

    expect(floatOf(container).getAttribute("data-motion")).toBe("growing");
  });

  for (const [button, action] of [
    ["Back to tab", "back-to-page"],
    ["Close", "close"],
  ] as const) {
    it(`shrinks back into its page before ${action}`, () => {
      const { container, fake } = floating({ ...VIDEO, source: SOURCE });
      drawn(container);
      const float = floatOf(container);
      fireEvent.animationEnd(float);

      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(float.getAttribute("data-motion")).toBe("returning");
      expect(fake.calls).not.toContainEqual([
        "actOnPictureInPictureVideo",
        "1",
        action,
      ]);

      fireEvent.animationEnd(float);
      expect(fake.calls).toContainEqual([
        "actOnPictureInPictureVideo",
        "1",
        action,
      ]);
    });
  }

  it("fades in its page's place once the page takes the video back", () => {
    const { container, fake } = floating({ ...VIDEO, source: SOURCE });
    drawn(container);
    const float = floatOf(container);
    fireEvent.animationEnd(float);
    fireEvent.click(screen.getByRole("button", { name: "Back to tab" }));
    fireEvent.animationEnd(float);

    act(() => {
      fake.set({ pictureInPictureVideos: [] });
    });

    expect(floatOf(container)).toBe(float);
    expect(float.getAttribute("data-motion")).toBe("leaving-page");
    expect(float.style.getPropertyValue("--pip-x")).toBe("-1116px");
  });

  it("goes back to its tab at once when its page is drawn nowhere", () => {
    const { fake } = floating({ ...VIDEO, source: SOURCE }, () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Back to tab" }));

    expect(fake.calls).toContainEqual([
      "actOnPictureInPictureVideo",
      "1",
      "back-to-page",
    ]);
  });
});
