import { describe, expect, it } from "bun:test";

import { token } from "../styled-system/tokens";
import { Axis, Direction } from "./direction";
import type { Geometry } from "./placement";
import {
  contentsOf,
  FULLSCREEN,
  GRABBING,
  leaving,
  placementsOf,
  raised,
  TILED,
  wellDepthOf,
} from "./placement";
import { SURFACE_TUCK, TITLE_BAR } from "./rect";
import { Layout } from "./tree/node";
import { appWindowId } from "./window";
import type { WindowState } from "./window-state";
import {
  NO_WINDOWS,
  reduceWindows,
  WindowAction,
  workspaceHere,
  workspaceOn,
} from "./window-state";

const GEOMETRY: Geometry = {
  desktop: { height: 1080, width: 3200, x: 0, y: 0 },
  // The default screen, where `NO_WINDOWS` puts every window.
  name: "",
  screen: { height: 1080, width: 1920, x: 0, y: 0 },
  workspace: { height: 1048, width: 1920, x: 0, y: 32 },
};

const reduce = (
  state: WindowState,
  ...actions: readonly WindowAction[]
): WindowState => actions.reduce(reduceWindows, state);

const desktop = (...appIds: readonly string[]): WindowState =>
  reduce(
    NO_WINDOWS,
    ...appIds.map((appId) => WindowAction.AppAppeared(appId, appId)),
  );

/** Mail, and a tab holding a row of kitty and the editor; the row selected. */
const nested = (): WindowState =>
  reduce(
    desktop("kitty", "editor", "mail"),
    WindowAction.ContainerSplit(Axis.Vertical),
    WindowAction.FocusStepped(Direction.Up),
    WindowAction.ContainerSplit(Axis.Horizontal),
    WindowAction.ParentFocused(),
    WindowAction.WindowStepped(Direction.Down),
  );

/** What the screen of `geometry` shows. */
const placementsIn = (state: WindowState, geometry: Geometry) =>
  placementsOf(workspaceOn(state, geometry.name), geometry, 0);

const placementFor = (state: WindowState, appId: string) => {
  const { placements } = placementsIn(state, GEOMETRY);
  return placements.find(({ id }) => id === appWindowId(appId));
};

