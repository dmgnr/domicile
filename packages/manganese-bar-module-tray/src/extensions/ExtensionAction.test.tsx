import { afterEach, describe, expect, it } from "bun:test";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type {
  Extension,
  ExtensionPopup,
} from "@domicile-desktop/sdk/extension";
import {
  WEBVIEW_CLOSE_EVENT,
  WEBVIEW_CONTENT_SIZE_CHANGE_EVENT,
  WEBVIEW_DEVICE_REQUEST_EVENT,
  WEBVIEW_DIALOG_EVENT,
  WEBVIEW_LOADING_CHANGE_EVENT,
  WEBVIEW_PERMISSION_REQUEST_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExtensionAction } from "./ExtensionAction";

const BLOCKER = "abcdefghijklmnopabcdefghijklmnop";
const COUNTER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const POPUP = `chrome-extension://${BLOCKER}/popup.html`;
/** Blocker's popup, open. */
const OPEN: ExtensionPopup = { id: BLOCKER, popup: POPUP, profile: "default" };

/** An extension whose click opens its popup. */
const blocker: Extension = {
  badgeColor: "#00000000",
  badgeText: "",
  enabled: true,
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id: BLOCKER,
  name: "Blocker",
  popup: POPUP,
  profile: "default",
  title: "Blocker: on for this site",
};

/** An extension whose click fires `action.onClicked`, with a badge set. */
const counter: Extension = {
  badgeColor: "#d93025ff",
  badgeText: "12",
  enabled: true,
  icon: "data:image/png;base64,iVBORw0KGgo=",
  id: COUNTER,
  name: "Counter",
  popup: undefined,
  profile: "default",
  title: "Counter",
};

/** A host that records every extension the tray activated, in order. */
const recordingDomicile = (activated: string[]): Domicile =>
  ({
    extensions: {
      activate: (id: string) => {
        activated.push(id);
      },
    },
  }) as unknown as Domicile;

const NO_DOMICILE = recordingDomicile([]);

