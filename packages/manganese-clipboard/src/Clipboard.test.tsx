import { describe, expect, it } from "bun:test";
import {
  OnOneScreen,
  SCREEN,
} from "@domicile-desktop/manganese-window-management/screens/fixture";
import type { ClipboardEntry } from "@domicile-desktop/sdk/desktop/clipboard";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Clipboard } from "./Clipboard";

/** An earlier copy's text, with no picture. */
const text = (id: number, preview: string): ClipboardEntry => ({
  current: false,
  id,
  image: false,
  preview,
  thumbnail: undefined,
});

/** What is on the clipboard. */
const current = (id: number, preview: string): ClipboardEntry => ({
  ...text(id, preview),
  current: true,
});

const HISTORY = [
  current(3, "https://example.invalid/a/long/address"),
  text(2, "Thanks, see you\nTuesday"),
  text(1, "the first thing copied"),
];

/** The panel open over that history, recording copy and remove requests. */
const clipboard = (entries = HISTORY) => {
  const copied: number[] = [];
  const dismissed: true[] = [];
  const removed: number[] = [];
  render(
    <Clipboard
      entries={entries}
      onCopy={(entry) => {
        copied.push(entry);
      }}
      onDismiss={() => {
        dismissed.push(true);
      }}
      onRemove={(entry) => {
        removed.push(entry);
      }}
      open
      screen={SCREEN}
    />,
    { wrapper: OnOneScreen },
  );
  return { copied, dismissed, removed, user: userEvent.setup() };
};

/** Each row's text, without what is hidden from screen readers. */
const rows = () =>
  screen.getAllByRole("option").map((row) => {
    const shown = row.cloneNode(true);
    if (shown instanceof HTMLElement) {
      for (const hidden of shown.querySelectorAll("[aria-hidden]")) {
        hidden.remove();
      }
      return shown.textContent;
    } else {
      throw new Error("test: a row is not an element");
    }
  });

