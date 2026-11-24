import { describe, expect, it } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import type { Rect } from "../rect";
import { appWindowId } from "../window";
import { besideOf, overviewOf } from "./fixture";
import { OverviewPicker } from "./OverviewPicker";
import type { ScreenOverview } from "./overview";

const OVERVIEW = overviewOf(false);

const tileBox = (name: string): Rect => {
  const tile = OVERVIEW.tiles.find((found) => found.name === name);
  if (tile === undefined) {
    throw new Error(`test: no tile for workspace ${name}`);
  } else {
    return tile.box;
  }
};

/** The middle of workspace `name`'s tile, over its lone window. */
const overWindow = (name: string) => {
  const box = tileBox(name);
  return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
};

/** The top of workspace `name`'s tile, where the bar would be: no window. */
const overDesk = (name: string) => {
  const box = tileBox(name);
  return { clientX: box.x + 2, clientY: box.y + 2 };
};

type Picked =
  | { dismissed: true }
  | { moved: [string, string] }
  | { picked: string }
  | { pickedWindow: string };

/** The picker, keeping the aim its keys move as the desktop does. */
const Aiming = ({
  overviews = [OVERVIEW],
  picked,
}: {
  overviews?: readonly ScreenOverview[];
  picked: Picked[];
}) => {
  const [aim, setAim] = useState<string | undefined>();
  return (
    <OverviewPicker
      aim={aim}
      cards={{}}
      focused=""
      onAim={setAim}
      onDismiss={() => picked.push({ dismissed: true })}
      onMove={(id, workspace) => picked.push({ moved: [id, workspace] })}
      onPick={(workspace) => picked.push({ picked: workspace })}
      onPickWindow={(id) => picked.push({ pickedWindow: id })}
      overviews={overviews}
    />
  );
};

const picker = () => {
  const picked: Picked[] = [];
  render(<Aiming picked={picked} />);
  return picked;
};

const tile = (name: string) =>
  screen.getByRole("button", { name: `Workspace ${name}` });

