import { describe, expect, it } from "bun:test";

import { Axis, Direction } from "./direction";
import { SURFACE_TUCK, TITLE_BAR } from "./rect";
import { Beside } from "./tree/drop";
import { Layout, LayoutNode, NodeKind, windowsIn } from "./tree/node";
import { focusedNodeOf, shownOver, windowsOf } from "./tree/tiling";
import { appWindowId, browserWindowId } from "./window";
import type { WindowState } from "./window-state";
import {
  activeIdOf,
  activeIsPrivate,
  closedBrowsersOf,
  closedIdsOf,
  currentHere,
  currentOn,
  NO_WINDOWS,
  reduceWindows,
  screenHolding,
  screenOfApp,
  WindowAction,
  workspaceHere,
  workspaceNamed,
  workspaceOn,
  workspacesOn,
} from "./window-state";
import { windowsOn } from "./workspace";

const reduce = (
  state: WindowState,
  ...actions: readonly WindowAction[]
): WindowState => actions.reduce(reduceWindows, state);

/** A desktop with these clients open on workspace 1. */
const desktop = (...appIds: readonly string[]): WindowState =>
  reduce(
    NO_WINDOWS,
    ...appIds.map((appId) => WindowAction.AppAppeared(appId, appId)),
  );

const APP = appWindowId;
const BROWSER = browserWindowId;

/** A browser window as the engine lists it. */
const listed = (
  id: string,
  url: string,
  popup: { popupWindow: number; width: number; height: number } = {
    height: 0,
    popupWindow: 0,
    width: 0,
  },
) => ({
  appId: "",
  height: popup.height,
  id,
  isApp: false,
  isCaptured: false,
  isPrivate: false,
  partition: "",
  popupWindow: popup.popupWindow === 0 ? undefined : popup.popupWindow,
  title: "",
  url,
  width: popup.width,
});

/** Screens of 1920 by 1080, left to right in the order named. */
const sideBySide = (...names: readonly string[]) =>
  names.map((name, at) => ({
    box: { height: 1080, width: 1920, x: at * 1920, y: 0 },
    name,
  }));

describe("the windows a host announces", () => {
  it("opens a window for each client, tiled on the workspace on screen", () => {
    const state = desktop("kitty", "editor");

    expect(windowsOn(workspaceHere(state))).toEqual([
      APP("kitty"),
      APP("editor"),
    ]);
    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("takes the window away when the client goes", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.AppClosed("editor"),
    );

    expect(state.windows.map(({ id }) => id)).toEqual([APP("kitty")]);
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("re-announces a client it already has a window for as the same window", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.AppAppeared("kitty", "kitty"),
    );

    expect(state.windows).toHaveLength(1);
  });

  it("names the window whatever the client last called it", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.AppTitled("kitty", "vim ~/notes"),
    );

    expect(state.windows[0]).toMatchObject({ title: "vim ~/notes" });
  });

  it("knows the desktop entry the client last named", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.AppDesktopIdChanged("kitty", "kitty"),
    );

    expect(state.windows[0]).toMatchObject({ desktopId: "kitty" });
  });

  it("grants a client asking for the keyboard, on the workspace it is on", () => {
    // The compositor forwards xdg-activation requests without granting them;
    // manganese grants them and switches to the window's workspace.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.FocusRequested(APP("kitty")),
    );

    expect(currentHere(state)).toBe("1");
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("shows the hidden tab of a window it grants the keyboard", () => {
    // As from a notification click: the window must be seen, not only focused.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
      WindowAction.FocusRequested(APP("kitty")),
    );

    const { root } = workspaceNamed(state, "1").tiling;
    expect(activeIdOf(state)).toBe(APP("kitty"));
    expect(root === undefined ? undefined : shownOver(root, APP("kitty"))).toBe(
      APP("kitty"),
    );
  });

  it("warps the pointer to a window it grants the keyboard", () => {
    // Counted as a key press is: the pointer is elsewhere, and focus follows
    // it, so it would take the keyboard back.
    const state = desktop("kitty", "editor");

    expect(
      reduceWindows(state, WindowAction.FocusRequested(APP("kitty"))).pressed,
    ).toBe(state.pressed + 1);
  });

  it("leaves a window that already has the keyboard as it is", () => {
    // A launched window asks with the launch's token once it opens focused.
    // Where the pointer goes is then the new window's rule.
    const state = desktop("kitty", "editor");

    expect(
      reduceWindows(state, WindowAction.FocusRequested(APP("editor"))),
    ).toBe(state);
  });
});

// The stage redraws only what changed, by identity, so a report that changes
// nothing keeps the state, and one that changes a window keeps the others.
describe("a report that changes nothing", () => {
  it("keeps the desktop when the engine lists the same browser windows", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([
        listed("1", "https://example.com/"),
        listed("2", "https://docs.rs/"),
      ]),
    );

    expect(
      reduceWindows(
        state,
        WindowAction.BrowserWindowsListed([
          listed("1", "https://example.com/"),
          listed("2", "https://docs.rs/"),
        ]),
      ),
    ).toBe(state);
  });

  it("keeps the browser windows whose pages did not change", () => {
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([
        listed("1", "https://example.com/"),
        listed("2", "https://docs.rs/"),
      ]),
    );

    const next = reduceWindows(
      state,
      WindowAction.BrowserWindowsListed([
        listed("1", "https://example.com/"),
        listed("2", "https://docs.rs/std"),
      ]),
    );

    expect(next.windows[0]).toBe(state.windows[0]);
    expect(next.windows[1]).toMatchObject({ url: "https://docs.rs/std" });
  });

  it("keeps a cursor a client drew until it names one again", () => {
    const drawn =
      'image-set(url("data:image/png;base64,iVBO") 1x) 1 2, default';
    const drawing = reduce(
      desktop("gimp"),
      WindowAction.AppCursorChanged("gimp", "default", drawn),
    );
    expect(drawing.windows[0]).toMatchObject({
      cursor: "default",
      cursorImage: drawn,
    });

    const named = reduce(
      drawing,
      WindowAction.AppCursorChanged("gimp", "crosshair"),
    );
    expect(named.windows[0]).toMatchObject({
      cursor: "crosshair",
      cursorImage: undefined,
    });
  });

  it("keeps the desktop when a window is told what it already has", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.AppCursorChanged("kitty", "text"),
      WindowAction.AppDesktopIdChanged("kitty", "kitty"),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/")]),
      WindowAction.BrowserIconChanged("1", "https://docs.rs/icon.svg"),
      WindowAction.BrowserDescribed("1", "Rust documentation"),
    );

    expect(
      reduce(
        state,
        WindowAction.AppTitled("kitty", "kitty"),
        WindowAction.AppCursorChanged("kitty", "text"),
        WindowAction.AppDesktopIdChanged("kitty", "kitty"),
        WindowAction.BrowserIconChanged("1", "https://docs.rs/icon.svg"),
        WindowAction.BrowserDescribed("1", "Rust documentation"),
      ),
    ).toBe(state);
  });
});

describe("the browser windows the engine lists", () => {
  it("opens one on the workspace on screen and works in it", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([listed("1", "https://example.com/")]),
    );

    expect(activeIdOf(state)).toBe(BROWSER("1"));
    expect(state.windows[1]).toMatchObject({ title: "example.com" });
  });

  it("asks for one and opens nothing until it is listed", () => {
    // The engine owns the page, so the window arrives with the list.
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserOpened("https://example.com/", false),
    );

    expect(state.windows).toHaveLength(1);
  });

  it("marks a private window as private", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([
        { ...listed("1", "https://example.com/"), isPrivate: true },
      ]),
    );

    expect(state.windows[1]).toMatchObject({ isPrivate: true });
  });

  it("says whether the active window is a private one", () => {
    const listedPrivate = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([
        { ...listed("1", "https://example.com/"), isPrivate: true },
      ]),
    );

    expect(activeIsPrivate(listedPrivate)).toBe(true);
    expect(activeIsPrivate(desktop("kitty"))).toBe(false);
  });

  it("names a window after the site its page is at now", () => {
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([listed("1", "https://example.com/")]),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/")]),
    );

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]).toMatchObject({ title: "docs.rs" });
  });

  it("marks a window with its page's icon, through later lists", () => {
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/")]),
      WindowAction.BrowserIconChanged("1", "https://docs.rs/icon.svg"),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/std")]),
    );

    expect(state.windows[0]).toMatchObject({
      icon: "https://docs.rs/icon.svg",
    });
  });

  it("takes the icon away from a page that has none", () => {
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/")]),
      WindowAction.BrowserIconChanged("1", "https://docs.rs/icon.svg"),
      WindowAction.BrowserIconChanged("1", ""),
    );

    expect(state.windows[0]).toMatchObject({ icon: undefined });
  });

  it("describes a window with its page's description, through later lists", () => {
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/")]),
      WindowAction.BrowserDescribed("1", "Rust documentation"),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/std")]),
    );

    expect(state.windows[0]).toMatchObject({
      description: "Rust documentation",
    });
  });

  it("takes the description away from a page that has none", () => {
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/")]),
      WindowAction.BrowserDescribed("1", "Rust documentation"),
      WindowAction.BrowserDescribed("1", ""),
    );

    expect(state.windows[0]).toMatchObject({ description: undefined });
  });

  it("names a window after its page's title once the page has one", () => {
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([listed("1", "https://docs.rs/")]),
      WindowAction.BrowserWindowsListed([
        { ...listed("1", "https://docs.rs/"), title: "Docs.rs" },
      ]),
    );

    expect(state.windows[0]).toMatchObject({ title: "Docs.rs" });
  });

  it("fills the screen with a window while its page is fullscreen", () => {
    const listing = WindowAction.BrowserWindowsListed([
      listed("1", "https://example.com/"),
    ]);
    const full = reduce(
      desktop("kitty"),
      listing,
      WindowAction.PageFullscreened(BROWSER("1"), true),
    );

    expect(workspaceHere(full).fullscreen).toMatchObject({ id: BROWSER("1") });
    expect(
      workspaceHere(
        reduce(full, WindowAction.PageFullscreened(BROWSER("1"), false)),
      ).fullscreen,
    ).toBeUndefined();
  });

  it("takes a window away when the engine no longer lists it", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([listed("1", "https://example.com/")]),
      WindowAction.BrowserWindowsListed([]),
    );

    expect(state.windows.map(({ id }) => id)).toEqual([APP("kitty")]);
  });

  it("leaves a browser window for the engine to close", () => {
    // `closeBrowserWindow` is asked, and the window goes when the list says.
    const state = reduce(
      desktop(),
      WindowAction.BrowserWindowsListed([listed("1", "https://example.com/")]),
      WindowAction.WindowKilled(),
    );

    expect(state.windows).toHaveLength(1);
  });

  it("leaves a client's window for the client to close", () => {
    // `closeApp` is a request: an editor with unsaved work may stay open, so
    // the window is removed only when the host reports it closed.
    const state = reduce(desktop("editor"), WindowAction.WindowKilled());

    expect(state.windows).toHaveLength(1);
  });
});