describe("placementsOf", () => {
  it("places nothing on an empty workspace", () => {
    expect(placementsIn(NO_WINDOWS, GEOMETRY)).toEqual({
      focusBox: undefined,
      placements: [],
      tabs: [],
    });
  });

  it("marks the windows inside the container `focus parent` selected", () => {
    // `mod+a` with two tiled windows selects the workspace's root container.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ParentFocused(),
    );

    expect(
      placementsIn(state, GEOMETRY).placements.map(({ selected }) => selected),
    ).toEqual([true, true]);
  });

  it("insets a lone tiled window by the gap at the screen's sides and bottom, half of it under the top bar", () => {
    expect(placementFor(desktop("kitty"), "kitty")).toEqual({
      // A tab at most 240 wide, the rest of the strip after it.
      bar: { height: TITLE_BAR, width: 240, x: 20, y: 42 },
      bare: false,
      behind: undefined,
      depth: 0,
      frame: { height: 1018, width: 1880, x: 20, y: 42 },
      id: appWindowId("kitty"),
      selected: false,
      soleTab: true,
      strip: {
        area: { height: 1018, width: 1880, x: 20, y: 42 },
        at: 0,
        box: { height: TITLE_BAR, width: 1880, x: 20, y: 42 },
        divided: false,
        end: { height: TITLE_BAR, width: 1640, x: 260, y: 42 },
        endDivided: false,
        group: {
          node: { id: appWindowId("kitty"), up: 1 },
          wells: 0,
          windows: [appWindowId("kitty")],
        },
        nested: false,
        open: true,
        tabs: 1,
      },
      surface: {
        height: 1018 - TITLE_BAR + SURFACE_TUCK,
        width: 1880,
        x: 20,
        y: 42 + TITLE_BAR - SURFACE_TUCK,
      },
      // The workspace's tab group, holding one tab.
      tabbed: Layout.Tabbed,
    });
  });

  it("puts the config's gap between two of them and around them", () => {
    // `gaps.inner = 20` between them and at the screen's sides and bottom:
    // 1860 is shared and the second starts 20 past the first.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
    );
    expect(placementFor(state, "kitty")?.frame).toEqual({
      height: 1018,
      width: 930,
      x: 20,
      y: 42,
    });
    expect(placementFor(state, "editor")?.frame).toEqual({
      height: 1018,
      width: 930,
      x: 970,
      y: 42,
    });
  });

  it("leaves the windows on other workspaces off the screen", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToWorkspace("2"),
    );

    expect(placementFor(state, "editor")).toBeUndefined();
    expect(placementFor(state, "kitty")).toBeDefined();
  });

  it("stacks the floating windows over the tiled ones", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
    );

    expect(placementFor(state, "kitty")?.depth).toBe(0);
    expect(placementFor(state, "editor")?.depth).toBeGreaterThan(0);
  });

  it("gives a bare float's client its whole box, with no bar", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.AppAppearedFloating("huddle", "Huddle", [400, 300], true),
    );
    const [float] = workspaceHere(state).floats;
    const box = { height: 300, width: 400, x: float?.x, y: float?.y };

    expect(placementFor(state, "huddle")).toMatchObject({
      bare: true,
      frame: box,
      surface: box,
    });
    expect(placementFor(state, "kitty")?.bare).toBe(false);
  });

  it("puts a float where it is on its own screen, wherever that screen is", () => {
    // A float is in screen pixels, and this screen is offset in the page.
    const state = reduce(desktop("kitty"), WindowAction.FloatToggled());
    const right = { ...GEOMETRY.screen, x: 1920 };

    const { placements } = placementsIn(state, {
      ...GEOMETRY,
      screen: right,
      workspace: { ...GEOMETRY.workspace, x: 1920 },
    });

    expect(placements.map(({ frame }) => frame.x)).toEqual(
      workspaceHere(state).floats.map(({ x }) => 1920 + x),
    );
  });

  it("stacks each float over the one behind it", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
      WindowAction.WindowSelected(appWindowId("kitty")),
      WindowAction.FloatToggled(),
    );

    const front = placementFor(state, "kitty")?.depth ?? 0;
    const behind = placementFor(state, "editor")?.depth ?? 0;
    expect(front).toBeGreaterThan(behind);
  });

  // A window's open tab is drawn just over it, so it must stay under the next
  // window up.
  it("leaves a depth free over each window for its open tab", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
      WindowAction.WindowSelected(appWindowId("kitty")),
      WindowAction.FloatToggled(),
    );

    const front = placementFor(state, "kitty")?.depth ?? 0;
    const behind = placementFor(state, "editor")?.depth ?? 0;
    expect(raised(TILED)).toBeLessThan(behind);
    expect(raised(behind)).toBeLessThan(front);
  });

  // A closing window draws over the windows easing into its space, open tab
  // and all, but must stay under the next window up.
  it("leaves room over each window to close in", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
      WindowAction.WindowSelected(appWindowId("kitty")),
      WindowAction.FloatToggled(),
    );

    const front = placementFor(state, "kitty")?.depth ?? 0;
    const behind = placementFor(state, "editor")?.depth ?? 0;
    expect(leaving(TILED)).toBeGreaterThan(raised(TILED));
    expect(raised(leaving(TILED))).toBeLessThan(behind);
    expect(leaving(behind)).toBeGreaterThan(raised(behind));
    expect(raised(leaving(behind))).toBeLessThan(front);
  });

  it("lays a floating group out inside its box, all at one depth", () => {
    // `mod+a` then `mod+Shift+Tab` over a vertical split floats the split
    // whole.
    const state = reduce(
      desktop("kitty", "editor", "mail"),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.ParentFocused(),
      WindowAction.ParentFocused(),
      WindowAction.FloatToggled(),
    );
    const editor = placementFor(state, "editor");
    const mail = placementFor(state, "mail");

    expect(editor?.depth).toBeGreaterThan(TILED);
    expect(mail?.depth).toBe(editor?.depth);
    expect(mail?.frame.x).toBe(editor?.frame.x);
    // The floating gap is narrower than the tiling's.
    const gap =
      (mail?.frame.y ?? 0) -
      ((editor?.frame.y ?? 0) + (editor?.frame.height ?? 0));
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(20);
  });

  it("stacks the tabs of a floating group with the group", () => {
    const state = reduce(
      nested(),
      WindowAction.ParentFocused(),
      WindowAction.FloatToggled(),
    );

    expect(placementsIn(state, GEOMETRY).tabs).toMatchObject([
      { depth: placementFor(state, "editor")?.depth },
    ]);
  });

  it("fills the screen with a fullscreen window", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FullscreenToggled(false),
    );

    expect(placementFor(state, "editor")?.bare).toBe(false);
    expect(placementFor(state, "editor")?.surface).toMatchObject({
      height: 1080 - TITLE_BAR + SURFACE_TUCK,
      width: 1920,
      x: 0,
      y: TITLE_BAR - SURFACE_TUCK,
    });
  });

  // A fullscreen video covers its tab too, as in a browser.
  it("fills the screen without a bar for a fullscreen page", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.PageFullscreened(appWindowId("editor"), true),
    );

    expect(placementFor(state, "editor")).toMatchObject({
      bare: true,
      surface: GEOMETRY.screen,
    });
  });

  it("keeps a fullscreen page bare over every screen", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.PageFullscreened(appWindowId("editor"), true),
      WindowAction.FullscreenToggled(true),
    );

    expect(placementFor(state, "editor")).toMatchObject({
      bare: true,
      surface: GEOMETRY.desktop,
    });
  });

  // Fullscreen leaves the other windows placed, so they stay drawn while it
  // animates over them.
  it("leaves the rest of the workspace laid out under it", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FullscreenToggled(false),
    );

    expect(placementFor(state, "kitty")).toEqual(
      placementFor(desktop("kitty", "editor"), "kitty"),
    );
  });

  it("goes on reporting the tabs it covers", () => {
    const tabbed = reduce(
      desktop("kitty", "editor"),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("mail", "mail"),
      WindowAction.ParentFocused(),
      WindowAction.ParentFocused(),
      WindowAction.LayoutSet(Layout.Tabbed),
      WindowAction.ChildFocused(),
      WindowAction.ChildFocused(),
    );
    const state = reduce(tabbed, WindowAction.FullscreenToggled(false));

    expect(placementsIn(state, GEOMETRY).tabs).toEqual(
      placementsIn(tabbed, GEOMETRY).tabs,
    );
  });

  // So a closing window does not animate over it.
  it("stacks a fullscreen window over everything it covers", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FullscreenToggled(false),
    );

    expect(placementFor(state, "editor")?.depth).toBeGreaterThan(
      leaving(TILED),
    );
  });

  describe("a fullscreen group", () => {
    // Kitty and the editor tabbed, the group selected and filling the screen.
    const full = () =>
      reduce(
        desktop("kitty", "editor"),
        WindowAction.ParentFocused(),
        WindowAction.FullscreenToggled(false),
      );

    it("lays the group out over the whole screen", () => {
      expect(placementFor(full(), "editor")).toMatchObject({
        bar: { width: 240, x: 240, y: 0 },
        surface: {
          height: 1080 - TITLE_BAR + SURFACE_TUCK,
          width: 1920,
          x: 0,
          y: TITLE_BAR - SURFACE_TUCK,
        },
      });
    });

    it("stacks every window in it, hidden tabs too, over everything", () => {
      expect(placementFor(full(), "kitty")).toMatchObject({
        bar: { width: 240, x: 0, y: 0 },
        depth: placementFor(full(), "editor")?.depth,
      });
      expect(placementFor(full(), "editor")?.depth).toBeGreaterThan(
        leaving(TILED),
      );
    });

    it("draws the tabs of the groups inside it over everything", () => {
      const state = reduce(
        nested(),
        WindowAction.ParentFocused(),
        WindowAction.FullscreenToggled(false),
      );

      expect(placementsIn(state, GEOMETRY).tabs).toMatchObject([
        { depth: placementFor(state, "kitty")?.depth, rect: { y: 0 } },
      ]);
    });
  });

  it("fills every screen when the fullscreen is global", () => {
    const state = reduce(
      desktop("kitty"),
      WindowAction.FullscreenToggled(true),
    );

    expect(placementFor(state, "kitty")?.surface).toMatchObject({
      width: 3200,
    });
  });

  it("reports the tabs of a tabbed container for the chrome to draw", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
      WindowAction.ModeSwapped(),
      WindowAction.LayoutSet(Layout.Tabbed),
    );

    // A lone window in a tabbed container: its tab is its title bar.
    expect(placementsIn(state, GEOMETRY).tabs).toEqual([]);
    expect(placementFor(state, "kitty")?.bar).toMatchObject({ y: 42 });
  });
  // `frame` spans the bar and contents, so both scale about one center.
  it("gives every window the box its bar and its contents span together", () => {
    expect(placementFor(desktop("kitty"), "kitty")?.frame).toEqual({
      height: 1018,
      width: 1880,
      x: 20,
      y: 42,
    });
  });

  it("gives a window a tab is hiding the box of the tab alone", () => {
    // A hidden tab has no contents on screen, so its frame is the tab.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
    );
    const hidden = placementFor(state, "kitty");

    expect(hidden?.surface).toBeUndefined();
    expect(hidden?.frame).toEqual(hidden?.bar ?? GEOMETRY.screen);
  });

  it("carries which way a tiled window's tabs run through to its placement", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
    );

    expect(placementFor(state, "kitty")?.tabbed).toBe(Layout.Tabbed);
  });

  // A hidden tab has no box, so the compositor stops its client drawing.
  it("draws nothing for a window a tab is hiding", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
    );
    const shown = placementFor(state, "editor");

    expect(contentsOf(placementFor(state, "kitty"), "resting")).toBeUndefined();
    expect(contentsOf(shown, "resting")).toEqual({
      depth: TILED,
      rect: shown?.surface ?? GEOMETRY.screen,
    });
  });

  // A tab switch fades the new tab in over the one it hides, so that one stays
  // drawn under it until the fade ends.
  it("draws the tab a switch is hiding under the one it shows", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
    );
    const shown = placementFor(state, "editor");

    const concealing = contentsOf(placementFor(state, "kitty"), "concealing");

    expect(concealing?.rect).toEqual(shown?.surface ?? GEOMETRY.screen);
    expect(concealing?.depth ?? TILED).toBeLessThan(TILED);
  });

  // A captured page draws only while laid out, so a screenshot or cast of a
  // hidden tab keeps it under the shown one.
  it("draws a captured tab under the one hiding it", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.Tabbed),
    );
    const shown = placementFor(state, "editor");

    const captured = contentsOf(placementFor(state, "kitty"), "resting", true);

    expect(captured?.rect).toEqual(shown?.surface ?? GEOMETRY.screen);
    expect(captured?.depth ?? TILED).toBeLessThan(TILED);
  });

  it("draws nothing for a window that is not on screen", () => {
    expect(contentsOf(undefined, "resting")).toBeUndefined();
    expect(contentsOf(undefined, "resting", true)).toBeUndefined();
  });
});

