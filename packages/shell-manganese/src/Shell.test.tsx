import { beforeEach, describe, expect, it } from "bun:test";
import { standaloneThemeSource } from "@domicile-desktop/component-library/standalone-theme-source";
import { useBar } from "@domicile-desktop/manganese-bar/bar-context";
import type { BarLayout } from "@domicile-desktop/manganese-bar/bar-layout";
import { useKeepsKeyboard } from "@domicile-desktop/manganese-bar/panel-keyboard";
import { Clock } from "@domicile-desktop/manganese-bar-module-clock";
import { LauncherButton } from "@domicile-desktop/manganese-bar-module-launcher-button";
import { WorkspaceSwitcher } from "@domicile-desktop/manganese-bar-module-workspace-switcher";
import type { ApplicationsConfig } from "@domicile-desktop/manganese-launcher/applications-config";
import { answerOpening } from "@domicile-desktop/manganese-launcher/fixture";
import {
  Inbox,
  InboxReading,
} from "@domicile-desktop/manganese-notifications/inbox";
import { useNotificationsDrawer } from "@domicile-desktop/manganese-notifications/notifications-context";
import { grabCursorStyles } from "@domicile-desktop/manganese-window-management/grab-cursor-styles";
import { DEFAULT_KEYBINDINGS } from "@domicile-desktop/manganese-window-management/keyboard/commands";
import {
  SURFACE_TUCK,
  TITLE_BAR,
} from "@domicile-desktop/manganese-window-management/rect";
import { GrabCursor } from "@domicile-desktop/manganese-window-management/useGrabCursor";
import { movingStyles } from "@domicile-desktop/manganese-window-management/window-styles";
import { DomicileProvider } from "@domicile-desktop/react/domicile-provider";
import { sharedWatch } from "@domicile-desktop/react/shared-watch";
import { APP_TAG_NAME } from "@domicile-desktop/sdk/app-element";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { FileSearch } from "@domicile-desktop/sdk/desktop/files";
import type {
  DomicileDisplay,
  DomicileHostEventMap,
  DomicileWindow,
} from "@domicile-desktop/sdk/domicile-host";
import type { DomicileState } from "@domicile-desktop/sdk/fake-host";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { KeyAction } from "@domicile-desktop/sdk/key-action";
import type { ShellKeybindings } from "@domicile-desktop/sdk/own-keybindings";
import {
  WEBVIEW_DESCRIPTION_CHANGE_EVENT,
  WEBVIEW_FAVICON_CHANGE_EVENT,
  WEBVIEW_GUEST_FOCUS_EVENT,
  WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT,
} from "@domicile-desktop/sdk/webview-element";
import {
  answerSystemCalls,
  THINKPAD_BACKLIGHT,
} from "@domicile-desktop/system-backlight/fixture";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { css } from "../styled-system/css";
import { Shell } from "./Shell";

// Displays in the engine's shape, so every render exercises the mapping in
// `screens/host-displays.ts`. Two landscape monitors side by side.
const LEFT: DomicileDisplay = {
  adaptiveSync: "unsupported",
  height: 1080,
  modeHeight: 1080,
  modeWidth: 1920,
  name: "left",
  refreshMhz: 60_000,
  scale: 1,
  transform: "normal",
  width: 1920,
  x: 0,
  y: 0,
};

const RIGHT: DomicileDisplay = {
  adaptiveSync: "unsupported",
  height: 1024,
  modeHeight: 1024,
  modeWidth: 1280,
  name: "right",
  refreshMhz: 60_000,
  scale: 1,
  transform: "normal",
  width: 1280,
  x: 1920,
  y: 0,
};

/** The top bar's height; windows start below it. */
const TOP_BAR = 32;

/** `gaps.inner`: around tiled windows, even a lone one. */
const GAP = 20;

/** The gap between the top bar and the tiled windows under it. */
const TOP_GAP = GAP / 2;

/** The region a `<Screen>` renders for the display of this name. */
const screenNamed = (container: HTMLElement, name: string): Element | null =>
  container.querySelector(`[data-screen="${name}"]`);

/** The open dialog's left edge and width. */
/** The notification bell on monitor `name`. */
const bellOn = (container: HTMLElement, name: string) =>
  within(screenNamed(container, name) as HTMLElement).getByRole("button", {
    name: /^Notifications/v,
  });

const dialogBox = (): { left: string; width: string } => {
  const viewport = screen.getByRole("dialog").parentElement;
  return {
    left: viewport?.style.left ?? "",
    width: viewport?.style.width ?? "",
  };
};

/**
 * A fake desktop that applies the compositor's changes under React's `act`
 * and records the chrome's calls. File searches are answered once
 * {@link holds} sets the index contents.
 */
class Desk {
  readonly fake = new FakeDomicileHost();
  readonly domicile: Domicile;

  /** The files the host's index holds, or `undefined` until a test sets it. */
  #home: readonly string[] | undefined;
  /** Searches not yet answered. */
  readonly #asked: {
    query: string;
    settle: (found: {
      files: string[];
      indexing: boolean;
      matched: number;
    }) => void;
  }[] = [];

  constructor() {
    const asked = this.#asked;
    const searchFiles = (query: string) => {
      this.fake.calls.push(["searchFiles", query]);
      return new Promise<FileSearch>((settle) => {
        asked.push({ query, settle });
        this.#answer();
      });
    };
    const { domicile } = this.fake;
    this.domicile = {
      ...domicile,
      files: { ...domicile.files, search: searchFiles },
    };
  }

  get calls() {
    return this.fake.calls;
  }

  /** The host describes the desktop. */
  describes(displays: readonly DomicileDisplay[]): void {
    this.set({ displays });
  }

  set(changes: Partial<DomicileState>): void {
    act(() => {
      this.fake.set(changes);
    });
  }

  appear(appId: string, fields: Partial<DomicileWindow> = {}): void {
    act(() => {
      this.fake.appear(appId, fields);
    });
  }

  change(appId: string, fields: Partial<DomicileWindow>): void {
    act(() => {
      this.fake.change(appId, fields);
    });
  }

  close(appId: string): void {
    act(() => {
      this.fake.close(appId);
    });
  }

  /**
   * Opens a browser window as the engine does unasked: for a page's
   * target="_blank", `domicile open`, with `popupWindow` an extension's
   * popup window, or with `isApp` `domicile open --app`.
   */
  engineOpens(
    url: string,
    options: Parameters<FakeDomicileHost["openBrowser"]>[1] = {},
  ): void {
    act(() => {
      this.fake.openBrowser(url, options);
    });
  }

  /** Starts or ends a capture of browser window `id`'s page, as the engine does. */
  engineCaptures(id: string, captured = true): void {
    act(() => {
      this.fake.captureBrowser(id, captured);
    });
  }

  /** Closes one as the engine does: its page's window.close(), or an extension. */
  engineCloses(id: string): void {
    act(() => {
      this.fake.closeBrowser(id);
    });
  }

  dispatch<T extends keyof DomicileHostEventMap>(
    type: T,
    fields: Partial<Omit<DomicileHostEventMap[T], keyof Event>>,
  ): void {
    act(() => {
      this.fake.dispatch(type, fields);
    });
  }

  /** Sets the index contents and answers every pending search. */
  async holds(files: readonly string[]): Promise<void> {
    this.#home = files;
    await act(async () => {
      this.#answer();
      await Promise.resolve();
    });
  }

  #answer(): void {
    const home = this.#home;
    if (home !== undefined) {
      for (const { query, settle } of this.#asked.splice(0)) {
        const files = home.filter((path) => path.includes(query));
        settle({ files, indexing: false, matched: files.length });
      }
    }
  }
}

/** An inbox with 2 unread conversations, and one in an app window. */
const FAKE_INBOXES: readonly Inbox[] = [
  Inbox.Watched({
    icon: EnvelopeSimpleIcon,
    name: "Work",
    notifiesAs: "Work",
    open: () => undefined,
    read: () =>
      sharedWatch((onReading) => {
        onReading(InboxReading.Counted(5, 2));
        return () => undefined;
      }),
  }),
  Inbox.Window({
    appId: "fake-chat",
    countUnread: () => () => undefined,
    icon: EnvelopeSimpleIcon,
    name: "Fake inbox",
    notifiesAs: "inbox.example.com",
    url: "https://inbox.example.com/",
  }),
];

let domicile: Desk;

/**
 * Renders the chrome on `desktop`, in strict mode as `mount` draws it unless
 * `strict` is false.
 *
 * The desktop is described before the first render by default, as after a
 * completed handshake. Pass `undefined` to test the gap.
 */
const renderingShell = async (
  desktop: readonly DomicileDisplay[] | undefined,
  bar?: BarLayout,
  keybindings: ShellKeybindings = MANGANESE_KEYS,
  inboxes?: readonly Inbox[],
  strict = true,
) => {
  domicile = new Desk();
  if (desktop !== undefined) {
    domicile.fake.set({ displays: desktop });
  }
  const client = domicile.domicile;
  // A standalone theme, so these tests do not depend on the host theme
  // protocol; `host-theme.test.ts` covers that.
  const rendered = await act(async () =>
    render(
      <DomicileProvider domicile={client}>
        <Shell
          applications={NO_APPLICATIONS}
          bar={bar}
          inboxes={inboxes}
          keybindings={keybindings}
          theme={standaloneThemeSource()}
        />
      </DomicileProvider>,
      { reactStrictMode: strict },
    ),
  );
  return rendered;
};

/** The chrome on an already described desktop. */
const renderShell = (desktop: readonly DomicileDisplay[] = [LEFT]) =>
  renderingShell(desktop);

/**
 * The chrome on `desktop`, outside strict mode, for tests that count what it
 * asks the desktop for. Strict mode runs every effect twice in development.
 */
const renderCountedShell = (desktop: readonly DomicileDisplay[] = [LEFT]) =>
  renderingShell(desktop, undefined, MANGANESE_KEYS, undefined, false);

/** The chrome before any desktop is described, or with no host at all. */
const renderUndescribedShell = () => renderingShell(undefined);

/**
 * Waits for the launcher's pick to run: it runs two animation frames after
 * the launcher closes, so the screen no longer shows the launcher.
 */
const launched = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );

/** The host announces a client, which becomes a window. */
const clientAppears = (appId: string, title = appId): void => {
  domicile.appear(appId, { title });
};

/** A notification as the engine holds one. */
const arrived = (id: number, summary: string) => ({
  actions: [],
  appName: "chat.example.com",
  body: "",
  browserWindow: "",
  clickable: true,
  icon: "",
  id,
  summary,
  time: id,
  timeoutMs: -1,
  urgency: "normal",
});

/**
 * One binding in the README sample's form: Meta, Shift if `shift`, the
 * keysym, and the `send-shell` action.
 */
const line = (
  keysym: string,
  shift: boolean,
  action: string,
): readonly [chord: string, action: KeyAction] => [
  `Meta+${shift ? "Shift+" : ""}${keysym}`,
  KeyAction.SendShell(action.split(" ").slice(1)),
];

const DIRECTIONS = [
  ["h", "left"],
  ["j", "down"],
  ["k", "up"],
  ["l", "right"],
  ["Left", "left"],
  ["Down", "down"],
  ["Up", "up"],
  ["Right", "right"],
] as const;

const WORKSPACE_KEYS = [
  "parenleft",
  "parenright",
  "braceright",
  "plus",
  "braceleft",
  "bracketright",
  "bracketleft",
  "exclam",
  "equal",
  "asterisk",
] as const;

/** A desk with no omitted applications and no bookmarks. */
const NO_APPLICATIONS: ApplicationsConfig = { bookmarks: [], omit: [] };

/** The README's sample config. */
const MANGANESE_KEYS: ShellKeybindings = {
  keybindings: Object.fromEntries([
    line("Return", false, "send-shell exec kitty"),
    line("q", true, "send-shell kill"),
    line("Return", true, "send-shell lock"),
    line("space", false, "send-shell launcher"),
    line("d", false, "send-shell launcher"),
    line("n", false, "send-shell notifications"),
    line("n", true, "send-shell notifications clear"),
    line("i", false, "send-shell idle-inhibitor"),
    line("t", true, "send-shell night-light"),
    line("m", false, "send-shell virtual-monitor add 2560x1440"),
    line("m", true, "send-shell virtual-monitor remove"),
    ...DIRECTIONS.map(([keysym, way]) =>
      line(keysym, false, `send-shell focus ${way}`),
    ),
    ...DIRECTIONS.map(([keysym, way]) =>
      line(keysym, true, `send-shell move ${way}`),
    ),
    line("v", true, "send-shell clipboard"),
    line("o", false, "send-shell overview"),
    line("t", false, "send-shell keymap next"),
    line("b", false, "send-shell split h"),
    line("v", false, "send-shell split v"),
    line("s", false, "send-shell layout stacking"),
    line("w", false, "send-shell layout tabbed"),
    line("e", false, "send-shell layout toggle split"),
    line("a", false, "send-shell focus parent"),
    line("a", true, "send-shell focus child"),
    line("f", false, "send-shell fullscreen toggle"),
    line("f", true, "send-shell fullscreen toggle global"),
    line("Tab", false, "send-shell focus mode_toggle"),
    line("Tab", true, "send-shell floating toggle"),
    line("minus", false, "send-shell scratchpad show"),
    line("minus", true, "send-shell move scratchpad"),
    ...WORKSPACE_KEYS.map((keysym, at) =>
      line(keysym, false, `send-shell workspace ${String(at + 1)}`),
    ),
    ...WORKSPACE_KEYS.map((keysym, at) =>
      line(
        keysym,
        true,
        `send-shell move container to workspace ${String(at + 1)}`,
      ),
    ),
  ]),
};

/**
 * A chord pressed on this page or in a browser window, which the engine sends
 * as a `shortcut` naming the chord as it was grabbed.
 */
const press = (keysym: string, shift = false): void => {
  domicile.dispatch("shortcut", {
    chord: `${shift ? "Shift+" : ""}Meta+${keysym}`,
  });
};

/** Moves the pointer on the page; crossings are judged against it. */
const pointerAt = (x: number, y: number): void => {
  fireEvent.pointerMove(document, { clientX: x, clientY: y, pointerId: 1 });
};

/**
 * The pointer crossing into a window at a point on the page.
 *
 * The desktop reads this `pointerover` to tell whether the pointer moved or
 * the window moved under it.
 */
const crossInto = (element: HTMLElement, x: number, y: number): void => {
  fireEvent.pointerOver(element, { clientX: x, clientY: y, pointerId: 1 });
};

/**
 * Where the shell last warped the cursor.
 *
 * Throws if it never warped, so a missing warp fails the test.
 */
const warpedTo = (): readonly [x: number, y: number] => {
  const asked = [...domicile.calls]
    .reverse()
    .find(([kind]) => kind === "warpPointer");
  const x = asked?.[1];
  const y = asked?.[2];
  if (typeof x !== "number" || typeof y !== "number") {
    throw new Error("test: the shell asked for no warp");
  } else {
    return [x, y];
  }
};

/** Sets the page's held modifiers. Meta held hands the shell the pointer. */
const pageHolds = (held: { meta?: boolean; shift?: boolean }): void => {
  const meta = held.meta ?? false;
  (meta ? fireEvent.keyDown : fireEvent.keyUp)(document, {
    code: "MetaLeft",
    key: "Meta",
    metaKey: meta,
    shiftKey: held.shift ?? false,
  });
};