// A dialog, such as pinentry, or a window a floating rule names.
describe("the apps that run in the background", () => {
  /** App window `id` of app `appId`, as the engine lists it. */
  const app = (id: string, appId: string) => ({
    ...listed(id, "https://messages.example/"),
    appId,
    isApp: true,
  });

  /** Messages' window listed, with Messages running in the background. */
  const running = () =>
    reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([app("1", "messages")], ["messages"]),
    );

  it("opens a background app's window hidden, keeping the window in front", () => {
    const state = running();

    expect(state.windows.map(({ id }) => id)).toContain(BROWSER("1"));
    expect(windowsOn(workspaceHere(state))).toEqual([APP("kitty")]);
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("opens another app's window as any other", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([app("1", "mail")], ["messages"]),
    );

    expect(activeIdOf(state)).toBe(BROWSER("1"));
  });

  it("shows the hidden window on the workspace on screen when it asks to be in front", () => {
    const state = reduce(running(), WindowAction.FocusRequested(BROWSER("1")));

    expect(windowsOn(workspaceHere(state))).toEqual([
      APP("kitty"),
      BROWSER("1"),
    ]);
    expect(activeIdOf(state)).toBe(BROWSER("1"));
  });

  it("hides the window again when it is closed", () => {
    const shown = reduce(running(), WindowAction.FocusRequested(BROWSER("1")));
    const state = reduce(shown, WindowAction.WindowClosed(BROWSER("1")));

    expect(state.windows.map(({ id }) => id)).toContain(BROWSER("1"));
    expect(windowsOn(workspaceHere(state))).toEqual([APP("kitty")]);
    expect(closedIdsOf(shown, [BROWSER("1"), APP("kitty")])).toEqual([
      APP("kitty"),
    ]);
  });

  it("hides the window when it is killed", () => {
    const shown = reduce(running(), WindowAction.FocusRequested(BROWSER("1")));
    const state = reduce(shown, WindowAction.WindowKilled());

    expect(state.windows.map(({ id }) => id)).toContain(BROWSER("1"));
    expect(windowsOn(workspaceHere(state))).toEqual([APP("kitty")]);
  });

  it("counts the window closed only while it is off every workspace and the scratchpad", () => {
    const shown = reduce(running(), WindowAction.FocusRequested(BROWSER("1")));
    const stashed = reduce(shown, WindowAction.WindowSentToScratchpad());
    const closed = reduce(shown, WindowAction.WindowClosed(BROWSER("1")));

    expect(closedBrowsersOf(running())).toEqual(["1"]);
    expect(closedBrowsersOf(shown)).toEqual([]);
    expect(closedBrowsersOf(stashed)).toEqual([]);
    expect(closedBrowsersOf(closed)).toEqual(["1"]);
  });

  it("closes the window when the engine drops it", () => {
    const state = reduce(
      running(),
      WindowAction.BrowserWindowsListed([], ["messages"]),
    );

    expect(state.windows.map(({ id }) => id)).toEqual([APP("kitty")]);
  });
});

describe("the clients that open floating", () => {
  const floatOf = (state: WindowState) => {
    const [float] = workspaceHere(state).floats;
    if (float === undefined) {
      throw new Error("nothing is floating");
    } else {
      return float;
    }
  };

  it("opens one floating in the middle of the screen, at the size it drew", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left")),
      WindowAction.AppAppearedFloating("pin", "pinentry", [400, 300], false),
    );

    expect(activeIdOf(state)).toBe(APP("pin"));
    expect(windowsOf(workspaceHere(state).tiling)).toEqual([APP("kitty")]);
    // The title bar goes on top of the size the client drew.
    const height = 300 + TITLE_BAR - SURFACE_TUCK;
    expect(floatOf(state)).toMatchObject({
      bare: false,
      height,
      width: 400,
      x: 760,
      y: Math.round((1080 - height) / 2),
    });
  });

  it("opens one that draws its own frame at that size alone, limits and all", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left")),
      WindowAction.AppAppearedFloating("huddle", "Huddle", [400, 300], true),
      WindowAction.AppMinSize("huddle", [400, 300]),
      WindowAction.AppMaxSize("huddle", [400, 300]),
    );

    expect(floatOf(state)).toMatchObject({
      bare: true,
      height: 300,
      width: 400,
      x: 760,
      y: 390,
    });
  });
});

// `chrome.windows.create` with a popup (such as Bitwarden's "Unlock"), opened
// as a browser window owned by the extension.
describe("the windows an extension asks for", () => {
  const POPUP = "chrome-extension://vault/popup/index.html?uilocation=popout";

  /** The one float on the workspace on screen. */
  const floatOf = (state: WindowState) => {
    const [float] = workspaceHere(state).floats;
    if (float === undefined) {
      throw new Error("nothing is floating");
    } else {
      return float;
    }
  };

  it("opens one floating in front, the size it asked for, and works in it", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([
        listed("1", POPUP, { height: 630, popupWindow: 7, width: 380 }),
      ]),
    );

    expect(activeIdOf(state)).toBe(BROWSER("1"));
    expect(state.windows[1]).toMatchObject({ popupWindow: 7 });
    expect(floatOf(state)).toMatchObject({ height: 630, width: 380 });
  });

  // 0 means the extension gave no size on that axis.
  it("opens at a float's own size on an axis it did not ask about", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left")),
      WindowAction.BrowserWindowsListed([
        listed("1", POPUP, { height: 630, popupWindow: 7, width: 0 }),
      ]),
    );

    expect(floatOf(state)).toMatchObject({ height: 630, width: 1280 });
  });

  // An extension's side panel: the engine opens it as a popup window at no
  // size, and the user wants it beside their windows.
  it("tiles one that asked for no size", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([
        listed("1", POPUP, { height: 0, popupWindow: 7, width: 0 }),
      ]),
    );

    expect(activeIdOf(state)).toBe(BROWSER("1"));
    expect(state.windows[1]).toMatchObject({ popupWindow: 7 });
    expect(workspaceHere(state).floats).toEqual([]);
  });
});

// `window.open()` with a size (such as Slack's huddle), which the engine lists
// with that size and no extension popup window.
describe("the windows a page asks for at a size", () => {
  it("opens one floating in front, the size it asked for", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([
        listed("1", "https://app.slack.com/huddle", {
          height: 420,
          popupWindow: 0,
          width: 640,
        }),
      ]),
    );

    expect(activeIdOf(state)).toBe(BROWSER("1"));
    expect(workspaceHere(state).floats).toEqual([
      expect.objectContaining({ height: 420, width: 640 }),
    ]);
  });

  it("tiles one that asked for no size", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.BrowserWindowsListed([
        listed("1", "https://app.slack.com/client"),
      ]),
    );

    expect(workspaceHere(state).floats).toEqual([]);
  });
});

