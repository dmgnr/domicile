import { describe, expect, it } from "bun:test";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { Extension } from "@domicile-desktop/sdk/extension";
import type { TrayItem } from "@domicile-desktop/sdk/tray";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { Tray } from "./Tray";

/** An application's icon. */
const sync: TrayItem = {
  bus: ":1.9",
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id: "syncthing",
  itemIsMenu: false,
  menu: undefined,
  title: "Syncthing",
};

/** An extension's action with no popup, so a click is one call. */
const counter: Extension = {
  badgeColor: "#00000000",
  badgeText: "",
  enabled: true,
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id: "ponmlkjihgfedcbaponmlkjihgfedcba",
  name: "Counter",
  popup: undefined,
  profile: "default",
  title: "Counter",
};

/** An extension action disabled with `action.disable()`. */
const off: Extension = {
  ...counter,
  enabled: false,
  id: "x".repeat(32),
  title: "Off",
};

const SYNC = `status-notifier:${sync.id}`;
const COUNTER = `extension:${counter.id}`;

/** A host that records every click the tray forwards, in order. */
const recordingDomicile = (clicked: string[]): Domicile =>
  ({
    extensions: {
      activate: (id: string) => {
        clicked.push(id);
      },
    },
    tray: {
      activate: (id: string) => {
        clicked.push(id);
      },
    },
  }) as unknown as Domicile;

type Move = [readonly string[], string, string];

type TrayProps = {
  domicile?: Domicile;
  end?: ReactNode;
  onUnpin?: (key: string) => void;
  opened?: { id: string; popup: string; profile: string } | undefined;
  unpinned?: ReadonlySet<string>;
  extensions?: readonly Extension[];
  items?: readonly TrayItem[];
  onMove?: (shown: readonly string[], dragged: string, target: string) => void;
  order?: readonly string[];
};

const renderTray = ({
  domicile = recordingDomicile([]),
  end = <button type="button">All tray icons</button>,
  extensions = [counter],
  items = [sync],
  onMove = () => undefined,
  onUnpin = () => undefined,
  opened = undefined,
  order = [],
  unpinned = new Set(),
}: TrayProps) =>
  render(
    <Tray
      domicile={domicile}
      end={end}
      extensions={extensions}
      items={items}
      onActivate={() => undefined}
      onMove={onMove}
      onOpen={() => undefined}
      onUnpin={onUnpin}
      opened={opened}
      order={order}
      unpinned={unpinned}
    />,
  );

const labels = () =>
  screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));

const button = (name: string) => screen.getByRole("button", { name });

/** Press on `from` and move the pointer over `to`. */
const drag = (from: string, to: string) => {
  fireEvent.pointerDown(button(from), { button: 0, pointerId: 1 });
  fireEvent.pointerOver(button(to), { pointerId: 1 });
};

describe("Tray", () => {
  describe("rendering", () => {
    it("draws applications' icons and enabled extensions' actions in one row", () => {
      // Applications first, in arrival order, until the user reorders.
      renderTray({ extensions: [counter, off] });

      expect(labels()).toStrictEqual(["Syncthing", "Counter", null]);
    });

    it("leaves out unpinned icons", () => {
      renderTray({ unpinned: new Set([SYNC, COUNTER]) });

      expect(labels()).toStrictEqual([null]);
    });

    it("shows an unpinned extension while its popup is open", () => {
      renderTray({
        opened: {
          id: counter.id,
          popup: "chrome-extension://x/popup.html",
          profile: "default",
        },
        unpinned: new Set([COUNTER]),
      });

      expect(labels()).toStrictEqual(["Syncthing", "Counter", null]);
    });

    it("draws them in the order the user put them in", () => {
      renderTray({ order: [COUNTER, SYNC] });

      expect(labels()).toStrictEqual(["Counter", "Syncthing", null]);
    });

    it("follows the lists as they change", () => {
      const { rerender } = renderTray({});

      rerender(
        <Tray
          domicile={recordingDomicile([])}
          extensions={[]}
          items={[{ ...sync, title: "Syncthing (paused)" }]}
          onActivate={() => undefined}
          onMove={() => undefined}
          onOpen={() => undefined}
          opened={undefined}
          order={[]}
        />,
      );

      expect(labels()).toStrictEqual(["Syncthing (paused)"]);
    });

    it("keeps an application's place when it retitles its icon", () => {
      // For example, an unread count or the connected network.
      renderTray({
        items: [{ ...sync, title: "Syncthing (paused)" }],
        order: [SYNC, COUNTER],
      });

      expect(labels()).toStrictEqual(["Syncthing (paused)", "Counter", null]);
    });

    it("leaves no picture for the engine to drag instead", () => {
      // A native `<img>` drag would cancel the pointer events the reorder uses.
      const { container } = renderTray({});

      // Decorative images have no role to query by.
      expect(
        [...container.querySelectorAll("img")].map((image) =>
          image.getAttribute("draggable"),
        ),
      ).toStrictEqual(["false", "false"]);
    });
  });

  describe("a drag", () => {
    it("moves the pressed icon to the one the pointer is over", async () => {
      const moved = new Promise<Move>((resolve) => {
        renderTray({
          onMove: (shown, dragged, target) => {
            resolve([shown, dragged, target]);
          },
        });
      });

      drag("Syncthing", "Counter");

      expect(await moved).toStrictEqual([[SYNC, COUNTER], SYNC, COUNTER]);
    });

    it("moves nothing once let go, or when pressed with another button", () => {
      const moves: Move[] = [];
      renderTray({
        onMove: (shown, dragged, target) => {
          moves.push([shown, dragged, target]);
        },
      });

      fireEvent.pointerDown(button("Syncthing"), { button: 0, pointerId: 1 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      fireEvent.pointerOver(button("Counter"), { pointerId: 1 });
      fireEvent.pointerDown(button("Syncthing"), { button: 2, pointerId: 1 });
      fireEvent.pointerOver(button("Counter"), { pointerId: 1 });

      expect(moves).toStrictEqual([]);
    });

    it("unpins the icon dropped on the menu's button", () => {
      const unpinned: string[] = [];
      renderTray({ onUnpin: (key) => unpinned.push(key) });

      drag("Syncthing", "All tray icons");
      fireEvent.pointerUp(button("All tray icons"), { pointerId: 1 });

      expect(unpinned).toStrictEqual([SYNC]);
    });

    it("is not a click, and the next press is", () => {
      const clicked: string[] = [];
      renderTray({ domicile: recordingDomicile(clicked) });

      drag("Counter", "Syncthing");
      fireEvent.pointerUp(window, { pointerId: 1 });
      fireEvent.click(button("Counter"));
      fireEvent.pointerDown(button("Counter"), { button: 0, pointerId: 1 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      fireEvent.click(button("Counter"));

      expect(clicked).toStrictEqual([counter.id]);
    });

    it("leaves the menu's button working after a drag", () => {
      const pressed: string[] = [];
      renderTray({
        end: (
          <button onClick={() => pressed.push("menu")} type="button">
            All tray icons
          </button>
        ),
      });

      drag("Counter", "Syncthing");
      fireEvent.pointerUp(window, { pointerId: 1 });
      fireEvent.click(button("Counter"));
      fireEvent.pointerDown(button("All tray icons"), {
        button: 0,
        pointerId: 1,
      });
      fireEvent.pointerUp(window, { pointerId: 1 });
      fireEvent.click(button("All tray icons"));

      expect(pressed).toStrictEqual(["menu"]);
    });
  });
});
