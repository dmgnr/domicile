import { afterEach, describe, expect, it } from "bun:test";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import {
  drawAt,
  drawPopups,
  popupLeft,
  undrawPopups,
} from "@domicile-desktop/test-support/popup-layout";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "../Button/Button";
import { ContextMenu } from "../ContextMenu/ContextMenu";
import { Popover } from "../Popover/Popover";
import { Tooltip } from "../Tooltip/Tooltip";

import { PopupBoundary } from "./PopupBoundary";

/** A window on the left of a 600px screen. */
const WINDOW = { height: 800, width: 400, x: 0, y: 0 };

/** Every popup here is drawn this wide. */
const POPUP_WIDTH = 300;

describe(PopupBoundary, () => {
  afterEach(undrawPopups);

  it("keeps a popover opened inside it within its box", async () => {
    render(
      <OnScreen>
        <PopupBoundary box={WINDOW}>
          <Popover trigger={<Button>Details</Button>}>Body</Popover>
        </PopupBoundary>
      </OnScreen>,
    );
    const trigger = screen.getByRole("button", { name: "Details" });
    drawAt(trigger, { height: 28, width: 28, x: 360, y: 0 });
    drawPopups("dialog", { height: 100, width: POPUP_WIDTH });

    await userEvent.click(trigger);

    await waitFor(() => {
      expect(popupLeft("dialog") + POPUP_WIDTH).toBeLessThanOrEqual(400);
    });
  });

  it("keeps a tooltip opened inside it within its box", async () => {
    render(
      <OnScreen>
        <PopupBoundary box={WINDOW}>
          <Tooltip content="Full title" open trigger={<Button>Tab</Button>} />
        </PopupBoundary>
      </OnScreen>,
    );
    drawAt(screen.getByRole("button", { name: "Tab" }), {
      height: 28,
      width: 28,
      x: 360,
      y: 0,
    });
    drawPopups("tooltip", { height: 30, width: POPUP_WIDTH });

    await waitFor(() => {
      expect(popupLeft("tooltip") + POPUP_WIDTH).toBeLessThanOrEqual(400);
    });
  });

  it("keeps a context menu opened inside it within its box", async () => {
    render(
      <PopupBoundary box={WINDOW}>
        <ContextMenu at={{ x: 360, y: 0 }} label="Page" open>
          <ContextMenu.Item>Reload</ContextMenu.Item>
        </ContextMenu>
      </PopupBoundary>,
    );
    drawPopups("menu", { height: 100, width: POPUP_WIDTH });

    await waitFor(() => {
      expect(popupLeft("menu") + POPUP_WIDTH).toBeLessThanOrEqual(400);
    });
  });

  it("lets a popover that spans windows reach the rest of its screen", async () => {
    render(
      <OnScreen>
        <PopupBoundary box={WINDOW}>
          <Popover spansWindows trigger={<Button>Details</Button>}>
            Body
          </Popover>
        </PopupBoundary>
      </OnScreen>,
    );
    const trigger = screen.getByRole("button", { name: "Details" });
    drawAt(trigger, { height: 28, width: 28, x: 360, y: 0 });
    drawPopups("dialog", { height: 100, width: POPUP_WIDTH });

    await userEvent.click(trigger);

    await waitFor(() => {
      expect(popupLeft("dialog") + POPUP_WIDTH).toBeGreaterThan(400);
    });
  });

  it("lets a tooltip that spans windows reach the rest of its screen", async () => {
    render(
      <OnScreen>
        <PopupBoundary box={WINDOW}>
          <Tooltip
            content="Full title"
            open
            spansWindows
            trigger={<Button>Tab</Button>}
          />
        </PopupBoundary>
      </OnScreen>,
    );
    drawAt(screen.getByRole("button", { name: "Tab" }), {
      height: 28,
      width: 28,
      x: 360,
      y: 0,
    });
    drawPopups("tooltip", { height: 30, width: POPUP_WIDTH });

    await waitFor(() => {
      expect(popupLeft("tooltip") + POPUP_WIDTH).toBeGreaterThan(400);
    });
  });
});

describe("a popup in a narrow PopupBoundary", () => {
  loadEmittedStylesheet(
    document,
    new URL("../../styled-system/styles.css", import.meta.url),
  );

  it("narrows a tooltip to the room it has", async () => {
    render(
      <Tooltip content="Full title" open trigger={<Button>Tab</Button>} />,
    );
    expectNarrowedToAvailableWidth(await screen.findByRole("tooltip"));
  });

  it("narrows a popover to the room it has", async () => {
    render(<Popover open>Body</Popover>);
    expectNarrowedToAvailableWidth(await screen.findByRole("dialog"));
  });
});

/**
 * Fails unless `popup`'s inline size is capped by the `--available-width` its
 * positioner (its parent) sets from the room its `PopupBoundary` leaves.
 */
const expectNarrowedToAvailableWidth = (popup: HTMLElement) => {
  const positioner = popup.parentElement;
  if (positioner === null) {
    throw new Error("the popup has no positioner");
  }
  const availableWidth = globalThis
    .getComputedStyle(positioner)
    .getPropertyValue("--available-width");
  expect(availableWidth).not.toBe("");
  expect(globalThis.getComputedStyle(popup).maxInlineSize).toContain(
    availableWidth,
  );
};

/** A 600px screen at the page's left edge, drawn once it mounts. */
const OnScreen = ({ children }: { children: React.ReactNode }) => (
  <div
    data-screen="DP-1"
    ref={(element) => {
      if (element !== null) {
        drawAt(element, { height: 800, width: 600, x: 0, y: 0 });
      }
    }}
  >
    {children}
  </div>
);