describe("the screens", () => {
  it("is one screen nobody has named until the host describes a desk", () => {
    // A window can open before the handshake, so a screen always exists. No
    // display is named "", so nothing is drawn on it.
    expect(NO_WINDOWS.screens).toEqual([
      {
        box: { height: 0, width: 0, x: 0, y: 0 },
        current: "1",
        name: "",
      },
    ]);
    expect(NO_WINDOWS.focused).toBe("");
  });

  it("gives the first named screen what the unnamed one was showing", () => {
    // A window opened before the desk was described keeps its workspace, which
    // the first real screen then shows.
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
    );

    expect(currentOn(state, "left")).toBe("1");
    expect(state.focused).toBe("left");
    expect(windowsOn(workspaceOn(state, "left"))).toEqual([APP("kitty")]);
  });

  it("finds the screen a client's window is on, for its dialogs", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
    );

    expect(screenOfApp(state, "kitty")).toBe("left");
    expect(screenOfApp(state, "closed")).toBeUndefined();
  });

  it("finds the screen a window's workspace is on, shown or not, for its picture-in-picture video", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("3"),
    );

    expect(currentOn(state, "left")).toBe("3");
    expect(screenHolding(state, APP("kitty"))).toBe("left");
    expect(screenHolding(state, APP("closed"))).toBeUndefined();
  });

  it("shows a workspace nobody else is on when a monitor is plugged in", () => {
    // Two screens on one workspace would embed each window twice, and the
    // second embedding takes the first's pixels.
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left")),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
    );

    expect(currentOn(state, "left")).toBe("1");
    expect(currentOn(state, "right")).toBe("2");
  });

  it("leaves a screen that was already there showing what it was", () => {
    // Every hotplug re-describes the whole desk, so unaffected monitors must
    // keep their workspaces.
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("5"),
      WindowAction.ScreensDescribed(sideBySide("left", "right", "third")),
    );

    expect(currentOn(state, "left")).toBe("5");
    expect(currentOn(state, "right")).toBe("2");
  });

  it("keeps where each screen is on the desk, as the host last said", () => {
    // `focus left` uses these positions, and moving a monitor in display
    // settings re-describes it.
    const state = reduce(
      desktop(),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.ScreensDescribed(sideBySide("right", "left")),
    );

    expect(state.screens.map(({ box, name }) => [name, box.x])).toEqual([
      ["right", 0],
      ["left", 1920],
    ]);
  });

  it("hands a swapped monitor what the one it replaced was showing", () => {
    // A dock change renames every output. Workspaces carry over instead of
    // every monitor resetting to workspace 1.
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      // Switch to the right monitor, then to a workspace on it.
      WindowAction.WorkspaceSelected("2"),
      WindowAction.WorkspaceSelected("7"),
      WindowAction.ScreensDescribed(sideBySide("left", "docked")),
    );

    expect(currentOn(state, "docked")).toBe("7");
    expect(currentOn(state, "left")).toBe("1");
  });

  it("moves the keyboard to the first screen when the one it was on goes", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.ScreensDescribed(sideBySide("left")),
    );

    expect(state.focused).toBe("left");
  });

  it("keeps the desktop on one unnamed screen when the last monitor goes", () => {
    // A laptop lid closed with nothing plugged in. Windows stay on their
    // workspaces; the empty name means there is nowhere to draw them.
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left")),
      WindowAction.ScreensDescribed(sideBySide()),
    );

    expect(state.screens).toEqual([
      {
        box: { height: 0, width: 0, x: 0, y: 0 },
        current: "1",
        name: "",
      },
    ]);
    expect(windowsOn(workspaceOn(state, ""))).toEqual([APP("kitty")]);
  });
});

describe("a key pressed on the desk", () => {
  it("is counted", () => {
    // Counted in the desk state because the monitor that receives focus answers
    // it by warping the pointer.
    const pressed = reduce(
      NO_WINDOWS,
      WindowAction.KeyPressed(),
      WindowAction.KeyPressed(),
    ).pressed;

    expect(pressed).toBe(2);
  });
});

describe("the workspaces", () => {
  it("starts on the first one", () => {
    expect(currentHere(NO_WINDOWS)).toBe("1");
  });

  it("switches to the one the key names", () => {
    const state = reduce(desktop("kitty"), WindowAction.WorkspaceSelected("3"));

    expect(currentHere(state)).toBe("3");
    expect(activeIdOf(state)).toBeUndefined();
  });

  it("goes back to the last one when the key names the one on screen", () => {
    // `workspaceAutoBackAndForth = true`.
    const state = reduce(
      desktop("kitty"),
      WindowAction.WorkspaceSelected("3"),
      WindowAction.WorkspaceSelected("3"),
    );

    expect(currentHere(state)).toBe("1");
  });

  it("moves the keyboard to the screen already showing the one named", () => {
    // As in sway, focus moves to the screen showing the workspace instead of
    // moving the workspace. Moving it would leave one monitor empty.
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
    );

    expect(state.focused).toBe("right");
    expect(currentOn(state, "left")).toBe("1");
    expect(currentOn(state, "right")).toBe("2");
  });

  it("shows a workspace nobody is showing on the screen the keyboard is on", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("9"),
    );

    expect(state.focused).toBe("left");
    expect(currentOn(state, "left")).toBe("9");
    expect(currentOn(state, "right")).toBe("2");
  });

  it("opens a window on the screen the keyboard is on", () => {
    // A new window opens on the focused screen, not always on the first.
    const state = reduce(
      desktop(),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("kitty", "kitty"),
    );

    expect(windowsOn(workspaceOn(state, "right"))).toEqual([APP("kitty")]);
    expect(windowsOn(workspaceOn(state, "left"))).toEqual([]);
  });

  it("sends the window being worked in to another workspace, and stays", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToWorkspace("2"),
    );

    expect(currentHere(state)).toBe("1");
    expect(windowsOn(workspaceHere(state))).toEqual([APP("kitty")]);
    expect(windowsOn(workspaceNamed(state, "2"))).toEqual([APP("editor")]);
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("sends a whole tab group selected by focus parent", () => {
    const state = reduce(
      desktop("mail", "kitty"),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
      WindowAction.ParentFocused(),
      WindowAction.WindowSentToWorkspace("2"),
    );

    expect(windowsOn(workspaceHere(state))).toEqual([APP("mail")]);
    expect(workspaceNamed(state, "2").tiling.root).toEqual(
      LayoutNode.Container(
        Layout.Tabbed,
        [
          LayoutNode.Window(APP("kitty"), 2),
          LayoutNode.Window(APP("editor"), 3),
        ],
        1,
      ),
    );
  });

  it("leaves fullscreen behind with the group a fullscreen window went in", () => {
    const state = reduce(
      desktop("mail", "kitty"),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.FullscreenToggled(false),
      WindowAction.ParentFocused(),
      WindowAction.WindowSentToWorkspace("2"),
    );

    expect(workspaceHere(state).fullscreen).toBeUndefined();
  });

  it("tiles it there even while a floating group has the keyboard", () => {
    // Only a newly opened window joins the floating group; a window sent here
    // lands tiled.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("mail", "mail"),
      WindowAction.ParentFocused(),
      WindowAction.FloatToggled(),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("term", "term"),
      WindowAction.WindowSentToWorkspace("1"),
    );

    expect(windowsOf(workspaceNamed(state, "1").tiling)).toEqual([
      APP("kitty"),
      APP("term"),
    ]);
  });

  it("keeps a window that closes on a workspace nobody is looking at", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToWorkspace("2"),
      WindowAction.AppClosed("editor"),
    );

    expect(windowsOn(workspaceNamed(state, "2"))).toEqual([]);
    expect(state.windows.map(({ id }) => id)).toEqual([APP("kitty")]);
  });
});

describe("the workspaces each screen has", () => {
  /**
   * Two monitors: kitty on the left one's workspace 1, and an editor on
   * workspace 2, which the right one showed before switching to 3.
   */
  const twoScreens = (): WindowState =>
    reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.WorkspaceSelected("3"),
    );

  it("keeps a workspace on the screen it was last shown on", () => {
    // As in sway, a workspace belongs to one output, and only that output's bar
    // lists it.
    const state = twoScreens();

    expect(workspacesOn(state, "left")).toEqual(["1"]);
    expect(workspacesOn(state, "right")).toEqual(["2", "3"]);
  });

  it("shows a hidden workspace on its own screen, and takes the keyboard there", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.WorkspaceSelected("1"),
      WindowAction.WorkspaceSelected("2"),
    );

    expect(state.focused).toBe("right");
    expect(currentOn(state, "left")).toBe("1");
    expect(currentOn(state, "right")).toBe("2");
  });

  it("puts a window sent to an empty workspace on the screen it was sent from", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WindowSentToWorkspace("5"),
    );

    expect(workspacesOn(state, "left")).toEqual(["1", "5"]);
    expect(workspacesOn(state, "right")).toEqual(["2"]);
  });

  it("hands the workspaces of a monitor that goes to the screen the keyboard is on", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.WorkspaceSelected("1"),
      WindowAction.ScreensDescribed(sideBySide("left")),
    );

    expect(workspacesOn(state, "left")).toEqual(["1", "2"]);
  });
});