/** The visible windows, by app ID or window label. */
const windowsOnScreen = (container: HTMLElement): string[] =>
  [
    ...container.querySelectorAll(
      `main :not([hidden]) > ${APP_TAG_NAME}, main section:not([hidden])`,
    ),
  ].map(
    (element) =>
      element.getAttribute("app-id") ??
      element.getAttribute("aria-label") ??
      "",
  );

/**
 * Whether `at` or an ancestor inside `container` turns `pointer-events` off.
 * happy-dom does not inherit it.
 */
const passesPointer = (
  at: HTMLElement | null,
  container: HTMLElement,
): boolean =>
  at !== null &&
  at !== container &&
  (globalThis.getComputedStyle(at).pointerEvents === "none" ||
    passesPointer(at.parentElement, container));

/** Every window's title bar, in opening order. */
const titleBars = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(
    "[data-window]:not([aria-hidden]):not([data-group-handle])",
  ),
];

const barFor = (container: HTMLElement, id: string): HTMLElement => {
  const bar = titleBars(container).find((found) => found.dataset.window === id);
  if (bar === undefined) {
    throw new Error(`test: no title bar for ${id}`);
  } else {
    return bar;
  }
};

/** The face of a bar or tab, which shows its state. */
const faceOf = (bar: HTMLElement): HTMLElement => {
  const face = bar.querySelector<HTMLElement>("[data-face]");
  if (face === null) {
    throw new Error("test: a title bar has no face");
  } else {
    return face;
  }
};

/** Every title bar's window, from the start of the strip. */
const tabOrder = (container: HTMLElement): (string | undefined)[] =>
  titleBars(container)
    .toSorted(
      (one, other) =>
        Number.parseFloat(one.style.insetInlineStart) -
        Number.parseFloat(other.style.insetInlineStart),
    )
    .map((bar) => bar.dataset.window);

/** The motion of every element that is arriving or leaving. */
const moving = (container: HTMLElement): string[] =>
  [
    ...container.querySelectorAll<HTMLElement>(
      '[data-motion]:not([data-motion="resting"])',
    ),
  ].map((element) => element.dataset.motion ?? "");

/** The elements in motion `motion`. */
const movingParts = (container: HTMLElement, motion: string): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(`[data-motion="${motion}"]`),
];

/**
 * Ends every running animation.
 *
 * Test DOMs fire no `animationend`, and the shell keeps drawing closed windows
 * and left workspaces until it arrives.
 */
const motionsPlayOut = (container: HTMLElement): void => {
  for (const element of container.querySelectorAll(
    '[data-motion]:not([data-motion="resting"])',
  )) {
    fireEvent.animationEnd(element);
  }
};

/** The drag-catching sheets over floating windows. */
const grabSheets = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(
    "[data-window][aria-hidden]:not([data-border]):not([data-group-handle])",
  ),
];

/** The sheet over the whole desk that shows the cursor while a window moves. */
const grabbingSheet = (container: HTMLElement): HTMLElement => {
  const sheet = container.querySelector<HTMLElement>("[data-grabbing]");
  if (sheet === null) {
    throw new Error("test: no window is moving");
  } else {
    return sheet;
  }
};

/** The one tab strip's empty end, which drags its group. */
const stripEnd = (container: HTMLElement): Element => {
  const end = container.querySelector("[data-group-handle]");
  if (end === null) {
    throw new Error("test: no strip has an empty end to drag");
  } else {
    return end;
  }
};

/**
 * The empty end of the strip whose group last focused `id`, which drags the
 * group.
 */
const stripEndOf = (container: HTMLElement, id: string): Element => {
  const end = container.querySelector(
    `[data-group-handle][data-window="${id}"]`,
  );
  if (end === null) {
    throw new Error(`test: no strip with an empty end holds ${id}`);
  } else {
    return end;
  }
};

/** A floating window's right border: its rightmost vertical strip. */
const rightBorder = (container: HTMLElement): HTMLElement => {
  const upright = [
    ...container.querySelectorAll<HTMLElement>("[data-border]"),
  ].filter(
    (border) =>
      Number.parseFloat(border.style.blockSize) >
      Number.parseFloat(border.style.inlineSize),
  );
  const [right] = upright.toSorted(
    (a, b) =>
      Number.parseFloat(b.style.insetInlineStart) -
      Number.parseFloat(a.style.insetInlineStart),
  );
  if (right === undefined) {
    throw new Error("test: no floating window's border on screen");
  } else {
    return right;
  }
};

/** The shadows under floating windows. */
const shadows = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>("[data-shadow]"),
];

/**
 * The shadow under the only floating window.
 *
 * Throws if there is none, like {@link groupOutline}.
 */
const floatShadow = (container: HTMLElement): HTMLElement => {
  const [shadow] = shadows(container);
  if (shadow === undefined) {
    throw new Error("test: no shadow under a floating window");
  } else {
    return shadow;
  }
};

/** The backdrop under a scratchpad window. Throws if there is none. */
const scratchpadBackdrop = (container: HTMLElement): HTMLElement => {
  const backdrop = container.querySelector<HTMLElement>(
    "[data-scratchpad-backdrop]",
  );
  if (backdrop === null) {
    throw new Error("test: no backdrop under a scratchpad window");
  } else {
    return backdrop;
  }
};

const appElement = (container: HTMLElement, appId: string): HTMLElement => {
  const element = container.querySelector<HTMLElement>(
    `${APP_TAG_NAME}[app-id="${appId}"]`,
  );
  if (element === null) {
    throw new Error(`test: no window for ${appId}`);
  } else {
    return element;
  }
};

/** The box that places, eases and clips a client's window; see `AppWindow`. */
const appBox = (container: HTMLElement, appId: string): HTMLElement => {
  const box = appElement(container, appId).parentElement;
  if (box === null) {
    throw new Error(`test: no box around the window for ${appId}`);
  } else {
    return box;
  }
};

/** Every address bar's value, in window order. */
const addressesShowing = (): string[] =>
  screen
    .getAllByRole<HTMLInputElement>("combobox", { name: "Address" })
    .map((field) => field.value);

/**
 * The glow around the window or group commands target; see `FocusGlow`.
 * Not one fading out after focus left it.
 */
const glowOf = (container: HTMLElement): HTMLElement | undefined =>
  container.querySelector<HTMLElement>(
    "[data-focus-box]:not([data-leaving])",
  ) ?? undefined;

/** {@link glowOf}, throwing if nothing is lit. */
const glowing = (container: HTMLElement): HTMLElement => {
  const glow = glowOf(container);
  if (glow === undefined) {
    throw new Error("test: nothing is lit");
  } else {
    return glow;
  }
};

/** The windows inside the lit box, or `undefined` when nothing is lit. */
const lit = (container: HTMLElement): readonly string[] | undefined =>
  glowOf(container)?.dataset.focusBox?.split(" ");

/**
 * The box of the tint over the `focus parent` selection, or `undefined` when
 * a window is focused. See `SelectionTint`.
 */
const tinted = (container: HTMLElement): string | undefined => {
  const tint = container.querySelector<HTMLElement>("[data-selection]");
  return tint === null
    ? undefined
    : [
        tint.style.insetInlineStart,
        tint.style.insetBlockStart,
        tint.style.inlineSize,
        tint.style.blockSize,
      ].join(" ");
};

/** The box of the lit glow, as {@link tinted} gives a tint's. */
const glowBox = (container: HTMLElement): string => {
  const glow = glowing(container);
  return [
    glow.style.insetInlineStart,
    glow.style.insetBlockStart,
    glow.style.inlineSize,
    glow.style.blockSize,
  ].join(" ");
};

/** Whether `focus parent` targets a group, which the tint covers. */
const pointedAtGroup = (container: HTMLElement): boolean =>
  tinted(container) !== undefined;

/** An element's laid-out box. */
const boxOf = (element: HTMLElement) => ({
  height: element.style.blockSize,
  width: element.style.inlineSize,
  x: element.style.insetInlineStart,
  y: element.style.insetBlockStart,
});

/** The first browser window's frame. */
const browserWindow = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>(
    "[aria-label='Browser']",
  );
  if (element === null) {
    throw new Error("test: no browser window");
  } else {
    return element;
  }
};

/** The compositor reports the clipboard history, newest first. */
const copied = (
  entries: readonly {
    id: number;
    image: boolean;
    preview: string;
    thumbnail: string;
  }[],
): void => {
  domicile.set({ clipboard: entries });
};

/** An extension whose click fires `action.onClicked`. */
const CLICKED = "abcdefghijklmnopabcdefghijklmnop";

/** An extension whose click opens its popup. */
const POPPED = "ponmlkjihgfedcbaponmlkjihgfedcba";

/**
 * The engine reports both extensions' actions. The second is disabled when
 * `popped` is false.
 */