describe("Clipboard", () => {
  it("shows nothing at all while it is shut", () => {
    render(
      <Clipboard
        entries={HISTORY}
        onCopy={() => undefined}
        onDismiss={() => undefined}
        onRemove={() => undefined}
        open={false}
        screen={SCREEN}
      />,
      { wrapper: OnOneScreen },
    );

    expect(screen.queryByRole("option")).toBeNull();
  });

  describe("rows", () => {
    it("shows the newest copy in its own group, as what is on the clipboard", () => {
      // Choosing it would change nothing, so it is not a row.
      clipboard();

      const now = screen.getByRole("group", { name: "On your clipboard" });
      expect(now.textContent).toContain(
        "https://example.invalid/a/long/address",
      );
    });

    it("lists the earlier copies newest first, keeping their line breaks", () => {
      // Kept in the compositor's order; the panel does not sort.
      clipboard();

      expect(rows()).toStrictEqual([
        "Thanks, see you\nTuesday",
        "the first thing copied",
      ]);
    });

    it("shows a copied image's thumbnail", () => {
      const thumbnail = "data:image/png;base64,iVBORw0KGgo=";
      clipboard([
        current(5, "newer"),
        {
          current: false,
          id: 4,
          image: true,
          preview: "Image, 3 × 2",
          thumbnail,
        },
      ]);

      const row = screen.getByRole("option", { name: /^Image, 3 × 2/ });
      expect(row.querySelector("img")?.getAttribute("src")).toBe(thumbnail);
    });

    it("counts the copies", () => {
      clipboard();

      expect(screen.getByText("2 copied before")).toBeDefined();
    });

    it("lists every copy as a row when nothing is on the clipboard", () => {
      // After the current copy was removed.
      clipboard([text(2, "kept"), text(1, "older")]);

      expect(
        screen.queryByRole("group", { name: "On your clipboard" }),
      ).toBeNull();
      expect(rows()).toStrictEqual(["kept", "older"]);
    });

    it("says a desktop nothing was copied on is empty", () => {
      // Usual right after the desktop starts, since the history does not
      // survive a restart. There is nothing to search, so no box.
      clipboard([]);

      expect(screen.getByText("Nothing copied yet")).toBeDefined();
      expect(screen.queryByRole("combobox")).toBeNull();
    });
  });

  describe("keyboard", () => {
    it("starts on the copy before the current one", async () => {
      // Enter alone swaps back.
      const panel = clipboard();

      await panel.user.keyboard("{Enter}");

      expect(panel.copied).toStrictEqual([2]);
      expect(panel.dismissed).toStrictEqual([true]);
    });

    it("has nothing to choose with only the current copy", async () => {
      const panel = clipboard([current(7, "alone")]);

      await panel.user.keyboard("{Enter}");

      expect(panel.copied).toStrictEqual([]);
      expect(screen.queryByRole("option")).toBeNull();
    });

    it("copies the row the arrows walked to", async () => {
      const panel = clipboard();

      await panel.user.keyboard("{ArrowDown}{Enter}");

      expect(panel.copied).toStrictEqual([1]);
    });

    it("copies the row Page Down walked to", async () => {
      const panel = clipboard();

      await panel.user.keyboard("{PageDown}{Enter}");

      expect(panel.copied).toStrictEqual([1]);
    });

    it("narrows to the copies holding every typed word, and takes the first", async () => {
      const panel = clipboard();

      await panel.user.keyboard("tues THANKS");

      // The current copy is not searched, so its group goes.
      expect(rows()).toStrictEqual(["Thanks, see you\nTuesday"]);
      expect(
        screen.queryByRole("group", { name: "On your clipboard" }),
      ).toBeNull();
      expect(screen.getByText("1 matched")).toBeDefined();
      await panel.user.keyboard("{Enter}");
      expect(panel.copied).toStrictEqual([2]);
    });

    it("says when nothing matches", async () => {
      const panel = clipboard();

      await panel.user.keyboard("zebra");

      expect(screen.queryByRole("option")).toBeNull();
      expect(screen.getByText("Nothing copied matches")).toBeDefined();
    });
  });

  describe("removing", () => {
    it("removes the highlighted row with its button, and keeps the panel open", async () => {
      const panel = clipboard();

      await panel.user.click(
        within(
          screen.getByRole("option", { name: /^Thanks, see you/ }),
        ).getByText("Remove"),
      );

      expect(panel.removed).toStrictEqual([2]);
      expect(panel.copied).toStrictEqual([]);
      expect(panel.dismissed).toStrictEqual([]);
    });

    it("shows Remove on the highlighted row only", async () => {
      const panel = clipboard();

      await panel.user.keyboard("{ArrowDown}");

      expect(
        within(
          screen.getByRole("option", { name: /^the first thing copied/ }),
        ).getByText("Remove"),
      ).toBeDefined();
      expect(
        within(
          screen.getByRole("option", { name: /^Thanks, see you/ }),
        ).queryByText("Remove"),
      ).toBeNull();
    });

    it("removes what is on the clipboard with its button", async () => {
      const panel = clipboard();

      await panel.user.click(
        within(
          screen.getByRole("group", { name: "On your clipboard" }),
        ).getByRole("button", { name: "Remove" }),
      );

      expect(panel.removed).toStrictEqual([3]);
      expect(panel.copied).toStrictEqual([]);
    });

    it("removes the highlighted row with Delete", async () => {
      const panel = clipboard();

      await panel.user.keyboard("{ArrowDown}{Delete}");

      expect(panel.removed).toStrictEqual([1]);
    });

    it("leaves Delete to the box when there is text after the cursor", async () => {
      const panel = clipboard();

      await panel.user.keyboard("see{ArrowLeft}{Delete}");

      expect(panel.removed).toStrictEqual([]);
      expect(screen.getByRole("combobox")).toHaveProperty("value", "se");
    });

    it("removes the highlighted row with Delete at the end of a search", async () => {
      const panel = clipboard();

      await panel.user.keyboard("first{Delete}");

      expect(panel.removed).toStrictEqual([1]);
    });
  });

  it("keeps its rows while it closes, though the history moves", () => {
    // Choosing an earlier copy moves it to the top while the panel fades.
    const props = {
      onCopy: () => undefined,
      onDismiss: () => undefined,
      onRemove: () => undefined,
      screen: SCREEN,
    };
    const { rerender } = render(
      <Clipboard {...props} entries={HISTORY} open />,
      { wrapper: OnOneScreen },
    );
    const [newest, middle, first] = HISTORY;
    if (newest === undefined || middle === undefined || first === undefined) {
      throw new Error("test: history too short");
    }

    rerender(
      <Clipboard {...props} entries={[first, newest, middle]} open={false} />,
    );

    expect(rows()).toStrictEqual([
      "Thanks, see you\nTuesday",
      "the first thing copied",
    ]);
  });

  it("copies the row that was clicked, and closes behind it", async () => {
    // Choosing closes the panel so the user can paste.
    const panel = clipboard();

    await panel.user.click(
      screen.getByRole("option", { name: "the first thing copied" }),
    );

    expect(panel.copied).toStrictEqual([1]);
    expect(panel.dismissed).toStrictEqual([true]);
  });
});