describe("the scratchpad", () => {
  it("takes the window being worked in off the desktop", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
    );

    expect(windowsOn(workspaceHere(state))).toEqual([APP("kitty")]);
    expect(state.scratchpad).toEqual([APP("editor")]);
    expect(state.windows).toHaveLength(2);
  });

  it("shows it again, floating over whatever workspace is on screen", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.ScratchpadShown(),
    );

    expect(state.scratchpad).toEqual([]);
    expect(
      workspaceHere(state).floats.flatMap(({ root }) => windowsIn(root)),
    ).toEqual([APP("editor")]);
    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  // A drop-down: it hangs from the top of the screen, which it slides down
  // from.
  it("shows it as wide and tall as the screen, less a gutter but at the top", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.ScratchpadShown(),
    );

    expect(workspaceHere(state).floats).toMatchObject([
      { height: 1080 - 48, width: 1920 - 2 * 48, x: 48, y: 0 },
    ]);
  });

  it("hides the one it is showing rather than fetching another", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.ScratchpadShown(),
      WindowAction.ScratchpadShown(),
    );

    expect(state.scratchpad).toEqual([APP("editor")]);
    expect(workspaceHere(state).floats).toEqual([]);
  });

  it("rotates through its windows, oldest first, as sway does", () => {
    const hidden = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.WindowSentToScratchpad(),
    );
    const first = reduce(hidden, WindowAction.ScratchpadShown());
    const second = reduce(
      first,
      WindowAction.ScratchpadShown(),
      WindowAction.ScratchpadShown(),
    );

    expect(activeIdOf(first)).toBe(APP("editor"));
    expect(activeIdOf(second)).toBe(APP("kitty"));
    expect(second.scratchpad).toEqual([APP("editor")]);
  });

  // A click on the backdrop behind it, even after focus has moved on.
  it("hides a window it shows when the window is dismissed", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.ScratchpadShown(),
      WindowAction.WindowSelected(APP("kitty")),
      WindowAction.ScratchpadDismissed(APP("editor")),
    );

    expect(state.scratchpad).toEqual([APP("editor")]);
    expect(windowsOn(workspaceHere(state))).toEqual([APP("kitty")]);
  });

  // A gesture that goes one way: down only brings, up only hides.
  it("brings a window only while none is out", () => {
    const hidden = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.WindowSentToScratchpad(),
    );
    const brought = reduce(hidden, WindowAction.ScratchpadBrought());

    expect(activeIdOf(brought)).toBe(APP("editor"));
    expect(reduceWindows(brought, WindowAction.ScratchpadBrought())).toBe(
      brought,
    );
  });

  it("hides the window it shows, even once focus has moved on", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.ScratchpadBrought(),
      WindowAction.WindowSelected(APP("kitty")),
      WindowAction.ScratchpadHidden(),
    );

    expect(state.scratchpad).toEqual([APP("editor")]);
    expect(workspaceHere(state).floats).toEqual([]);
  });

  it("has nothing to hide while nothing is out", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
    );

    expect(reduceWindows(state, WindowAction.ScratchpadHidden())).toBe(state);
  });

  it("has nothing to show on an empty scratchpad", () => {
    const state = desktop("kitty");

    expect(reduceWindows(state, WindowAction.ScratchpadShown())).toBe(state);
  });

  it("takes a window out of the scratchpad when its client goes", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.AppClosed("editor"),
    );

    expect(state.scratchpad).toEqual([]);
    expect(state.windows).toHaveLength(1);
  });
});

describe("focus across screens", () => {
  /** Kitty on the left screen; the editor and a terminal on the right. */
  const twoScreens = () =>
    reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.AppAppeared("term", "term"),
    );

  it("goes on to the screen that way from the edge of the tiling", () => {
    // sway's order: a window that way, then a screen that way, then wrap.
    const state = reduce(
      twoScreens(),
      WindowAction.FocusStepped(Direction.Left),
      WindowAction.FocusStepped(Direction.Left),
    );

    expect(state.focused).toBe("left");
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("comes in by the window on the near edge", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.ScreenHovered("left"),
      WindowAction.FocusStepped(Direction.Right),
    );

    expect(state.focused).toBe("right");
    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("goes on to a screen with nothing on it", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.FocusStepped(Direction.Right),
    );

    expect(state.focused).toBe("right");
    expect(activeIdOf(state)).toBeUndefined();
  });

  it("leaves a screen with nothing on it", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.ScreenHovered("right"),
      WindowAction.FocusStepped(Direction.Left),
    );

    expect(state.focused).toBe("left");
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("wraps round where no screen lies that way", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.FocusStepped(Direction.Right),
    );

    expect(state.focused).toBe("right");
    expect(activeIdOf(state)).toBe(APP("editor"));
  });
});

describe("moves across screens", () => {
  /** Kitty on the left screen; a row of the editor and a terminal on the right. */
  const twoScreens = () =>
    reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.AppAppeared("term", "term"),
      WindowAction.LayoutSet(Layout.SplitH),
    );

  it("goes on to the screen that way from the edge of the tiling", () => {
    // sway's order: through the tiling, then to the screen that way.
    const state = reduce(
      twoScreens(),
      WindowAction.FocusStepped(Direction.Left),
      WindowAction.WindowStepped(Direction.Left),
    );

    expect(state.focused).toBe("left");
    expect(activeIdOf(state)).toBe(APP("editor"));
    expect(windowsOf(workspaceNamed(state, "1").tiling)).toEqual([
      APP("kitty"),
      APP("editor"),
    ]);
    expect(windowsOf(workspaceNamed(state, "2").tiling)).toEqual([APP("term")]);
  });

  it("comes in on the near edge of a row", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.ScreenHovered("left"),
      WindowAction.WindowStepped(Direction.Right),
    );

    expect(state.focused).toBe("right");
    expect(windowsOf(workspaceNamed(state, "2").tiling)).toEqual([
      APP("kitty"),
      APP("editor"),
      APP("term"),
    ]);
  });

  it("goes on to a screen with nothing on it", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WindowStepped(Direction.Right),
    );

    expect(state.focused).toBe("right");
    // In the workspace's tab group, as a window opened there would be.
    expect(workspaceOn(state, "right").tiling.root).toEqual(
      LayoutNode.Container(Layout.Tabbed, [
        LayoutNode.Window(APP("editor"), 2),
      ]),
    );
  });
});

describe("the keyed commands", () => {
  it("passes the tiling commands to the workspace on screen", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FocusStepped(Direction.Left),
    );

    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("moves a window through the tiling", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowStepped(Direction.Left),
    );

    expect(windowsOf(workspaceHere(state).tiling)).toEqual([
      APP("editor"),
      APP("kitty"),
    ]);
  });

  it("rearranges and splits the container the focus is in", () => {
    const stacked = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.Stacking),
    );
    expect(workspaceHere(stacked).tiling.root).toMatchObject({
      layout: Layout.Stacking,
    });

    const split = reduce(
      desktop("kitty", "editor"),
      WindowAction.ContainerSplit(Axis.Vertical),
    );
    expect(workspaceHere(split).tiling.root).toMatchObject({
      children: [
        { children: [{ id: APP("kitty") }], layout: Layout.Tabbed },
        { children: [{ id: APP("editor") }], layout: Layout.Tabbed },
      ],
      layout: Layout.SplitV,
    });
  });

  it("opens a window as a tab of one moved out of its group", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowStepped(Direction.Right),
      WindowAction.AppAppeared("files", "files"),
    );

    expect(workspaceHere(state).tiling.root).toMatchObject({
      children: [
        { children: [{ id: APP("kitty") }], layout: Layout.Tabbed },
        {
          children: [{ id: APP("editor") }, { id: APP("files") }],
          layout: Layout.Tabbed,
        },
      ],
      layout: Layout.SplitH,
    });
  });

  it("floats the window being worked in, and puts it back", () => {
    const floated = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
    );
    expect(
      workspaceHere(floated).floats.flatMap(({ root }) => windowsIn(root)),
    ).toEqual([APP("editor")]);

    const tiled = reduce(floated, WindowAction.FloatToggled());
    expect(workspaceHere(tiled).floats).toEqual([]);
  });

  it("fills the screen with the window being worked in", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.FullscreenToggled(false),
    );

    expect(workspaceHere(state).fullscreen).toEqual({
      global: false,
      id: APP("kitty"),
      up: 0,
    });
  });

  it("changes the mode the keys are read in, on every page of the desk", () => {
    const state = reduce(desktop(), WindowAction.ModeSet("resize"));

    expect(state.mode).toBe("resize");
  });

  it("leaves the state alone for an `exec`, which is the compositor's to spawn", () => {
    const state = desktop("kitty");

    expect(reduceWindows(state, WindowAction.CommandExecuted(["kitty"]))).toBe(
      state,
    );
  });
});