const extensionsInstalled = (popped = true): void => {
  domicile.set({
    extensions: [
      {
        badgeColor: "#00000000",
        badgeText: "",
        enabled: true,
        icon: "data:image/png;base64,iVBORw0KGgo=",
        id: CLICKED,
        name: "Clicked",
        popup: null,
        title: "Clicked",
      },
      {
        badgeColor: "#00000000",
        badgeText: "",
        enabled: popped,
        icon: "data:image/png;base64,iVBORw0KGgo=",
        id: POPPED,
        name: "Popped",
        popup: `chrome-extension://${POPPED}/popup.html`,
        title: "Popped",
      },
    ],
  });
};

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("Shell", () => {
  describe("across the displays", () => {
    it("gives every display a bar, and every window one element on the desk", async () => {
      // Each monitor gets its own bar. Windows are drawn once for the desk, so
      // a window keeps its element when it changes screens.
      const { container } = await renderShell([LEFT, RIGHT]);
      clientAppears("term");

      for (const name of ["left", "right"]) {
        expect(
          screenNamed(container, name)?.querySelector("[aria-current]"),
        ).toBeInTheDocument();
      }
      expect(container.querySelectorAll("main")).toHaveLength(1);
      expect(container.querySelectorAll(APP_TAG_NAME)).toHaveLength(1);
    });

    it("shows a different workspace on each of them", async () => {
      // Two screens on one workspace would embed a window twice, and the
      // second embedding takes the first's pixels. Each screen gets its own.
      const { container } = await renderShell([LEFT, RIGHT]);

      const marked = (name: string) =>
        screenNamed(container, name)?.querySelector("[aria-current]")
          ?.textContent;

      expect(marked("left")).toBe("1");
      expect(marked("right")).toBe("2");
    });

    it("says so when the host describes a desktop with no screens", async () => {
      await renderShell([]);

      expect(
        screen.getByRole("heading", { name: "No screens" }),
      ).toBeInTheDocument();
    });

    it("says nothing of the kind before the host has described anything", async () => {
      await renderUndescribedShell();

      expect(
        screen.queryByRole("heading", { name: "No screens" }),
      ).not.toBeInTheDocument();
    });

    it("renders nothing until the desktop is described", async () => {
      const { container } = await renderUndescribedShell();

      expect(container.querySelector("main")).toBeNull();
    });

    it("mounts the chrome once, over the windows already open", async () => {
      // A reloaded chrome can learn of open clients before the handshake.
      // Rebuilding it after would blank every portal and reload every page.
      const { container } = await renderUndescribedShell();
      clientAppears("term", "Terminal");

      domicile.describes([LEFT]);

      expect(appBox(container, "term")).not.toHaveAttribute("hidden");
    });

    it("follows the desktop when it changes", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);

      const stage = container.querySelector("main");
      domicile.describes([RIGHT]);

      expect(screenNamed(container, "left")).toBeNull();
      // The same stage: rebuilding it would reload every page and blank every
      // portal. Unplugging a monitor is the common case.
      expect(container.querySelector("main")).toBe(stage);
    });
  });

  describe("the wallpaper", () => {
    it("hangs behind every screen rather than inside one", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);

      expect(
        container.querySelector("[data-screen] [data-wallpaper]"),
      ).toBeNull();
      expect(
        container.firstElementChild?.querySelector("[data-wallpaper]"),
      ).toBeInTheDocument();
    });

    it("is up before the host has described a desktop", async () => {
      const { container } = await renderUndescribedShell();

      expect(container.querySelector("[data-wallpaper]")).toBeInTheDocument();
    });
  });

  describe("the top bar", () => {
    it("lays out the items it is given, in the columns it is given them in", async () => {
      // A custom item beside some of manganese's, the rest left out.
      const { container } = await renderingShell([LEFT], {
        center: [<span key="mail">mail 3/12</span>],
        left: [
          <LauncherButton key="launcher" />,
          <WorkspaceSwitcher key="spaces" />,
        ],
        right: [<Clock key="clock" />],
      });

      const bar = container.querySelector("header");
      expect(bar).toContainElement(screen.getByText("mail 3/12"));
      expect(bar).toContainElement(
        screen.getByRole("navigation", { name: "Workspaces" }),
      );
      expect(
        screen.queryByRole("button", { name: /notification/i }),
      ).toBeNull();
    });

    it("tells the time as the shell's clock options say", async () => {
      const { container } = await renderShell();

      act(() => {
        domicile.fake.set({
          shellOptions: '{"clock":{"format":"12h","seconds":false}}',
        });
      });

      expect(container.querySelector("header time")?.textContent).toMatch(
        / \d\d:\d\d [AP]M$/,
      );
    });

    it("draws text in the shell's font option", async () => {
      await renderShell();

      act(() => {
        domicile.fake.set({ shellOptions: '{"font":"DejaVu Sans"}' });
      });

      expect(
        document.documentElement.style.getPropertyValue("--desktop-font"),
      ).toBe('"DejaVu Sans"');
      document.documentElement.style.removeProperty("--desktop-font");
    });

    it("lays out every item of manganese's when it is given none", async () => {
      await renderShell();

      expect(
        screen.getByRole("button", { name: "Launcher" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /notification/i }),
      ).toBeInTheDocument();
    });

    it("redraws only the items that read what changed", async () => {
      const drawn = { bar: 0, unread: 0 };
      const ReadsUnread = () => {
        drawn.unread += 1;
        return <span>{useNotificationsDrawer().unread}</span>;
      };
      const ReadsBar = () => {
        drawn.bar += 1;
        return <span>{useBar().screen}</span>;
      };
      await renderingShell([LEFT], {
        center: [],
        left: [<ReadsUnread key="unread" />, <ReadsBar key="bar" />],
        right: [],
      });
      clientAppears("term");
      domicile.set({ notifications: [] });
      const before = { ...drawn };

      domicile.change("term", { title: "vim" });
      expect(drawn).toEqual(before);

      domicile.set({ notifications: [arrived(7, "New message")] });
      // The unread count changes; the bar's screen does not.
      await waitFor(() => {
        expect(drawn.unread).toBeGreaterThan(before.unread);
      });
      expect(drawn.bar).toBe(before.bar);
    });

    it("draws no focus ring on anything in it", async () => {
      const { container } = await renderShell();

      expect(container.querySelector("header")?.className).toContain(
        css({ "& *": { outline: "none" } }),
      );
    });

    it("reads the date and the time down to the second", async () => {
      await renderShell();

      expect(
        screen.getByText(/^\w+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      ).toBeInTheDocument();
    });

    it("shows the workspace on screen and the ones with windows on them", async () => {
      // As in sway's bar, an empty workspace that is not shown is omitted.
      await renderShell();
      clientAppears("term");
      press("parenright");

      const workspaces = screen.getByRole("navigation", {
        name: "Workspaces",
      });
      expect(
        [...workspaces.querySelectorAll("button")].map(
          (button) => button.textContent,
        ),
      ).toEqual(["1", "2"]);
    });

    it("marks the workspace on screen", async () => {
      await renderShell();
      clientAppears("term");
      press("parenright");

      expect(screen.getByRole("button", { name: "2" })).toHaveAttribute(
        "aria-current",
        "true",
      );
    });

    it("switches workspace when one is picked", async () => {
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("term");
      press("parenright");

      await user.click(screen.getByRole("button", { name: "1" }));

      expect(windowsOnScreen(container)).toEqual(["term"]);
    });

    it("shows the brightness /sys says in quick settings", async () => {
      await renderShell();

      await act(() => answerSystemCalls(domicile.fake, THINKPAD_BACKLIGHT));
      await userEvent.click(
        screen.getByRole("button", { name: "Quick settings" }),
      );

      expect(screen.getByRole("slider", { name: "Brightness" })).toHaveValue(
        "60",
      );
    });

    it("reads the volume from the sound server", async () => {
      await renderShell();

      await waitFor(() => {
        expect(
          domicile.calls.flatMap(([method, , request]) =>
            method === "callSystem" && typeof request === "string"
              ? [JSON.parse(request)]
              : [],
          ),
        ).toContainEqual(
          expect.objectContaining({
            argv: ["pactl", "-f", "json", "subscribe"],
            call: "spawn",
          }),
        );
      });
    });

    it("asks the system once for every bar and the lock screen", async () => {
      // One `pactl subscribe`, `udevadm monitor` and D-Bus match for the
      // desk, not one per bar and one more for the lock screen.
      await renderCountedShell([LEFT, RIGHT]);
      await act(() => new Promise((settled) => setTimeout(settled, 0)));

      const requests = domicile.calls.flatMap(([method, , request]) =>
        method === "callSystem" && typeof request === "string" ? [request] : [],
      );

      expect(requests).toContainEqual(expect.stringContaining('"pactl"'));
      expect(requests).toEqual([...new Set(requests)]);
    });

    it("draws no meter until UPower answers", async () => {
      // A desktop PC gets no battery reading; the bar must not show `100%`.
      await renderShell();

      expect(screen.queryByRole("meter")).toBeNull();
    });

    it("opens the launcher from the button left of the tray", async () => {
      // `mod+Space` also opens it; the button is for pointer users.
      await renderShell();

      fireEvent.click(screen.getByRole("button", { name: "Launcher" }));

      expect(
        screen.getByRole("combobox", {
          name: "Open an app, a file, a URL, or search",
        }),
      ).toBeVisible();
    });

    it("has no button for the terminal: that is a key", async () => {
      await renderShell();

      expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New window" })).toBeNull();
    });

    it("carries the dark mode tile in quick settings", async () => {
      // No key does this. Two states and no `system`, since this bar is the
      // system.
      await renderShell();

      await userEvent.click(
        screen.getByRole("button", { name: "Quick settings" }),
      );

      expect(screen.getByRole("button", { name: "Dark mode" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.queryByLabelText(/system/i)).toBeNull();
    });
  });

  describe("the idle inhibitor", () => {
    it("is held from `idle-inhibitor`, as from the keep awake tile", async () => {
      await renderShell();

      press("i");
      await userEvent.click(
        screen.getByRole("button", { name: "Quick settings" }),
      );

      expect(screen.getByRole("button", { name: "Keep awake" })).toBeDisabled();
    });
  });

  describe("the night light", () => {
    it("is toggled from `night-light`, as from its tile", async () => {
      await renderShell();
      await userEvent.click(
        screen.getByRole("button", { name: "Quick settings" }),
      );
      const pressed = () =>
        screen
          .getByRole("button", { name: "Night light" })
          .getAttribute("aria-pressed");
      const before = pressed();

      press("t", true);

      expect(pressed()).not.toBe(before);
    });
  });

  describe("virtual monitors", () => {
    it("are added by `virtual-monitor add` and removed by `virtual-monitor remove`", async () => {
      await renderShell();
      press("m");
      const [, id] =
        domicile.calls.find(
          ([method, , request]) =>
            method === "callSystem" &&
            typeof request === "string" &&
            request.includes('"virtual_monitor"'),
        ) ?? [];
      expect(id).toBeDefined();
      await act(async () => {
        domicile.fake.dispatch("system", {
          data: JSON.stringify({
            id,
            reply: { kind: "virtual_monitor", output: "virtual-1" },
            type: "system_reply",
          }),
        });
        await Promise.resolve();
      });

      press("m", true);

      expect(domicile.calls).toContainEqual([
        "callSystem",
        id,
        JSON.stringify({ call: "unwatch" }),
      ]);
    });
  });

  describe("picture-in-picture", () => {
    const VIDEO = {
      canNextTrack: false,
      canPlay: true,
      canPreviousTrack: false,
      duration: 0,
      height: 360,
      id: "1",
      playbackRate: 1,
      playing: true,
      position: 0,
      width: 640,
      window: "",
    };

    it("floats a page's video over the windows, but not on the lock screen", async () => {
      const { container } = await renderShell();
      act(() => {
        domicile.fake.set({ pictureInPictureVideos: [VIDEO] });
      });

      expect(
        container.querySelector('app[picture-in-picture="1"]'),
      ).not.toBeNull();

      act(() => {
        domicile.fake.set({ locked: true });
      });

      expect(container.querySelector("app[picture-in-picture]")).toBeNull();
    });
  });

  describe("the lock screen", () => {
    it("says why the compositor refused a passphrase, and how long to wait", async () => {
      await renderShell();
      act(() => {
        domicile.fake.set({ locked: true });
      });
      const [, id] =
        domicile.calls.find(
          ([method, , request]) =>
            method === "callSystem" &&
            request === JSON.stringify({ call: "unlock_refusals" }),
        ) ?? [];
      const say = (line: object) => {
        domicile.fake.dispatch("system", {
          data: JSON.stringify({ id, ...line }),
        });
      };

      await act(async () => {
        say({ reply: { kind: "started" }, type: "system_reply" });
        await Promise.resolve();
        say({
          event: {
            failures: 3,
            kind: "unlock_refused",
            refusal: "too_soon",
            retry_in_ms: 20_000,
          },
          type: "system_event",
        });
        await new Promise((settled) => setTimeout(settled, 0));
      });

      // The wait is read off a ticking clock, so allow the second it may lag.
      expect(screen.getByRole("alert").textContent).toMatch(
        /^Too many tries\. Try again in 2[01] s$/,
      );
    });
  });

  describe("the clipboard", () => {
    it("shows what has been copied, the newest apart", async () => {
      // The compositor pushes the history; the panel does not ask for it.
      await renderShell();
      copied([
        { id: 3, image: false, preview: "the newest", thumbnail: "" },
        { id: 2, image: false, preview: "the middle", thumbnail: "" },
        { id: 1, image: false, preview: "the oldest", thumbnail: "" },
      ]);

      press("v", true);

      expect(
        screen.getByRole("group", { name: "On your clipboard" }).textContent,
      ).toContain("the newest");
      expect(
        screen.getAllByRole("option").map((row) => row.textContent),
      ).toStrictEqual(["the middle", "the oldest"]);
    });

    it("opens on the screen the keyboard is on", async () => {
      await renderShell([LEFT, RIGHT]);
      clientAppears("one");
      press("l");

      press("v", true);

      expect(dialogBox()).toStrictEqual({ left: "1920px", width: "1280px" });
    });

    it("puts the row that was picked back on the clipboard", async () => {
      // By id, never by text: the page may only choose among entries already
      // on the seat's clipboard.
      await renderShell();
      copied([
        { id: 8, image: false, preview: "the newest", thumbnail: "" },
        { id: 7, image: false, preview: "ssh-rsa AAAA", thumbnail: "" },
      ]);
      press("v", true);

      act(() => {
        screen.getByRole("option", { name: "ssh-rsa AAAA" }).click();
      });

      expect(domicile.calls).toContainEqual(["copyClipboardEntry", 7]);
    });
  });

  describe("the system tray", () => {
    it("is on the bar, and a click activates the icon", async () => {
      await renderShell();
      domicile.set({
        tray: [
          {
            bus: ":1.9",
            icon: "",
            id: ":1.9/StatusNotifierItem",
            itemIsMenu: false,
            menu: "",
            title: "Sync",
          },
        ],
      });

      await userEvent.click(screen.getByRole("button", { name: "Sync" }));

      expect(domicile.calls).toContainEqual([
        "activateTrayItem",
        ":1.9/StatusNotifierItem",
        "primary",
      ]);
    });

    it("is left of the extensions, which are left of the workspaces", async () => {
      await renderShell();
      domicile.set({
        tray: [
          {
            bus: ":1.9",
            icon: "",
            id: ":1.9/StatusNotifierItem",
            itemIsMenu: false,
            menu: "",
            title: "Sync",
          },
        ],
      });
      extensionsInstalled();

      const tray = screen.getByRole("button", { name: "Sync" });
      const extension = screen.getByRole("button", { name: "Clicked" });
      const workspace = screen.getByRole("button", { name: "1" });
      expect(
        tray.compareDocumentPosition(extension) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        extension.compareDocumentPosition(workspace) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe("an application's dialog", () => {
    it("is asked over the desktop, and answered", async () => {
      await renderShell();
      domicile.dispatch("portalrequests", {
        data: JSON.stringify({
          capturing: [],
          items: [
            {
              app_id: "org.example.App",
              body: {
                body: "",
                destructive: false,
                subtitle: "",
                title: "Use the camera?",
              },
              id: 1,
              kind: "access",
            },
          ],
          type: "portal_requests",
        }),
      });

      await userEvent.click(
        await screen.findByRole("button", { name: "Allow" }),
      );

      expect(domicile.calls).toContainEqual([
        "answerPortalRequest",
        1,
        '{"kind":"access"}',
      ]);
    });

    it("takes the keyboard off the window while it is up, and gives it back", async () => {
      // Or the window gets every key typed into a file chooser's box.
      await renderShell();
      clientAppears("one");
      domicile.set({ focusedWindow: "one" });
      domicile.calls.length = 0;
      const requests = (items: readonly object[]) => {
        domicile.dispatch("portalrequests", {
          data: JSON.stringify({
            capturing: [],
            items,
            type: "portal_requests",
          }),
        });
      };

      requests([
        {
          app_id: "org.example.App",
          body: {
            body: "",
            destructive: false,
            subtitle: "",
            title: "Use the camera?",
          },
          id: 1,
          kind: "access",
        },
      ]);
      await screen.findByRole("button", { name: "Allow" });

      expect(domicile.calls).toContainEqual(["focusChrome"]);

      domicile.set({ focusedWindow: null });
      domicile.calls.length = 0;
      requests([]);

      await waitFor(() => {
        expect(domicile.calls).toContainEqual(["focusApp", "one"]);
      });
    });

    describe("a screenshot", () => {
      /** Asks to pick from a 1:1 frame of the one screen, with two windows. */
      const asked = () => {
        domicile.dispatch("portalrequests", {
          data: JSON.stringify({
            items: [
              {
                app_id: "org.example.Shooter",
                body: {
                  desk: { position: [0, 0], size: [1920, 1080] },
                  frame: "data:image/png;base64,AA==",
                  height: 1080,
                  monitors: [
                    {
                      area: { height: 1080, width: 1920, x: 0, y: 0 },
                      description: "",
                      name: "left",
                    },
                  ],
                  width: 1920,
                  windows: [
                    { app_id: "", id: "one", title: "one" },
                    { app_id: "", id: "two", title: "two" },
                  ],
                },
                id: 3,
                kind: "screenshot",
              },
            ],
            type: "portal_requests",
          }),
        });
      };

      it("saves a browser window from its page alone", async () => {
        await renderShell();
        domicile.engineOpens("https://example.com");
        asked();

        await userEvent.click(
          await screen.findByRole("radio", {
            name: "Browser: Untitled window",
          }),
        );
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(
          domicile.calls
            .filter(([call]) => call === "answerPortalRequest")
            .map(([, , answer]) => JSON.parse(String(answer))),
        ).toMatchObject([{ copy: false, kind: "screenshot_browser_window" }]);
      });

      it("saves a hidden tab from its own frame", async () => {
        await renderShell();
        clientAppears("one");
        clientAppears("two");
        press("w");
        asked();

        await userEvent.click(
          await screen.findByRole("radio", { name: "one" }),
        );
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(domicile.calls).toContainEqual([
          "answerPortalRequest",
          3,
          '{"copy":false,"id":"one","kind":"screenshot_window"}',
        ]);
      });
    });

    it("flags a global shortcut that takes one of the shell's chords", async () => {
      await renderShell();
      domicile.dispatch("portalrequests", {
        data: JSON.stringify({
          items: [
            {
              app_id: "org.example.App",
              body: {
                shortcuts: [
                  { description: "Talk", id: "talk", trigger: "Meta+Return" },
                ],
                taken: [],
              },
              id: 2,
              kind: "global_shortcuts",
            },
          ],
          type: "portal_requests",
        }),
      });

      expect(
        await screen.findByText("The desktop uses this chord"),
      ).toBeInTheDocument();
    });
  });

  describe("the notifications", () => {
    it("toasts what arrives, and the bell counts it", async () => {
      await renderShell();
      domicile.set({ notifications: [] });

      domicile.set({ notifications: [arrived(7, "New message")] });

      expect(
        await screen.findByRole("button", { name: "New message" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Notifications, 1 unread" }),
      ).toBeVisible();
    });

    it("lists them in the drawer the bell opens, and clears them all", async () => {
      await renderShell();
      domicile.set({
        notifications: [arrived(1, "Older"), arrived(2, "Newer")],
      });

      await userEvent.click(
        screen.getByRole("button", { name: "Notifications" }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "Clear all" }),
      );

      expect(domicile.calls).toContainEqual(["dismissNotifications", [2, 1]]);
    });

    it("opens the drawer from `notifications`, under the bell on the screen with the keyboard", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);
      clientAppears("one");
      press("l");

      press("n");

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(bellOn(container, "right")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("closes the drawer on a second `notifications`", async () => {
      await renderShell();
      press("n");
      await screen.findByRole("dialog");

      press("n");

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    });

    it("clears them all from `notifications clear`", async () => {
      await renderShell();
      domicile.set({
        notifications: [arrived(1, "Older"), arrived(2, "Newer")],
      });

      press("n", true);

      expect(domicile.calls).toContainEqual(["dismissNotifications", [2, 1]]);
    });

    it("opens the drawer under the bell pressed", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);

      await userEvent.click(bellOn(container, "left"));

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(bellOn(container, "left")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(bellOn(container, "right")).not.toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    it("adds the inboxes' unread conversations to the bell", async () => {
      await renderingShell([LEFT], undefined, MANGANESE_KEYS, FAKE_INBOXES);

      expect(
        await screen.findByRole("button", { name: "Notifications, 2 unread" }),
      ).toBeVisible();
    });

    it("leaves the inboxes' own notifications out of the bell, which counts their conversations already", async () => {
      await renderingShell([LEFT], undefined, MANGANESE_KEYS, FAKE_INBOXES);
      domicile.set({ notifications: [] });

      domicile.set({
        notifications: [
          { ...arrived(1, "New mail"), appName: "Work" },
          { ...arrived(2, "New text"), appName: "inbox.example.com" },
          arrived(3, "New message"),
        ],
      });

      expect(
        await screen.findByRole("button", { name: "Notifications, 3 unread" }),
      ).toBeVisible();
    });

    it("opens an inbox's app window, and closes the notifications", async () => {
      await renderingShell([LEFT], undefined, MANGANESE_KEYS, FAKE_INBOXES);
      await userEvent.click(
        screen.getByRole("button", { name: "Notifications, 2 unread" }),
      );

      await userEvent.click(
        await screen.findByRole("button", { name: "Fake inbox" }),
      );

      expect(domicile.calls).toContainEqual([
        "openAppWindow",
        "https://inbox.example.com/",
        "fake-chat",
        "focus",
      ]);
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("is the far end of the bar", async () => {
      await renderShell();

      const battery = screen.getByRole("button", { name: "Quick settings" });
      const bell = screen.getByRole("button", { name: "Notifications" });
      expect(
        battery.compareDocumentPosition(bell) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe("a bar item's panel", () => {
    it("takes the keyboard off the window while it is open, and gives it back", async () => {
      // Such as a page to type into in a popover.
      const Panel = () => {
        const [open, setOpen] = useState(false);
        useKeepsKeyboard(open);
        return (
          <button
            onClick={() => {
              setOpen(!open);
            }}
            type="button"
          >
            Panel
          </button>
        );
      };
      await renderingShell([LEFT], {
        center: [],
        left: [<Panel key="panel" />],
        right: [],
      });
      clientAppears("one");
      domicile.set({ focusedWindow: "one" });
      domicile.calls.length = 0;

      await userEvent.click(screen.getByRole("button", { name: "Panel" }));

      expect(domicile.calls).toContainEqual(["focusChrome"]);

      domicile.set({ focusedWindow: null });
      domicile.calls.length = 0;
      await userEvent.click(screen.getByRole("button", { name: "Panel" }));

      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
    });
  });

  describe("the extension tray", () => {
    it("is on the bar, and a click on one with no popup activates it", async () => {
      await renderShell();
      extensionsInstalled();

      await userEvent.click(screen.getByRole("button", { name: "Clicked" }));

      expect(domicile.calls).toContainEqual(["activateExtension", CLICKED]);
    });

    it("takes the keyboard off the window while a popup is up, and gives it back", async () => {
      // A popup is a page to type into, as with the launcher; see
      // `AppWindow`.
      await renderShell();
      extensionsInstalled();
      clientAppears("one");
      domicile.set({ focusedWindow: "one" });
      domicile.calls.length = 0;

      await userEvent.click(screen.getByRole("button", { name: "Popped" }));

      expect(domicile.calls).toContainEqual(["focusChrome"]);

      domicile.set({ focusedWindow: null });
      domicile.calls.length = 0;
      await userEvent.keyboard("{Escape}");

      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
    });

    it("forgets a popup whose action was disabled while it was open", async () => {
      // Re-enabling the action is not a click, so the popup stays closed.
      const { container } = await renderShell();
      extensionsInstalled();
      await userEvent.click(screen.getByRole("button", { name: "Popped" }));
      await waitFor(() => {
        expect(container.ownerDocument.querySelector("webview")).not.toBeNull();
      });

      extensionsInstalled(false);
      extensionsInstalled(true);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Popped" })).toBeVisible();
      });
      expect(container.ownerDocument.querySelector("webview")).toBeNull();
    });
  });

  describe("the windows", () => {
    it("tiles a client's window over the workspace, inset by the gap, half of it under the top bar", async () => {
      const { container } = await renderShell();
      clientAppears("term");

      expect(boxOf(appBox(container, "term"))).toEqual({
        height: `${(1080 - TOP_BAR - TOP_GAP - GAP - TITLE_BAR + SURFACE_TUCK).toString()}px`,
        width: `${(1920 - 2 * GAP).toString()}px`,
        x: `${GAP.toString()}px`,
        y: `${(TOP_BAR + TOP_GAP + TITLE_BAR - SURFACE_TUCK).toString()}px`,
      });
    });

    it("gives every window a title bar with what it is called on it", async () => {
      const { container } = await renderShell();
      clientAppears("term", "Terminal");

      const bar = barFor(container, "app:term");
      expect(bar).toHaveTextContent("Terminal");
      expect(boxOf(bar)).toMatchObject({
        height: `${TITLE_BAR.toString()}px`,
        y: `${(TOP_BAR + TOP_GAP).toString()}px`,
      });
    });

    it("draws a client's menu over its window, and takes it down when it goes", async () => {
      // The workspace starts under the top bar, and a lone window's contents
      // start under its title bar.
      const { container } = await renderShell();
      clientAppears("term");
      const window = boxOf(appBox(container, "term"));

      domicile.appear("menu", {
        grab: true,
        height: 240,
        parent: "term",
        width: 180,
        x: 12,
        y: 30,
      });

      // Placed on the window's contents, which it moves with.
      const menu = appElement(container, "menu");
      expect(boxOf(menu)).toMatchObject({
        height: "240px",
        width: "180px",
        x: "12px",
        y: "30px",
      });
      const layer = menu.parentElement;
      if (layer === null) {
        throw new Error("test: the menu is drawn in nothing");
      }
      expect(boxOf(layer)).toMatchObject({ x: window.x, y: window.y });
      // Over its window, not in its own frame.
      expect(container.querySelectorAll("[data-window]").length).toBe(
        container.querySelectorAll('[data-window="app:term"]').length,
      );

      domicile.close("menu");
      expect(() => appElement(container, "menu")).toThrow();
      expect(appElement(container, "term")).toBeDefined();
    });

    it("draws the drop target and the selection tint over a window's bubble", async () => {
      // Firefox draws its whole window into a bubble, which ties with them at
      // the window's raised depth; the later element wins the tie.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      const window2 = boxOf(appBox(container, "two"));
      domicile.appear("bubble", {
        height: Number.parseFloat(window2.height),
        parent: "two",
        width: Number.parseFloat(window2.width),
        x: 0,
        y: 0,
      });
      const over = (element: HTMLElement | null): boolean => {
        // Drawn in a layer over its window, which holds its depth.
        const bubble = appElement(container, "bubble").parentElement;
        return (
          element !== null &&
          bubble !== null &&
          element.style.zIndex === bubble.style.zIndex &&
          (bubble.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0
        );
      };

      press("a");
      press("a");
      expect(over(container.querySelector("[data-selection]"))).toBe(true);
      press("a", true);
      press("a", true);

      fireEvent.pointerDown(barFor(container, "app:one"), {
        clientX: GAP + 100,
        clientY: TOP_BAR + TOP_GAP + TITLE_BAR / 2,
      });
      fireEvent.pointerMove(window, {
        clientX: Number.parseFloat(window2.x) + 200,
        clientY: Number.parseFloat(window2.y) + 300,
      });
      expect(over(container.querySelector("[data-drop]"))).toBe(true);
    });

    it("renames the bar when the client renames its window", async () => {
      const { container } = await renderShell();
      clientAppears("term", "Terminal");

      domicile.change("term", { title: "vim ~/notes" });

      expect(barFor(container, "app:term")).toHaveTextContent("vim ~/notes");
    });

    it("splits the workspace between two windows, with the config's gap", async () => {
      // `gaps.inner = 20` between and around them: 1860 of the 1920 is shared
      // out.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");

      expect(boxOf(appBox(container, "one"))).toMatchObject({
        width: "930px",
        x: "20px",
      });
      expect(boxOf(appBox(container, "two"))).toMatchObject({
        width: "930px",
        x: "970px",
      });
    });

    it("moves a tab along its strip when dragged onto another tab", async () => {
      // Tabs are 240px wide from the gap; the drop lands past the last tab's
      // middle, on its far side.
      const { container } = await renderShell();
      for (const id of ["one", "two", "three"]) {
        clientAppears(id);
      }
      const y = TOP_BAR + TOP_GAP + TITLE_BAR / 2;

      fireEvent.pointerDown(barFor(container, "app:one"), {
        clientX: GAP + 100,
        clientY: y,
      });
      fireEvent.pointerMove(window, { clientX: GAP + 600, clientY: y });
      fireEvent.pointerUp(window, { clientX: GAP + 600, clientY: y });

      expect(tabOrder(container)).toEqual(["app:two", "app:three", "app:one"]);
      // Still one group: only its open tab's window shows.
      expect(windowsOnScreen(container)).toHaveLength(1);
    });

    describe("between a floating group and a tiled one", () => {
      /** The pointer at the middle of `id`'s tab. */
      const middleOf = (container: HTMLElement, id: string) => {
        const tab = barFor(container, id);
        return {
          clientX:
            Number.parseFloat(tab.style.insetInlineStart) +
            Number.parseFloat(tab.style.inlineSize) / 4,
          clientY: Number.parseFloat(tab.style.insetBlockStart) + 15,
        };
      };

      const dragTab = (container: HTMLElement, id: string, onto: string) => {
        const from = middleOf(container, id);
        const to = middleOf(container, onto);
        fireEvent.pointerDown(barFor(container, id), from);
        fireEvent.pointerMove(window, to);
        fireEvent.pointerUp(window, to);
      };

      /** Tiled "one"; floating "two" and `rest` as its tabs, clear of it. */
      const layered = async (...rest: readonly string[]) => {
        const rendered = await renderShell();
        clientAppears("one");
        clientAppears("two");
        press("Tab", true);
        for (const id of rest) {
          clientAppears(id);
        }
        const { container } = rendered;
        // Off the tiled group, by the float's strip's empty end.
        const focused = rest.at(-1) ?? "two";
        fireEvent.pointerDown(stripEndOf(container, `app:${focused}`), {
          clientX: 1000,
          clientY: 60,
        });
        fireEvent.pointerMove(window, { clientX: 1400, clientY: 460 });
        fireEvent.pointerUp(window, { clientX: 1400, clientY: 460 });
        return container;
      };

      it("pulls a tab out of a floating group into a tiled one", async () => {
        const container = await layered("three");

        dragTab(container, "app:three", "app:one");

        expect(tabOrder(container)).toEqual([
          "app:three",
          "app:one",
          "app:two",
        ]);
        expect(windowsOnScreen(container)).toEqual(["two", "three"]);
      });

      it("drags a tiled tab into a floating group", async () => {
        const container = await layered();

        dragTab(container, "app:one", "app:two");

        expect(windowsOnScreen(container)).toEqual(["one"]);
        expect(
          Number.parseFloat(barFor(container, "app:one").style.insetBlockStart),
        ).toBeGreaterThan(400);
      });

      it("lets go of a lone float beside a tab it is dragged onto", async () => {
        const container = await layered();

        dragTab(container, "app:two", "app:one");

        expect(tabOrder(container)).toEqual(["app:two", "app:one"]);
        expect(container.querySelectorAll("[data-shadow]")).toHaveLength(0);
      });
    });

    it("breaks a tab out of its group into a split when dragged over the group", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      fireEvent.pointerDown(barFor(container, "app:two"), {
        clientX: GAP + 300,
        clientY: TOP_BAR + TOP_GAP + TITLE_BAR / 2,
      });
      fireEvent.pointerMove(window, { clientX: 1800, clientY: 500 });
      fireEvent.pointerUp(window, { clientX: 1800, clientY: 500 });

      expect(windowsOnScreen(container)).toEqual(["one", "two"]);
      expect(boxOf(appBox(container, "two"))).toMatchObject({
        x: "970px",
      });
    });

    it("shows a grabbing pointer over the whole desk once a tab moves", async () => {
      // The pointer leaves the bar for the gaps, the wallpaper and the top
      // bar, which each have their own cursor.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("w");

      fireEvent.pointerDown(barFor(container, "app:one"), {
        clientX: 100,
        clientY: TOP_BAR + TOP_GAP + TITLE_BAR / 2,
      });
      // A click's jitter moves nothing, so it shows no grabbing pointer.
      fireEvent.pointerMove(window, {
        clientX: 103,
        clientY: TOP_BAR + TOP_GAP + TITLE_BAR / 2 + 3,
      });
      expect(() => grabbingSheet(container)).toThrow();

      fireEvent.pointerMove(window, { clientX: 1800, clientY: 10 });

      expect(grabbingSheet(container).className).toContain(
        grabCursorStyles[GrabCursor.Grabbing],
      );

      fireEvent.pointerUp(window, { clientX: 1800, clientY: 10 });
      expect(() => grabbingSheet(container)).toThrow();
    });

    it("drags a whole tab group by its strip's empty end onto another screen", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);
      clientAppears("one");
      clientAppears("two");

      fireEvent.pointerDown(stripEnd(container), {
        clientX: GAP + 600,
        clientY: TOP_BAR,
      });
      fireEvent.pointerMove(window, {
        clientX: LEFT.width + 600,
        clientY: 500,
      });
      fireEvent.pointerUp(window, { clientX: LEFT.width + 600, clientY: 500 });

      expect(tabOrder(container)).toEqual(["app:one", "app:two"]);
      expect(
        Number.parseFloat(barFor(container, "app:one").style.insetInlineStart),
      ).toBeGreaterThan(LEFT.width);
    });

    it("asks a client to close its own window", async () => {
      // `closeApp` is a request: the client may show a dialog and stay, so the
      // window goes only when the host reports it closed.
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("term");

      await user.click(screen.getByRole("button", { name: "Close" }));

      expect(domicile.calls).toContainEqual(["closeApp", "term"]);
      expect(windowsOnScreen(container)).toEqual(["term"]);
    });

    it("fills the screen from the button on the window's own bar", async () => {
      // The pointer equivalent of `mod+f`.
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("term");

      await user.click(screen.getByRole("button", { name: "Maximize" }));

      // A fullscreen window covers the top bar too.
      expect(boxOf(appBox(container, "term"))).toMatchObject({
        height: `${(1080 - TITLE_BAR + SURFACE_TUCK).toString()}px`,
        y: `${(TITLE_BAR - SURFACE_TUCK).toString()}px`,
      });

      // The same button restores it.
      await user.click(screen.getByRole("button", { name: "Restore" }));

      expect(boxOf(appBox(container, "term"))).toMatchObject({
        y: `${(TOP_BAR + TOP_GAP + TITLE_BAR - SURFACE_TUCK).toString()}px`,
      });
    });

    it("floats and tiles the window from the button on its own bar", async () => {
      // The pointer equivalent of `floating toggle`.
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("term");

      await user.click(screen.getByRole("button", { name: "Float" }));
      expect(shadows(container)).toHaveLength(1);

      await user.click(screen.getByRole("button", { name: "Tile" }));
      expect(shadows(container)).toHaveLength(0);
    });

    it("fills the screen with a whole tab group from its strip's button", async () => {
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      await user.click(screen.getByRole("button", { name: "Maximize group" }));

      // The strip sits at the screen's top, over the top bar.
      expect(
        Number.parseFloat(barFor(container, "app:one").style.insetBlockStart),
      ).toBe(0);
      expect(boxOf(appBox(container, "two"))).toMatchObject({
        y: `${(TITLE_BAR - SURFACE_TUCK).toString()}px`,
      });

      await user.click(screen.getByRole("button", { name: "Restore group" }));

      expect(boxOf(appBox(container, "two"))).toMatchObject({
        y: `${(TOP_BAR + TOP_GAP + TITLE_BAR - SURFACE_TUCK).toString()}px`,
      });
    });

    // One box under the whole strip, so no seam shows between tabs. The tabs
    // come after it at its depth, so they lie on it.
    it("draws one strip under all of a group's tabs", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      const strips = container.querySelectorAll("[data-strip]");

      expect(strips).toHaveLength(1);
      for (const bar of titleBars(container)) {
        expect(strips[0]?.compareDocumentPosition(bar)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }
      expect(
        within(strips[0] as HTMLElement).getByRole("button", {
          name: "Float group",
        }),
      ).toBeDefined();
    });

    it("floats and tiles a whole tab group from its strip's button", async () => {
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      await user.click(screen.getByRole("button", { name: "Float group" }));
      // A shadow for each window in it.
      expect(shadows(container)).toHaveLength(2);

      await user.click(screen.getByRole("button", { name: "Tile group" }));
      expect(shadows(container)).toHaveLength(0);
    });

    it("drops a floating group's shadows while it fills the screen", async () => {
      // They would spill onto the next display.
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      await user.click(screen.getByRole("button", { name: "Float group" }));
      await user.click(screen.getByRole("button", { name: "Maximize group" }));

      expect(shadows(container)).toHaveLength(0);
    });

    it("opens the launcher from the new-tab button at a strip's end", async () => {
      // The pointer equivalent of `mod+space` from inside the strip.
      const user = userEvent.setup();
      await renderShell();
      clientAppears("term");

      await user.click(screen.getByRole("button", { name: "New tab" }));

      expect(
        screen.getByRole("combobox", {
          name: "Open an app, a file, a URL, or search",
        }),
      ).toBeVisible();
    });

    it("takes the window away when the client goes", async () => {
      const { container } = await renderShell();
      clientAppears("term");

      domicile.close("term");
      motionsPlayOut(container);

      expect(windowsOnScreen(container)).toEqual([]);
    });

    // A closed window is gone from the state at once, so the page draws its
    // exit from a snapshot; see `closing.ts`.
    it("plays a closed window out at the box it had, showing the window itself", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      const was = boxOf(appBox(container, "term"));

      domicile.close("term");

      // The window's own element, so its contents do not change as it leaves.
      expect(appBox(container, "term")).toHaveAttribute(
        "data-motion",
        "closing",
      );
      expect(boxOf(appBox(container, "term"))).toEqual(was);
    });

    // Closing the visible tab collapses it along the strip and fades its
    // contents, rather than shrinking the whole window over the next tab.
    it("closes a closed tab up along the strip it was in", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      clientAppears("editor");

      domicile.close("editor");

      expect(appBox(container, "editor")).toHaveAttribute(
        "data-motion",
        "closing-tab",
      );
      expect(
        barFor(container, "app:editor").style.getPropertyValue("--collapse-x"),
      ).toBe("0");
      // Its contents only fade, revealing the next tab underneath.
      expect(
        appBox(container, "editor").style.getPropertyValue("--collapse-x"),
      ).toBe("");
    });

    // The shown tab's contents tuck under the strip at the same `z-index`, so
    // only document order keeps them off a hidden tab's bottom edge.
    it("draws every tab over the contents of the tab that is shown", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      clientAppears("editor");

      expect(
        appBox(container, "editor").compareDocumentPosition(
          barFor(container, "app:term"),
        ),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    // Closing moves the keyboard elsewhere, so the closing bar keeps its
    // focused look from the snapshot.
    it("keeps its bar saying the keyboard was in it while it goes", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      clientAppears("editor");

      domicile.close("editor");

      expect(barFor(container, "app:editor")).toHaveAttribute(
        "data-focus",
        "focused",
      );
    });

    // The neighbor grows into its space while it shrinks. At equal `z-index`
    // document order would put the neighbor on top too early.
    it("draws a closing window over the one taking its space", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");

      domicile.close("one");

      expect(Number(appBox(container, "one").style.zIndex)).toBeGreaterThan(
        Number(appBox(container, "two").style.zIndex),
      );
    });

    it("takes it off the page once it has finished leaving", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      domicile.close("term");

      motionsPlayOut(container);

      expect(movingParts(container, "closing")).toEqual([]);
      expect(windowsOnScreen(container)).toEqual([]);
    });

    // A page draws only while laid out, so a screenshot or screen cast of a
    // hidden tab would never get a frame.
    it("lays out a hidden tab while the engine captures its page", async () => {
      const { container } = await renderShell();
      domicile.engineOpens("https://example.com");
      clientAppears("two");
      press("w");
      const browser = () =>
        container.querySelector("webview[window='1']")?.closest("section");
      expect(browser()).toHaveAttribute("hidden");

      domicile.engineCaptures("1");
      expect(browser()).not.toHaveAttribute("hidden");

      domicile.engineCaptures("1", false);
      expect(browser()).toHaveAttribute("hidden");
    });

    it("keeps a window that is on another workspace mounted and hidden", async () => {
      // Hidden, not unmounted: remounting blanks a portal and reloads a page.
      const { container } = await renderShell();
      clientAppears("term");

      press("parenright");
      motionsPlayOut(container);

      expect(windowsOnScreen(container)).toEqual([]);
      expect(appBox(container, "term")).toBeInTheDocument();
    });

    // Workspaces form a row: the arriving one slides in from its side and the
    // leaving one slides out the other way.
    it("slides one workspace off as the next one slides in", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("braceright");
      clientAppears("editor");

      press("parenleft");

      expect(moving(container)).toContain("leaving-to-end");
      expect(moving(container)).toContain("arriving-from-start");
    });

    // The glow moves with its windows.
    it("brings the glow on with the workspace", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      clientAppears("shell");
      press("e");
      press("braceright");
      clientAppears("editor");

      press("parenleft");

      expect(glowing(container).className).toContain(
        movingStyles({ motion: "arriving-from-start" }),
      );
    });

    // Each workspace slides by its own screen's width, read from the window.
    it("slides a workspace the width of its screen", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);

      pointerAt(2000, 500);
      clientAppears("term");

      expect(
        appBox(
          container,
          "term",
        ).parentElement?.parentElement?.style.getPropertyValue(
          "--workspace-width",
        ),
      ).toBe("1280px");
    });

    // The page spans every monitor, so a window sliding off its screen would
    // show on the next one. Each of its parts is clipped by its wrapper.
    it("keeps every part of a sliding workspace on its screen", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);
      pointerAt(2000, 500);
      clientAppears("term");
      motionsPlayOut(container);

      press("braceright");

      const clips = movingParts(container, "leaving-to-start").map(
        (part) => part.parentElement?.parentElement?.style.clip,
      );
      expect(clips).not.toHaveLength(0);
      expect(new Set(clips)).toStrictEqual(
        new Set(["rect(0px, 3200px, 1024px, 1920px)"]),
      );
    });

    // A float can hang over the next screen while it is dragged across.
    it("lets windows at rest draw across screens", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);
      pointerAt(2000, 500);
      clientAppears("term");
      motionsPlayOut(container);

      expect(
        appBox(container, "term").parentElement?.parentElement?.style.clip,
      ).toBe("");
    });

    it("and the other way when the switch goes the other way", async () => {
      const { container } = await renderShell();
      clientAppears("term");

      press("braceright");

      expect(moving(container)).toContain("leaving-to-start");
    });

    // A window revealed by a workspace switch is not new, so it gets no
    // opening animation.
    it("does not play a window in when a workspace switch reveals it", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("braceright");
      motionsPlayOut(container);

      press("parenleft");
      motionsPlayOut(container);

      expect(moving(container)).toEqual([]);
    });

    // `target="_blank"`, end to end: the engine opens and lists a browser
    // window at the address, and the desktop draws it with an address bar.
    it("draws a second browser window when the engine opens one", async () => {
      const { container } = await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();
      motionsPlayOut(container);

      domicile.engineOpens("https://example.com/opened");

      // It opens as a tab over the first, which stays drawn under it until it
      // is in.
      expect(windowsOnScreen(container)).toEqual(["Browser", "Browser"]);
      expect(addressesShowing()).toContain("https://example.com/opened");
    });

    // The launcher asks the engine to open the window. The engine owns the
    // page, so a shell loaded over this one draws the same window.
    it("asks the engine for the browser window the launcher opens", async () => {
      await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();

      expect(domicile.calls).toContainEqual([
        "openBrowserWindow",
        "https://example.com",
        "",
      ]);
    });

    it("opens a private browser window from the launcher's private row", async () => {
      await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "!p example.com{Enter}");
      await launched();

      expect(domicile.calls).toContainEqual([
        "openPrivateBrowserWindow",
        "https://example.com",
      ]);
    });

    it("says a private browser window is private", async () => {
      await renderShell();

      domicile.engineOpens("https://example.com/", { isPrivate: true });

      expect(screen.getByText("Private")).toBeInTheDocument();
    });

    // `domicile open --app`, as Settings and History open.
    it("draws an app window without an address bar", async () => {
      const { container } = await renderShell();

      domicile.engineOpens("chrome-extension://settings/settings.html", {
        isApp: true,
      });

      expect(container.querySelector("webview[window='1']")).not.toBeNull();
      expect(
        screen.queryByRole("combobox", { name: "Address" }),
      ).not.toBeInTheDocument();
    });

    // Bitwarden's "Unlock", end to end: `chrome.windows.create` opens a browser
    // window as that window's tab, and the desktop draws it.
    it("opens the window an extension asks for, as that window", async () => {
      const { container } = await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();

      domicile.engineOpens("chrome-extension://vault/popup.html", {
        height: 600,
        popupWindow: 7,
        width: 380,
      });

      expect(windowsOnScreen(container)).toEqual(["Browser", "Browser"]);
      expect(container.querySelector("webview[window='2']")).not.toBeNull();
    });

    it("marks a browser window's title bar with its page's icon", async () => {
      const { container } = await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();
      const view = container.querySelector("webview");
      if (view === null) {
        throw new Error("test: no browser window");
      }

      // `defineProperty` because `favicon` is readonly on the real element.
      Object.defineProperty(view, "favicon", {
        configurable: true,
        value: "https://example.com/icon.svg",
      });
      act(() => {
        view.dispatchEvent(new Event(WEBVIEW_FAVICON_CHANGE_EVENT));
      });

      expect(
        titleBars(container)[0]?.querySelector("img")?.getAttribute("src"),
      ).toBe("https://example.com/icon.svg");
    });

    it("shows a browser tab's whole title and its page's description on hover", async () => {
      const { container } = await renderShell();
      press("space");
      const user = userEvent.setup();
      await user.type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();
      const view = container.querySelector("webview");
      if (view === null) {
        throw new Error("test: no browser window");
      }
      press("w");

      // `defineProperty` because `description` is readonly on the real
      // element.
      Object.defineProperty(view, "description", {
        configurable: true,
        value: "An example page",
      });
      act(() => {
        view.dispatchEvent(new Event(WEBVIEW_DESCRIPTION_CHANGE_EVENT));
      });
      await user.hover(screen.getByText("example.com", { selector: "span" }));

      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent("example.com");
      expect(tooltip).toHaveTextContent("An example page");
    });

    // A video's fullscreen button: the page fills its window, and the window
    // fills the screen until the page leaves fullscreen.
    it("fills the screen with a browser window while its page is fullscreen", async () => {
      const { container } = await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();
      const view = container.querySelector("webview");
      if (view === null) {
        throw new Error("test: no browser window");
      }
      const fullscreens = (fullscreen: boolean) => {
        // `defineProperty` because `pageFullscreen` is readonly on the real
        // element.
        Object.defineProperty(view, "pageFullscreen", {
          configurable: true,
          value: fullscreen,
        });
        act(() => {
          view.dispatchEvent(new Event(WEBVIEW_PAGE_FULLSCREEN_CHANGE_EVENT));
        });
      };
      const tiled = boxOf(browserWindow(container));

      fullscreens(true);
      // A fullscreen page covers the top bar and its own title bar too.
      expect(boxOf(browserWindow(container))).toMatchObject({
        height: "1080px",
        y: "0px",
      });

      fullscreens(false);
      expect(boxOf(browserWindow(container))).toEqual(tiled);
    });

    // `window.close()` or `chrome.tabs.remove`: the engine closes the window,
    // and the desktop stops drawing it.
    it("takes away a browser window the engine closes", async () => {
      const { container } = await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();

      domicile.engineCloses("1");
      motionsPlayOut(container);

      expect(windowsOnScreen(container)).toEqual([]);
    });
  });

  describe("which window has the keyboard", () => {
    it("marks the focused window's bar and leaves the others resting", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      expect(barFor(container, "app:two").dataset.focus).toBe("focused");
      expect(barFor(container, "app:one").dataset.focus).toBe("resting");
    });

    it("moves the mark with the focus", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      press("h");

      expect(barFor(container, "app:one").dataset.focus).toBe("focused");
      expect(barFor(container, "app:two").dataset.focus).toBe("resting");
    });

    it("moves the keyboard to a window whose bar the pointer crosses into", async () => {
      // The bar is part of the window, so crossing onto it moves focus.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      pointerAt(1440, 800);

      crossInto(barFor(container, "app:one"), 300, TOP_BAR + 10);

      expect(barFor(container, "app:one").dataset.focus).toBe("focused");
    });

    it("moves the keyboard to a browser window whose page the pointer crosses into", async () => {
      // The same rule for a guest page: the shell sees the pointer enter its
      // element.
      const { container } = await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();
      clientAppears("one");
      press("e");
      pointerAt(1440, 800);
      const view = container.querySelector<HTMLElement>("webview");
      if (view === null) {
        throw new Error("test: no browser window");
      }

      crossInto(view, 300, 500);

      expect(titleBars(container).map((bar) => bar.dataset.focus)).toEqual([
        "focused",
        "resting",
      ]);
    });

    // The page still gets keys while locked, for the passphrase.
    it("keeps the keyboard out of a browser window's page while locked", async () => {
      const { container } = await renderShell();
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();
      act(() => {
        domicile.set({ locked: true });
      });
      const field = document.createElement("input");
      document.body.append(field);
      field.focus();

      field.remove();
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

      expect(container.querySelector("webview")).not.toHaveFocus();
    });

    it("lights the window being worked in, and rings no window's edge", async () => {
      // Checked by declarations because Panda hashes class names.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");

      expect(lit(container)).toEqual(["app:two"]);
      expect(container.querySelector("[data-selection]")).toBeNull();
      for (const id of ["one", "two"]) {
        expect(appBox(container, id).className).toContain(
          css({ borderColor: "borderStrong" }),
        );
      }
    });

    // A glow at opacity 0 would stay on the page, drawing nothing.
    it("takes the glow focus left off the page once it has faded", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      const left = container.querySelector("[data-focus-box][data-leaving]");
      if (left === null) {
        throw new Error("test: focus left no glow fading");
      }

      // happy-dom's `TransitionEvent` drops `propertyName`.
      fireEvent(
        left,
        Object.assign(new Event("transitionend", { bubbles: true }), {
          propertyName: "opacity",
        }),
      );

      expect(container.querySelector("[data-leaving]")).toBeNull();
    });

    it("lights a window the desk shows alone", async () => {
      const { container } = await renderShell();
      clientAppears("one");

      expect(lit(container)).toEqual(["app:one"]);
    });

    it("lights only the screen being worked in", async () => {
      // Each screen shows one window, but the commands target only one.
      const { container } = await renderShell([LEFT, RIGHT]);
      clientAppears("one");
      clientAppears("two");
      press("parenright", true);

      expect(lit(container)).toEqual(["app:one"]);
    });
  });

  describe("the keys, as the sway config binds them", () => {
    it("claims every chord it answers from the compositor", async () => {
      // So presses reach the shell while a `<webview>` has the keyboard.
      await renderShell();

      expect(domicile.calls).toContainEqual(["grabShortcut", "Meta+Return"]);
    });

    it("binds sway's keys when it is given none", async () => {
      await renderingShell([LEFT], undefined, {
        keybindings: DEFAULT_KEYBINDINGS,
      });
      clientAppears("term");

      press("q", true);

      expect(domicile.calls).toContainEqual(["closeApp", "term"]);
    });

    it("runs what `exec` names on the chord the config names", async () => {
      await renderShell();

      press("Return");

      expect(domicile.calls).toContainEqual(["spawn", ["kitty"]]);
    });

    it("switches the keymap with `keymap`, and says which it switched to", async () => {
      await renderShell();
      /** Answer the system call `call` as the compositor would. */
      const answer = (call: object, ...lines: object[]) => {
        const [, id] =
          domicile.calls.findLast(
            ([method, , request]) =>
              method === "callSystem" && request === JSON.stringify(call),
          ) ?? [];
        for (const line of lines) {
          domicile.fake.dispatch("system", {
            data: JSON.stringify({ id, ...line }),
          });
        }
      };
      const keymaps = (active: string) => ({
        event: {
          active,
          keymaps: [
            { description: "English (programmer Dvorak)", name: "dvp" },
            { description: "English (US)", name: "us" },
          ],
          kind: "keymaps",
        },
        type: "system_event",
      });
      const settled = () => new Promise((done) => setTimeout(done, 0));
      await act(async () => {
        answer(
          { call: "keymaps" },
          {
            reply: { kind: "started" },
            type: "system_reply",
          },
        );
        await settled();
        answer({ call: "keymaps" }, keymaps("dvp"));
        await settled();
      });

      await act(async () => {
        press("t");
        await settled();
        answer(
          { call: "select_keymap", keymap: { kind: "next" } },
          { reply: { kind: "set" }, type: "system_reply" },
        );
        answer({ call: "keymaps" }, keymaps("us"));
        await settled();
      });

      expect(screen.getByRole("status")).toHaveTextContent(
        "KeymapusEnglish (US)",
      );
    });

    it("moves the focus with the direction keys", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      press("h");

      // The focused look on the bar is the only on-screen focus indicator.
      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
      expect(faceOf(barFor(container, "app:one")).className).not.toBe(
        faceOf(barFor(container, "app:two")).className,
      );
    });

    // On the compositor's thread, as their windows' contents move.
    it("slides tabs moved along their strip over to their new places", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      motionsPlayOut(container);

      press("h", true);

      expect(barFor(container, "app:two").getAnimations()).toHaveLength(1);
      expect(barFor(container, "app:one").getAnimations()).toHaveLength(1);
    });

    it("slides a dragged tab into the slot it moves to along its strip", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      motionsPlayOut(container);
      const y = TOP_BAR + TOP_GAP + TITLE_BAR / 2;

      fireEvent.pointerDown(barFor(container, "app:one"), {
        clientX: GAP + 100,
        clientY: y,
      });
      fireEvent.pointerMove(window, { clientX: GAP + 400, clientY: y });

      expect(tabOrder(container)).toEqual(["app:two", "app:one"]);
      expect(barFor(container, "app:one").getAnimations()).toHaveLength(1);
    });

    it("moves a window through the tiling with Shift held", async () => {
      // A group of two beside a lone window: `focus parent` selects the group.
      // It goes in as a tab of the window's group, past it, then out beside.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      clientAppears("three");
      press("b");
      press("h");
      press("a");

      press("l", true);
      press("l", true);
      press("l", true);

      expect(boxOf(appBox(container, "three"))).toMatchObject({ x: "20px" });
      expect(boxOf(appBox(container, "two"))).toMatchObject({ x: "970px" });
    });

    it("splits a window out of its group, and back in as a tab", async () => {
      // `mod+v` moves the window out below its group. Alone in its own group,
      // moving it back joins the group as a tab instead of swapping.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      press("v");
      expect(boxOf(appBox(container, "two"))).toMatchObject({
        width: "1880px",
        y: `${(TOP_BAR + TOP_GAP + 499 + 20 + TITLE_BAR - SURFACE_TUCK).toString()}px`,
      });

      press("k", true);

      expect(tabOrder(container)).toEqual(["app:one", "app:two"]);
      expect(windowsOnScreen(container)).toEqual(["two"]);
    });

    it("lays the container out in tabs, which are the windows' own bars", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      press("w");

      // One tab each across the top, at most 240px wide, in one strip. Only
      // the focused tab's contents are drawn, so the other client stops
      // drawing.
      expect(boxOf(barFor(container, "app:one"))).toMatchObject({
        width: "240px",
        x: "20px",
      });
      expect(windowsOnScreen(container)).toEqual(["two"]);
    });

    it("lights the whole group `focus parent` selects, and back", async () => {
      // `mod+a` targets the container around the focus, and this highlight is
      // the only indication of which container.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      expect(lit(container)).toEqual(["app:two"]);
      expect(tinted(container)).toBeUndefined();

      // Past the group of one the window is in, to the split.
      press("a");
      press("a");

      // The glow takes in every window in it and a tint covers them all.
      // Each bar is a tab, which keeps its own state.
      expect(lit(container)).toEqual(["app:one", "app:two"]);
      expect(tinted(container)).toBe(glowBox(container));
      expect(barFor(container, "app:two").dataset.focus).toBe("focused");
      // `mod+Shift+a` returns to the window.
      press("a", true);
      press("a", true);
      expect(lit(container)).toEqual(["app:two"]);
      expect(tinted(container)).toBeUndefined();
      expect(barFor(container, "app:two").dataset.focus).toBe("focused");
    });

    it("tints a selected tab group, leaving its tabs' states", async () => {
      // The tabs keep showing which one is open and has the keyboard. A
      // sibling window keeps the tabs from filling the screen.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      press("v");
      clientAppears("three");
      press("w");
      // A focused tab lights its whole group too, so only the tint tells
      // the two apart.
      expect(lit(container)).toEqual(["app:two", "app:three"]);
      expect(tinted(container)).toBeUndefined();

      press("a");

      expect(lit(container)).toEqual(["app:two", "app:three"]);
      expect(tinted(container)).toBe(glowBox(container));
      expect(barFor(container, "app:two").dataset.focus).toBe("resting");
      expect(barFor(container, "app:three").dataset.focus).toBe("focused");
    });

    it("tints the open tab, which stands over the rest of its strip", async () => {
      // A sibling window keeps the tabs from filling the screen.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      press("v");
      clientAppears("three");
      press("w");

      press("a");

      // Drawn after every tab, so an equal depth covers the open tab too.
      expect(
        Number(
          container.querySelector<HTMLElement>("[data-selection]")?.style
            .zIndex,
        ),
      ).toBeGreaterThanOrEqual(
        Number(barFor(container, "app:three").style.zIndex),
      );
    });

    it("offers to tile a floating group from the tab that stands for it", async () => {
      // A tabbed container holding a row, floated whole.
      await renderShell();
      clientAppears("one");
      clientAppears("two");
      clientAppears("three");
      press("v");
      press("k");
      press("b");
      press("a");
      press("j", true);
      press("a");
      press("Tab", true);

      expect(screen.getByRole("img", { name: "Row of 2" })).toBeDefined();
      expect(screen.queryAllByRole("button", { name: "Float" })).toEqual([]);
    });

    it("runs the window's top edge along the strip, under all but the open tab", async () => {
      // A sibling window keeps the tabs from filling the screen.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      press("v");
      clientAppears("three");

      press("w");

      // The strip draws the line; the open tab covers it to join its window.
      const covers = css({ marginBlockEnd: "-1px" });
      expect(faceOf(barFor(container, "app:two")).className).not.toContain(
        covers,
      );
      expect(faceOf(barFor(container, "app:three")).className).toContain(
        covers,
      );
    });

    it("grows the glow in with the window that opened", async () => {
      // A full-size glow around a growing window would stick out past it.
      // It opens beside the selected split, in a box of its own.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("b");
      press("a");
      press("a");
      clientAppears("three");

      expect(glowing(container).className).toContain(
        movingStyles({ motion: "opening" }),
      );
    });

    it("keeps the group when the layout slides a window under the pointer", async () => {
      // Moving a group slides windows under a still pointer, and each fires
      // `pointerover` at the pointer's spot. Following those would hand focus,
      // and the selection, to whichever window passed by.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("v");
      clientAppears("three");
      pointerAt(1440, 800);

      // In as a tab of one's group, past it, then out to its left.
      press("a");
      press("h", true);
      press("h", true);
      press("h", true);

      crossInto(appElement(container, "one"), 1440, 800);
      expect(pointedAtGroup(container)).toBe(true);
    });

    it("knows its own warp, at a place that is not a whole pixel", async () => {
      // Thirds of the workspace are not whole pixels, and the engine rounds
      // the warp (`base::ClampRound`). The page must still recognize its own
      // warp, or it treats the window under the cursor as a user's choice.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      clientAppears("three");
      clientAppears("four");
      press("b");
      press("h");
      press("b");
      press("h");
      pointerAt(1700, 900);

      // Move the group of one and two to the last of three.
      press("a");
      press("l", true);
      press("l", true);

      // The cursor lands on a rounded pixel over a window outside the group.
      // Only this rule keeps the crossing from taking the selection.
      const [x, y] = warpedTo();
      crossInto(appElement(container, "four"), Math.round(x), Math.round(y));

      expect(pointedAtGroup(container)).toBe(true);
    });

    it("and hands it over to a pointer that really crossed into one", async () => {
      // A crossing at a point the pointer was not at is the user choosing a
      // window, and choosing one outside the group leaves it. The browser fires
      // `pointerover` before the move, so the desktop must act on it alone.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      press("v");
      clientAppears("three");
      pointerAt(1440, 800);

      press("a");
      press("h", true);
      press("h", true);
      press("h", true);

      crossInto(appElement(container, "one"), 1700, 500);
      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
      expect(pointedAtGroup(container)).toBe(false);
    });

    it("fills the screen with the window being worked in", async () => {
      const { container } = await renderShell();
      clientAppears("term");

      press("f");

      // A fullscreen window covers the top bar too.
      expect(boxOf(appBox(container, "term"))).toMatchObject({
        height: `${(1080 - TITLE_BAR + SURFACE_TUCK).toString()}px`,
        y: `${(TITLE_BAR - SURFACE_TUCK).toString()}px`,
      });
    });

    it("squares the corners of the window filling the screen", async () => {
      const { container } = await renderShell();
      clientAppears("term");

      press("f");

      expect(appBox(container, "term").className).not.toContain(
        css({ borderEndEndRadius: "lg" }),
      );
      expect(barFor(container, "app:term").className).not.toContain(
        css({ borderStartStartRadius: "lg" }),
      );
    });

    it("spreads a global fullscreen across every screen", async () => {
      const { container } = await renderShell([LEFT, RIGHT]);
      clientAppears("term");

      press("f", true);

      expect(boxOf(appBox(container, "term"))).toMatchObject({
        width: `${(1920 + 1280).toString()}px`,
      });
    });

    it("sends a window to another workspace and stays put", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      press("parenright", true);

      // `two` animates off the screen first.
      expect(windowsOnScreen(container)).toEqual(["one", "two"]);
      motionsPlayOut(container);
      expect(windowsOnScreen(container)).toEqual(["one"]);
      press("parenright");
      // After the old workspace finishes sliding off, which keeps `one` drawn.
      motionsPlayOut(container);
      expect(windowsOnScreen(container)).toEqual(["two"]);
    });

    it("goes back to the last workspace when the same key is pressed", async () => {
      // `workspaceAutoBackAndForth = true`.
      const { container } = await renderShell();
      clientAppears("term");

      press("parenright");
      press("parenright");

      expect(windowsOnScreen(container)).toEqual(["term"]);
    });

    it("closes the window being worked in", async () => {
      await renderShell();
      clientAppears("term");

      press("q", true);

      expect(domicile.calls).toContainEqual(["closeApp", "term"]);
    });
  });

  describe("floating windows", () => {
    it("opens a dialog at the size it drew, with a title bar", async () => {
      const { container } = await renderShell();
      domicile.appear("pin", { dialog: true, height: 300, width: 400 });

      expect(boxOf(appBox(container, "pin"))).toMatchObject({
        height: "300px",
        width: "400px",
      });
      expect(barFor(container, "app:pin")).toBeDefined();
    });

    it("opens a dialog that draws its own frame with no title bar", async () => {
      const { container } = await renderShell();
      domicile.appear("huddle", {
        clientFrame: true,
        dialog: true,
        height: 300,
        width: 400,
      });

      expect(boxOf(appBox(container, "huddle"))).toMatchObject({
        height: "300px",
        width: "400px",
      });
      expect(() => barFor(container, "app:huddle")).toThrow("no title bar");
    });

    it("takes a window out of the tiling and puts it back", async () => {
      const { container } = await renderShell();
      clientAppears("term");

      press("Tab", true);

      // Its own box over the tiling, not the whole workspace.
      const floated = boxOf(appBox(container, "term"));
      expect(floated.width).not.toBe(`${(1920 - 2 * GAP).toString()}px`);
      expect(Number(appBox(container, "term").style.zIndex)).toBeGreaterThan(0);

      press("Tab", true);
      expect(boxOf(appBox(container, "term"))).toMatchObject({
        width: `${(1920 - 2 * GAP).toString()}px`,
      });
    });

    it("floats a window no smaller than its client will draw", async () => {
      // Wider than the default float width of 1280 and shorter than its 770,
      // so both limits apply.
      const { container } = await renderShell();
      clientAppears("vault");
      domicile.change("vault", {
        maxHeight: 350,
        maxWidth: 1400,
        minHeight: 300,
        minWidth: 1300,
      });

      press("Tab", true);

      expect(boxOf(appBox(container, "vault"))).toMatchObject({
        height: "350px",
        width: "1300px",
      });
    });

    it("keeps a window's bar across floating it and back", async () => {
      // The window eases to its new box; a new bar would jump there instead.
      const { container } = await renderShell();
      clientAppears("term");
      const tiled = barFor(container, "app:term");

      press("Tab", true);
      expect(barFor(container, "app:term")).toBe(tiled);

      press("Tab", true);
      expect(barFor(container, "app:term")).toBe(tiled);
    });

    it("swaps the keyboard between the floating window and the tiling", async () => {
      await renderShell();
      clientAppears("one");
      clientAppears("two");

      press("Tab", true);
      domicile.calls.length = 0;
      press("Tab");

      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
    });

    it("puts a sheet over a float to catch a drag while the modifier is held", async () => {
      // The client owns the pointer over its surface, so the shell needs a
      // sheet on top to receive the drag.
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);

      // The floating chord held the modifier; release it first.
      pageHolds({});
      expect(grabSheets(container)).toHaveLength(0);

      pageHolds({ meta: true });
      expect(grabSheets(container)).toHaveLength(1);
    });

    it("takes the sheet down when Meta comes up", async () => {
      // Chromium on Wayland reports Meta's release with `metaKey` still set,
      // so the flag alone would leave the modifier stuck.
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);

      fireEvent.keyUp(document, {
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
      });

      expect(grabSheets(container)).toHaveLength(0);
    });

    it("moves a floating window by its title bar, with no modifier held", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);
      const bar = barFor(container, "app:term");
      const was = Number.parseFloat(bar.style.insetInlineStart);

      fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 });
      fireEvent.pointerMove(window, { clientX: 140, clientY: 100 });
      fireEvent.pointerUp(window, { clientX: 140, clientY: 100 });

      expect(
        Number.parseFloat(barFor(container, "app:term").style.insetInlineStart),
      ).toBe(was + 40);
    });

    it("keeps the resize cursor while Meta+Shift resizes a float", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);
      pageHolds({ meta: true, shift: true });
      const [sheet] = grabSheets(container);

      fireEvent.pointerDown(sheet as HTMLElement, {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, { clientX: 140, clientY: 130 });

      expect(() => grabbingSheet(container)).toThrow();
    });

    it("resizes a floating window by its edge, with no modifier held", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);
      pageHolds({});
      const was = Number.parseFloat(floatShadow(container).style.inlineSize);

      fireEvent.pointerDown(rightBorder(container), {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, {
        buttons: 1,
        clientX: 140,
        clientY: 130,
      });
      fireEvent.pointerUp(window, { clientX: 140, clientY: 130 });

      expect(Number.parseFloat(floatShadow(container).style.inlineSize)).toBe(
        was + 40,
      );
    });

    it("marks a window resizing while its edge is dragged", async () => {
      // The engine then stops holding the desktop's frame for the client.
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);
      pageHolds({});

      fireEvent.pointerDown(rightBorder(container), {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, {
        buttons: 1,
        clientX: 140,
        clientY: 130,
      });
      expect(appElement(container, "term").hasAttribute("resizing")).toBe(true);

      fireEvent.pointerUp(window, { clientX: 140, clientY: 130 });
      expect(appElement(container, "term").hasAttribute("resizing")).toBe(
        false,
      );
    });

    describe("while an edge is dragged", () => {
      // Click-through is a style, so these read the shell's stylesheet.
      loadEmittedStylesheet(
        document,
        new URL("../styled-system/styles.css", import.meta.url),
      );

      it("keeps windows taking the pointer", async () => {
        // The edge holds the pointer, so the drag needs no click-through. A
        // window made click-through takes the pointer back only at the
        // engine's next frame, so moves and clicks just after the release
        // would go to the desktop instead of the page under them.
        const { container } = await renderShell();
        clientAppears("term");
        press("Tab", true);
        pageHolds({});

        fireEvent.pointerDown(rightBorder(container), {
          clientX: 100,
          clientY: 100,
        });
        fireEvent.pointerMove(window, {
          buttons: 1,
          clientX: 140,
          clientY: 130,
        });

        expect(passesPointer(appElement(container, "term"), container)).toBe(
          false,
        );

        fireEvent.pointerUp(window, { clientX: 140, clientY: 130 });
      });
    });

    it("does not mark a window resizing while it is moved", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);

      fireEvent.pointerDown(barFor(container, "app:term"), {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, { clientX: 140, clientY: 100 });

      expect(appElement(container, "term").hasAttribute("resizing")).toBe(
        false,
      );
    });

    it("resizes a float's window with the pointer rather than easing after it", async () => {
      // An eased window would trail the pointer; see `useSettling`.
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);
      pageHolds({});
      // A window plays its motion out before it settles.
      motionsPlayOut(container);

      fireEvent.pointerDown(rightBorder(container), {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, { clientX: 140, clientY: 130 });

      for (const part of [
        appBox(container, "term"),
        barFor(container, "app:term"),
        floatShadow(container),
        glowing(container),
      ]) {
        expect(part.getAnimations()).toHaveLength(0);
      }
    });

    it("keeps a float's glow on it while it is dragged rather than easing after it", async () => {
      // A transitioning glow would trail the window during a drag.
      const { container } = await renderShell();
      clientAppears("shell");
      clientAppears("term");
      press("Tab", true);
      const bar = barFor(container, "app:term");

      fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 });
      fireEvent.pointerMove(window, { clientX: 140, clientY: 100 });

      expect(glowing(container).getAnimations()).toHaveLength(0);
    });

    // A tab easing after its group would trail the pointer.
    it("carries every tab of a dragged floating group with it at once", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      press("Tab", true);
      clientAppears("two");
      motionsPlayOut(container);
      const parts = () => [
        barFor(container, "app:one"),
        barFor(container, "app:two"),
        ...container.querySelectorAll<HTMLElement>("[data-strip]"),
      ];
      expect(parts()).toHaveLength(3);
      const before = parts().map((part) => part.style.insetInlineStart);

      fireEvent.pointerDown(stripEndOf(container, "app:two"), {
        clientX: 600,
        clientY: 60,
      });
      fireEvent.pointerMove(window, { clientX: 700, clientY: 100 });

      expect(parts().map((part) => part.style.insetInlineStart)).not.toEqual(
        before,
      );
      for (const part of parts()) {
        expect(part.getAnimations()).toHaveLength(0);
        expect(globalThis.getComputedStyle(part).transition).not.toContain(
          "inset",
        );
      }
    });

    it("drags a floating window onto the next screen and keeps hold of it", async () => {
      // The screen under the float's center takes it, and the drag continues
      // after its bar leaves the pressed screen.
      const { container } = await renderShell([LEFT, RIGHT]);
      clientAppears("term");
      press("Tab", true);
      const was = Number.parseFloat(
        barFor(container, "app:term").style.insetInlineStart,
      );

      fireEvent.pointerDown(barFor(container, "app:term"), {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, {
        clientX: 100 + LEFT.width,
        clientY: 100,
      });
      fireEvent.pointerMove(window, {
        clientX: 110 + LEFT.width,
        clientY: 100,
      });
      fireEvent.pointerUp(window, { clientX: 110 + LEFT.width, clientY: 100 });

      expect(
        Number.parseFloat(barFor(container, "app:term").style.insetInlineStart),
      ).toBe(was + LEFT.width + 10);
    });

    it("keeps a dragged float focused and on top while only the pointer is on the next screen", async () => {
      // The sheet that shows the grab cursor is under the pointer, not the
      // window, so it must not read as the bare desk.
      const { container } = await renderShell([LEFT, RIGHT]);
      pointerAt(2000, 500);
      clientAppears("other");
      press("Tab", true);
      pointerAt(500, 500);
      clientAppears("term");
      press("Tab", true);

      fireEvent.pointerDown(barFor(container, "app:term"), {
        clientX: LEFT.width - 50,
        clientY: 100,
      });
      // The first move pulls the float, which puts the sheet up.
      fireEvent.pointerMove(window, { clientX: LEFT.width - 40, clientY: 100 });
      const sheet = grabbingSheet(container);
      domicile.calls.length = 0;
      fireEvent.pointerMove(sheet, { clientX: LEFT.width + 10, clientY: 100 });

      expect(domicile.calls).not.toContainEqual(["focusApp", "other"]);
      expect(
        Number(barFor(container, "app:term").style.zIndex),
      ).toBeGreaterThan(Number(barFor(container, "app:other").style.zIndex));
    });

    it("drags a browser window onto the next screen without loading its page again", async () => {
      // One `<webview>` throughout; a new one would reload the page.
      const { container } = await renderShell([LEFT, RIGHT]);
      press("space");
      await userEvent
        .setup()
        .type(screen.getByRole("combobox"), "example.com{Enter}");
      await launched();
      press("Tab", true);
      const view = container.querySelector("webview");

      fireEvent.pointerDown(barFor(container, "browser:1"), {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, {
        clientX: 100 + LEFT.width,
        clientY: 100,
      });
      fireEvent.pointerUp(window, { clientX: 100 + LEFT.width, clientY: 100 });

      expect(container.querySelectorAll("webview")).toHaveLength(1);
      expect(container.querySelector("webview")).toBe(view);
    });

    it("draws a float over the edge between two screens once, whole", async () => {
      // One page spans the desk, so a float across two screens is one element.
      const { container } = await renderShell([LEFT, RIGHT]);
      clientAppears("term");
      press("Tab", true);
      const was = Number.parseFloat(
        barFor(container, "app:term").style.insetInlineStart,
      );

      fireEvent.pointerDown(barFor(container, "app:term"), {
        clientX: 100,
        clientY: 100,
      });
      fireEvent.pointerMove(window, { clientX: 1500, clientY: 100 });
      fireEvent.pointerUp(window, { clientX: 1500, clientY: 100 });

      expect(
        container.querySelectorAll(`:not([hidden]) > ${APP_TAG_NAME}`),
      ).toHaveLength(1);
      expect(
        Number.parseFloat(barFor(container, "app:term").style.insetInlineStart),
      ).toBe(was + 1400);
    });

    it("draws a fullscreen float's bar at the top of the screen", async () => {
      const user = userEvent.setup();
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);

      await user.click(screen.getByRole("button", { name: "Maximize" }));

      expect(boxOf(barFor(container, "app:term"))).toMatchObject({
        width: "1920px",
        x: "0px",
        y: "0px",
      });
    });

    it("keys a floating window around the desktop instead of retiling it", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);
      const was = Number.parseFloat(
        appBox(container, "term").style.insetInlineStart,
      );

      press("l", true);

      expect(
        Number.parseFloat(appBox(container, "term").style.insetInlineStart),
      ).toBeGreaterThan(was);
    });

    it("casts a shadow under a floating window and not under a tiled one", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      expect(shadows(container)).toHaveLength(0);

      press("Tab", true);

      // Around the whole frame, at the window's depth, and earlier in the
      // document so each window paints over only its own shadow.
      const shadow = floatShadow(container);
      const app = appBox(container, "term");
      const bar = barFor(container, "app:term");
      const top = Number.parseFloat(bar.style.insetBlockStart);
      const bottom =
        Number.parseFloat(app.style.insetBlockStart) +
        Number.parseFloat(app.style.blockSize);
      expect(boxOf(shadow)).toEqual({
        height: `${(bottom - top).toString()}px`,
        width: app.style.inlineSize,
        x: app.style.insetInlineStart,
        y: bar.style.insetBlockStart,
      });
      expect(shadow.style.zIndex).toBe(app.style.zIndex);
      expect(shadow.compareDocumentPosition(app)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );

      press("Tab", true);
      expect(shadows(container)).toHaveLength(0);
    });

    it("rounds its shadow at all four corners, as the frame is", async () => {
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);

      expect(floatShadow(container).className).toContain(
        css({ borderRadius: "lg" }),
      );
    });

    it("casts no shadow from a float that fills the screen", async () => {
      // Its shadow would spill onto the next display.
      const { container } = await renderShell();
      clientAppears("term");
      press("Tab", true);

      press("f");

      expect(shadows(container)).toHaveLength(0);
    });

    it("stacks each float over the one behind it", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("Tab", true);
      press("Tab");
      press("Tab", true);

      expect(Number(appBox(container, "one").style.zIndex)).toBeGreaterThan(
        Number(appBox(container, "two").style.zIndex),
      );
    });
    it("shuffles a float pressed on over the one covering it", async () => {
      // The two move apart, swap depths, and return, every part of each
      // window included.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("Tab", true);
      press("Tab");
      press("Tab", true);
      motionsPlayOut(container);
      const under = appBox(container, "two");
      expect(Number(under.style.zIndex)).toBeLessThan(
        Number(appBox(container, "one").style.zIndex),
      );

      fireEvent.pointerDown(barFor(container, "app:two"), {
        clientX: 100,
        clientY: 100,
      });

      const raised = [
        appBox(container, "two"),
        barFor(container, "app:two"),
        glowing(container),
      ];
      const covered = [appBox(container, "one"), barFor(container, "app:one")];
      for (const element of [...raised, ...covered]) {
        expect(element.style.getPropertyValue("--restack-x")).not.toBe("");
      }
      const restacking = movingParts(container, "restacking");
      expect(
        restacking.filter(
          (element) =>
            element.dataset.shadow === undefined &&
            element.dataset.strip === undefined,
        ),
      ).toEqual([
        appBox(container, "one"),
        appBox(container, "two"),
        barFor(container, "app:one"),
        barFor(container, "app:two"),
      ]);
      // Each float's strip goes with it.
      expect(
        restacking.filter((element) => element.dataset.strip !== undefined),
      ).toHaveLength(2);
      for (const element of raised) {
        expect(
          Number(element.style.getPropertyValue("--restack-to")),
        ).toBeGreaterThan(
          Number(element.style.getPropertyValue("--restack-from")),
        );
      }
      expect(
        [...shadows(container)].map((shadow) =>
          shadow.style.getPropertyValue("--restack-x"),
        ),
      ).not.toContain("");
    });

    it("starts the glow's shuffle over with its window's", async () => {
      // Each press restarts the animation, for the glow as well as windows.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("Tab", true);
      press("Tab");
      press("Tab", true);
      motionsPlayOut(container);

      for (const id of ["two", "one"]) {
        fireEvent.pointerDown(barFor(container, `app:${id}`), {
          clientX: 100,
          clientY: 100,
        });
        fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
      }

      expect(appBox(container, "one").dataset.motion).toBe("restacking-again");
      expect(glowing(container).className).toContain(
        movingStyles({ motion: "restacking-again" }),
      );
    });
  });

  describe("the scratchpad", () => {
    it("takes a window off the desktop and brings it back floating", async () => {
      const { container } = await renderShell();
      clientAppears("term");

      press("minus", true);
      // It slides off the top of the screen first.
      expect(appBox(container, "term")).toHaveAttribute(
        "data-motion",
        "stowing",
      );
      motionsPlayOut(container);
      expect(windowsOnScreen(container)).toEqual([]);

      press("minus");
      expect(appBox(container, "term")).toHaveAttribute(
        "data-motion",
        "dropping",
      );
      expect(Number(appBox(container, "term").style.zIndex)).toBeGreaterThan(0);
    });
    // It hangs from the top edge, so its top corners are square.
    it("hangs a window it shows from the top edge of the screen", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("minus", true);
      motionsPlayOut(container);

      press("minus");

      expect(floatShadow(container).className).not.toContain(
        css({ borderRadius: "lg" }),
      );
    });

    it("dims the screen under a window it shows, which a press there hides", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("minus", true);
      motionsPlayOut(container);
      press("minus");
      // It fades with the window's slide.
      expect(scratchpadBackdrop(container).dataset.motion).toBe("dropping");
      motionsPlayOut(container);
      const backdrop = scratchpadBackdrop(container);
      // Over every title bar under it, by document order at equal depths.
      const bar = barFor(container, "app:one");

      expect(Number(backdrop.style.zIndex)).toBeLessThan(
        Number(appBox(container, "two").style.zIndex),
      );
      expect(Number(backdrop.style.zIndex)).toBeGreaterThanOrEqual(
        Number(bar.style.zIndex),
      );
      expect(
        bar.compareDocumentPosition(backdrop) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.pointerDown(backdrop);
      expect(appBox(container, "two")).toHaveAttribute(
        "data-motion",
        "stowing",
      );
      expect(backdrop.dataset.motion).toBe("stowing");
      motionsPlayOut(container);
      expect(container.querySelector("[data-scratchpad-backdrop]")).toBeNull();
    });

    it("keeps the focus ring on the window under a scratchpad window", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("minus", true);
      motionsPlayOut(container);

      press("minus");

      expect(glowing(container).dataset.focusBox).toBe("app:one");
    });
  });

  describe("focus follows the cursor", () => {
    it("takes the pointer to a window that has just opened", async () => {
      // The window took focus without a key press. The pointer is still over
      // the previous window, and the next pointer event would take focus
      // back.
      // It opens beside the selected split, in a box of its own.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("b");
      press("a");
      press("a");
      pointerAt(485, 566);
      domicile.calls.length = 0;

      clientAppears("three");

      expect(warpedTo()).toStrictEqual([1594, 566]);
      expect(boxOf(appBox(container, "three"))).toMatchObject({
        height: "989px",
        width: "613px",
        x: "1287px",
        y: "71px",
      });
    });

    it("takes the pointer with it when a key moves the focus", async () => {
      // sway's `mouse_warping`: otherwise the next pointer event over the old
      // window would take focus back. The pointer goes to the center of the
      // window's contents, below its title bar.
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      domicile.calls.length = 0;

      press("h");

      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
      expect(warpedTo()).toStrictEqual([485, 566]);
      expect(boxOf(appBox(container, "one"))).toMatchObject({
        height: "989px",
        width: "930px",
        x: "20px",
        y: "71px",
      });
    });

    it("takes the pointer to the middle of an empty screen a key moved to", async () => {
      // sway's `focus right` onto an empty output. Otherwise the pointer on
      // the old screen would take focus back.
      await renderShell([LEFT, RIGHT]);
      clientAppears("one");
      domicile.calls.length = 0;

      press("l");

      expect(warpedTo()).toStrictEqual([2560, 512]);
    });

    it("gives the keyboard to the window the pointer moves into", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("e");
      domicile.calls.length = 0;

      act(() => {
        appElement(container, "one").dispatchEvent(
          new MouseEvent("pointerover", { bubbles: true }),
        );
      });

      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
    });

    describe("while Meta is held", () => {
      // Meta covers each window with a sheet that catches drags, so the
      // pointer enters the sheet instead of the window.
      const sheetOver = (container: HTMLElement, id: string): HTMLElement => {
        const sheet = grabSheets(container).find(
          (grab) => grab.getAttribute("data-window") === id,
        );
        if (sheet === undefined) {
          throw new Error(`test: no sheet over ${id}`);
        } else {
          return sheet;
        }
      };

      // A tiled window and a float, so no tiled border counts as a sheet.
      const renderHeld = async (): Promise<HTMLElement> => {
        const { container } = await renderShell();
        clientAppears("one");
        clientAppears("two");
        press("Tab", true);
        pageHolds({ meta: true });
        return container;
      };

      it("gives the keyboard to the tiled window the pointer moves into", async () => {
        const container = await renderHeld();
        domicile.calls.length = 0;

        crossInto(sheetOver(container, "app:one"), 300, 300);

        expect(domicile.calls).toContainEqual(["focusApp", "one"]);
      });

      it("gives the keyboard to the floating window the pointer moves into", async () => {
        const container = await renderHeld();
        crossInto(sheetOver(container, "app:one"), 300, 300);
        domicile.calls.length = 0;

        crossInto(sheetOver(container, "app:two"), 900, 500);

        expect(domicile.calls).toContainEqual(["focusApp", "two"]);
      });
    });

    it("leaves the keyboard where it is when the pointer lands on the chrome", async () => {
      // The bar, wallpaper and float decorations are not windows; taking focus
      // for them would make the desktop untypeable.
      const { container } = await renderShell();
      clientAppears("term");
      domicile.calls.length = 0;

      act(() => {
        barFor(container, "app:term").dispatchEvent(
          new MouseEvent("pointerover", { bubbles: true }),
        );
      });

      expect(domicile.calls).toEqual([]);
    });

    it("grants a client that asks for the keyboard over xdg-activation", async () => {
      await renderShell();
      clientAppears("one");
      clientAppears("two");
      press("parenright");
      domicile.calls.length = 0;

      domicile.dispatch("focusrequested", { appId: "one" });

      // Granted, and its workspace is switched to.
      expect(domicile.calls).toContainEqual(["focusApp", "one"]);
      expect(screen.getByRole("button", { name: "1" })).toHaveAttribute(
        "aria-current",
        "true",
      );
    });

    it("moves the keyboard to the screen the pointer moves onto", async () => {
      // As in sway, even an empty screen takes focus, so the next window opens
      // where the pointer is.
      const { container } = await renderShell([LEFT, RIGHT]);

      pointerAt(2000, 500);
      clientAppears("term");

      // Shown there, not only assigned.
      const term = appBox(container, "term");
      expect(term).not.toHaveAttribute("hidden");
      expect(
        Number.parseFloat(term.style.insetInlineStart),
      ).toBeGreaterThanOrEqual(RIGHT.x);
    });

    it("follows the seat when the compositor moves the keyboard itself", async () => {
      const { container } = await renderShell();
      clientAppears("one");
      clientAppears("two");

      domicile.set({ focusedWindow: "one" });

      expect(faceOf(barFor(container, "app:one")).className).not.toBe(
        faceOf(barFor(container, "app:two")).className,
      );
    });
  });
});