// Drops the view's state a test gave every element.
afterEach(() => {
  for (const name of ["contentHeight", "contentWidth", "loading"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

/**
 * The popup's view, portaled to the body, once base-ui has positioned it (a
 * tick after mount).
 */
const popupView = (): Promise<HTMLWebViewElement> =>
  waitFor(() => {
    const view = document.querySelector("webview");
    if (view === null) {
      throw new Error("test: the popup rendered no view");
    } else {
      return view;
    }
  });

/** The action with `opened` open; resolves with the next `opened` requested. */
const trayAsking = (
  extension: Extension,
  opened: ExtensionPopup | undefined,
): Promise<ExtensionPopup | undefined> =>
  new Promise((resolve) => {
    render(
      <ExtensionAction
        domicile={NO_DOMICILE}
        extension={extension}
        onActivate={() => undefined}
        onOpen={resolve}
        opened={opened}
      />,
    );
  });

/**
 * A fake engine camera request from the popup, recording its answers. Built
 * by hand because the test DOM lacks the engine's event type.
 */
const askCamera = (view: HTMLWebViewElement, answers: string[]) => {
  fireEvent(
    view,
    Object.assign(
      new Event(WEBVIEW_PERMISSION_REQUEST_EVENT, { cancelable: true }),
      {
        allow: () => {
          answers.push("allow");
        },
        deny: () => {
          answers.push("deny");
        },
        dismiss: () => {
          answers.push("dismiss");
        },
        origin: `chrome-extension://${BLOCKER}`,
        permissions: ["camera"],
      },
    ),
  );
};

describe("ExtensionAction", () => {
  describe("rendering", () => {
    it("draws a badge in its color, and none without text", () => {
      render(
        <>
          <ExtensionAction
            domicile={NO_DOMICILE}
            extension={blocker}
            onActivate={() => undefined}
            onOpen={() => undefined}
            opened={undefined}
          />
          <ExtensionAction
            domicile={NO_DOMICILE}
            extension={counter}
            onActivate={() => undefined}
            onOpen={() => undefined}
            opened={undefined}
          />
        </>,
      );

      expect(screen.getByText("12").style.backgroundColor).toBe("#d93025ff");
      expect(
        screen.getByRole("button", { name: "Blocker: on for this site" })
          .textContent,
      ).toBe("");
    });

    it("holds the popup in a view while it is open, and nothing while not", async () => {
      const { rerender } = render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={undefined}
        />,
      );

      expect(document.querySelector("webview")).toBeNull();

      rerender(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );

      expect((await popupView()).getAttribute("src")).toBe(POPUP);
    });

    it("opens the popup in the extension's own browser profile", async () => {
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={{ ...blocker, profile: "work" }}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={{ ...OPEN, profile: "work" }}
        />,
      );

      expect((await popupView()).getAttribute("profile")).toBe("work");
    });

    it("marks the popup's view an extension popup, so its page is no tab", async () => {
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );

      expect((await popupView()).hasAttribute("extensionpopup")).toBe(true);
    });

    it("draws the popup's panel flush, with no padding framing the page", async () => {
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );

      await popupView();

      expect(screen.getByRole("dialog")).toHaveAttribute("data-flush");
    });

    it("sizes the popup's view to its content once the page says what that is", async () => {
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );
      const view = await popupView();
      const before = [view.style.inlineSize, view.style.blockSize];

      // The engine's reply, held by the element and announced by the event.
      Object.defineProperties(view, {
        contentHeight: { configurable: true, value: 170 },
        contentWidth: { configurable: true, value: 230 },
      });
      fireEvent(view, new Event(WEBVIEW_CONTENT_SIZE_CHANGE_EVENT));

      expect(before).toStrictEqual(["", ""]);
      await waitFor(() => {
        expect([view.style.inlineSize, view.style.blockSize]).toStrictEqual([
          "230px",
          "170px",
        ]);
      });
    });
    it("shows the popup only once its page has loaded and sized itself, as Chrome does", async () => {
      // A fresh view, as the engine's starts: nothing loading, no size. On the
      // prototype, because the view reads them as it mounts.
      Object.defineProperties(HTMLElement.prototype, {
        contentHeight: { configurable: true, value: 0 },
        contentWidth: { configurable: true, value: 0 },
        loading: { configurable: true, value: false },
      });
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );
      const view = await popupView();
      const panel = screen.getByRole("dialog");
      const withheld = () => panel.hasAttribute("data-withheld");
      const before = withheld();

      // The page starts loading, then sizes itself while it loads.
      Object.defineProperty(view, "loading", {
        configurable: true,
        value: true,
      });
      fireEvent(view, new Event(WEBVIEW_LOADING_CHANGE_EVENT));
      Object.defineProperties(view, {
        contentHeight: { configurable: true, value: 170 },
        contentWidth: { configurable: true, value: 230 },
      });
      fireEvent(view, new Event(WEBVIEW_CONTENT_SIZE_CHANGE_EVENT));
      await waitFor(() => {
        expect(view.style.inlineSize).toBe("230px");
      });
      const whileLoading = withheld();

      Object.defineProperty(view, "loading", {
        configurable: true,
        value: false,
      });
      fireEvent(view, new Event(WEBVIEW_LOADING_CHANGE_EVENT));

      expect([before, whileLoading]).toStrictEqual([true, true]);
      await waitFor(() => {
        expect(withheld()).toBe(false);
      });
    });
  });

  describe("a click", () => {
    it("opens the popup of an extension that has one", async () => {
      const asked = trayAsking(blocker, undefined);

      await userEvent.click(
        screen.getByRole("button", { name: "Blocker: on for this site" }),
      );

      expect(await asked).toStrictEqual(OPEN);
    });

    it("activates an extension as it opens its popup, and not as it closes it", async () => {
      // Activation mimics Chrome's toolbar click: it grants `activeTab` on the
      // focused browser window, which the popup's `scripting.executeScript`
      // needs. The engine sends no `action.onClicked` when there is a popup.
      const activated: string[] = [];
      const { rerender } = render(
        <ExtensionAction
          domicile={recordingDomicile(activated)}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={undefined}
        />,
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Blocker: on for this site" }),
      );
      rerender(
        <ExtensionAction
          domicile={recordingDomicile(activated)}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );
      await popupView();
      await userEvent.keyboard("{Escape}");

      expect(activated).toStrictEqual([BLOCKER]);
    });

    it("activates an extension that has none, and opens nothing", async () => {
      const activated: string[] = [];
      const opened: (ExtensionPopup | undefined)[] = [];
      render(
        <ExtensionAction
          domicile={recordingDomicile(activated)}
          extension={counter}
          onActivate={() => undefined}
          onOpen={(id) => {
            opened.push(id);
          }}
          opened={undefined}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Counter" }));

      expect(activated).toStrictEqual([COUNTER]);
      expect(opened).toStrictEqual([]);
    });

    it("tells its bar it was clicked, so a popup it then asks for opens there", async () => {
      let clicks = 0;
      render(
        <ExtensionAction
          domicile={recordingDomicile([])}
          extension={counter}
          onActivate={() => {
            clicks += 1;
          }}
          onOpen={() => undefined}
          opened={undefined}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Counter" }));

      expect(clicks).toBe(1);
    });
  });

  describe("a popup its extension asked for", () => {
    it("is drawn, though the action names none", async () => {
      // Phantom clears its action's popup, so a click reaches
      // `action.onClicked`, and opens the popup with `action.openPopup()`.
      const popup = `chrome-extension://${COUNTER}/popup.html`;
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={counter}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={{ id: COUNTER, popup, profile: "default" }}
        />,
      );

      expect((await popupView()).getAttribute("src")).toBe(popup);
    });
  });

  describe("closing the popup", () => {
    it("closes when the popup closes itself", async () => {
      const asked = trayAsking(blocker, OPEN);

      fireEvent(
        await popupView(),
        new Event(WEBVIEW_CLOSE_EVENT, { bubbles: true }),
      );

      expect(await asked).toBeUndefined();
    });

    it("closes on Escape", async () => {
      const asked = trayAsking(blocker, OPEN);

      await userEvent.keyboard("{Escape}");

      expect(await asked).toBeUndefined();
    });

    it("closes on a press outside it", async () => {
      const asked = trayAsking(blocker, OPEN);

      await userEvent.click(document.body);

      expect(await asked).toBeUndefined();
    });

    it("closes when a click lands in a page outside it", async () => {
      const page = document.createElement("webview");
      document.body.append(page);
      const asked = trayAsking(blocker, OPEN);
      await popupView();

      fireEvent.focusIn(page);

      expect(await asked).toBeUndefined();
      page.remove();
    });

    it("stays open when a click lands in its own popup", async () => {
      let asked: ExtensionPopup | undefined | null = null;
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={(id) => {
            asked = id;
          }}
          opened={OPEN}
        />,
      );

      fireEvent.focusIn(await popupView());

      expect(asked).toBeNull();
    });
  });

  describe("a permission request from the popup", () => {
    it("asks in the panel, naming the extension", async () => {
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );

      askCamera(await popupView(), []);

      expect(await screen.findByText("Blocker")).toBeInTheDocument();
      expect(screen.getByText("Camera")).toBeInTheDocument();
    });

    it("answers it, and stops asking", async () => {
      const answers: string[] = [];
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );
      askCamera(await popupView(), answers);

      await userEvent.click(
        await screen.findByRole("button", { name: "Allow" }),
      );

      expect(answers).toStrictEqual(["allow"]);
      expect(screen.queryByRole("region", { name: "Request" })).toBeNull();
    });
  });

  // A wallet's popup asks for its hardware wallet.
  describe("a device request from the popup", () => {
    it("connects the device picked above it", async () => {
      const answers: string[] = [];
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );
      fireEvent(
        await popupView(),
        Object.assign(
          new Event(WEBVIEW_DEVICE_REQUEST_EVENT, { cancelable: true }),
          {
            cancel: () => undefined,
            choose: (ids: readonly number[]) => {
              answers.push(`choose ${ids.join(",")}`);
            },
            devices: () => [{ id: 1, name: "Nano X" }],
            listed: true,
            multiple: false,
            title: "Blocker wants to connect to a HID device",
          },
        ),
      );

      await userEvent.click(
        await screen.findByRole("radio", { name: "Nano X" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Connect" }));

      expect(answers).toStrictEqual(["choose 1"]);
    });
  });

  // A password manager's popup confirms a delete.
  describe("a dialog from the popup", () => {
    it("is answered over it, naming the extension", async () => {
      const answers: string[] = [];
      render(
        <ExtensionAction
          domicile={NO_DOMICILE}
          extension={blocker}
          onActivate={() => undefined}
          onOpen={() => undefined}
          opened={OPEN}
        />,
      );
      fireEvent(
        await popupView(),
        Object.assign(new Event(WEBVIEW_DIALOG_EVENT, { cancelable: true }), {
          accept: () => undefined,
          defaultValue: "",
          dialogType: "confirm",
          dismiss: () => {
            answers.push("dismiss");
          },
          message: "Delete this item?",
          origin: "chrome-extension://blocker",
        }),
      );

      await userEvent.click(
        within(
          await screen.findByRole("alertdialog", { name: "Blocker says" }),
        ).getByRole("button", { name: "Cancel" }),
      );

      expect(answers).toStrictEqual(["dismiss"]);
    });
  });
});