describe("what the compositor says about the keyboard", () => {
  it("follows the seat onto the window it names", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FocusChanged("kitty"),
    );

    expect(state.focusedId).toBe(APP("kitty"));
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("leaves the window being worked in alone when the chrome takes it", () => {
    // Pressing the top bar gives keyboard focus to the page, but the active
    // window is unchanged.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FocusChanged(undefined),
    );

    expect(state.focusedId).toBeUndefined();
    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("keeps a window opened after the launcher when the old one's grant lands late", () => {
    // Closing the launcher hands the keyboard back to kitty. The editor it
    // launched can open before the compositor answers.
    const state = reduce(
      desktop("kitty"),
      WindowAction.FocusChanged("kitty"),
      WindowAction.FocusChanged(undefined),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.FocusChanged("kitty"),
    );

    expect(state.focusedId).toBe(APP("kitty"));
    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("keeps a window opened after the launcher when the old one asks for the keyboard it has", () => {
    // A client may ask for focus when the keyboard enters it, so the launcher
    // handing the keyboard back makes kitty ask. The compositor forwards it,
    // since kitty has the keyboard, and the editor can open first.
    const state = reduce(
      desktop("kitty"),
      WindowAction.FocusChanged("kitty"),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.FocusRequested(APP("kitty")),
    );

    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("says nothing twice", () => {
    // The host reports focus to a newly connected chrome, which usually matches
    // the existing state.
    const state = reduce(desktop("kitty"), WindowAction.FocusChanged("kitty"));

    expect(reduceWindows(state, WindowAction.FocusChanged("kitty"))).toBe(
      state,
    );
  });
});

describe("the pointer", () => {
  it("makes the window under it the one being worked in", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.WindowHovered(APP("kitty")),
    );

    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("raises a floating window it crosses into", () => {
    // Applies to every window kind, including browser windows with no client.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
      WindowAction.WindowHovered(APP("kitty")),
      WindowAction.FloatToggled(),
      WindowAction.WindowHovered(APP("editor")),
    );

    expect(
      workspaceHere(state).floats.flatMap(({ root }) => windowsIn(root)),
    ).toEqual([APP("kitty"), APP("editor")]);
  });

  // Crossing a tab row enters the container, so focus goes to its shown tab.
  // Only a click changes the shown tab.
  it("goes to the open tab of a container whose hidden tab it crosses", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("mail", "mail"),
      WindowAction.LayoutSet(Layout.Tabbed),
      WindowAction.FocusStepped(Direction.Left),
      WindowAction.FocusStepped(Direction.Left),
      WindowAction.WindowHovered(APP("mail")),
    );

    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("goes to the open tab of a floating group whose hidden tab it crosses", () => {
    const state = reduce(
      desktop("mail", "kitty"),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
      WindowAction.ParentFocused(),
      WindowAction.FloatToggled(),
      WindowAction.ModeSwapped(),
      WindowAction.WindowHovered(APP("kitty")),
    );

    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("goes to a fullscreen window a tab opened since would hide", () => {
    // A fullscreen window is visible regardless of the tree.
    const state = reduce(
      desktop("kitty"),
      WindowAction.FullscreenToggled(false),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.WindowHovered(APP("kitty")),
    );

    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("reports a window on another workspace as nothing at all", () => {
    // The page cannot report this, since an off-screen window has no box, and
    // it would focus something invisible.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToWorkspace("2"),
    );

    expect(
      reduceWindows(state, WindowAction.WindowHovered(APP("editor"))),
    ).toBe(state);
  });

  it("answers a press in the window it is already in with the same state", () => {
    // `AppWindow` reports every press, most of which change nothing. Returning
    // a new object would re-render the desktop on every click and undo `focus
    // parent`.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ParentFocused(),
    );

    expect(
      reduceWindows(state, WindowAction.WindowSelected(APP("editor"))),
    ).toBe(state);
  });

  it("goes to the workspace of a window that asks to be reached", () => {
    // `xdg-activation`, which this shell grants. The window already has its
    // workspace's focus, so granting means switching to that workspace.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToWorkspace("2"),
    );

    expect(
      currentHere(
        reduceWindows(state, WindowAction.FocusRequested(APP("editor"))),
      ),
    ).toBe("2");
  });

  it("moves the keyboard to the screen the window it crossed is on", () => {
    // Focus follows the pointer across monitors. Each screen is its own page,
    // so the page that saw the pointer reports it.
    const state = reduce(
      desktop(),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.AppAppeared("kitty", "kitty"),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.WindowHovered(APP("kitty")),
    );

    expect(state.focused).toBe("left");
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("moves the keyboard to a screen it crossed onto with no window under it", () => {
    // As in sway, focus follows the pointer onto an empty output, where the
    // next window should open.
    const state = reduce(
      desktop(),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.AppAppeared("kitty", "kitty"),
      WindowAction.ScreenHovered("right"),
    );

    expect(state.focused).toBe("right");
    expect(activeIdOf(state)).toBeUndefined();
  });

  it("answers a pointer on the screen the keyboard is on with the same state", () => {
    // Reported on every pointer move, so a no-op must return the same state.
    const state = reduce(
      desktop(),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
    );

    expect(reduceWindows(state, WindowAction.ScreenHovered("left"))).toBe(
      state,
    );
  });

  it("leaves the keyboard where it is for a screen the desk has not taken up", () => {
    // A new monitor's page can see the pointer before the reducer learns the
    // screen exists.
    const state = reduce(
      desktop(),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
    );

    expect(reduceWindows(state, WindowAction.ScreenHovered("docked"))).toBe(
      state,
    );
  });

  it("raises and holds the window a drag takes hold of", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
      WindowAction.WindowGrabbed(APP("editor")),
    );

    expect(state.draggingId).toBe(APP("editor"));
    expect(
      reduceWindows(state, WindowAction.WindowDropped()).draggingId,
    ).toBeUndefined();
  });

  it("tabs a tiled window after the one it is dropped in the middle of", () => {
    const state = reduce(
      desktop("kitty", "editor", "browser"),
      WindowAction.WindowDroppedOn(
        APP("kitty"),
        { id: APP("browser"), up: 0 },
        undefined,
      ),
    );

    expect(windowsOf(workspaceHere(state).tiling)).toEqual([
      APP("editor"),
      APP("browser"),
      APP("kitty"),
    ]);
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("drags a tiled window's edge by a share of the screen it is on", () => {
    // Two windows share a 1060px screen minus three 20px gaps, one between
    // them and one at each edge, so 100px is a tenth of their share.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.WindowStretched(APP("kitty"), Direction.Right, 100, {
        height: 800,
        width: 1060,
        x: 0,
        y: 0,
      }),
    );

    expect(workspaceHere(state).tiling.root).toMatchObject({
      fractions: [0.6, 0.4],
    });
  });

  it("puts a dragged window where it was dropped", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.FloatToggled(),
      WindowAction.WindowMoved(APP("kitty"), 300, 200),
      WindowAction.WindowResized(APP("kitty"), {
        height: 600,
        width: 800,
        x: 250,
        y: 150,
      }),
    );

    // A resize from the top-left corner moves the window as well.
    expect(workspaceHere(state).floats[0]).toMatchObject({
      height: 600,
      width: 800,
      x: 250,
      y: 150,
    });
  });
});

describe("a tiled window dragged across screens", () => {
  /** Kitty and the editor on the left screen; a terminal on the right. */
  const twoScreens = () =>
    reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("term", "term"),
      WindowAction.ScreenHovered("left"),
    );

  it("goes beside the window it is dropped on, and takes the keyboard there", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.WindowDroppedOn(
        APP("kitty"),
        { id: APP("term"), up: 0 },
        Direction.Left,
      ),
    );

    expect(state.focused).toBe("right");
    expect(activeIdOf(state)).toBe(APP("kitty"));
    expect(windowsOf(workspaceOn(state, "left").tiling)).toEqual([
      APP("editor"),
    ]);
    expect(windowsOf(workspaceOn(state, "right").tiling)).toEqual([
      APP("kitty"),
      APP("term"),
    ]);
  });

  it("splits a nested group it is dropped apart from", () => {
    const state = reduce(
      desktop("a", "b"),
      WindowAction.TabSubgrouped(),
      WindowAction.AppAppeared("c", "c"),
      WindowAction.WindowDroppedOn(
        APP("c"),
        { id: APP("b"), up: 1 },
        Direction.Right,
        Beside.Apart,
      ),
    );

    expect(workspaceHere(state).tiling.root).toMatchObject({
      children: [
        { id: APP("a") },
        {
          children: [
            { children: [{ id: APP("b") }] },
            { children: [{ id: APP("c") }] },
          ],
          layout: Layout.SplitH,
        },
      ],
      layout: Layout.Tabbed,
    });
  });

  it("joins the tab group of the window it is dropped in the middle of", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.WindowDroppedOn(
        APP("kitty"),
        { id: APP("term"), up: 0 },
        undefined,
      ),
    );

    expect(windowsOf(workspaceOn(state, "left").tiling)).toEqual([
      APP("editor"),
    ]);
    expect(workspaceOn(state, "right").tiling.root).toMatchObject({
      children: [{ id: APP("term") }, { id: APP("kitty") }],
      layout: Layout.Tabbed,
    });
  });

  it("fills a screen with nothing tiled on it", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WindowDroppedOnScreen(APP("kitty"), "right"),
    );

    expect(state.focused).toBe("right");
    expect(windowsOf(workspaceOn(state, "left").tiling)).toEqual([
      APP("editor"),
    ]);
    expect(windowsOf(workspaceOn(state, "right").tiling)).toEqual([
      APP("kitty"),
    ]);
  });
});

describe("the buttons on a tab group's strip", () => {
  /** Kitty and the editor tabbed on the left screen; a terminal on the right. */
  const twoScreens = () =>
    reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("term", "term"),
    );
  /** The tab group, named by its open tab, as its strip names it. */
  const GROUP = { id: APP("editor"), up: 1 };

  it("floats the whole group, from another screen", () => {
    const state = reduce(twoScreens(), WindowAction.GroupFloated(GROUP));
    const left = workspaceOn(state, "left");

    expect(windowsOf(left.tiling)).toEqual([]);
    expect(left.floats.map(({ root }) => windowsIn(root))).toEqual([
      [APP("kitty"), APP("editor")],
    ]);
    expect(state.focused).toBe("left");
  });

  it("fills the screen with the whole group, and gives it back", () => {
    const full = reduce(twoScreens(), WindowAction.GroupFullscreened(GROUP));

    expect(workspaceOn(full, "left").fullscreen).toEqual({
      global: false,
      ...GROUP,
    });
    expect(
      workspaceOn(reduce(full, WindowAction.GroupFullscreened(GROUP)), "left")
        .fullscreen,
    ).toBeUndefined();
  });

  it("leaves the selection on the open tab", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.GroupFullscreened(GROUP),
      WindowAction.GroupFullscreened(GROUP),
    );

    expect(focusedNodeOf(workspaceOn(state, "left").tiling)).toEqual(
      LayoutNode.Window(APP("editor"), 2),
    );
  });

  it("fills the screen with a floating group", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
      WindowAction.GroupFullscreened(GROUP),
    );

    expect(workspaceHere(state).fullscreen).toEqual({
      global: false,
      ...GROUP,
    });
  });
});