describe("the overview", () => {
  const overview = (): HTMLElement | null =>
    screen.queryByRole("dialog", { name: "Workspaces" });

  it("opens on mod+o with a tile per workspace, the shown one current", async () => {
    await renderShell();
    clientAppears("one");

    press("o");

    expect(overview()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Workspace 1" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("opens from the workspace switcher's button", async () => {
    await renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));

    expect(overview()).not.toBeNull();
  });

  it("shows the workspace picked from it", async () => {
    await renderShell();
    clientAppears("one");
    press("parenright", true);
    press("o");

    fireEvent.click(screen.getByRole("button", { name: "Workspace 2" }));

    expect(overview()).toBeNull();
    expect(screen.getByRole("button", { name: "2" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("steps between workspaces on mod+h/j/k/l and swaps them with shift, leaving windows alone", async () => {
    const { container } = await renderShell();
    clientAppears("one");
    press("parenright");
    clientAppears("two");
    press("o");

    press("h");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Workspace 1" }),
    );
    // Workspace 1's windows trade places with 2's, which stay on screen.
    press("l", true);
    fireEvent.keyDown(overview() ?? document, { key: "Escape" });
    // The closing fade plays out.
    const backdrop = container.querySelector("[data-overview-backdrop]");
    if (backdrop !== null) {
      fireEvent.animationEnd(backdrop);
    }

    expect(windowsOnScreen(container)).toEqual(["two"]);
    expect(screen.getByRole("button", { name: "1" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("has the engine show a hidden workspace's windows as they come in, without waiting for them to draw", async () => {
    // Out of view, a window's surface is let go; coming back, the engine
    // would hold the desktop's frame for it to draw again.
    const { container } = await renderShell();
    clientAppears("one");
    press("parenright");
    clientAppears("two");
    press("parenleft");

    press("o");
    expect(appElement(container, "two").hasAttribute("resizing")).toBe(true);
    expect(appElement(container, "one").hasAttribute("resizing")).toBe(false);

    fireEvent.keyDown(overview() ?? document, { key: "Escape" });
    expect(appElement(container, "two").hasAttribute("resizing")).toBe(false);
  });

  it("closes on Escape", async () => {
    await renderShell();
    press("o");

    fireEvent.keyDown(overview() ?? document, { key: "Escape" });

    expect(overview()).toBeNull();
  });
});

describe("the launcher", () => {
  /**
   * The launcher's box, matched by name because a browser window's address
   * bar is also a combobox.
   */
  const launcherBox = (): HTMLElement | null =>
    screen.queryByRole("combobox", {
      name: "Open an app, a file, a URL, or search",
    });

  /** Types into the launcher's box, which must be open. */
  const typeIntoLauncher = async (typed: string): Promise<void> => {
    await userEvent.setup().type(
      screen.getByRole("combobox", {
        name: "Open an app, a file, a URL, or search",
      }),
      typed,
    );
  };

  /** Each URL the desktop asked the engine to open. */
  const browsing = (): string[] =>
    domicile.calls.flatMap(([kind, url]) =>
      kind === "openBrowserWindow" ? [String(url)] : [],
    );

  /** Sets the files the host's index holds. */
  const homeHolds = (...files: readonly string[]): Promise<void> =>
    domicile.holds(files);

  it("is not on screen until the key that opens it", async () => {
    await renderShell();

    expect(launcherBox()).toBeNull();
  });

  it("opens on the screen the keyboard is on", async () => {
    await renderShell([LEFT, RIGHT]);
    clientAppears("one");
    press("l");

    press("space");

    expect(dialogBox()).toStrictEqual({ left: "1920px", width: "1280px" });
  });

  it("stays on the empty screen it was opened on", async () => {
    // Opening it gives the page the keyboard, so the engine refocuses the last
    // guest, here the browser window on the other screen, as if clicked.
    const { container } = await renderShell([LEFT, RIGHT]);
    press("space");
    await typeIntoLauncher("example.com{Enter}");
    await launched();
    press("l");
    press("space");
    const behind = container.querySelector<HTMLElement>("webview");
    if (behind === null) {
      throw new Error("test: no browser window");
    }

    // The view takes focus too, as a click in its page would give it.
    act(() => {
      behind.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      behind.dispatchEvent(
        new Event(WEBVIEW_GUEST_FOCUS_EVENT, { bubbles: true }),
      );
    });

    expect(dialogBox()).toStrictEqual({ left: "1920px", width: "1280px" });
  });

  it("opens on mod+space and asks the host what matches its empty box", async () => {
    // Searched on each open, not at startup, so the results are current.
    await renderShell();

    press("space");

    expect(launcherBox()).toBeVisible();
    expect(domicile.calls).toContainEqual(["searchFiles", ""]);
  });

  it("reads the installed applications before it is opened", async () => {
    // Unlike files, read before opening so late results do not push rows
    // down. See `launcher/useOpeningApps.ts`. A read starts by asking the
    // desktop's environment where applications are installed.
    await renderCountedShell();
    const reads = () =>
      domicile.calls.filter(
        ([call, , request]) =>
          call === "callSystem" &&
          typeof request === "string" &&
          request.includes('"argv":["env","-0"]'),
      );

    expect(reads()).toHaveLength(1);

    press("space");

    expect(reads()).toHaveLength(1);
  });

  it("shows the files the host answered with", async () => {
    const { unmount } = await renderShell();
    press("space");

    await homeHolds("Notes/today.org", "todo.txt");

    // A row is the name, then its directories, separated by the grid's gap;
    // see `launcher/file-row.ts`.
    expect(
      screen.getAllByRole("option").map((row) => row.textContent),
    ).toStrictEqual(["Notestoday.org", "todo.txt"]);
    // Unmounted here: the preview timer could fire before shared cleanup and
    // update the panel outside `act`.
    unmount();
  });

  it("opens a file nothing claims with xdg-open and puts the panel away", async () => {
    // The spawned shell resolves `$HOME`; the page cannot. See
    // `launcher/open-command.ts`.
    await renderShell();
    press("space");
    await homeHolds("Notes/today.org");

    await userEvent.setup().click(screen.getByRole("option"));
    // First asks `domicile open --which`, then opens it once the panel has
    // gone.
    await act(() => answerOpening(domicile.fake));
    await launched();
    await act(() => answerOpening(domicile.fake));

    expect(domicile.calls).toContainEqual([
      "spawn",
      [
        "sh",
        "-c",
        'case $1 in /*) exec xdg-open "$1" ;; *) exec xdg-open "$HOME/$1" ;; esac',
        "domicile-launcher",
        "Notes/today.org",
      ],
    ]);
    expect(launcherBox()).toBeNull();
  });

  it("opens a typed URL in a browser window on the desktop", async () => {
    await renderShell();
    press("space");
    await homeHolds("todo.txt");

    await typeIntoLauncher("example.com{Enter}");
    await launched();

    expect(browsing()).toStrictEqual(["https://example.com"]);
    expect(launcherBox()).toBeNull();
  });

  it("opens what was picked only once it has closed, so a screenshot leaves it out", async () => {
    await renderShell();
    press("space");
    await homeHolds("todo.txt");
    const closing = Promise.withResolvers<unknown>();
    const { getAnimations } = Element.prototype;
    Element.prototype.getAnimations = () => [
      { finished: closing.promise } as Animation,
    ];
    try {
      await typeIntoLauncher("example.com{Enter}");

      expect(browsing()).toStrictEqual([]);
      await act(async () => {
        closing.resolve(undefined);
        await closing.promise;
      });
      // Not yet: the screen may still show the launcher's last frame.
      expect(browsing()).toStrictEqual([]);
      await waitFor(() => {
        expect(browsing()).toStrictEqual(["https://example.com"]);
      });
    } finally {
      Element.prototype.getAnimations = getAnimations;
    }
  });

  it("searches for a query that is neither a file nor a URL", async () => {
    await renderShell();
    press("space");

    await typeIntoLauncher("!wiki mesa{Enter}");
    await launched();

    // The URL shows the search engine and escaping used.
    expect(browsing()).toStrictEqual([
      "https://en.wikipedia.org/wiki/Special:Search?search=mesa",
    ]);
  });

  it("takes the keyboard off the window it is opened over", async () => {
    // The page draws the panel but the compositor routes keys. Without this,
    // the focused client would keep receiving the typed text.
    await renderShell();
    clientAppears("one");
    domicile.set({ focusedWindow: "one" });
    domicile.calls.length = 0;

    press("space");

    expect(domicile.calls).toContainEqual(["focusChrome"]);
  });

  it("hands the keyboard back to the window when it is put away", async () => {
    // Focus returns as soon as the panel closes, without waiting for the
    // pointer.
    await renderShell();
    clientAppears("one");
    domicile.set({ focusedWindow: "one" });
    press("space");
    // The compositor confirms the focus change.
    domicile.set({ focusedWindow: null });
    domicile.calls.length = 0;

    press("space");

    expect(domicile.calls).toContainEqual(["focusApp", "one"]);
  });

  it("keeps the box focused over a browser window", async () => {
    // A guest page keeps pulling focus back to itself, so the panel must
    // hold it explicitly.
    const { container } = await renderShell();
    press("space");
    await typeIntoLauncher("example.com{Enter}");
    await launched();
    expect(container.querySelector("webview")).not.toBeNull();

    press("space");

    expect(launcherBox()).toHaveFocus();
  });

  it("leaves nothing over the desktop once a launch puts it away", async () => {
    // The panel closes as the new window arrives. A leftover backdrop would
    // capture every click.
    const { baseElement } = await renderShell([LEFT]);
    press("space");

    await typeIntoLauncher("example.com{Enter}");
    await launched();

    await waitFor(() => {
      expect(baseElement.querySelector("[data-backdrop]")).toBeNull();
    });
  });

  it("keeps the panel up while it closes", async () => {
    // It stays drawn until the dialog's close animation finishes.
    await renderShell();
    press("space");

    press("space");

    expect(screen.getByRole("dialog")).toHaveAttribute("data-ending-style");
  });

  it("leaves the tab that was open selected once it is dismissed", async () => {
    // While the panel is up the engine may give focus back to the last guest,
    // here the hidden tab's browser. Dismissing must keep the visible tab
    // selected.
    const { container } = await renderShell();
    press("space");
    await typeIntoLauncher("example.com{Enter}");
    await launched();
    clientAppears("two");
    press("space");
    const behind = container.querySelector<HTMLElement>("webview");
    if (behind === null) {
      throw new Error("test: no browser window");
    }
    act(() => {
      behind.dispatchEvent(
        new Event(WEBVIEW_GUEST_FOCUS_EVENT, { bubbles: true }),
      );
    });

    await userEvent.setup().keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(barFor(container, "app:two").dataset.focus).toBe("focused");
  });
});
