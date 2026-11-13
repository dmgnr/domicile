import { describe, expect, it } from "bun:test";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import {
  WEBVIEW_CONTEXT_MENU_EVENT,
  WEBVIEW_DEVICE_REQUEST_EVENT,
  WEBVIEW_DIALOG_EVENT,
  WEBVIEW_EXTERNAL_APP_EVENT,
  WEBVIEW_FILE_CHOOSER_EVENT,
  WEBVIEW_FIND_CHANGE_EVENT,
  WEBVIEW_FOCUS_REQUEST_EVENT,
  WEBVIEW_GUEST_FOCUS_EVENT,
  WEBVIEW_GUEST_KEYDOWN_EVENT,
  WEBVIEW_HISTORY_CHANGE_EVENT,
  WEBVIEW_IDENTITY_EVENT,
  WEBVIEW_LOAD_PROGRESS_CHANGE_EVENT,
  WEBVIEW_LOADING_CHANGE_EVENT,
  WEBVIEW_PAGE_CHANGE_EVENT,
  WEBVIEW_PAGE_FAILURE_CHANGE_EVENT,
  WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT,
  WEBVIEW_PERMISSION_REQUEST_EVENT,
  WEBVIEW_PROMPT_EVENT,
  WEBVIEW_SIGN_IN_EVENT,
  WEBVIEW_SITE_PERMISSIONS_CHANGE_EVENT,
  WEBVIEW_TARGET_URL_CHANGE_EVENT,
  WEBVIEW_ZOOM_CHANGE_EVENT,
  WEBVIEW_ZOOM_OUT_REQUEST_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import { fakeDesktop } from "@domicile-desktop/system-apps/fake-desktop";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { css } from "../styled-system/css";
import { BrowserWindow } from "./BrowserWindow";
import { CROSSING } from "./placement";
import { recordedSettles } from "./recorded-settles";

/** A desktop whose system calls these tests never answer. */
const fakeDesk = new FakeDomicileHost().domicile;

const silentDomicile: Domicile = {
  ...fakeDesk,
  windows: {
    ...fakeDesk.windows,
    focus: () => undefined,
    focusShell: () => undefined,
  },
};

/** Records the window's host calls, in order. */
const recordingDomicile = (calls: string[]): Domicile => ({
  ...silentDomicile,
  windows: {
    ...silentDomicile.windows,
    focusShell: () => {
      calls.push("focusShell");
    },
  },
});

const view = (container: HTMLElement): HTMLWebViewElement => {
  const element = container.querySelector("webview");
  if (element === null) {
    throw new Error("test: the browser window rendered no view");
  } else {
    return element;
  }
};

const address = (): HTMLInputElement =>
  screen.getByRole("combobox", { name: "Address" });

const browser = (): HTMLElement =>
  screen.getByRole("region", { name: "Browser" });

const control = (name: string): HTMLElement =>
  screen.getByRole("button", { name });

/**
 * Fires a history change with the given back/forward availability.
 *
 * Uses `defineProperties` because the properties are readonly on the real
 * element.
 */
const historyReaches = (
  element: HTMLWebViewElement,
  canGoBack: boolean,
  canGoForward: boolean,
): void => {
  Object.defineProperties(element, {
    canGoBack: { configurable: true, value: canGoBack },
    canGoForward: { configurable: true, value: canGoForward },
  });
  fireEvent(element, new Event(WEBVIEW_HISTORY_CHANGE_EVENT));
};

/** Fires a loading change with the given state. */
const loads = (element: HTMLWebViewElement, loading: boolean): void => {
  Object.defineProperty(element, "loading", {
    configurable: true,
    value: loading,
  });
  fireEvent(element, new Event(WEBVIEW_LOADING_CHANGE_EVENT));
};

/** Fires a load progress change with the given progress. */
const progresses = (element: HTMLWebViewElement, progress: number): void => {
  Object.defineProperty(element, "loadProgress", {
    configurable: true,
    value: progress,
  });
  fireEvent(element, new Event(WEBVIEW_LOAD_PROGRESS_CHANGE_EVENT));
};

/**
 * Fires a file chooser request, recording each answer in `answers`. Cancelable
 * because taking it calls `preventDefault()`.
 */
const asksForAFile = (element: HTMLWebViewElement, answers: string[]): void => {
  fireEvent(
    element,
    Object.assign(new Event(WEBVIEW_FILE_CHOOSER_EVENT, { cancelable: true }), {
      accept: [],
      cancel: () => {
        answers.push("cancel");
      },
      choose: (paths: readonly string[]) => {
        answers.push(`choose ${paths.join(",")}`);
      },
      home: "/home/someone",
      mode: "open",
      suggestedName: "",
    }),
  );
};

/** The file picker's input. */
const pickerBox = (): HTMLElement =>
  screen.getByRole("combobox", { name: "Filter or go to a path" });

/**
 * Fires a page change with the given URL and security state.
 *
 * Uses `defineProperties` because both are readonly on the real element.
 */
const shows = (
  element: HTMLWebViewElement,
  url: string,
  security: string,
): void => {
  Object.defineProperties(element, {
    security: { configurable: true, value: security },
    url: { configurable: true, value: url },
  });
  fireEvent(element, new Event(WEBVIEW_PAGE_CHANGE_EVENT));
};

/** Fires a change of the link under the pointer. */
const hovers = (element: HTMLWebViewElement, url: string): void => {
  Object.defineProperty(element, "targetUrl", {
    configurable: true,
    value: url,
  });
  fireEvent(element, new Event(WEBVIEW_TARGET_URL_CHANGE_EVENT));
};

/**
 * Makes `setZoom` behave like the engine's: it sets `zoom` and fires a zoom
 * change. Returns every requested factor, in order.
 */
const zoomable = (element: HTMLWebViewElement, factor: number): number[] => {
  const asked: number[] = [];
  const answer = (next: number) => {
    Object.defineProperty(element, "zoom", { configurable: true, value: next });
    fireEvent(element, new Event(WEBVIEW_ZOOM_CHANGE_EVENT));
  };
  element.setZoom = (next: number) => {
    asked.push(next);
    answer(next);
  };
  answer(factor);
  return asked;
};

/** Fires a chord the guest page did not handle, as the engine forwards it. */
const guestPresses = (
  element: HTMLWebViewElement,
  init: KeyboardEventInit,
): void => {
  fireEvent(
    element,
    new KeyboardEvent(WEBVIEW_GUEST_KEYDOWN_EVENT, { bubbles: true, ...init }),
  );
};

/**
 * Records `find` and `stopFinding` calls, in order. Starts with no matches, as
 * the engine's element does.
 */
const findable = (element: HTMLWebViewElement): string[] => {
  const calls: string[] = [];
  finds(element, 0, 0);
  element.find = (text: string, backward = false) => {
    calls.push(backward ? `find ${text} backward` : `find ${text}`);
  };
  element.stopFinding = () => {
    calls.push("stop");
  };
  return calls;
};

/**
 * Fires a find result. Uses `defineProperties` because both are readonly on
 * the real element.
 */
const finds = (
  element: HTMLWebViewElement,
  matches: number,
  activeMatch: number,
): void => {
  Object.defineProperties(element, {
    findActiveMatch: { configurable: true, value: activeMatch },
    findMatches: { configurable: true, value: matches },
  });
  fireEvent(element, new Event(WEBVIEW_FIND_CHANGE_EVENT));
};

/** The find bar's input. */
const findBox = (): HTMLElement =>
  screen.getByRole("searchbox", { name: "Find in page" });

/**
 * Fires the engine's context menu event on `element` with what was under the
 * click. Returns the actions the window runs on it, in order.
 */
const asksForAMenu = (
  element: HTMLWebViewElement,
  under: Partial<DomicileContextMenuEvent>,
  ran: string[] = [],
): string[] => {
  fireEvent(
    element,
    Object.assign(new Event(WEBVIEW_CONTEXT_MENU_EVENT), {
      canCopy: false,
      canCut: false,
      canDelete: false,
      canPaste: false,
      canRedo: false,
      canSelectAll: false,
      canUndo: false,
      hasImageContents: false,
      isEditable: false,
      linkText: "",
      linkUrl: "",
      mediaType: "none",
      run: (action: string) => {
        ran.push(action);
      },
      selectionText: "",
      srcUrl: "",
      x: 10,
      y: 20,
      ...under,
    }),
  );
  return ran;
};

/**
 * Adds the package's stylesheet for the tests of the enclosing `describe`.
 *
 * Only tests that read a style take it. With it, role queries and `userEvent`
 * resolve each element's style against all of it, which is slow.
 */
const usesStylesheet = () => {
  loadEmittedStylesheet(
    document,
    new URL("../styled-system/styles.css", import.meta.url),
  );
};

/** An arbitrary on-screen box. */
const ON_SCREEN = { height: 800, width: 1200, x: 0, y: 32 };

/** The box spanning title bar and contents. */
const FRAME = { height: 830, width: 1200, x: 0, y: 2 };

/** Drops the page description; `usePageDescription` has its own tests. */
const noDescription = () => undefined;

/** Drops the page icon; `usePageIcon`'s cases are in `Shell.test.tsx`. */
const noIcon = () => undefined;

/** Drops the page's fullscreen; `usePageFullscreen` has its own tests. */
const noFullscreen = () => undefined;

const nothingEnded = () => {
  // No test here needs the callback.
};

describe("BrowserWindow", () => {
  describe("its corners", () => {
    usesStylesheet();

    it("rounds its bottom corners, and clips the page to them", () => {
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const style = globalThis.getComputedStyle(browser());

      expect(style.borderEndStartRadius).not.toBe("");
      expect(style.borderEndEndRadius).not.toBe("");
      // A radius clips the view only if overflow is hidden.
      expect(style.overflow).toBe("hidden");
    });

    it("squares its corners and drops its edge while it fills the screen", () => {
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const style = globalThis.getComputedStyle(browser());

      expect(style.borderEndStartRadius).toBe("");
      expect(style.borderEndEndRadius).toBe("");
      // No edge at the screen border.
      expect(style.borderTopWidth).not.toBe("1px");
    });
  });

  it("leaves its frame the resting color even while it is focused", () => {
    // Focus is shown by a glow around the window (see `FocusGlow`), not a
    // border.
    render(
      <BrowserWindow
        behindPanel={false}
        clickThrough={false}
        covered={false}
        depth={0}
        domicile={silentDomicile}
        dragging={false}
        focused
        frame={FRAME}
        fullscreen={false}
        motion="resting"
        onDescription={noDescription}
        onFocusRequest={() => undefined}
        onIcon={noIcon}
        onMotionEnded={nothingEnded}
        onPageFullscreen={noFullscreen}
        onReach={() => undefined}
        rect={ON_SCREEN}
        resizing={false}
        url="https://example.com"
        window="1"
      />,
    );

    expect(browser().className).toContain(css({ borderColor: "borderStrong" }));
  });

  // The view names the engine's listed browser window and sends no address:
  // the page is already loaded and outlives this shell. The bar shows the
  // listed address until the view reports one.
  it("shows the browser window it is given, at the address it is at", () => {
    const { container } = render(
      <BrowserWindow
        behindPanel={false}
        clickThrough={false}
        covered={false}
        depth={0}
        domicile={silentDomicile}
        dragging={false}
        focused
        frame={FRAME}
        fullscreen={false}
        motion="resting"
        onDescription={noDescription}
        onFocusRequest={() => undefined}
        onIcon={noIcon}
        onMotionEnded={nothingEnded}
        onPageFullscreen={noFullscreen}
        onReach={() => undefined}
        rect={ON_SCREEN}
        resizing={false}
        url="https://example.com"
        window="1"
      />,
    );
    expect(view(container).getAttribute("window")).toBe("1");
    expect(view(container).hasAttribute("src")).toBe(false);
    expect(address()).toHaveValue("https://example.com");
  });

  describe("the address bar", () => {
    it("sends the view to what was typed, filling in a missing scheme", async () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      await userEvent.clear(address());
      await userEvent.type(address(), "docs.example.com{Enter}");
      expect(view(container).getAttribute("src")).toBe(
        "https://docs.example.com",
      );
    });

    // A video's fullscreen button: the page fills the window, as in Chrome.
    it("hides while its page is fullscreen, and comes back after", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const fullscreens = (fullscreen: boolean) => {
        Object.defineProperty(view(container), "pageFullscreen", {
          configurable: true,
          value: fullscreen,
        });
        fireEvent(
          view(container),
          new Event(WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT),
        );
      };

      fullscreens(true);
      expect(
        screen.queryByRole("combobox", { name: "Address" }),
      ).not.toBeInTheDocument();

      fullscreens(false);
      expect(address()).toBeInTheDocument();
    });

    // The address bar shows the page's actual URL.
    it("shows where the page went rather than where it was sent", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      expect(address()).toHaveValue("https://example.com");

      shows(view(container), "https://elsewhere.example/landing", "warning");

      expect(address()).toHaveValue("https://elsewhere.example/landing");
    });

    // The lock reflects the browser's security state, not the URL scheme. A
    // `https` URL can still have a bad certificate or mixed content.
    it("draws the browser's verdict on the page, not a guess from its scheme", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      // No page committed yet, so the security state is unknown.
      expect(control("Connection is not known")).toBeVisible();

      shows(view(container), "https://expired.example.com", "dangerous");

      expect(control("Connection is not private")).toBeVisible();
    });
  });

  // An extension's popup window, such as Bitwarden's "Unlock" from its autofill
  // menu (`chrome.windows.create`). The engine lists it with its
  // `chrome.windows` id.
  describe("an extension's popup window", () => {
    const POPUP = "chrome-extension://vault/popup/index.html?uilocation=popout";
    const windowProps = {
      behindPanel: false,
      clickThrough: false,
      covered: false,
      depth: 0,
      domicile: silentDomicile,
      dragging: false,
      focused: true,
      frame: FRAME,
      fullscreen: false,
      motion: "resting",
      onDescription: noDescription,
      onFocusRequest: () => undefined,
      onIcon: noIcon,
      onMotionEnded: nothingEnded,
      onPageFullscreen: noFullscreen,
      onReach: () => undefined,
      rect: ON_SCREEN,
      resizing: false,
    } as const;

    // The engine reads the `window` attribute once when the view is inserted.
    // A recreated view would be refused and leave the window empty.
    it("is that window, in one view however often it is re-rendered", () => {
      const { container, rerender } = render(
        <BrowserWindow
          {...windowProps}
          popupWindow={7}
          url={POPUP}
          window="1"
        />,
      );
      const first = view(container);
      rerender(
        <BrowserWindow
          {...windowProps}
          focused={false}
          popupWindow={7}
          url={POPUP}
          window="1"
        />,
      );

      expect(first.getAttribute("window")).toBe("1");
      expect(view(container)).toBe(first);
    });

    // As in Chrome, an extension's window shows only its page.
    it("draws no address bar", () => {
      render(
        <BrowserWindow
          {...windowProps}
          popupWindow={7}
          url={POPUP}
          window="1"
        />,
      );

      expect(
        screen.queryByRole("combobox", { name: "Address" }),
      ).not.toBeInTheDocument();
    });
  });

  // `domicile open --app`. See docs/architecture/WEB-APPS.md.
  describe("an app window", () => {
    const renderApp = (url: string, fullscreen = false) =>
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={fullscreen}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url={url}
          window="1"
        />,
      );

    // With no address bar, the popup hangs from the page's corner.
    it("says what it zoomed to", async () => {
      const { container } = renderApp("https://music.example/");
      zoomable(view(container), 1);
      hovers(view(container), "");

      guestPresses(view(container), { ctrlKey: true, key: "+" });
      expect(await screen.findByRole("dialog")).toHaveTextContent("110%");
    });

    it("draws no address while its page is on the app's origin", () => {
      const { container } = renderApp("https://music.example/");

      shows(view(container), "https://music.example/album/7", "secure");

      expect(
        screen.queryByRole("status", { name: "Address" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("combobox", { name: "Address" }),
      ).not.toBeInTheDocument();
    });

    // As Chrome does for an installed app, so a sign-in page elsewhere says
    // where it is.
    it("shows the site, read-only, once its page leaves the app's origin", () => {
      const { container } = renderApp("https://music.example/");

      shows(view(container), "https://login.example/sign-in", "secure");

      expect(screen.getByRole("status", { name: "Address" })).toHaveTextContent(
        "login.example",
      );
      expect(control("Connection is secure")).toBeVisible();
      expect(
        screen.queryByRole("combobox", { name: "Address" }),
      ).not.toBeInTheDocument();
    });

    it("hides the address while its page is fullscreen", () => {
      const { container } = renderApp("https://music.example/", true);
      shows(view(container), "https://video.example/watch", "secure");

      Object.defineProperty(view(container), "pageFullscreen", {
        configurable: true,
        value: true,
      });
      fireEvent(
        view(container),
        new Event(WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT),
      );

      expect(
        screen.queryByRole("status", { name: "Address" }),
      ).not.toBeInTheDocument();
    });

    // The engine lists the page's current address, so the origin is the one
    // the window opened at.
    it("keeps the origin it opened at as the engine lists the page elsewhere", () => {
      const { container, rerender } = renderApp("https://music.example/");
      shows(view(container), "https://login.example/sign-in", "secure");

      rerender(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://login.example/sign-in"
          window="1"
        />,
      );

      expect(
        screen.getByRole("status", { name: "Address" }),
      ).toBeInTheDocument();
    });
  });

  // The engine draws no file dialog and cancels unanswered requests, so the
  // window draws a picker over the page and gives it the keyboard.
  describe("a file its page asks for", () => {
    const windowProps = {
      behindPanel: false,
      clickThrough: false,
      covered: false,
      depth: 0,
      domicile: silentDomicile,
      dragging: false,
      // One file in the home directory is enough for these tests.
      folders: () => ({
        create: () => {
          throw new Error("unexpected create");
        },
        list: () => Promise.resolve(["notes.txt"]),
        userFolders: () => Promise.resolve([]),
        watch: () => () => undefined,
      }),
      frame: FRAME,
      fullscreen: false,
      motion: "resting",
      onDescription: noDescription,
      onFocusRequest: () => undefined,
      onIcon: noIcon,
      onMotionEnded: nothingEnded,
      onPageFullscreen: noFullscreen,
      onReach: () => undefined,
      rect: ON_SCREEN,
      resizing: false,
      url: "https://example.com",
      window: "1",
    } as const;

    // While resizing, the engine shows each box without waiting for the page.
    it("marks its page while the user resizes it", () => {
      const { container, rerender } = render(
        <BrowserWindow {...windowProps} focused resizing />,
      );
      expect(view(container).hasAttribute("resizing")).toBe(true);

      rerender(<BrowserWindow {...windowProps} focused resizing={false} />);
      expect(view(container).hasAttribute("resizing")).toBe(false);
    });

    // A window on another workspace was not drawn, so a heavy page can take
    // frames to draw again as the switch slides it in. The desk must not
    // wait for it.
    it("marks its page while it slides in", () => {
      const { container } = render(
        <BrowserWindow {...windowProps} focused motion="arriving-from-start" />,
      );
      expect(view(container).hasAttribute("resizing")).toBe(true);
    });

    it("answers the page with what is picked, and puts the picker away", async () => {
      const answers: string[] = [];
      const { container } = render(<BrowserWindow {...windowProps} focused />);
      asksForAFile(view(container), answers);

      await userEvent.dblClick(
        await screen.findByRole("option", { name: "notes.txt" }),
      );

      expect(answers).toStrictEqual(["choose /home/someone/notes.txt"]);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("puts the keyboard in the picker rather than the page", async () => {
      const { container } = render(<BrowserWindow {...windowProps} focused />);

      asksForAFile(view(container), []);
      await screen.findByRole("option", { name: "notes.txt" });

      expect(pickerBox()).toHaveFocus();
    });

    // Focusing the picker is not a user reach.
    it("says nothing when it puts the keyboard in its picker", async () => {
      const reaches: string[] = [];
      const { container } = render(
        <BrowserWindow
          {...windowProps}
          focused
          onReach={() => {
            reaches.push("reach");
          }}
        />,
      );

      asksForAFile(view(container), []);
      await screen.findByRole("option", { name: "notes.txt" });

      expect(reaches).toStrictEqual([]);
    });

    // While the picker is open, refocusing the window focuses the picker, not
    // the page.
    it("hands the keyboard back to the picker when the window is reached again", async () => {
      const { container, rerender } = render(
        <BrowserWindow {...windowProps} focused />,
      );
      asksForAFile(view(container), []);
      await screen.findByRole("option", { name: "notes.txt" });

      rerender(<BrowserWindow {...windowProps} focused={false} />);
      expect(pickerBox()).not.toHaveFocus();
      rerender(<BrowserWindow {...windowProps} focused />);

      expect(pickerBox()).toHaveFocus();
    });

    // The PDF viewer refocuses its own button after asking where to save, and
    // the keys would follow it into a page that is waiting.
    it("takes the keyboard back when the waiting page takes focus", async () => {
      const { container } = render(<BrowserWindow {...windowProps} focused />);
      asksForAFile(view(container), []);
      await screen.findByRole("option", { name: "notes.txt" });

      act(() => {
        pickerBox().blur();
        view(container).dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));
      });

      expect(pickerBox()).toHaveFocus();
    });

    // A newer request replaces the older one (see `useFileRequest`) and starts
    // empty.
    it("starts afresh on a second question", async () => {
      const answers: string[] = [];
      const { container } = render(<BrowserWindow {...windowProps} focused />);
      asksForAFile(view(container), answers);
      await userEvent.type(pickerBox(), "notes");

      asksForAFile(view(container), answers);

      expect(answers).toStrictEqual(["cancel"]);
      expect(pickerBox()).toHaveValue("");
      await screen.findByRole("option", { name: "notes.txt" });
    });

    it("gives the page its keyboard back once the question is answered", async () => {
      const answers: string[] = [];
      const { container } = render(<BrowserWindow {...windowProps} focused />);
      asksForAFile(view(container), answers);
      await screen.findByRole("option", { name: "notes.txt" });

      await userEvent.type(pickerBox(), "{Escape}");

      expect(answers).toStrictEqual(["cancel"]);
      expect(view(container)).toHaveFocus();
    });
  });

  describe("the page", () => {
    usesStylesheet();

    it("takes the whole window under the address bar", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      // The window is a flex column, so the page fills the height below the
      // bar...
      expect(globalThis.getComputedStyle(browser()).display).toBe("flex");
      expect(globalThis.getComputedStyle(browser()).flexDirection).toBe(
        "column",
      );
      // ...and the view stretches to fill it. A `<webview>` is a replaced
      // element with a 300x150 intrinsic size.
      expect(globalThis.getComputedStyle(view(container)).flexGrow).toBe("1");
    });

    describe("the link under the pointer", () => {
      const renderWindow = () =>
        render(
          <BrowserWindow
            behindPanel={false}
            clickThrough={false}
            covered={false}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused
            frame={FRAME}
            fullscreen={false}
            motion="resting"
            onDescription={noDescription}
            onFocusRequest={() => undefined}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => undefined}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );

      it("shows its address, as Chrome's status bubble does", () => {
        const { container } = renderWindow();
        hovers(view(container), "https://example.com/linked");
        expect(screen.getByRole("status", { name: "Link" })).toHaveTextContent(
          "https://example.com/linked",
        );
      });

      it("shows nothing once the pointer leaves the link", () => {
        const { container } = renderWindow();
        hovers(view(container), "https://example.com/linked");
        hovers(view(container), "");
        expect(screen.queryByRole("status", { name: "Link" })).toBeNull();
      });

      // The page's own clicks must land on whatever is under the bubble.
      it("lets the pointer through to the page", () => {
        const { container } = renderWindow();
        hovers(view(container), "https://example.com/linked");
        expect(
          globalThis.getComputedStyle(
            screen.getByRole("status", { name: "Link" }),
          ).pointerEvents,
        ).toBe("none");
      });
    });
  });

  describe("the keyboard", () => {
    // Otherwise the compositor keeps sending keys to the previous client.
    it("tells the host no client holds the keyboard when it takes focus", () => {
      const calls: string[] = [];
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={recordingDomicile(calls)}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      expect(calls).toStrictEqual(["focusShell"]);
    });

    it("says nothing while the user is working somewhere else", () => {
      const calls: string[] = [];
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={recordingDomicile(calls)}
          dragging={false}
          focused={false}
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      expect(calls).toStrictEqual([]);
    });

    // Keys typed into a panel over it, or the lock screen, must not reach the
    // page when the panel drops focus, such as a dismissed card's button.
    it("leaves focus dropped on nothing alone while behind a panel", async () => {
      const { container } = render(
        <BrowserWindow
          behindPanel
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const card = document.createElement("button");
      document.body.append(card);
      card.focus();

      card.remove();
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

      expect(view(container)).not.toHaveFocus();
    });

    // The guest page has its own browsing context, so the window must focus it.
    it("puts the keyboard in its page when it becomes the window being worked in", () => {
      const windowProps = {
        behindPanel: false,
        clickThrough: false,
        covered: false,
        depth: 0,
        domicile: silentDomicile,
        dragging: false,
        frame: FRAME,
        fullscreen: false,
        motion: "resting",
        onDescription: noDescription,
        onFocusRequest: () => undefined,
        onIcon: noIcon,
        onMotionEnded: nothingEnded,
        onPageFullscreen: noFullscreen,
        onReach: () => undefined,
        rect: ON_SCREEN,
        resizing: false,
        url: "https://example.com",
        window: "1",
      } as const;
      const { container, rerender } = render(
        <BrowserWindow {...windowProps} focused={false} />,
      );

      rerender(<BrowserWindow {...windowProps} focused />);

      expect(view(container)).toHaveFocus();
    });

    // A click in the address bar also makes this the focused window. Focusing
    // the page then would pull the caret out of the address bar.
    it("leaves the focus in its address bar when the press that reached it landed there", async () => {
      const windowProps = {
        behindPanel: false,
        clickThrough: false,
        covered: false,
        depth: 0,
        domicile: silentDomicile,
        dragging: false,
        frame: FRAME,
        fullscreen: false,
        motion: "resting",
        onDescription: noDescription,
        onFocusRequest: () => undefined,
        onIcon: noIcon,
        onMotionEnded: nothingEnded,
        onPageFullscreen: noFullscreen,
        onReach: () => undefined,
        rect: ON_SCREEN,
        resizing: false,
        url: "https://example.com",
        window: "1",
      } as const;
      const { rerender } = render(
        <BrowserWindow {...windowProps} focused={false} />,
      );
      await userEvent.click(address());

      // The desktop responds to the reach by focusing this window.
      rerender(<BrowserWindow {...windowProps} focused />);

      expect(address()).toHaveFocus();
    });

    // The engine forwards keys from this document to clients, but keys sent to a
    // focused guest never reach the document. A guest left focused would block
    // typing into every client, and `focusChrome` cannot fix that.
    it("gives the keyboard back when the user moves to another window", () => {
      const windowProps = {
        behindPanel: false,
        clickThrough: false,
        covered: false,
        depth: 0,
        domicile: silentDomicile,
        dragging: false,
        frame: FRAME,
        fullscreen: false,
        motion: "resting",
        onDescription: noDescription,
        onFocusRequest: () => undefined,
        onIcon: noIcon,
        onMotionEnded: nothingEnded,
        onPageFullscreen: noFullscreen,
        onReach: () => undefined,
        rect: ON_SCREEN,
        resizing: false,
        url: "https://example.com",
        window: "1",
      } as const;
      const { container, rerender } = render(
        <BrowserWindow {...windowProps} focused />,
      );
      expect(view(container)).toHaveFocus();

      rerender(<BrowserWindow {...windowProps} focused={false} />);

      expect(view(container)).not.toHaveFocus();
    });

    // Keys pressed in chrome still reach the document and get forwarded, so a
    // caret left in the address bar would look active but receive nothing.
    it("gives it back from its address bar too", async () => {
      const windowProps = {
        behindPanel: false,
        clickThrough: false,
        covered: false,
        depth: 0,
        domicile: silentDomicile,
        dragging: false,
        frame: FRAME,
        fullscreen: false,
        motion: "resting",
        onDescription: noDescription,
        onFocusRequest: () => undefined,
        onIcon: noIcon,
        onMotionEnded: nothingEnded,
        onPageFullscreen: noFullscreen,
        onReach: () => undefined,
        rect: ON_SCREEN,
        resizing: false,
        url: "https://example.com",
        window: "1",
      } as const;
      const { rerender } = render(<BrowserWindow {...windowProps} focused />);
      await userEvent.click(address());

      rerender(<BrowserWindow {...windowProps} focused={false} />);

      expect(address()).not.toHaveFocus();
    });
  });

  // Chrome clicks send pointer events this document sees. Guest page clicks
  // send none, so the window listens for the guest taking focus instead.
  describe("reaching the window", () => {
    // A guest takes focus as the embedder page loses it, so Blink fires no
    // `focus` or `focusin`. The engine fires `WEBVIEW_GUEST_FOCUS_EVENT`
    // instead.
    it("reports a reach when the guest in the page takes focus", async () => {
      await new Promise<void>((resolve) => {
        const { container } = render(
          <BrowserWindow
            behindPanel={false}
            clickThrough={false}
            covered={false}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused={false}
            frame={FRAME}
            fullscreen={false}
            motion="resting"
            onDescription={noDescription}
            onFocusRequest={() => undefined}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => {
              resolve();
            }}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );
        view(container).dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));
      });
    });

    it("reports a reach when focus lands in the page", async () => {
      await new Promise<void>((resolve) => {
        const { container } = render(
          <BrowserWindow
            behindPanel={false}
            clickThrough={false}
            covered={false}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused={false}
            frame={FRAME}
            fullscreen={false}
            motion="resting"
            onDescription={noDescription}
            onFocusRequest={() => undefined}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => {
              resolve();
            }}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );
        fireEvent.focusIn(view(container));
      });
    });

    // When the page regains the keyboard, the engine refocuses the last guest
    // and fires both `focusin` and its own event. The window ignores both
    // while nothing can click its page.
    it.each([
      { behindPanel: false, covered: true, under: "another tab" },
      { behindPanel: true, covered: false, under: "a desktop panel" },
    ])(
      "says nothing when the page under $under takes focus",
      ({ behindPanel, covered }) => {
        const reaches: string[] = [];
        const { container } = render(
          <BrowserWindow
            behindPanel={behindPanel}
            clickThrough={false}
            covered={covered}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused={false}
            frame={FRAME}
            fullscreen={false}
            motion="resting"
            onDescription={noDescription}
            onFocusRequest={() => undefined}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => {
              reaches.push("reach");
            }}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );

        fireEvent.focusIn(view(container));
        view(container).dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));

        expect(reaches).toStrictEqual([]);
      },
    );

    it("reports a click in the page of the window it is already in", async () => {
      // Focus follows the cursor, so the window is usually focused before the
      // click. The click must still raise it.
      await new Promise<void>((resolve) => {
        const { container } = render(
          <BrowserWindow
            behindPanel={false}
            clickThrough={false}
            covered={false}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused
            frame={FRAME}
            fullscreen={false}
            motion="resting"
            onDescription={noDescription}
            onFocusRequest={() => undefined}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => {
              resolve();
            }}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );
        view(container).dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));
      });
    });

    it("reports a focus request when the page or an extension asks for the window in front", async () => {
      // A page's `window.focus()` or `client.focus()` (as from a notification
      // click), `chrome.tabs.update(id, {active: true})` and
      // `chrome.windows.update(id, {focused: true})` arrive on the view. Not a
      // reach: the pointer is elsewhere, so the shell warps it.
      await new Promise<void>((resolve) => {
        const { container } = render(
          <BrowserWindow
            behindPanel={false}
            clickThrough={false}
            covered={false}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused={false}
            frame={FRAME}
            fullscreen={false}
            motion="resting"
            onDescription={noDescription}
            onFocusRequest={() => {
              resolve();
            }}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => undefined}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );
        view(container).dispatchEvent(new Event(WEBVIEW_FOCUS_REQUEST_EVENT));
      });
    });

    it("says nothing when the shell put the focus there itself", () => {
      // Programmatic focus of the page fires the same event as a click. If it
      // counted as a reach, moving the pointer across windows would restack
      // them.
      const reaches: string[] = [];
      const windowProps = {
        behindPanel: false,
        clickThrough: false,
        covered: false,
        depth: 0,
        domicile: silentDomicile,
        dragging: false,
        frame: FRAME,
        fullscreen: false,
        motion: "resting",
        onDescription: noDescription,
        onFocusRequest: () => undefined,
        onIcon: noIcon,
        onMotionEnded: nothingEnded,
        onPageFullscreen: noFullscreen,
        onReach: () => {
          reaches.push("reach");
        },
        rect: ON_SCREEN,
        resizing: false,
        url: "https://example.com",
        window: "1",
      } as const;
      const { container, rerender } = render(
        <BrowserWindow {...windowProps} focused={false} />,
      );
      // Simulates the engine firing the event from inside `focus()`, which
      // happy-dom's element does not do.
      const guest = view(container);
      guest.addEventListener("focus", () => {
        guest.dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));
      });

      rerender(<BrowserWindow {...windowProps} focused />);

      expect(reaches).toStrictEqual([]);
    });

    it("says nothing when it takes the focus back from nothing", async () => {
      // Focus restored by `useReclaimFocus` (such as after another window
      // closes) is also programmatic. Counted as a reach, it would raise the
      // window under the pointer.
      const reaches: string[] = [];
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => {
            reaches.push("reach");
          }}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const guest = view(container);
      guest.addEventListener("focus", () => {
        guest.dispatchEvent(new Event(WEBVIEW_GUEST_FOCUS_EVENT));
      });
      // Chrome takes focus and then drops it, as when an element unmounts
      // mid-press.
      const pressed = document.createElement("button");
      document.body.append(pressed);
      pressed.focus();

      await act(() => {
        pressed.blur();
        return Promise.resolve();
      });
      pressed.remove();

      expect(reaches).toStrictEqual([]);
    });
  });

  // Buttons that would do nothing are disabled.
  describe("the history controls", () => {
    it("grays Back out until the page has somewhere to go back to", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      expect(control("Back")).toBeDisabled();
      historyReaches(view(container), true, false);
      expect(control("Back")).not.toBeDisabled();
      // Back and forward availability are independent.
      expect(control("Forward")).toBeDisabled();
    });

    it("grays Forward out until the page has somewhere to go forward to", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      expect(control("Forward")).toBeDisabled();
      historyReaches(view(container), false, true);
      expect(control("Forward")).not.toBeDisabled();
      expect(control("Back")).toBeDisabled();
    });

    it("goes back and forward in a new window on a middle click", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const element = view(container);
      historyReaches(element, true, true);
      const calls: string[] = [];
      element.goBackInNewWindow = () => {
        calls.push("back");
      };
      element.goForwardInNewWindow = () => {
        calls.push("forward");
      };

      for (const name of ["Back", "Forward"]) {
        fireEvent(
          control(name),
          new MouseEvent("auxclick", { bubbles: true, button: 1 }),
        );
      }

      expect(calls).toStrictEqual(["back", "forward"]);
    });
  });

  // `AddressBar` tests the button itself. This checks that it reads the view's
  // loading state and drives the view.
  describe("the reload button", () => {
    it("becomes a stop button while the view says a page is arriving", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      // The element reports not loading until the browser says otherwise.
      expect(control("Reload")).toBeVisible();
      loads(view(container), true);
      expect(control("Stop")).toBeVisible();
      loads(view(container), false);
      expect(control("Reload")).toBeVisible();
    });

    it("drives the view with whichever of the two it is", async () => {
      const driven: string[] = [];
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const guest = view(container);
      guest.reload = () => {
        driven.push("reload");
      };
      guest.stop = () => {
        driven.push("stop");
      };

      await userEvent.click(control("Reload"));
      loads(guest, true);
      await userEvent.click(control("Stop"));

      expect(driven).toStrictEqual(["reload", "stop"]);
    });

    it("fills the loading bar as far as the page has loaded", () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      loads(view(container), true);
      progresses(view(container), 0.5);

      expect(
        screen.getByRole("progressbar", { name: "Loading" }),
      ).toHaveAttribute("aria-valuenow", "50");
    });
  });

  describe("a browser's keys", () => {
    const keysWindow = ({
      covered = false,
      focused = true,
    }: {
      covered?: boolean;
      focused?: boolean;
    }) => (
      <BrowserWindow
        behindPanel={false}
        clickThrough={false}
        covered={covered}
        depth={0}
        domicile={silentDomicile}
        dragging={false}
        focused={focused}
        frame={FRAME}
        fullscreen={false}
        motion="resting"
        onDescription={noDescription}
        onFocusRequest={() => undefined}
        onIcon={noIcon}
        onMotionEnded={nothingEnded}
        onPageFullscreen={noFullscreen}
        onReach={() => undefined}
        rect={ON_SCREEN}
        resizing={false}
        url="https://example.com"
        window="1"
      />
    );
    const renderWindow = () => render(keysWindow({}));

    /** Records the history controls' calls. */
    const driven = (element: HTMLWebViewElement): string[] => {
      const calls: string[] = [];
      element.goBack = () => {
        calls.push("back");
      };
      element.goForward = () => {
        calls.push("forward");
      };
      element.reload = () => {
        calls.push("reload");
      };
      return calls;
    };

    // Keys pressed in the page never reach this document. The engine forwards
    // chords the page did not handle.
    it("answers a chord the page left alone", () => {
      const { container } = renderWindow();
      const calls = driven(view(container));

      guestPresses(view(container), { altKey: true, key: "ArrowLeft" });
      guestPresses(view(container), { altKey: true, key: "ArrowRight" });
      guestPresses(view(container), { ctrlKey: true, key: "r" });

      expect(calls).toStrictEqual(["back", "forward", "reload"]);
    });

    it("answers the same chord pressed in its own address bar", () => {
      const { container } = renderWindow();
      const calls = driven(view(container));

      fireEvent.keyDown(address(), { ctrlKey: true, key: "R", shiftKey: true });

      expect(calls).toStrictEqual(["reload"]);
    });

    it("leaves a chord that is not a browser's alone", () => {
      const { container } = renderWindow();
      const calls = driven(view(container));
      const asked = zoomable(view(container), 1);

      guestPresses(view(container), { ctrlKey: true, key: "q" });

      expect(calls).toStrictEqual([]);
      expect(asked).toStrictEqual([]);
    });

    it("zooms a step from wherever the page is", () => {
      const { container } = renderWindow();
      const asked = zoomable(view(container), 1.25);

      guestPresses(view(container), { ctrlKey: true, key: "=" });
      guestPresses(view(container), { ctrlKey: true, key: "-" });
      guestPresses(view(container), { ctrlKey: true, key: "0" });

      expect(asked).toStrictEqual([1.5, 1.25, 1]);
    });

    // The engine turns Ctrl+wheel over the page into a zoom request, which uses
    // the same steps as the keys.
    it("zooms when the wheel asks it to", () => {
      const { container } = renderWindow();
      const asked = zoomable(view(container), 1);

      fireEvent(view(container), new Event(WEBVIEW_ZOOM_OUT_REQUEST_EVENT));

      expect(asked).toStrictEqual([0.9]);
    });

    it("zooms from the buttons in its bar", async () => {
      const { container } = renderWindow();
      // Zoomed already: the buttons show only then.
      const asked = zoomable(view(container), 1.1);

      await userEvent.click(control("Zoom in"));

      expect(asked).toStrictEqual([1.25]);
    });

    it("says what it zoomed to", async () => {
      const { container } = renderWindow();
      zoomable(view(container), 1);
      // Over no link, as the engine's element starts, so the zoom is the only
      // status.
      hovers(view(container), "");

      guestPresses(view(container), { ctrlKey: true, key: "+" });

      expect(await screen.findByRole("dialog")).toHaveTextContent("110%");
    });

    // Another window opening over it, or a tab over it, left its popup over
    // that window.
    it.each([
      ["another window takes the focus", { focused: false }],
      ["another tab covers it", { covered: true }],
    ])("hides what it zoomed to once %s", async (_, outOfView) => {
      const { container, rerender } = renderWindow();
      zoomable(view(container), 1);
      hovers(view(container), "");
      guestPresses(view(container), { ctrlKey: true, key: "+" });
      await screen.findByRole("dialog");

      rerender(keysWindow(outOfView));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    });
  });

  // The engine sends what was under a right click; the window draws the menu.
  describe("site permissions", () => {
    const renderWindow = () =>
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );

    it("answers the page's request from the panel it opens", async () => {
      const answers: string[] = [];
      const { container } = renderWindow();
      fireEvent(
        view(container),
        Object.assign(
          new Event(WEBVIEW_PERMISSION_REQUEST_EVENT, { cancelable: true }),
          {
            allow: () => {
              answers.push("allow");
            },
            deny: () => undefined,
            dismiss: () => undefined,
            origin: "https://example.com",
            permissions: ["camera"],
          },
        ),
      );

      await userEvent.click(
        await screen.findByRole("button", { name: "Allow" }),
      );

      expect(answers).toStrictEqual(["allow"]);
    });

    it("stores a setting on the page's site", async () => {
      const stored: string[] = [];
      const { container } = renderWindow();
      const element = view(container);
      Object.assign(element, {
        setSitePermission: (permission: string, setting: string) => {
          stored.push(`${permission} ${setting}`);
        },
        sitePermissions: () => ({ camera: "ask" }),
      });
      fireEvent(element, new Event(WEBVIEW_SITE_PERMISSIONS_CHANGE_EVENT));

      await userEvent.click(control("Site permissions"));
      await userEvent.click(
        await screen.findByRole("combobox", { name: "Camera" }),
      );
      await userEvent.click(screen.getByRole("option", { name: "Block" }));

      expect(stored).toStrictEqual(["camera block"]);
    });
  });

  // The engine draws no chooser for WebHID, WebUSB or Web Serial.
  describe("a device its page asks for", () => {
    it("connects the device picked over the page", async () => {
      const answers: string[] = [];
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      fireEvent(
        view(container),
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
            title: "example.com wants to connect to a HID device",
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

  // The engine draws no dialog for a link for an application.
  describe("a link for an application its page opens", () => {
    it("asks over the page, naming the application, and opens it", async () => {
      const answers: string[] = [];
      const apps = fakeDesktop(
        {
          "/apps/applications/zoom.desktop":
            "[Desktop Entry]\nType=Application\nName=Zoom\nExec=zoom %u\n",
        },
        (argv) =>
          argv[0] === "env"
            ? { code: 0, stderr: "", stdout: "XDG_DATA_DIRS=/apps\0" }
            : { code: 0, stderr: "", stdout: "zoom.desktop\n" },
      );
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={{
            ...silentDomicile,
            dbus: apps.dbus,
            files: { ...silentDomicile.files, ...apps.files },
            processes: { ...silentDomicile.processes, ...apps.processes },
          }}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://zoom.us"
          window="1"
        />,
      );
      fireEvent(
        view(container),
        Object.assign(
          new Event(WEBVIEW_EXTERNAL_APP_EVENT, { cancelable: true }),
          {
            dismiss: () => undefined,
            mayRemember: true,
            open: (remember: boolean) => {
              answers.push(`open ${String(remember)}`);
            },
            origin: "https://zoom.us",
            url: "zoommtg://zoom.us/join?confno=1",
          },
        ),
      );

      const open = within(
        await screen.findByRole("alertdialog", { name: "Open Zoom?" }),
      ).getByRole("button", { name: "Open Zoom" });
      // The page waits on it, so a focused window gives it the keyboard.
      await waitFor(() => {
        expect(open).toHaveFocus();
      });
      await userEvent.click(open);

      expect(answers).toStrictEqual(["open false"]);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  // The engine draws no sign-in dialog.
  describe("a sign-in its site asks for", () => {
    it("asks for it over the page", async () => {
      const answers: string[] = [];
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="http://router.home"
          window="1"
        />,
      );
      fireEvent(
        view(container),
        Object.assign(new Event(WEBVIEW_SIGN_IN_EVENT, { cancelable: true }), {
          dismiss: () => undefined,
          proxy: false,
          realm: "Router",
          secure: false,
          signIn: (username: string, password: string) => {
            answers.push(`sign in ${username} ${password}`);
          },
          url: "http://router.home/",
        }),
      );

      const dialog = await screen.findByRole("alertdialog", {
        name: "Sign in to router.home",
      });
      const username = within(dialog).getByLabelText("Username");
      // The page waits on it, so a focused window gives it the keyboard.
      await waitFor(() => {
        expect(username).toHaveFocus();
      });
      await userEvent.type(username, "admin");
      await userEvent.type(
        within(dialog).getByLabelText("Password"),
        "hunter2{Enter}",
      );

      expect(answers).toStrictEqual(["sign in admin hunter2"]);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  // The engine draws no "Sign in with" account chooser.
  describe("a provider its site signs in with", () => {
    const renderWindow = (opens: (url: string) => void = () => undefined) =>
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={{
            ...silentDomicile,
            browser: { ...silentDomicile.browser, open: opens },
          }}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://news.example"
          window="1"
        />,
      );

    /** The accounts step, from the site's button or offered unasked. */
    const asksWithAccounts = (
      element: HTMLElement,
      button: boolean,
      answers: string[],
    ) => {
      fireEvent(
        element,
        Object.assign(new Event(WEBVIEW_IDENTITY_EVENT, { cancelable: true }), {
          accounts: () => [
            {
              identifier: "alex@idp.example",
              name: "Alex Rivera",
              picture: "",
              provider: 0,
              returning: false,
              shared: ["name"],
            },
          ],
          automatic: false,
          button,
          choose: (account: number) => {
            answers.push(`choose ${account}`);
          },
          dismiss: () => undefined,
          error: "",
          errorUrl: "",
          frameSite: "",
          moreDetails: () => undefined,
          providers: () => [
            {
              addAccount: false,
              icon: "",
              name: "idp.example",
              privacyPolicy: "https://news.example/privacy",
              signedOut: false,
              termsOfService: "",
            },
          ],
          purpose: "sign-in",
          signInToProvider: () => undefined,
          site: "news.example",
          step: "accounts",
        }),
      );
    };

    it("asks over the page after the site's button, with the keyboard", async () => {
      const answers: string[] = [];
      const { container } = renderWindow();
      asksWithAccounts(view(container), true, answers);

      const dialog = await screen.findByRole("alertdialog", {
        name: "Sign in to news.example with idp.example",
      });
      const continuing = within(dialog).getByRole("button", {
        name: "Continue as Alex",
      });
      // The page waits on it, so a focused window gives it the keyboard.
      await waitFor(() => {
        expect(continuing).toHaveFocus();
      });
      await userEvent.keyboard("{Enter}");

      expect(answers).toStrictEqual(["choose 0"]);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("leaves the page the keyboard when the site offers it unasked", async () => {
      const { container } = renderWindow();
      asksWithAccounts(view(container), false, []);

      const card = await screen.findByRole("dialog", {
        name: "Sign in to news.example with idp.example",
      });

      expect(card.contains(document.activeElement)).toBe(false);
    });

    it("opens the site's privacy policy in a browser window", async () => {
      const opened = Promise.withResolvers<string>();
      const { container } = renderWindow(opened.resolve);
      asksWithAccounts(view(container), true, []);

      await userEvent.click(
        await screen.findByRole("link", { name: "privacy policy" }),
      );

      expect(await opened.promise).toBe("https://news.example/privacy");
    });
  });

  // The engine leaves a failed page blank.
  describe("a page that failed to load", () => {
    it("draws the error over it, and tries again", async () => {
      const reloads: string[] = [];
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.invalid"
          window="1"
        />,
      );
      const element = view(container);
      Object.defineProperties(element, {
        pageFailure: { configurable: true, value: "network" },
        pageFailureCanProceed: { configurable: true, value: false },
        pageFailureError: {
          configurable: true,
          value: "ERR_NAME_NOT_RESOLVED",
        },
        pageFailureHttpStatus: { configurable: true, value: 0 },
        pageFailureUrl: {
          configurable: true,
          value: "https://example.invalid/",
        },
        reload: {
          configurable: true,
          value: () => {
            reloads.push("reload");
          },
        },
      });
      fireEvent(element, new Event(WEBVIEW_PAGE_FAILURE_CHANGE_EVENT));

      const again = await screen.findByRole("button", { name: "Try again" });
      expect(
        screen.getByRole("heading", { name: "Can't reach example.invalid" }),
      ).toBeTruthy();
      // A focused window gives it the keyboard.
      await waitFor(() => {
        expect(again).toHaveFocus();
      });
      await userEvent.click(again);

      expect(reloads).toStrictEqual(["reload"]);
    });
  });

  // The engine draws no file access, certificate, pairing or extension dialog.
  describe("a prompt its page needs answered", () => {
    it("asks it over the page", async () => {
      const answers: string[] = [];
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://vscode.dev"
          window="1"
        />,
      );
      fireEvent(
        view(container),
        Object.assign(new Event(WEBVIEW_PROMPT_EVENT, { cancelable: true }), {
          accept: (choice = 0, text = "") => {
            answers.push(`accept ${choice} ${text}`);
          },
          details: ["/home/ada/notes.md"],
          dismiss: () => undefined,
          kind: "file-edit",
          origin: "https://vscode.dev",
          pin: "",
          subject: "notes.md",
        }),
      );

      const allow = within(
        await screen.findByRole("alertdialog", {
          name: "Let vscode.dev edit notes.md?",
        }),
      ).getByRole("button", { name: "Allow" });
      // The page waits on it, so a focused window gives it the keyboard.
      await waitFor(() => {
        expect(allow).toHaveFocus();
      });
      await userEvent.click(allow);

      expect(answers).toStrictEqual(["accept 0 "]);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  // The engine draws no dialog for alert, confirm, prompt or beforeunload.
  describe("a dialog its page opens", () => {
    it("answers it over the page", async () => {
      const answers: string[] = [];
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isApp
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      fireEvent(
        view(container),
        Object.assign(new Event(WEBVIEW_DIALOG_EVENT, { cancelable: true }), {
          accept: () => {
            answers.push("accept");
          },
          defaultValue: "",
          dialogType: "confirm",
          dismiss: () => undefined,
          message: "Leave?",
          origin: "https://example.com",
        }),
      );

      const ok = within(
        await screen.findByRole("alertdialog", { name: "example.com says" }),
      ).getByRole("button", { name: "OK" });
      // The page waits on it, so a focused window gives it the keyboard.
      await waitFor(() => {
        expect(ok).toHaveFocus();
      });
      await userEvent.click(ok);

      expect(answers).toStrictEqual(["accept"]);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    // A window arriving with a workspace switch is off screen when it takes
    // focus. Focus that scrolled it into view would scroll the whole desk,
    // breaking the slide.
    it("focuses it without scrolling", async () => {
      const scrolling: boolean[] = [];
      const focus = HTMLElement.prototype.focus;
      // `focus` is the platform's, so it is patched rather than injected.
      Object.defineProperty(HTMLElement.prototype, "focus", {
        configurable: true,
        value(this: HTMLElement, options?: FocusOptions) {
          if (this.closest("[role=alertdialog]") !== null) {
            scrolling.push(options?.preventScroll !== true);
          }
          focus.call(this, options);
        },
      });
      try {
        const { container } = render(
          <BrowserWindow
            behindPanel={false}
            clickThrough={false}
            covered={false}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused
            frame={FRAME}
            fullscreen={false}
            isApp
            motion="arriving-from-end"
            onDescription={noDescription}
            onFocusRequest={() => undefined}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => undefined}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );
        fireEvent(
          view(container),
          Object.assign(new Event(WEBVIEW_DIALOG_EVENT, { cancelable: true }), {
            accept: () => undefined,
            defaultValue: "",
            dialogType: "alert",
            dismiss: () => undefined,
            message: "Hi",
            origin: "https://example.com",
          }),
        );

        const ok = within(
          await screen.findByRole("alertdialog", { name: "example.com says" }),
        ).getByRole("button", { name: "OK" });
        await waitFor(() => {
          expect(ok).toHaveFocus();
        });
        expect(scrolling).toStrictEqual([false]);
      } finally {
        HTMLElement.prototype.focus = focus;
      }
    });

    // Closing a background tab asks there, as Chrome switches to the tab.
    it("raises its window for a beforeunload", async () => {
      await new Promise<void>((resolve) => {
        const { container } = render(
          <BrowserWindow
            behindPanel={false}
            clickThrough={false}
            covered={false}
            depth={0}
            domicile={silentDomicile}
            dragging={false}
            focused={false}
            frame={FRAME}
            fullscreen={false}
            motion="resting"
            onDescription={noDescription}
            onFocusRequest={resolve}
            onIcon={noIcon}
            onMotionEnded={nothingEnded}
            onPageFullscreen={noFullscreen}
            onReach={() => undefined}
            rect={ON_SCREEN}
            resizing={false}
            url="https://example.com"
            window="1"
          />,
        );
        fireEvent(
          view(container),
          Object.assign(new Event(WEBVIEW_DIALOG_EVENT, { cancelable: true }), {
            accept: () => undefined,
            defaultValue: "",
            dialogType: "beforeunload",
            dismiss: () => undefined,
            message: "",
            origin: "https://example.com",
          }),
        );
      });

      expect(
        await screen.findByRole("alertdialog", { name: "Leave site?" }),
      ).toBeInTheDocument();
    });
  });

  describe("a context menu its page asks for", () => {
    const renderWindow = (
      opens: (url: string) => void = () => undefined,
      opensPrivately: (url: string) => void = () => undefined,
      isPrivate = false,
    ) =>
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={{
            ...silentDomicile,
            browser: {
              ...silentDomicile.browser,
              open: opens,
              openPrivate: opensPrivately,
            },
          }}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          isPrivate={isPrivate}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );

    const menuItem = (name: string): Promise<HTMLElement> =>
      screen.findByRole("menuitem", { name: new RegExp(`^${name}`, "u") });

    it("draws the page's menu, with nothing in particular under the click", async () => {
      const { container } = renderWindow();
      zoomable(view(container), 1);
      asksForAMenu(view(container), {});

      const menu = await screen.findByRole("menu", { name: "Page" });
      expect(
        [...menu.querySelectorAll("[role=menuitem]")].map(
          (item) => item.textContent,
        ),
      ).toEqual([
        "BackAlt+←",
        "ForwardAlt+→",
        "ReloadCtrl+R",
        "Zoom inCtrl++",
        "Zoom outCtrl+−",
        "InspectCtrl+Shift+I",
      ]);
    });

    it("drives the view from the page's history", async () => {
      const { container } = renderWindow();
      const element = view(container);
      historyReaches(element, true, false);
      const calls: string[] = [];
      element.goBack = () => {
        calls.push("back");
      };
      asksForAMenu(element, {});

      await userEvent.click(await menuItem("Back"));

      expect(calls).toStrictEqual(["back"]);
    });

    it("opens a link in a window of its own", async () => {
      const opened = Promise.withResolvers<string>();
      const { container } = renderWindow(opened.resolve);
      asksForAMenu(view(container), { linkUrl: "https://example.com/opened" });

      await userEvent.click(await menuItem("Open link in new window"));

      expect(await opened.promise).toBe("https://example.com/opened");
    });

    it("opens a link from a private window in a private window", async () => {
      const opened = Promise.withResolvers<string>();
      const { container } = renderWindow(
        () => {
          opened.reject(new Error("opened an ordinary window"));
        },
        opened.resolve,
        true,
      );
      asksForAMenu(view(container), { linkUrl: "https://example.com/opened" });

      await userEvent.click(await menuItem("Open link in new window"));

      expect(await opened.promise).toBe("https://example.com/opened");
    });

    it("says a private window is private", () => {
      renderWindow(undefined, undefined, true);

      expect(screen.getByText("Private")).toBeInTheDocument();
    });

    it("hands what only the browser can do back to the menu it came from", async () => {
      const { container } = renderWindow();
      const ran = asksForAMenu(view(container), {
        hasImageContents: true,
        linkUrl: "https://example.com/opened",
        mediaType: "image",
        srcUrl: "https://example.com/picture.png",
      });

      await userEvent.click(await menuItem("Copy link address"));
      asksForAMenu(
        view(container),
        {
          hasImageContents: true,
          mediaType: "image",
          srcUrl: "https://example.com/picture.png",
        },
        ran,
      );
      await userEvent.click(await menuItem("Copy image$"));
      asksForAMenu(view(container), {}, ran);
      await userEvent.click(await menuItem("Inspect"));

      expect(ran).toStrictEqual(["copy-link-address", "copy-image", "inspect"]);
    });

    it("opens a search for the selection in a window of its own", async () => {
      const opened = Promise.withResolvers<string>();
      const { container } = renderWindow(opened.resolve);
      asksForAMenu(view(container), {
        canCopy: true,
        selectionText: "domicile",
      });

      await userEvent.click(await menuItem("Search for"));

      expect(await opened.promise).toBe("https://google.com/search?q=domicile");
    });

    it("pastes into the field under the click", async () => {
      const { container } = renderWindow();
      const ran = asksForAMenu(view(container), {
        canPaste: true,
        isEditable: true,
      });

      await userEvent.click(await menuItem("Paste$"));

      expect(ran).toStrictEqual(["paste"]);
    });
  });

  describe("DevTools", () => {
    it("opens on Ctrl+Shift+I the page left alone", async () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const inspected = await new Promise<boolean>((resolve) => {
        view(container).inspect = () => {
          resolve(true);
        };
        guestPresses(view(container), {
          ctrlKey: true,
          key: "I",
          shiftKey: true,
        });
      });
      expect(inspected).toBe(true);
    });
  });

  describe("printing", () => {
    it("prints on Ctrl+Shift+P the page left alone", async () => {
      const { container } = render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );
      const printed = await new Promise<boolean>((resolve) => {
        view(container).print = () => {
          resolve(true);
        };
        guestPresses(view(container), {
          ctrlKey: true,
          key: "P",
          shiftKey: true,
        });
      });
      expect(printed).toBe(true);
    });
  });

  describe("finding in the page", () => {
    const renderWindow = () =>
      render(
        <BrowserWindow
          behindPanel={false}
          clickThrough={false}
          covered={false}
          depth={0}
          domicile={silentDomicile}
          dragging={false}
          focused
          frame={FRAME}
          fullscreen={false}
          motion="resting"
          onDescription={noDescription}
          onFocusRequest={() => undefined}
          onIcon={noIcon}
          onMotionEnded={nothingEnded}
          onPageFullscreen={noFullscreen}
          onReach={() => undefined}
          rect={ON_SCREEN}
          resizing={false}
          url="https://example.com"
          window="1"
        />,
      );

    // Ctrl+F pressed in the page, forwarded by the engine.
    it("opens a find bar on Ctrl+F, with the keyboard in it", () => {
      const { container } = renderWindow();

      guestPresses(view(container), { ctrlKey: true, key: "f" });

      expect(findBox()).toHaveFocus();
    });

    // As in Chrome, Ctrl+F with the bar open refocuses it with its text
    // selected.
    it("takes the keyboard back on Ctrl+F with the bar already up", async () => {
      const { container } = renderWindow();
      findable(view(container));
      guestPresses(view(container), { ctrlKey: true, key: "f" });
      await userEvent.type(findBox(), "ab");
      act(() => {
        view(container).focus();
      });

      guestPresses(view(container), { ctrlKey: true, key: "f" });

      expect(findBox()).toHaveFocus();
      expect(findBox()).toHaveProperty("selectionStart", 0);
      expect(findBox()).toHaveProperty("selectionEnd", 2);
    });

    it("finds as the user types, and steps with Enter and Shift+Enter", async () => {
      const { container } = renderWindow();
      const calls = findable(view(container));
      guestPresses(view(container), { ctrlKey: true, key: "f" });

      await userEvent.type(findBox(), "ab");
      await userEvent.keyboard("{Enter}{Shift>}{Enter}{/Shift}");

      expect(calls).toStrictEqual([
        "find a",
        "find ab",
        "find ab",
        "find ab backward",
      ]);
    });

    it("steps from its buttons", async () => {
      const { container } = renderWindow();
      const calls = findable(view(container));
      guestPresses(view(container), { ctrlKey: true, key: "f" });
      await userEvent.type(findBox(), "a");
      finds(view(container), 2, 1);

      await userEvent.click(control("Next match"));
      await userEvent.click(control("Previous match"));

      expect(calls).toStrictEqual(["find a", "find a", "find a backward"]);
    });

    it("says which match it is on, out of how many", async () => {
      const { container } = renderWindow();
      findable(view(container));
      guestPresses(view(container), { ctrlKey: true, key: "f" });
      await userEvent.type(findBox(), "a");

      finds(view(container), 3, 2);

      expect(screen.getByText("2/3")).toBeInTheDocument();
    });

    // As in Chrome, Escape keeps the current match selected and refocuses the
    // page.
    it("stops and hands the page back the keyboard on Escape", async () => {
      const { container } = renderWindow();
      const calls = findable(view(container));
      guestPresses(view(container), { ctrlKey: true, key: "f" });

      await userEvent.keyboard("{Escape}");

      expect(calls).toStrictEqual(["stop"]);
      expect(
        screen.queryByRole("searchbox", { name: "Find in page" }),
      ).toBeNull();
      expect(view(container)).toHaveFocus();
    });

    it("stops from its close button", async () => {
      const { container } = renderWindow();
      const calls = findable(view(container));
      guestPresses(view(container), { ctrlKey: true, key: "f" });

      await userEvent.click(control("Close find bar"));

      expect(calls).toStrictEqual(["stop"]);
      expect(
        screen.queryByRole("searchbox", { name: "Find in page" }),
      ).toBeNull();
    });
  });

  it("hides the window when it is not on screen", () => {
    render(
      <BrowserWindow
        behindPanel={false}
        clickThrough={false}
        covered={false}
        depth={0}
        domicile={silentDomicile}
        dragging={false}
        focused={false}
        frame={FRAME}
        fullscreen={false}
        motion="resting"
        onDescription={noDescription}
        onFocusRequest={() => undefined}
        onIcon={noIcon}
        onMotionEnded={nothingEnded}
        onPageFullscreen={noFullscreen}
        onReach={() => undefined}
        rect={undefined}
        resizing={false}
        url="https://example.com"
        window="1"
      />,
    );
    // A hidden element has no accessible name, but it is the only region.
    expect(screen.getByRole("region", { hidden: true })).not.toBeVisible();
  });

  describe("the way it moves", () => {
    usesStylesheet();

    /** Default props; each test overrides what it checks. */
    const windowProps = {
      behindPanel: false,
      clickThrough: false,
      covered: false,
      depth: 0,
      domicile: silentDomicile,
      dragging: false,
      focused: false,
      frame: FRAME,
      fullscreen: false,
      motion: "resting",
      onDescription: noDescription,
      onFocusRequest: () => undefined,
      onIcon: noIcon,
      onMotionEnded: nothingEnded,
      onPageFullscreen: noFullscreen,
      onReach: () => undefined,
      rect: ON_SCREEN,
      resizing: false,
      url: "https://example.com",
      window: "1",
    } as const;

    it("plays the motion it is given", () => {
      render(<BrowserWindow {...windowProps} motion="opening" />);

      expect(globalThis.getComputedStyle(browser()).animation).toContain(
        "windowOpening",
      );
    });

    // The contents and title bar are separate elements. Each must scale about
    // the same point or they would separate.
    it("turns about the middle of its whole frame rather than its own", () => {
      render(<BrowserWindow {...windowProps} motion="opening" />);

      expect(browser()).toHaveStyle({ transformOrigin: "600px 385px" });
    });

    // Resizing the box every frame would lay its page out at every size in
    // between; see `useSettling`.
    it("takes its new box at once, and eases into it from the old one", () => {
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <BrowserWindow {...windowProps} settler={settler} />,
      );

      rerender(
        <BrowserWindow
          {...windowProps}
          rect={{ ...ON_SCREEN, width: 600 }}
          resizing={false}
          settler={settler}
        />,
      );

      expect(globalThis.getComputedStyle(browser()).transition).not.toContain(
        "inline-size",
      );
      expect(played).toStrictEqual([{ scaleX: 2, scaleY: 1, x: 600, y: 0 }]);
    });

    // Tiled strips share its depth and come later in the page.
    it("eases into another group over the strips it passes", () => {
      const { held, settler } = recordedSettles();
      const { rerender } = render(
        <BrowserWindow {...windowProps} settler={settler} />,
      );

      rerender(
        <BrowserWindow
          {...windowProps}
          crossing
          rect={{ ...ON_SCREEN, width: 600 }}
          resizing={false}
          settler={settler}
        />,
      );

      expect(held).toStrictEqual([CROSSING]);
    });

    // The page draws at its new size before the window gets there, so
    // scaling it with the window would stretch it. The window clips it
    // instead, and it keeps to the window's top left corner.
    it("crops its page to the easing box rather than stretching it", () => {
      const { kept, settler } = recordedSettles();
      const { container, rerender } = render(
        <BrowserWindow {...windowProps} settler={settler} />,
      );

      rerender(
        <BrowserWindow
          {...windowProps}
          rect={{ ...ON_SCREEN, width: 600 }}
          resizing={false}
          settler={settler}
        />,
      );

      const upright = kept[0] ?? [];
      expect(upright).toHaveLength(1);
      expect(upright[0]?.contains(view(container))).toBe(true);
      expect(globalThis.getComputedStyle(browser()).overflow).toBe("hidden");
      expect(
        upright[0] === undefined
          ? undefined
          : globalThis.getComputedStyle(upright[0]).transformOrigin,
      ).toBe("0 0");
    });

    // As an app window keeps its client; see `AppWindow.test.tsx`.
    it("keeps the page at its old size until a shrinking box settles", () => {
      const { ends, settler } = recordedSettles();
      const { container, rerender } = render(
        <BrowserWindow {...windowProps} settler={settler} />,
      );

      rerender(
        <BrowserWindow
          {...windowProps}
          rect={{ ...ON_SCREEN, height: 900, width: 600 }}
          resizing={false}
          settler={settler}
        />,
      );
      const shown = () => {
        const contents = view(container).closest<HTMLElement>("[data-upright]");
        const { blockSize, inlineSize } = contents?.style ?? {};
        return {
          resizing: view(container).hasAttribute("resizing"),
          size: [blockSize, inlineSize],
        };
      };
      const settling = shown();
      act(() => {
        ends[0]?.();
      });

      expect(settling).toStrictEqual({
        resizing: true,
        size: ["", "calc(100% + 600px)"],
      });
      expect(shown()).toStrictEqual({ resizing: false, size: ["", ""] });
    });

    it("follows the pointer exactly while it is being dragged", () => {
      // Easing would make the window trail the pointer.
      const { played, settler } = recordedSettles();
      const { rerender } = render(
        <BrowserWindow {...windowProps} dragging settler={settler} />,
      );

      rerender(
        <BrowserWindow
          {...windowProps}
          dragging
          rect={{ ...ON_SCREEN, x: 40 }}
          resizing={false}
          settler={settler}
        />,
      );

      expect(played).toStrictEqual([undefined]);
    });

    it("stays opaque while it is being dragged", () => {
      render(<BrowserWindow {...windowProps} dragging />);

      // Unset, so it draws at full opacity.
      expect(globalThis.getComputedStyle(browser()).opacity).toBe("");
    });

    // A leaving window still shows its page, but must not pull focus back into
    // its guest.
    it("leaves the keyboard alone while it is leaving", () => {
      const calls: string[] = [];

      render(
        <BrowserWindow
          {...windowProps}
          domicile={recordingDomicile(calls)}
          focused
          motion="closing"
        />,
      );

      expect(calls).toStrictEqual([]);
    });

    it("takes no pointer while it is leaving, and no keyboard can reach it", () => {
      render(<BrowserWindow {...windowProps} motion="leaving-to-start" />);

      expect(globalThis.getComputedStyle(browser()).pointerEvents).toBe("none");
      expect(browser()).toHaveAttribute("inert");
    });

    it("says when it has played its motion out", async () => {
      await new Promise<void>((resolve) => {
        render(
          <BrowserWindow
            {...windowProps}
            motion="closing"
            onMotionEnded={() => {
              resolve();
            }}
          />,
        );
        fireEvent.animationEnd(browser());
      });
    });
  });
});