describe("a tab of a selected group", () => {
  /** Kitty and the editor tabbed, the whole group selected. */
  const selected = () =>
    reduce(desktop("kitty", "editor"), WindowAction.ParentFocused());
  /** The two tabbed and floated as one box. */
  const floated = () => reduce(selected(), WindowAction.FloatToggled());
  const floatsOf = (state: WindowState) =>
    workspaceHere(state).floats.map(({ root }) => windowsIn(root));

  it("takes the selection when its open tab is pressed", () => {
    const state = reduce(
      selected(),
      WindowAction.WindowBarPressed(APP("editor")),
    );

    expect(focusedNodeOf(workspaceHere(state).tiling)).toEqual(
      LayoutNode.Window(APP("editor"), 2),
    );
  });

  it("answers a press on the bar of a window alone in focus with the same state", () => {
    const state = desktop("kitty", "editor");

    expect(
      reduceWindows(state, WindowAction.WindowBarPressed(APP("editor"))),
    ).toBe(state);
  });

  it("floats alone from its float button", () => {
    const state = reduce(selected(), WindowAction.WindowFloated(APP("editor")));

    expect(windowsOf(workspaceHere(state).tiling)).toEqual([APP("kitty")]);
    expect(floatsOf(state)).toEqual([[APP("editor")]]);
  });

  it("tiles alone from its float button in a floating group", () => {
    const state = reduce(floated(), WindowAction.WindowFloated(APP("editor")));

    expect(windowsOf(workspaceHere(state).tiling)).toEqual([APP("editor")]);
    expect(floatsOf(state)).toEqual([[APP("kitty")]]);
  });
});

describe("a tab group dragged by its strip", () => {
  /** Kitty and the editor tabbed on the left screen; a terminal on the right. */
  const twoScreens = () =>
    reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.AppAppeared("term", "term"),
      WindowAction.ScreenHovered("left"),
    );
  /** Mail beside kitty and the editor tabbed, the editor focused. */
  const tabbedBesideMail = () =>
    reduce(
      desktop("mail", "kitty"),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("editor", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
    );
  const GROUP = { id: APP("kitty"), up: 1 };

  it("holds the group a drag takes hold of, focusing its open tab alone", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.WindowSelected(APP("editor")),
      WindowAction.GroupGrabbed(GROUP),
    );

    expect(state.draggingId).toBe(APP("kitty"));
    expect(focusedNodeOf(workspaceHere(state).tiling)).toMatchObject({
      id: APP("editor"),
      kind: NodeKind.Window,
    });
  });

  it("keeps a selection already on the group a drag takes hold of", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.WindowSelected(APP("editor")),
      WindowAction.ParentFocused(),
      WindowAction.GroupGrabbed(GROUP),
    );

    expect(focusedNodeOf(workspaceHere(state).tiling)).toMatchObject({
      layout: Layout.Tabbed,
    });
  });

  it("goes whole beside the window it is dropped on, on another screen", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.GroupDroppedOn(
        GROUP,
        { id: APP("term"), up: 0 },
        Direction.Left,
      ),
    );

    expect(state.focused).toBe("right");
    expect(windowsOf(workspaceOn(state, "left").tiling)).toEqual([]);
    expect(windowsOf(workspaceOn(state, "right").tiling)).toEqual([
      APP("kitty"),
      APP("editor"),
      APP("term"),
    ]);
  });

  it("fills a screen with nothing tiled on it", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.GroupDroppedOnScreen(GROUP, "right"),
    );

    expect(state.focused).toBe("right");
    expect(windowsOf(workspaceOn(state, "left").tiling)).toEqual([]);
    expect(windowsOf(workspaceOn(state, "right").tiling)).toEqual([
      APP("kitty"),
      APP("editor"),
    ]);
  });

  it("leaves its open tab focused alone when dropped on another screen", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.GroupGrabbed(GROUP),
      WindowAction.GroupDroppedOn(
        GROUP,
        { id: APP("term"), up: 0 },
        Direction.Left,
      ),
    );

    expect(focusedNodeOf(workspaceOn(state, "right").tiling)).toMatchObject({
      kind: NodeKind.Window,
    });
  });

  it("leaves its open tab focused alone when dropped on its own screen", () => {
    const state = reduce(
      tabbedBesideMail(),
      WindowAction.GroupGrabbed(GROUP),
      WindowAction.GroupDroppedOn(
        GROUP,
        { id: APP("mail"), up: 0 },
        Direction.Left,
      ),
    );

    expect(focusedNodeOf(workspaceHere(state).tiling)).toMatchObject({
      kind: NodeKind.Window,
    });
  });

  it("stays selected when dropped while selected", () => {
    const state = reduce(
      tabbedBesideMail(),
      WindowAction.ParentFocused(),
      WindowAction.GroupDroppedOn(
        GROUP,
        { id: APP("mail"), up: 0 },
        Direction.Left,
      ),
    );

    expect(focusedNodeOf(workspaceHere(state).tiling)).toMatchObject({
      layout: Layout.Tabbed,
    });
  });

  it("stays selected when dropped on another screen while selected", () => {
    const state = reduce(
      twoScreens(),
      WindowAction.ParentFocused(),
      WindowAction.GroupDroppedOn(
        GROUP,
        { id: APP("term"), up: 0 },
        Direction.Left,
      ),
    );

    expect(focusedNodeOf(workspaceOn(state, "right").tiling)).toMatchObject({
      layout: Layout.Tabbed,
    });
  });

  it("leaves its open tab focused alone when dropped on an empty screen", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.GroupGrabbed(GROUP),
      WindowAction.GroupDroppedOnScreen(GROUP, "right"),
    );

    expect(focusedNodeOf(workspaceOn(state, "right").tiling)).toMatchObject({
      kind: NodeKind.Window,
    });
  });
});