describe("OverviewPicker", () => {
  it("offers each workspace, marking the one on screen, which has focus", () => {
    picker();

    expect(tile("1").getAttribute("aria-current")).toBeNull();
    expect(tile("3").getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(tile("3"));
  });

  it("goes to the window pressed, or to the workspace around it", () => {
    const picked = picker();

    fireEvent.click(tile("1"), { ...overWindow("1"), detail: 1 });
    fireEvent.click(tile("1"), { ...overDesk("1"), detail: 1 });

    expect(picked).toStrictEqual([
      { pickedWindow: appWindowId("kitty") },
      { picked: "1" },
    ]);
  });

  it("goes to the workspace chosen from the keyboard", () => {
    const picked = picker();

    fireEvent.keyDown(tile("3"), { key: "ArrowLeft" });
    fireEvent.click(document.activeElement ?? document.body, { detail: 0 });

    expect(picked).toStrictEqual([{ picked: "1" }]);
  });

  it("moves the keyboard to the workspace aimed at by the overview's own keys", () => {
    // Meta+H/J/K/L step the aim; see `steeredInOverview`.
    const props = {
      cards: {},
      focused: "",
      onAim: () => undefined,
      onDismiss: () => undefined,
      onMove: () => undefined,
      onPick: () => undefined,
      onPickWindow: () => undefined,
      overviews: [OVERVIEW],
    };
    const { rerender } = render(<OverviewPicker aim={undefined} {...props} />);
    expect(document.activeElement).toBe(tile("3"));

    rerender(<OverviewPicker aim="1" {...props} />);

    expect(document.activeElement).toBe(tile("1"));
  });

  describe("its rings", () => {
    const props = {
      focused: "",
      onAim: () => undefined,
      onDismiss: () => undefined,
      onMove: () => undefined,
      onPick: () => undefined,
      onPickWindow: () => undefined,
    };
    const ringOf = (container: HTMLElement, kind: "aim" | "shown") => {
      const found = container.querySelector<HTMLElement>(
        `[data-overview-ring="${kind}"]`,
      );
      if (found === null) {
        throw new Error(`test: no ${kind} ring`);
      } else {
        return found;
      }
    };
    // Placed with `translate`, so a swap slides them on the compositor.
    const at = (ring: HTMLElement) => ring.style.getPropertyValue("translate");
    const placeOf = (box: Rect) =>
      `${box.x.toString()}px ${box.y.toString()}px`;

    it("slide with the workspaces they ring as those swap", () => {
      // The whole tile moves, ring and all, not just what is in it.
      const { container, rerender } = render(
        <OverviewPicker aim="3" cards={{}} overviews={[OVERVIEW]} {...props} />,
      );
      const aimRing = ringOf(container, "aim");
      const shownRing = ringOf(container, "shown");
      expect(at(aimRing)).toStrictEqual(placeOf(tileBox("3")));

      // 3, shown and aimed at, swapped into 1's place.
      const swappedOne = {
        ...OVERVIEW,
        screen: { ...OVERVIEW.screen, current: "1" },
      };
      rerender(
        <OverviewPicker
          aim="1"
          cards={{ "1": "3", "3": "1" }}
          overviews={[swappedOne]}
          {...props}
        />,
      );

      expect(ringOf(container, "aim")).toBe(aimRing);
      expect(ringOf(container, "shown")).toBe(shownRing);
      expect(at(aimRing)).toStrictEqual(placeOf(tileBox("1")));
      expect(at(shownRing)).toStrictEqual(placeOf(tileBox("1")));
    });

    it("ring the workspace aimed at, whatever moved the keyboard last", () => {
      // The overview's own keys are grabbed before the page sees them, so
      // `:focus-visible` would not ring the tile they move to.
      const { container, rerender } = render(
        <OverviewPicker
          aim={undefined}
          cards={{}}
          overviews={[OVERVIEW]}
          {...props}
        />,
      );
      expect(container.querySelector('[data-overview-ring="aim"]')).toBeNull();

      rerender(
        <OverviewPicker aim="1" cards={{}} overviews={[OVERVIEW]} {...props} />,
      );

      expect(at(ringOf(container, "aim"))).toStrictEqual(placeOf(tileBox("1")));
    });

    it("keep their order as two shown workspaces swap, so neither is redrawn", () => {
      // Moving a ring in the document would cut its slide short.
      const right = besideOf(OVERVIEW);
      const { container, rerender } = render(
        <OverviewPicker
          aim="3"
          cards={{}}
          overviews={[OVERVIEW, right]}
          {...props}
        />,
      );
      const before = [
        ...container.querySelectorAll('[data-overview-ring="shown"]'),
      ];

      rerender(
        <OverviewPicker
          aim="5"
          cards={{ "3": "5", "5": "3" }}
          overviews={[OVERVIEW, right]}
          {...props}
        />,
      );

      const after = [
        ...container.querySelectorAll('[data-overview-ring="shown"]'),
      ];
      expect(after.length).toBe(before.length);
      expect(after.every((ring, index) => ring === before[index])).toBe(true);
    });

    it("jump to another workspace aimed at, with nothing swapped", () => {
      const { container, rerender } = render(
        <OverviewPicker aim="3" cards={{}} overviews={[OVERVIEW]} {...props} />,
      );
      const before = ringOf(container, "aim");

      rerender(
        <OverviewPicker aim="1" cards={{}} overviews={[OVERVIEW]} {...props} />,
      );

      expect(ringOf(container, "aim")).not.toBe(before);
      expect(at(ringOf(container, "aim"))).toStrictEqual(placeOf(tileBox("1")));
    });

    it("slide across to another monitor", () => {
      const right = besideOf(OVERVIEW);
      const fivesBox = right.tiles.find(({ name }) => name === "5")?.box;
      const { container, rerender } = render(
        <OverviewPicker
          aim="3"
          cards={{}}
          overviews={[OVERVIEW, right]}
          {...props}
        />,
      );
      const before = ringOf(container, "aim");

      rerender(
        <OverviewPicker
          aim="5"
          cards={{ "3": "5", "5": "3" }}
          overviews={[OVERVIEW, right]}
          {...props}
        />,
      );

      expect(ringOf(container, "aim")).toBe(before);
      expect(fivesBox).toBeDefined();
      if (fivesBox !== undefined) {
        expect(at(before)).toStrictEqual(placeOf(fivesBox));
      }
    });
  });

  it("moves the keyboard on to the next monitor's workspaces at the edge of its own", () => {
    const picked: Picked[] = [];
    render(
      <Aiming overviews={[OVERVIEW, besideOf(OVERVIEW)]} picked={picked} />,
    );

    fireEvent.keyDown(tile("3"), { key: "ArrowRight" });

    expect(document.activeElement).toBe(tile("5"));
  });

  it("keeps Tab among its tiles", () => {
    // The bar and the other screens are behind it.
    picker();

    fireEvent.keyDown(tile("3"), { key: "Tab" });
    expect(document.activeElement).toBe(tile("1"));
    fireEvent.keyDown(tile("1"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(tile("3"));
  });

  it("closes on Escape, or a press between the tiles", () => {
    const picked = picker();

    fireEvent.keyDown(tile("3"), { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog", { name: "Workspaces" }));

    expect(picked).toStrictEqual([{ dismissed: true }, { dismissed: true }]);
  });

  it("moves a window dragged onto another workspace, and picks nothing", () => {
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overWindow("1"));
    fireEvent.pointerMove(tile("1"), { ...overWindow("3"), buttons: 1 });
    fireEvent.pointerUp(tile("3"), overWindow("3"));
    fireEvent.click(screen.getByRole("dialog", { name: "Workspaces" }));

    expect(picked).toStrictEqual([{ moved: [appWindowId("kitty"), "3"] }]);
  });

  it("leaves a window dragged back onto its own workspace", () => {
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overWindow("1"));
    fireEvent.pointerMove(tile("1"), { ...overDesk("1"), buttons: 1 });
    fireEvent.pointerUp(tile("1"), overDesk("1"));
    fireEvent.click(tile("1"), { ...overDesk("1"), detail: 1 });

    expect(picked).toStrictEqual([]);
  });

  it("keeps a drag whose pointer a tile hands it", () => {
    // A touch's pointer starts captured by the tile it went down on, which
    // loses it as the layer takes it.
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overWindow("1"));
    fireEvent.pointerMove(tile("1"), { ...overWindow("3"), buttons: 1 });
    fireEvent.lostPointerCapture(tile("1"));
    fireEvent.pointerUp(tile("3"), overWindow("3"));

    expect(picked).toStrictEqual([{ moved: [appWindowId("kitty"), "3"] }]);
  });

  it("moves nothing on a drag with another button, and still takes the next click", () => {
    const picked = picker();

    fireEvent.pointerDown(tile("1"), { ...overWindow("1"), button: 2 });
    fireEvent.pointerMove(tile("1"), { ...overWindow("3"), buttons: 1 });
    fireEvent.pointerUp(tile("3"), overWindow("3"));
    fireEvent.click(tile("3"), { ...overDesk("3"), detail: 1 });

    expect(picked).toStrictEqual([{ picked: "3" }]);
  });

  it("stays open when a press on a tile is let go between tiles", () => {
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overDesk("1"));
    fireEvent.pointerUp(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("dialog"));

    expect(picked).toStrictEqual([]);
  });

  it("takes Enter on a tile after a touch drag, which ends with no click", () => {
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overWindow("1"));
    fireEvent.pointerMove(tile("1"), { ...overWindow("3"), buttons: 1 });
    fireEvent.pointerUp(tile("3"), overWindow("3"));
    fireEvent.click(tile("3"), { detail: 0 });

    expect(picked).toStrictEqual([
      { moved: [appWindowId("kitty"), "3"] },
      { picked: "3" },
    ]);
  });

  it("forgets a press canceled before it became a drag", () => {
    // The shell can take a touch for a gesture of its own.
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overWindow("1"));
    fireEvent.pointerCancel(tile("1"));
    fireEvent.pointerMove(tile("3"), { ...overWindow("3"), buttons: 1 });
    fireEvent.pointerUp(tile("3"), overWindow("3"));

    expect(picked).toStrictEqual([]);
  });

  it("forgets a press let go off it, once the pointer comes back", () => {
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overWindow("1"));
    fireEvent.pointerMove(tile("3"), { ...overWindow("3"), buttons: 0 });
    fireEvent.pointerUp(tile("3"), overWindow("3"));

    expect(picked).toStrictEqual([]);
  });

  it("follows only the pointer that pressed", () => {
    const picked = picker();

    fireEvent.pointerDown(tile("1"), { ...overWindow("1"), pointerId: 1 });
    fireEvent.pointerDown(tile("3"), {
      ...overWindow("3"),
      isPrimary: false,
      pointerId: 2,
    });
    fireEvent.pointerMove(tile("1"), {
      ...overWindow("3"),
      buttons: 1,
      pointerId: 1,
    });
    fireEvent.pointerUp(tile("3"), { ...overWindow("3"), pointerId: 1 });

    expect(picked).toStrictEqual([{ moved: [appWindowId("kitty"), "3"] }]);
  });

  it("drops a drag whose pointer it loses", () => {
    // The shell or the engine can take the pointer from it mid-drag.
    const picked = picker();

    fireEvent.pointerDown(tile("1"), overWindow("1"));
    fireEvent.pointerMove(tile("1"), { ...overWindow("3"), buttons: 1 });
    fireEvent.lostPointerCapture(screen.getByRole("dialog"));
    fireEvent.pointerUp(tile("3"), overWindow("3"));

    expect(picked).toStrictEqual([]);
  });
});