describe("the focus box", () => {
  const focusBoxOf = (state: WindowState) =>
    placementsIn(state, GEOMETRY).focusBox;

  it("is the focused window's frame", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
    );

    expect(focusBoxOf(state)).toMatchObject({
      depth: TILED,
      rect: placementFor(state, "editor")?.frame ?? {},
      selection: undefined,
      windows: [appWindowId("editor")],
    });
  });

  it("spans the whole group `focus parent` selects", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.ParentFocused(),
      WindowAction.ParentFocused(),
    );

    expect(focusBoxOf(state)).toMatchObject({
      rect: { height: 1018, width: 1880, x: 20, y: 42 },
      selection: { height: 1018, width: 1880, x: 20, y: 42 },
      windows: [appWindowId("kitty"), appWindowId("editor")],
    });
  });

  // The tabs belong to the group, so the box takes them in.
  it("spans a tab group around its focused window, tabs and all", () => {
    // The right half of a split holds the tab group.
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("mail", "mail"),
    );

    expect(focusBoxOf(state)).toEqual({
      depth: TILED,
      rect: { height: 1018, width: 930, x: 970, y: 42 },
      selection: undefined,
      windows: [appWindowId("editor"), appWindowId("mail")],
    });
  });

  // `focus parent` from a tab selects its tab group, so the box is the same
  // as for the tab, and only `selection` tells the two apart.
  it("selects a tab group's box when `focus parent` selects the group", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.LayoutSet(Layout.SplitH),
      WindowAction.ContainerSplit(Axis.Vertical),
      WindowAction.AppAppeared("mail", "mail"),
      WindowAction.ParentFocused(),
    );

    expect(focusBoxOf(state)?.selection).toEqual({
      height: 1018,
      width: 930,
      x: 970,
      y: 42,
    });
  });

  it("is a focused float's frame, at its depth", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FloatToggled(),
    );
    const editor = placementFor(state, "editor");

    expect(focusBoxOf(state)).toMatchObject({
      depth: editor?.depth ?? -1,
      rect: editor?.frame ?? {},
      windows: [appWindowId("editor")],
    });
  });

  // The scratchpad window sits over the screen behind a backdrop, so the box
  // stays where focus goes back to when it is hidden.
  it("stays on the window under a scratchpad window", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.WindowSentToScratchpad(),
      WindowAction.ScratchpadShown(),
    );

    expect(focusBoxOf(state)?.windows).toEqual([appWindowId("kitty")]);
  });

  // A fullscreen window covers the screen, so there is nothing to set apart.
  it("is missing while a window is fullscreen", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.FullscreenToggled(false),
    );

    expect(focusBoxOf(state)).toBeUndefined();
  });

  it("selects a fullscreen tab group `focus parent` selected", () => {
    const state = reduce(
      desktop("kitty", "editor"),
      WindowAction.ParentFocused(),
      WindowAction.FullscreenToggled(false),
    );
    const editor = placementFor(state, "editor");

    expect(focusBoxOf(state)).toMatchObject({
      depth: editor?.depth ?? -1,
      selection: { height: 1080, width: 1920, x: 0, y: 0 },
      windows: [appWindowId("kitty"), appWindowId("editor")],
    });
  });
});

describe("wellDepthOf", () => {
  // A tab switch inside the well draws the tab it hides just under the tiled
  // windows; the well must stay under that.
  it("puts a tiled well under a tab being hidden in it", () => {
    expect(wellDepthOf(TILED)).toBeLessThan(TILED - 1);
  });

  it("keeps a float's well at its float's depth", () => {
    expect(wellDepthOf(4)).toBe(4);
  });
});

describe("window depths", () => {
  // A window's menus, tooltips and dialogs are portaled to the page's root,
  // so they stack against every window's depth, a fullscreen one's included.
  it("stay under the shell's popups and dialogs", () => {
    const under = Number.parseInt(token("zIndex.modalBackdrop"), 10);

    expect(Math.max(FULLSCREEN, GRABBING)).toBeLessThan(under);
  });
});