describe("a floating window dragged across screens", () => {
  /** Kitty floating on the left of two screens, grabbed. */
  const held = () =>
    reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.FloatToggled(),
      WindowAction.WindowGrabbed(APP("kitty")),
    );

  it("goes to the screen its middle crosses onto, in that screen's pixels", () => {
    // 640 wide from 1700 puts its center at 2020, 100 past the edge.
    const state = reduce(
      held(),
      WindowAction.WindowMoved(APP("kitty"), 1700, 100),
    );

    expect(windowsOn(workspaceOn(state, "left"))).toEqual([]);
    expect(workspaceOn(state, "right").floats[0]).toMatchObject({
      x: -220,
      y: 100,
    });
    expect(state.focused).toBe("right");
    expect(activeIdOf(state)).toBe(APP("kitty"));
    expect(state.draggingId).toBe(APP("kitty"));
  });

  it("keeps focus while the pointer is still on the screen it left", () => {
    // Held off-center, its middle crosses before the pointer does, and the
    // pointer keeps reporting the screen it is over.
    const state = reduce(
      held(),
      WindowAction.WindowMoved(APP("kitty"), 1700, 100),
      WindowAction.ScreenHovered("left"),
    );

    expect(state.focused).toBe("right");
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("keeps focus while the pointer crosses another window", () => {
    const state = reduce(
      desktop("editor", "kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.FloatToggled(),
      WindowAction.WindowGrabbed(APP("kitty")),
      WindowAction.WindowHovered(APP("editor")),
    );

    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("takes the drag in the page's pixels, whichever screen it is on", () => {
    // One page spans the desk, so drags use desk coordinates: the second move
    // lands on the right screen at 1800 - 1920.
    const state = reduce(
      held(),
      WindowAction.WindowMoved(APP("kitty"), 1700, 100),
      WindowAction.WindowMoved(APP("kitty"), 1800, 120),
    );

    expect(workspaceOn(state, "right").floats[0]).toMatchObject({
      x: -120,
      y: 120,
    });
  });

  it("comes back to the screen its middle crosses back onto", () => {
    const state = reduce(
      held(),
      WindowAction.WindowMoved(APP("kitty"), 1700, 100),
      WindowAction.WindowMoved(APP("kitty"), 1000, 100),
    );

    expect(windowsOn(workspaceOn(state, "right"))).toEqual([]);
    expect(workspaceOn(state, "left").floats[0]).toMatchObject({
      x: 1000,
      y: 100,
    });
    expect(state.focused).toBe("left");
  });

  it("stays on its screen while its middle is on no screen at all", () => {
    const state = reduce(
      held(),
      WindowAction.WindowMoved(APP("kitty"), 1700, -1000),
    );

    expect(workspaceOn(state, "left").floats[0]).toMatchObject({
      x: 1700,
      y: -1000,
    });
    expect(state.focused).toBe("left");
  });

  it("takes a browser window across like any other", () => {
    // The desk draws each window once, so the `<webview>` keeps its element and
    // does not reload. See docs/architecture/ONE-PAGE-FOR-THE-DESK.md.
    const state = reduce(
      desktop(),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.BrowserWindowsListed([listed("1", "https://example.com/")]),
      WindowAction.FloatToggled(),
      WindowAction.WindowMoved(BROWSER("1"), 1700, 100),
    );

    expect(windowsOn(workspaceOn(state, "left"))).toEqual([]);
    expect(workspaceOn(state, "right").floats[0]).toMatchObject({
      x: -220,
      y: 100,
    });
    expect(state.focused).toBe("right");
  });
});

describe("the buttons on a window's own title bar", () => {
  it("fills the screen with the window whose bar it is, not the one being worked in", () => {
    // A title bar button acts on its own window, not the focused one.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowFullscreened(APP("kitty")),
    );

    expect(workspaceHere(state).fullscreen).toEqual({
      global: false,
      id: APP("kitty"),
      up: 0,
    });
    expect(activeIdOf(state)).toBe(APP("kitty"));
  });

  it("gives the screen back when the same button is pressed again", () => {
    // The same toggle as `mod+f`.
    const state = reduce(
      desktop("kitty"),
      WindowAction.WindowFullscreened(APP("kitty")),
      WindowAction.WindowFullscreened(APP("kitty")),
    );

    expect(workspaceHere(state).fullscreen).toBeUndefined();
  });

  it("floats the window whose bar it is, not the one being worked in, and tiles it again", () => {
    const floated = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowFloated(APP("kitty")),
    );
    expect(
      workspaceHere(floated).floats.flatMap(({ root }) => windowsIn(root)),
    ).toEqual([APP("kitty")]);

    const tiled = reduce(floated, WindowAction.WindowFloated(APP("kitty")));
    expect(workspaceHere(tiled).floats).toEqual([]);
  });
});

describe("the clipboard panel", () => {
  it("is shut on a desktop nobody has opened it on", () => {
    expect(NO_WINDOWS.clipboardOpen).toBe(false);
  });

  it("opens and shuts on the same key", () => {
    // Same as the launcher: the key that opens the panel also closes it.
    const opened = reduce(NO_WINDOWS, WindowAction.ClipboardToggled());
    expect(opened.clipboardOpen).toBe(true);

    expect(reduce(opened, WindowAction.ClipboardToggled()).clipboardOpen).toBe(
      false,
    );
  });

  it("shuts when it is dismissed, however many times", () => {
    // Escape, a backdrop click and choosing a row all report a close, so
    // dismissing a closed panel must be a no-op.
    const dismissed = reduce(
      NO_WINDOWS,
      WindowAction.ClipboardToggled(),
      WindowAction.ClipboardDismissed(),
      WindowAction.ClipboardDismissed(),
    );

    expect(dismissed.clipboardOpen).toBe(false);
  });
});

describe("the launcher", () => {
  it("is shut on a desktop nobody has opened it on", () => {
    expect(NO_WINDOWS.launcherOpen).toBe(false);
  });

  it("opens and shuts on the same key", () => {
    // One binding: pressing `mod+space` again to close is the same reflex as
    // Escape.
    const opened = reduce(NO_WINDOWS, WindowAction.LauncherToggled());
    expect(opened.launcherOpen).toBe(true);

    expect(reduce(opened, WindowAction.LauncherToggled()).launcherOpen).toBe(
      false,
    );
  });

  it("opens from a tab strip's new-tab button, on the strip's open tab", () => {
    // A new window opens beside the focused one, so it joins the strip.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("mail", "mail"),
      WindowAction.LayoutSet(Layout.Tabbed),
      WindowAction.FocusStepped(Direction.Left),
      WindowAction.FocusStepped(Direction.Left),
      WindowAction.NewTabPressed(APP("mail")),
    );

    expect(state.launcherOpen).toBe(true);
    expect(activeIdOf(state)).toBe(APP("editor"));
  });

  it("shuts when it is dismissed, however many times", () => {
    // Escape and a backdrop click both report a close, and the dialog also
    // reports its own closing, so dismissing a closed launcher must be a no-op.
    const dismissed = reduce(
      NO_WINDOWS,
      WindowAction.LauncherToggled(),
      WindowAction.LauncherDismissed(),
      WindowAction.LauncherDismissed(),
    );

    expect(dismissed.launcherOpen).toBe(false);
  });

  it("shuts behind the browser window it opened", () => {
    // Leaving the launcher over the new window would force the user to dismiss
    // it. The launch action closes it on both query paths.
    const launched = reduce(
      NO_WINDOWS,
      WindowAction.LauncherToggled(),
      WindowAction.BrowserOpened("https://example.com", false),
    );

    expect(launched.launcherOpen).toBe(false);
  });

  it("shuts behind the application it ran, and opens no window itself", () => {
    // The application is a Wayland client, as with opening a file.
    const launched = reduce(
      NO_WINDOWS,
      WindowAction.LauncherToggled(),
      WindowAction.AppLaunched(["gedit"]),
    );

    expect(launched.launcherOpen).toBe(false);
    expect(launched.windows).toStrictEqual([]);
  });

  it("shuts behind the file it opened, and opens no window itself", () => {
    // The file opener is a spawned Wayland client, so its window arrives
    // through `app_appeared`, as with `CommandExecuted`.
    const launched = reduce(
      NO_WINDOWS,
      WindowAction.LauncherToggled(),
      WindowAction.FileOpened("Notes/today.org"),
    );

    expect(launched.launcherOpen).toBe(false);
    expect(launched.windows).toStrictEqual([]);
  });
});

describe("a client's limits on its size", () => {
  /** The one float on the workspace on screen. */
  const floatOf = (state: WindowState) => {
    const [float] = workspaceHere(state).floats;
    if (float === undefined) {
      throw new Error("nothing is floating");
    } else {
      return float;
    }
  };

  it("float a window no smaller than its client will draw", () => {
    // Bitwarden's 680x500 minimum exceeds the default float size when no screen
    // is described. Smaller, its frame would be cut off at the box's edge. Its
    // bar comes on top.
    const state = reduce(
      desktop("vault"),
      WindowAction.AppMinSize("vault", [680, 500]),
      WindowAction.FloatToggled(),
    );

    // The client's surface tucks under the bar. See `surfaceOf`.
    expect(floatOf(state)).toMatchObject({
      height: 500 + TITLE_BAR - SURFACE_TUCK,
      width: 680,
    });
  });

  it("float a window no bigger than the screen the keyboard is on", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed([
        { box: { height: 400, width: 600, x: 0, y: 0 }, name: "small" },
      ]),
      WindowAction.FloatToggled(),
    );

    expect(floatOf(state).width).toBeLessThanOrEqual(600);
    expect(floatOf(state).height).toBeLessThanOrEqual(400);
  });

  it("grow a float when the limit arrives after it", () => {
    // A client sends its limits on its own commit, which can come after the
    // window was floated.
    const state = reduce(
      desktop("vault"),
      WindowAction.FloatToggled(),
      WindowAction.AppMinSize("vault", [680, undefined]),
    );

    expect(floatOf(state).width).toBe(680);
  });

  it("stop a float being dragged past the largest its client will draw", () => {
    const floated = reduce(
      desktop("dialog"),
      WindowAction.AppMaxSize("dialog", [700, undefined]),
      WindowAction.FloatToggled(),
    );
    const { x, y } = floatOf(floated);

    const state = reduce(
      floated,
      WindowAction.WindowResized(APP("dialog"), {
        height: 900,
        width: 1200,
        x,
        y,
      }),
    );

    expect(floatOf(state)).toMatchObject({ height: 900, width: 700, x, y });
  });

  it("keep the edge nobody dragged where it was", () => {
    // Dragged in from the left, the right edge stays put, so a window at its
    // minimum stops instead of sliding right.
    const floated = reduce(
      desktop("vault"),
      WindowAction.AppMinSize("vault", [680, undefined]),
      WindowAction.FloatToggled(),
    );
    const before = floatOf(floated);
    const right = before.x + before.width;

    const state = reduce(
      floated,
      WindowAction.WindowResized(APP("vault"), {
        height: before.height,
        width: before.width - 100,
        x: before.x + 100,
        y: before.y,
      }),
    );

    expect(floatOf(state)).toMatchObject({ width: 680, x: right - 680 });
  });
});

describe("a client's popups", () => {
  const MENU = {
    appId: "menu",
    cursor: "default",
    frame: 0,
    parent: "term",
    position: [12, 30],
    size: [180, 240],
  } as const;

  it("are held as they are placed, and moved in place", () => {
    const state = reduce(
      desktop("term"),
      WindowAction.PopupPlaced(MENU),
      WindowAction.PopupPlaced({ ...MENU, position: [40, 30] }),
    );

    expect(state.popups).toEqual([{ ...MENU, position: [40, 30] }]);
    // Popups are never windows: a menu in its own frame is a bug.
    expect(state.windows.map(({ id }) => id)).toEqual([APP("term")]);
  });

  it("go when the client closes them, and leave the window alone", () => {
    const state = reduce(
      desktop("term"),
      WindowAction.PopupPlaced(MENU),
      WindowAction.AppClosed("menu"),
    );

    expect(state.popups).toEqual([]);
    expect(state.windows.map(({ id }) => id)).toEqual([APP("term")]);
  });
});

describe("stepping through the workspaces", () => {
  /** Windows on workspaces 1 and 3, showing 3. */
  const onOneAndThree = () =>
    reduce(
      desktop("kitty"),
      WindowAction.WorkspaceSelected("3"),
      WindowAction.AppAppeared("foot", "foot"),
    );

  it("goes to the screen's next and previous ones, as its bar lists them", () => {
    const back = reduce(onOneAndThree(), WindowAction.WorkspaceStepped("prev"));
    const ahead = reduce(back, WindowAction.WorkspaceStepped("next"));

    expect(currentHere(back)).toBe("1");
    expect(currentHere(ahead)).toBe("3");
  });

  it("wraps around, as sway's `next_on_output` does", () => {
    const state = reduce(
      onOneAndThree(),
      WindowAction.WorkspaceStepped("next"),
    );

    expect(currentHere(state)).toBe("1");
  });

  it("stays put with nothing else on the screen", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.WorkspaceStepped("next"),
    );

    expect(currentHere(state)).toBe("1");
  });
});

describe("the overview", () => {
  /** kitty on workspace 1, foot on 3, showing 3. */
  const onOneAndThree = () =>
    reduce(
      desktop("kitty"),
      WindowAction.WorkspaceSelected("3"),
      WindowAction.AppAppeared("foot", "foot"),
    );

  it("opens and shuts on the same key, closing the launcher and clipboard", () => {
    const opened = reduce(
      NO_WINDOWS,
      WindowAction.LauncherToggled(),
      WindowAction.ClipboardToggled(),
      WindowAction.OverviewToggled(),
    );

    expect(opened.overviewOpen).toBe(true);
    expect(opened.launcherOpen).toBe(false);
    expect(opened.clipboardOpen).toBe(false);
    expect(reduce(opened, WindowAction.OverviewToggled()).overviewOpen).toBe(
      false,
    );
  });

  it("opens and stays open on `overview show`, and closes on `overview hide`", () => {
    const shown = reduce(
      NO_WINDOWS,
      WindowAction.LauncherToggled(),
      WindowAction.OverviewShown(),
    );

    expect(shown.overviewOpen).toBe(true);
    expect(shown.launcherOpen).toBe(false);
    expect(reduceWindows(shown, WindowAction.OverviewShown())).toBe(shown);
    expect(reduce(shown, WindowAction.OverviewDismissed()).overviewOpen).toBe(
      false,
    );
  });

  it.each([
    ["launcher", WindowAction.LauncherToggled(), "launcherOpen"],
    ["clipboard", WindowAction.ClipboardToggled(), "clipboardOpen"],
  ] as const)("gives way to the %s", (_, toggled, open) => {
    // One panel at a time, as opening the overview closes the others.
    const state = reduce(NO_WINDOWS, WindowAction.OverviewToggled(), toggled);

    expect(state.overviewOpen).toBe(false);
    expect(state[open]).toBe(true);
  });

  it("drops a window drag in progress as it opens", () => {
    // The drag's handles go away under the overview, so its drop never comes.
    const state = reduce(
      desktop("kitty"),
      WindowAction.WindowGrabbed(appWindowId("kitty")),
      WindowAction.OverviewToggled(),
    );

    expect(state.draggingId).toBeUndefined();
  });

  it("shuts on the workspace picked, even the one already shown", () => {
    // Picking the shown workspace must not go back and forth, as its key does.
    const elsewhere = reduce(
      onOneAndThree(),
      WindowAction.OverviewToggled(),
      WindowAction.OverviewPicked("1"),
    );
    const here = reduce(
      onOneAndThree(),
      WindowAction.OverviewToggled(),
      WindowAction.OverviewPicked("3"),
    );

    expect(currentHere(elsewhere)).toBe("1");
    expect(elsewhere.overviewOpen).toBe(false);
    expect(currentHere(here)).toBe("3");
    expect(here.overviewOpen).toBe(false);
  });

  it("shuts on the window picked, focusing it and moving the pointer there", () => {
    const before = reduce(onOneAndThree(), WindowAction.OverviewToggled());
    const state = reduce(
      before,
      WindowAction.OverviewWindowPicked(APP("kitty")),
    );

    expect(currentHere(state)).toBe("1");
    expect(activeIdOf(state)).toBe(APP("kitty"));
    expect(state.overviewOpen).toBe(false);
    expect(state.pressed).toBe(before.pressed + 1);
  });

  it("shuts when dismissed", () => {
    const state = reduce(
      NO_WINDOWS,
      WindowAction.OverviewToggled(),
      WindowAction.OverviewDismissed(),
    );

    expect(state.overviewOpen).toBe(false);
  });

  it("moves a window dropped on another workspace, leaving the screen where it was", () => {
    const state = reduce(
      onOneAndThree(),
      WindowAction.OverviewToggled(),
      WindowAction.WindowMovedToWorkspace(APP("kitty"), "3"),
    );

    expect(windowsOn(workspaceNamed(state, "1"))).toStrictEqual([]);
    expect(windowsOn(workspaceNamed(state, "3")).toSorted()).toStrictEqual(
      [APP("foot"), APP("kitty")].toSorted(),
    );
    expect(currentHere(state)).toBe("3");
    expect(state.overviewOpen).toBe(true);
  });

  it("aims at a workspace, forgetting the aim once it closes", () => {
    const aimed = reduce(
      onOneAndThree(),
      WindowAction.OverviewToggled(),
      WindowAction.OverviewAimed("1"),
    );

    expect(aimed.overviewAim).toBe("1");
    expect(
      reduce(aimed, WindowAction.OverviewDismissed()).overviewAim,
    ).toBeUndefined();
  });

  it("forgets the aim once its workspace has no tile", () => {
    // Its last window dragged away, workspace 1 leaves the bar and the
    // overview; the keys go back to the shown workspace.
    const state = reduce(
      onOneAndThree(),
      WindowAction.OverviewToggled(),
      WindowAction.OverviewAimed("1"),
      WindowAction.WindowMovedToWorkspace(APP("kitty"), "3"),
    );

    expect(state.overviewAim).toBeUndefined();
  });

  it("trades the two tiles' cards on each swap, so each follows its windows", () => {
    const once = reduce(
      onOneAndThree(),
      WindowAction.OverviewToggled(),
      WindowAction.WorkspacesSwapped("3", "1"),
    );
    const twice = reduce(once, WindowAction.WorkspacesSwapped("1", "2"));

    expect(once.overviewCards).toStrictEqual({ "1": "3", "3": "1" });
    expect(twice.overviewCards).toStrictEqual({ "1": "2", "2": "3", "3": "1" });
    // Kept as it closes and opens again: every card looks alike, and
    // dealing them afresh would slide cards still drawn as it reopens.
    const reopened = reduce(
      twice,
      WindowAction.OverviewDismissed(),
      WindowAction.OverviewToggled(),
    );
    expect(reopened.overviewCards).toStrictEqual(twice.overviewCards);
  });

  it("swaps two workspaces' windows, the screen and the aim following the one aimed at", () => {
    // Workspace 3, shown, moves to slot 1: it is still what the screen
    // shows, now as 1.
    const state = reduce(
      onOneAndThree(),
      WindowAction.OverviewToggled(),
      WindowAction.WorkspacesSwapped("3", "1"),
    );

    expect(windowsOn(workspaceNamed(state, "1"))).toStrictEqual([APP("foot")]);
    expect(windowsOn(workspaceNamed(state, "3"))).toStrictEqual([APP("kitty")]);
    expect(currentHere(state)).toBe("1");
    expect(state.overviewAim).toBe("1");
  });

  it("swaps with a workspace on another monitor, each monitor keeping its places", () => {
    // 1 on the left, 2 on the right. The names stay where they are: the
    // windows cross, and each screen shows what is in its own place now.
    const state = reduce(
      desktop("kitty"),
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.ScreenHovered("right"),
      WindowAction.AppAppeared("foot", "foot"),
      WindowAction.OverviewToggled(),
      WindowAction.WorkspacesSwapped("1", "2"),
    );

    expect(windowsOn(workspaceNamed(state, "1"))).toStrictEqual([APP("foot")]);
    expect(windowsOn(workspaceNamed(state, "2"))).toStrictEqual([APP("kitty")]);
    expect(currentOn(state, "left")).toBe("1");
    expect(currentOn(state, "right")).toBe("2");
    expect(state.homes["1"]).toBe("left");
    expect(state.homes["2"]).toBe("right");
    expect(state.overviewAim).toBe("2");
  });

  it("keeps the aim on its own monitor, and back-and-forth as it was, when a swap across empties what it followed", () => {
    // The left screen shows 1, empty; 4 is hidden on the right with a
    // window. Swapped, 4 is empty and hidden, so it leaves the overview: the
    // aim stays on 1, where the window landed.
    const state = reduce(
      NO_WINDOWS,
      WindowAction.ScreensDescribed(sideBySide("left", "right")),
      WindowAction.ScreenHovered("right"),
      WindowAction.WorkspaceSelected("4"),
      WindowAction.AppAppeared("foot", "foot"),
      WindowAction.WorkspaceSelected("2"),
      WindowAction.ScreenHovered("left"),
      WindowAction.OverviewToggled(),
      WindowAction.WorkspacesSwapped("1", "4"),
    );

    expect(windowsOn(workspaceNamed(state, "1"))).toStrictEqual([APP("foot")]);
    expect(state.overviewAim).toBe("1");
    // Back-and-forth goes where it went: the places stayed.
    expect(state.previous).toBe("4");
  });

  it.each([
    ["focus", WindowAction.FocusStepped(Direction.Left)],
    ["move", WindowAction.WindowStepped(Direction.Left)],
    ["workspace", WindowAction.WorkspaceSelected("1")],
    ["layout", WindowAction.LayoutSet(Layout.Tabbed)],
    ["kill", WindowAction.WindowKilled()],
    ["scratchpad", WindowAction.ScratchpadShown()],
  ] as const)("ignores `%s` while open", (_, action) => {
    // Its keys steer the overview instead; see `steeredInOverview`.
    const before = reduce(onOneAndThree(), WindowAction.OverviewToggled());

    expect(reduce(before, action)).toBe(before);
  });

  it("leaves a window dropped back on its own workspace", () => {
    const before = reduce(onOneAndThree(), WindowAction.OverviewToggled());

    expect(
      reduce(before, WindowAction.WindowMovedToWorkspace(APP("kitty"), "1")),
    ).toBe(before);
  });
});
