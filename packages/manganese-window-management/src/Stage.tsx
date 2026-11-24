import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { ReactNode } from "react";
import { Fragment, memo, useCallback, useMemo, useState } from "react";

import { AppWindow } from "./AppWindow";
import { BrowserWindow } from "./BrowserWindow";
import { useProfileMark } from "./browser/useBrowserProfile";
import type { Direction } from "./direction";
import { FocusGlow } from "./FocusGlow";
import { FloatBorder } from "./floating/FloatBorder";
import { FloatGrab } from "./floating/FloatGrab";
import { FloatShadow } from "./floating/FloatShadow";
import type { Float } from "./floating/float";
import { floatHolds } from "./floating/float";
import { floatBordersOf } from "./floating/float-borders";
import { castsFloatShadow, floatCovers } from "./floating/float-covers";
import { ScratchpadBackdrop } from "./floating/ScratchpadBackdrop";
import { GrabbingSheet } from "./GrabbingSheet";
import { GroupTitleBar } from "./GroupTitleBar";
import { GroupWell } from "./GroupWell";
import type { HandedDrag } from "./handed-drag";
import type { Modifiers } from "./keyboard/useModifiers";
import { seenAt, seenClip, seenStyles } from "./overview/seen-styles";
import type { OverviewSight, Seen } from "./overview/sight";
import type {
  Geometry,
  PlacedFocusBox,
  PlacedTab,
  Placement,
  Screenful,
} from "./placement";
import { contentsOf, raised, TILED, wellDepthOf } from "./placement";
import type { Spot } from "./pointer-warp";
import type { Popup, WindowPopup } from "./popup";
import { popupsOf } from "./popup";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import { SelectionTint } from "./SelectionTint";
import { SettleHandoffs } from "./SettleHandoffs";
import type { StageScreen } from "./screens/stage-screens";
import { useShared } from "./screens/useShared";
import { SlidingScreen } from "./sliding-screen";
import { TabStrip } from "./TabStrip";
import type { Aim, DropTargets, TabTarget, Target } from "./tiled/aim";
import { bordersOf } from "./tiled/borders";
import { DropIndicator } from "./tiled/DropIndicator";
import { TileBorder } from "./tiled/TileBorder";
import { TileGrab } from "./tiled/TileGrab";
import { tabTargetsOf } from "./tiled/tab-targets";
import { titleFocus } from "./title-focus";
import type { StripPlace } from "./tree/frames";
import { tabKeyOf } from "./tree/frames";
import { windowsIn } from "./tree/node";
import type { NodeRef } from "./tree/path";
import { focusedWindowIn } from "./tree/tiling";
import { useCaptured } from "./useCaptured";
import { keyOf, useFocusGlows } from "./useFocusGlows";
import { useTabDrop } from "./useTabDrop";
import type { DrawnWindow, WindowMotions } from "./useWindowMotion";
import { useWindowMotion } from "./useWindowMotion";
import { WindowFrame } from "./WindowFrame";
import { WindowTitleBar } from "./WindowTitleBar";
import type { ShellWindow } from "./window";
import { browserIdOf, WindowKind } from "./window";
import type { WindowMotion } from "./window-motion";
import { barMotion } from "./window-motion";
import {
  clippedTo,
  screenClipStyles,
  slidAcross,
  slidingAcross,
} from "./window-styles";

type Props = {
  /** The window the user is working in. */
  activeId: string | undefined;
  /**
   * Whether a desktop panel, such as the launcher, is open over the windows
   * and holds the keyboard.
   */
  behindPanel: boolean;
  domicile: Domicile;
  /** The floating window being dragged, if any. */
  draggingId: string | undefined;
  /** A client's move or resize, for its window's grab to run. */
  handed?: HandedDrag | undefined;
  /**
   * The window with compositor keyboard focus, or `undefined` when the shell
   * has it. Can differ from `activeId`: see `AppWindow`.
   */
  focusedId: string | undefined;
  /** Client windows' icon URLs, by desktop id. See `useClientIcons`. */
  clientIcons: ReadonlyMap<string, string>;
  /** Held modifiers, which decide who gets the pointer. */
  modifiers: Modifiers;
  /** A press on window `id`'s title bar or tab. */
  onBarPress: (id: string) => void;
  onClose: (id: string) => void;
  /** A press on the backdrop under scratchpad window `id`. */
  onDismiss: (id: string) => void;
  onDrop: () => void;
  /** A tiled window dropped where it was aimed, on any screen. */
  onDropOn: (id: string, aim: Aim) => void;
  /** Toggles floating from a window's title bar. */
  onFloat: (id: string) => void;
  /** Toggles fullscreen from a window's title bar. */
  onFullscreen: (id: string) => void;
  onGrab: (id: string) => void;
  /** Closes every window in a group, from the tab that holds it. */
  onGroupClose: (group: NodeRef) => void;
  /** A tiled group dropped where it was aimed, on any screen. */
  onGroupDropOn: (group: NodeRef, aim: Aim) => void;
  /** Toggles floating from a tab group's strip. */
  onGroupFloat: (group: NodeRef) => void;
  /** Toggles fullscreen from a tab group's strip. */
  onGroupFullscreen: (group: NodeRef) => void;
  /** A tiled group taken hold of by the empty end of its tab strip. */
  onGroupGrab: (group: NodeRef) => void;
  /**
   * The pointer entered a window. `at` tells a real pointer move from a window
   * appearing under a still pointer.
   */
  onHover: (id: string, at: Spot) => void;
  /**
   * Browser window `id`'s page or an extension asked for it in front. See
   * `BrowserWindow`.
   */
  onFocusRequest: (id: string) => void;
  /** A browser window's page description. See `BrowserWindow`. */
  onDescription: (window: string, description: string) => void;
  /** A browser window's page icon. See `BrowserWindow`. */
  onIcon: (window: string, icon: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  /** The new-tab button past the last tab of the strip holding tab `id`. */
  onNewTab: (id: string) => void;
  /** Browser window `id`'s page entered or left fullscreen. */
  onPageFullscreen: (id: string, fullscreen: boolean) => void;
  /** A page's text, link or image dropped on a tab strip. See `useTabDrop`. */
  onTabDrop: (target: NodeRef, edge: Direction, url: string) => void;
  /** A float resized to `box`, in the page's pixels, on the screen `on`. */
  onResize: (id: string, box: Rect, on: Geometry) => void;
  /** The user clicked a window or its chrome. */
  onSelect: (id: string) => void;
  /**
   * A tiled window's `edge` dragged `by` pixels, rightwards or downwards, in
   * the tiling of the screen `on`.
   */
  onStretch: (id: string, edge: Direction, by: number, on: Geometry) => void;
  /**
   * How the overview shows each window, while it is open or closing.
   * `undefined` outside it.
   */
  overview: OverviewSight | undefined;
  /** Client popups, drawn over their parent windows. */
  popups: readonly Popup[];
  /** Every screen and what it shows. */
  screens: readonly StageScreen[];
  /** The windows hidden in the scratchpad. */
  scratchpad: readonly string[];
  /** The open windows shown as closed. See `Shown.shut`. */
  shut: readonly string[];
  windows: readonly ShellWindow[];
};

/**
 * Draws every window at the rectangle its layout gave it, across all screens.
 *
 * Renders one list for the whole desk, in opening order, so a window never
 * remounts when it moves between screens, workspaces or tiling and floating.
 * A remount would blank its portal and reload a `<webview>`. Windows without a
 * rectangle are hidden, not unmounted, for the same reason.
 *
 * Closing windows and windows of a workspace being switched away stay in the
 * list until their exit animation ends; `useWindowMotion` decides which.
 */
export const Stage = memo(
  ({
    activeId,
    behindPanel,
    clientIcons,
    domicile,
    draggingId,
    focusedId,
    handed,
    modifiers: { meta, shift },
    onBarPress,
    onClose,
    onDescription,
    onDismiss,
    onDrop,
    onDropOn,
    onFloat,
    onFocusRequest,
    onFullscreen,
    onGrab,
    onGroupClose,
    onGroupDropOn,
    onGroupFloat,
    onGroupFullscreen,
    onGroupGrab,
    onHover,
    onIcon,
    onMove,
    onNewTab,
    onPageFullscreen,
    onResize,
    onTabDrop,
    onSelect,
    onStretch,
    overview,
    popups,
    scratchpad,
    screens,
    shut,
    windows,
  }: Props) => {
    const motions = useWindowMotion(
      Object.fromEntries(
        screens.map(
          ({ current, geometry, screenful: { placements, tabs } }) => [
            geometry.name,
            {
              activeId,
              current,
              overview: overview !== undefined,
              placements,
              scratchpad,
              shut,
              tabs,
              windows,
            },
          ],
        ),
      ),
    );
    // Looked up once per change rather than once per window. Apart from the
    // windows, so a retitled window keeps the drop targets every bar takes.
    const desk = useMemo(() => deskOf(screens), [screens]);
    // Shared, so a change that moves no drop target keeps every bar's.
    const targets = useShared(desk.dropTargets);
    const named = useMemo(
      () => new Map(windows.map((window) => [window.id, window])),
      [windows],
    );
    // Each client window's popups, looked up once per change.
    const popupsByApp = useMemo(
      () =>
        new Map(
          windows.flatMap((window) =>
            window.kind === WindowKind.App
              ? [[window.appId, popupsOf(popups, window.appId)] as const]
              : [],
          ),
        ),
      [popups, windows],
    );
    // Every window, with a hidden workspace's laid out in its overview tile.
    const drawn = useMemo(
      () => motions.drawn.map((window) => seenIn(window, overview)),
      [motions.drawn, overview],
    );
    // What the overview leaves out: it is for picking, not for working.
    const working = overview === undefined;
    const lit = focusBoxShowing(screens, activeId);
    const { glows, onFaded } = useFocusGlows(lit);
    const active = motions.drawn.find(({ window }) => window.id === activeId);
    const activeMotion =
      active === undefined ? "resting" : barMotion(active.motion);
    // Drawn over every window, not by the dragged one: see `DropIndicator`.
    const [aim, setAim] = useState<Aim | undefined>(undefined);
    const tabDrop = useTabDrop({ onAim: setAim, onTabDrop, targets });
    // A border drag or a tiled resize grab resizes in place, so unlike a move
    // it does not fade the window. See `stageStyles`.
    const [stretching, setStretching] = useState(false);
    // The overview takes the grab's handles away before their drop.
    if (!working && stretching) {
      setStretching(false);
    }
    // Whether the running move has been pulled, which shows the grabbing
    // pointer: a click moves nothing, so it shows none. Each grab clears it.
    const [pulled, setPulled] = useState(false);
    const pull = useCallback(() => {
      setPulled(true);
    }, []);
    // The handed drag its grab already started, so a grab remounted mid-drag,
    // such as on another screen, does not start it over.
    const [taken, setTaken] = useState<HandedDrag | undefined>(undefined);
    const handing =
      handed !== taken &&
      handed !== undefined &&
      !desk.fullscreen.has(handed.window)
        ? handed
        : undefined;
    const grabbed = useCallback(
      (id: string) => {
        setPulled(false);
        setTaken(handing);
        onGrab(id);
      },
      [handing, onGrab],
    );
    const groupGrabbed = useCallback(
      (group: NodeRef) => {
        setPulled(false);
        onGroupGrab(group);
      },
      [onGroupGrab],
    );
    // The window being moved, which fades. A tiled resize grab still sets
    // `draggingId`, which keeps its `TileGrab` mounted once the modifier is
    // let go.
    const movingId = stretching ? undefined : draggingId;
    // Every window the drag carries, which follow the pointer without easing.
    const held = useMemo(() => heldBy(desk, movingId), [desk, movingId]);
    const { onPlayedOut } = motions;
    const tabsShown = motions.tabs.map(({ tab }) => tab);
    return (
      <main {...tabDrop}>
        <SettleHandoffs>
          {/*
          Before every window, so each float covers its own shadow by document
          order. See `FloatShadow`. Skipped for fullscreen floats, whose shadow
          would spill onto the next display.
        */}
          {drawn.map(
            ({ motion, placement, restack, rewound, screen, seen, window }) => {
              const float = desk.floats.get(window.id);
              return placement !== undefined &&
                !desk.fullscreen.has(window.id) &&
                float !== undefined ? (
                <Sliding
                  depth={placement.depth}
                  frame={placement.frame}
                  key={window.id}
                  motion={motion}
                  on={screenNamed(desk, screen)}
                  rewound={rewound}
                  seen={seen}
                >
                  <FloatShadow
                    depth={placement.depth}
                    dragging={stretching || held.has(window.id)}
                    frame={placement.frame}
                    hanging={float.scratchpad}
                    motion={motion}
                    restack={restack}
                  />
                </Sliding>
              ) : undefined;
            },
          )}
          {/*
          Before every window and glow, so the windows of each group shown in
          a tab, and their glows, lie on its well.
        */}
          {motions.tabs.map(({ motion, restack, screen, tab }) =>
            tab.well === undefined ? undefined : (
              <Sliding
                depth={wellDepthOf(tab.depth)}
                frame={tab.well}
                key={`well-${tabKeyOf(tab)}`}
                motion={motion}
                on={screenNamed(desk, screen)}
                rewound={0}
                seen={overview?.shown.get(screen)}
              >
                <GroupWell
                  // None for fullscreen floats, as for `FloatShadow`.
                  castsShadow={
                    !desk.fullscreen.has(tab.id) &&
                    castsFloatShadow(desk.floats.get(tab.id), tab, tabsShown)
                  }
                  depth={wellDepthOf(tab.depth)}
                  dragging={stretching || held.has(tab.id)}
                  motion={motion}
                  nested={tab.strip.nested}
                  rect={tab.well}
                  restack={restack}
                />
              </Sliding>
            ),
          )}
          {/*
          Before every window too, so the windows at its depth cover all but
          its glow. Only the glow fading in follows the focused window's
          motion.
        */}
          {working &&
            glows.map(({ box, leaving }) => {
              const following = leaving ? undefined : active;
              const motion =
                following === undefined
                  ? "resting"
                  : barMotion(following.motion);
              return (
                <Sliding
                  depth={box.depth}
                  frame={following?.placement?.frame}
                  key={keyOf(box)}
                  motion={motion}
                  on={screenNamed(desk, following?.screen)}
                  rewound={following?.rewound ?? 0}
                  seen={undefined}
                >
                  <FocusGlow
                    depth={box.depth}
                    dragging={
                      following !== undefined &&
                      (stretching ||
                        (activeId !== undefined && held.has(activeId)))
                    }
                    leaving={leaving}
                    motion={motion}
                    onFaded={() => {
                      onFaded(box);
                    }}
                    rect={box.rect}
                    restack={following?.restack}
                    windows={box.windows}
                  />
                </Sliding>
              );
            })}
          {drawn.map(
            ({
              crossing,
              focused,
              motion,
              placement,
              restack,
              screen,
              seen,
              shownRewound,
              window,
            }) => (
              <WindowContents
                behindPanel={behindPanel}
                // With the modifier held, the shell takes the pointer over every
                // grabbable window so it can catch a drag. During a drag it takes
                // it over every window: one that kept the pointer would swallow
                // the moves and the release, leaving the dragged window stuck.
                // An edge drag leaves windows taking the pointer: the edge holds
                // it, and a window takes it back only at the engine's next
                // frame, so the moves and clicks just after the release would
                // reach the desktop instead of the page under them.
                clickThrough={
                  draggingId !== undefined ||
                  (meta &&
                    (desk.floats.has(window.id) ||
                      desk.targeted.has(window.id)))
                }
                crossing={crossing}
                domicile={domicile}
                dragging={stretching || held.has(window.id)}
                fillsScreen={desk.fullscreen.has(window.id)}
                floating={desk.floats.has(window.id)}
                focused={focused}
                fullscreen={desk.fullscreen.get(window.id) === false}
                hasKeyboard={window.id === focusedId}
                key={window.id}
                motion={motion}
                onDescription={onDescription}
                onFocusRequest={onFocusRequest}
                onHover={onHover}
                onIcon={onIcon}
                onPageFullscreen={onPageFullscreen}
                onPlayedOut={onPlayedOut}
                onSelect={onSelect}
                placement={placement}
                popups={
                  window.kind === WindowKind.App
                    ? (popupsByApp.get(window.appId) ?? NO_POPUPS)
                    : NO_POPUPS
                }
                // Every window, since a tiled edge resizes the windows on
                // both sides of it. A window whose box stays put is unaffected.
                resizing={stretching}
                restack={restack}
                rewound={shownRewound}
                screen={screen}
                screenBox={screenNamed(desk, screen)?.geometry.screen}
                seen={seen}
                window={window}
              />
            ),
          )}
          {/*
          Tab strips, each drawn by its group's open tab, after every window's
          contents and before every bar, so the contents tuck under the strip
          and the tabs lie on it by document order. See `TabStrip`.
        */}
          {drawn.map(
            ({
              motion,
              placement,
              restack,
              screen,
              seen,
              shownRewound,
              window,
            }) =>
              placement?.strip?.open === true &&
              placement.tabbed !== undefined &&
              !leavesStrip(motion) ? (
                <GroupStrip
                  depth={placement.depth}
                  dragging={stretching || held.has(window.id)}
                  float={desk.floats.get(window.id)}
                  frame={placement.frame}
                  fullscreen={groupFills(
                    screens,
                    placement.strip.group.windows,
                  )}
                  id={window.id}
                  key={window.id}
                  motion={motion}
                  on={screenNamed(desk, screen)}
                  onAim={setAim}
                  onDrop={onDrop}
                  onGrab={grabbed}
                  onGroupDropOn={onGroupDropOn}
                  onGroupFloat={onGroupFloat}
                  onGroupFullscreen={onGroupFullscreen}
                  onGroupGrab={groupGrabbed}
                  onHover={onHover}
                  onMove={onMove}
                  onNewTab={onNewTab}
                  onPull={pull}
                  restack={restack}
                  rewound={shownRewound}
                  seen={seen}
                  strip={placement.strip}
                  targets={targets}
                />
              ) : undefined,
          )}
          {motions.tabs.map(({ motion, restack, screen, tab }) =>
            tab.active && tab.strip.open ? (
              <GroupStrip
                depth={tab.depth}
                dragging={stretching || held.has(tab.id)}
                float={desk.floats.get(tab.id)}
                frame={tab.strip.box}
                fullscreen={groupFills(screens, tab.strip.group.windows)}
                id={tab.id}
                key={`tab-${tabKeyOf(tab)}`}
                motion={motion}
                on={screenNamed(desk, screen)}
                onAim={setAim}
                onDrop={onDrop}
                onGrab={grabbed}
                onGroupDropOn={onGroupDropOn}
                onGroupFloat={onGroupFloat}
                onGroupFullscreen={onGroupFullscreen}
                onGroupGrab={groupGrabbed}
                onHover={onHover}
                onMove={onMove}
                onNewTab={onNewTab}
                onPull={pull}
                restack={restack}
                rewound={0}
                seen={overview?.shown.get(screen)}
                strip={tab.strip}
                targets={targets}
              />
            ) : undefined,
          )}
          {/*
          Every bar after every window's contents, so bars win the `z-index`
          tie by document order. A shown tab's contents tuck under its whole
          strip (see `SURFACE_TUCK`), including other windows' tabs. One
          component for tiled and floating, so the bar is not remounted when
          the window floats. See `WindowTitleBar`. A bare float has none.
        */}
          {drawn.map(
            ({
              crossing,
              focused,
              motion,
              placement,
              restack,
              rewound,
              screen,
              seen,
              window,
            }) =>
              placement === undefined || placement.bare ? undefined : (
                <WindowBar
                  crossing={crossing}
                  description={descriptionOf(window)}
                  domicile={domicile}
                  dragging={stretching || held.has(window.id)}
                  float={desk.floats.get(window.id)}
                  focused={focused}
                  fullscreen={desk.fullscreen.get(window.id) === false}
                  icon={iconOf(window, clientIcons)}
                  key={window.id}
                  motion={motion}
                  onAim={setAim}
                  onClose={onClose}
                  onDrop={onDrop}
                  onDropOn={onDropOn}
                  onFloat={onFloat}
                  onFullscreen={onFullscreen}
                  onGrab={grabbed}
                  onHover={onHover}
                  onMove={onMove}
                  onPlayedOut={onPlayedOut}
                  onPress={onBarPress}
                  onPull={pull}
                  placement={placement}
                  restack={restack}
                  rewound={rewound}
                  screen={screen}
                  screenBox={screenNamed(desk, screen)?.geometry.screen}
                  seen={seen}
                  targets={targets}
                  window={window}
                />
              ),
          )}
          {/*
          After every bar, so it covers the bars at its depth by document
          order.
        */}
          {screens.flatMap((on) => {
            const hanging = working ? hangingOn(motions.drawn, on) : undefined;
            return hanging?.placement === undefined
              ? []
              : [
                  <ScratchpadBackdrop
                    depth={hanging.placement.depth - 1}
                    key={on.geometry.name}
                    motion={hanging.motion}
                    onDismiss={() => {
                      onDismiss(hanging.window.id);
                    }}
                    rewound={hanging.rewound}
                    screen={on.geometry.screen}
                  />,
                ];
          })}
          {/*
          Tiled window borders, which resize without a modifier. After the
          windows, so a border wins the pointer over the edge it overlaps;
          before the grabs, so a modifier grab covers everything but the gaps.
        */}
          {screens.flatMap((on) =>
            bordersOf(working ? targetsOn(on) : []).map(
              ({ edge, id, rect }) => (
                <TileBorder
                  edge={edge}
                  id={id}
                  key={`${id}-${edge.toString()}`}
                  onDrop={() => {
                    setStretching(false);
                  }}
                  onGrab={() => {
                    setStretching(true);
                    onSelect(id);
                  }}
                  onStretch={(stretched, by) => {
                    onStretch(id, stretched, by, on.geometry);
                  }}
                  rect={rect}
                />
              ),
            ),
          )}
          {/*
          Floating window borders, at each float's depth so windows above cover
          them. None for fullscreen floats, alone or in a group. One set per
          float, since a floating group is one box.
        */}
          {motions.drawn.map(({ placement, screen, window }) => {
            const on = screenNamed(desk, screen);
            const floating = desk.floatsFocusing.get(window.id);
            return !working ||
              placement === undefined ||
              on === undefined ||
              floating === undefined ||
              desk.fullscreen.has(window.id)
              ? undefined
              : floatBordersOf(floating).map(({ cursor, grip, rect }) => (
                  <FloatBorder
                    cursor={cursor}
                    depth={placement.depth}
                    float={floating}
                    grip={grip}
                    key={`${window.id}-${grip.horizontal?.toString() ?? ""}-${grip.vertical?.toString() ?? ""}`}
                    onDrop={() => {
                      setStretching(false);
                    }}
                    onGrab={() => {
                      setStretching(true);
                      onSelect(window.id);
                    }}
                    onResize={(box) => {
                      onResize(window.id, box, on.geometry);
                    }}
                    rect={rect}
                    window={window.id}
                  />
                ));
          })}
          {/*
          Modifier grabs, after every window and border so they cover both.

          In window order, not stacking order: stacking uses `z-index` (see
          `placedAt`), and reordering would move the capturing element when a
          grab raises its window, which makes the browser drop pointer capture.
        */}
          {motions.drawn.map(({ placement, screen, window }) => {
            const on = screenNamed(desk, screen);
            const floating = desk.floats.get(window.id);
            const onGrabThis = () => {
              grabbed(window.id);
            };
            const handedHere =
              handing?.window === window.id ? handing : undefined;
            const resizes = handedHere?.resizes ?? shift;
            const onHoverThis = (at: Spot) => {
              onHover(window.id, at);
            };
            if (!working || placement === undefined || on === undefined) {
              return undefined;
            } else {
              return (
                <Fragment key={window.id}>
                  {floating === undefined &&
                    desk.targeted.has(window.id) &&
                    (meta ||
                      window.id === draggingId ||
                      handedHere !== undefined) && (
                      <TileGrab
                        frame={placement.frame}
                        handed={handedHere?.press}
                        id={window.id}
                        onAim={setAim}
                        onDrop={() => {
                          setStretching(false);
                          onDrop();
                        }}
                        onDropOn={(aim) => {
                          onDropOn(window.id, aim);
                        }}
                        onGrab={(resizing) => {
                          setStretching(resizing);
                          onGrabThis();
                        }}
                        onHover={onHoverThis}
                        onPull={pull}
                        onStretch={(edge, by) => {
                          onStretch(window.id, edge, by, on.geometry);
                        }}
                        resizes={resizes}
                        targets={targets}
                      />
                    )}
                  {/*
                  One grab per float, like its borders.
                */}
                  {floating !== undefined &&
                    focusedWindowIn(floating.root) === window.id &&
                    (meta ||
                      window.id === draggingId ||
                      handedHere !== undefined) && (
                      <FloatGrab
                        depth={placement.depth}
                        float={floating}
                        handed={handedHere?.press}
                        onDrop={() => {
                          setStretching(false);
                          onDrop();
                        }}
                        onGrab={(resizing) => {
                          setStretching(resizing);
                          onGrabThis();
                        }}
                        onHover={onHoverThis}
                        onMove={(x, y) => {
                          onMove(window.id, x, y);
                        }}
                        onPull={pull}
                        onResize={(box) => {
                          onResize(window.id, box, on.geometry);
                        }}
                        resizes={resizes}
                        window={window.id}
                      />
                    )}
                </Fragment>
              );
            }
          })}
          {/*
          Tabs of tabbed and stacking containers. Each tab is titled after, and
          selects, the window its container last focused.
        */}
          {motions.tabs.map(({ focused, motion, restack, screen, tab }) => {
            const tabbed = windowNamed(named, tab.id);
            return (
              <ContainerTab
                description={descriptionOf(tabbed)}
                dragging={stretching || held.has(tab.id)}
                floating={desk.floats.has(tab.id)}
                focused={focused}
                // Always false: a fullscreen workspace draws no tabs. See
                // `placement.ts`.
                fullscreen={desk.fullscreen.get(tab.id) === false}
                icon={iconOf(tabbed, clientIcons)}
                key={tabKeyOf(tab)}
                motion={motion}
                on={screenNamed(desk, screen)}
                onAim={setAim}
                onClose={onGroupClose}
                onDrop={onDrop}
                onDropOn={onGroupDropOn}
                onFloat={onFloat}
                onFullscreen={onFullscreen}
                onGrab={groupGrabbed}
                onPlayedOut={onPlayedOut}
                onPull={pull}
                onSelect={onSelect}
                restack={restack}
                screen={screen}
                seen={overview?.shown.get(screen)}
                tab={tab}
                targets={targets}
                title={tabbed.title}
              />
            );
          })}
          {/*
          After every window and tab, at the open tab's raised depth, so it
          covers the selected container's windows and every tab. It follows
          the focused window as its glow does.
        */}
          {working && lit?.selection !== undefined && (
            <Sliding
              depth={raised(lit.depth)}
              frame={active?.placement?.frame}
              motion={activeMotion}
              on={screenNamed(desk, active?.screen)}
              rewound={active?.rewound ?? 0}
              seen={undefined}
            >
              <SelectionTint
                depth={raised(lit.depth)}
                dragging={
                  stretching || (activeId !== undefined && held.has(activeId))
                }
                motion={activeMotion}
                rect={lit.selection}
                restack={active?.restack}
              />
            </Sliding>
          )}
          {working && aim !== undefined && <DropIndicator aim={aim} />}
          {movingId !== undefined && pulled && <GrabbingSheet />}
        </SettleHandoffs>
      </main>
    );
  },
);

/**
 * The stage's lookups, built once per change to the screens rather than
 * searched once per window.
 */
type Desk = {
  /** What a tiled window can be dropped on, on every screen. */
  dropTargets: DropTargets;
  /** The float holding each floating window. */
  floats: ReadonlyMap<string, Float>;
  /** Each float by the window it focuses, which its borders hang on. */
  floatsFocusing: ReadonlyMap<string, Float>;
  /** Each fullscreen window, and whether it is fullscreen in a group. */
  fullscreen: ReadonlyMap<string, boolean>;
  screens: ReadonlyMap<string, StageScreen>;
  /** The visible tiled windows, which drag, drop and take the modifier grab. */
  targeted: ReadonlySet<string>;
};

const deskOf = (screens: readonly StageScreen[]): Desk => {
  // Reversed, so the first float holding a window wins, as `find` would.
  const floats = screens.flatMap((screen) => screen.floats).toReversed();
  const targets = screens.flatMap(({ screenful }) =>
    tiledTargets(screenful.placements),
  );
  return {
    dropTargets: {
      floats: floatCovers(screens),
      screens: emptyScreens(screens),
      tabs: tabTargets(screens),
      windows: targets,
    },
    floats: new Map(
      floats.flatMap((float) =>
        windowsIn(float.root).map((id) => [id, float] as const),
      ),
    ),
    floatsFocusing: new Map(
      floats.map((float) => [focusedWindowIn(float.root), float] as const),
    ),
    fullscreen: new Map(
      screens.flatMap(({ fullscreen }) =>
        fullscreen === undefined
          ? []
          : fullscreen.windows.map((id) => [id, fullscreen.group] as const),
      ),
    ),
    screens: new Map(screens.map((screen) => [screen.geometry.name, screen])),
    targeted: new Set(targets.map(({ id }) => id)),
  };
};

/** No popups, shared so a window without any keeps its memoized render. */
const NO_POPUPS: readonly WindowPopup[] = [];

type WindowContentsProps = {
  behindPanel: boolean;
  clickThrough: boolean;
  /** See `DrawnWindow.crossing`. */
  crossing: boolean;
  domicile: Domicile;
  dragging: boolean;
  floating: boolean;
  focused: boolean;
  /** Whether it fills its screen, alone or in its group. */
  fillsScreen: boolean;
  fullscreen: boolean;
  hasKeyboard: boolean;
  motion: WindowMotion;
  onDescription: (window: string, description: string) => void;
  onFocusRequest: (id: string) => void;
  onHover: (id: string, at: Spot) => void;
  onIcon: (window: string, icon: string) => void;
  onPageFullscreen: (id: string, fullscreen: boolean) => void;
  onPlayedOut: WindowMotions["onPlayedOut"];
  onSelect: (id: string) => void;
  placement: Placement | undefined;
  /** Its client's popups. See `AppWindow`. */
  popups: readonly WindowPopup[];
  /** See `AppWindow`. */
  resizing: boolean;
  restack: Restack | undefined;
  /** How far into its motion it starts. See `DrawnWindow.rewound`. */
  rewound: number;
  screen: string | undefined;
  /** The box of the screen it is drawn on. */
  screenBox: Rect | undefined;
  /** How the overview shows it, if open. */
  seen: Seen | undefined;
  window: ShellWindow;
};

/**
 * One window's contents. Memoized, with callbacks that take the window's id,
 * so a change to one window redraws only that window.
 */
const WindowContents = memo(
  ({
    behindPanel,
    clickThrough,
    crossing,
    domicile,
    dragging,
    fillsScreen,
    floating,
    focused,
    fullscreen,
    hasKeyboard,
    motion,
    onDescription,
    onFocusRequest,
    onHover,
    onIcon,
    onPageFullscreen,
    onPlayedOut,
    onSelect,
    placement,
    popups,
    resizing,
    restack,
    rewound,
    screen,
    screenBox,
    seen,
    window,
  }: WindowContentsProps) => {
    const { id } = window;
    const captured = useCaptured(
      domicile,
      window.kind === WindowKind.App ? undefined : engineWindowOf(id),
    );
    const contents = contentsOf(placement, motion, captured);
    const hovered = useCallback(
      (at: Spot) => {
        onHover(id, at);
      },
      [id, onHover],
    );
    const reached = useCallback(() => {
      onSelect(id);
    }, [id, onSelect]);
    const asked = useCallback(() => {
      onFocusRequest(id);
    }, [id, onFocusRequest]);
    const ended = useCallback(() => {
      onPlayedOut(id, motion, screen, "contents");
    }, [id, motion, onPlayedOut, screen]);
    // A hidden workspace's window coming into the overview draws again, and
    // the engine would hold the desk for it as a workspace switch's would.
    // See `isSlidingIn`.
    const unheld = resizing || seen?.arriving !== undefined;
    const pageFilled = useCallback(
      (fullscreen: boolean) => {
        onPageFullscreen(id, fullscreen);
      },
      [id, onPageFullscreen],
    );
    return (
      <WindowFrame
        depth={contents?.depth ?? 0}
        fillsScreen={fillsScreen}
        frame={placement?.frame}
        motion={motion}
        onHover={hovered}
        onReach={reached}
        rewound={rewound}
        screen={screenBox}
        seen={seen}
      >
        {window.kind === WindowKind.App ? (
          <AppWindow
            appId={window.appId}
            behindPanel={behindPanel}
            clickThrough={clickThrough}
            crossing={crossing}
            cursor={window.cursorImage ?? window.cursor}
            depth={contents?.depth ?? 0}
            domicile={domicile}
            dragging={dragging}
            floating={floating}
            focused={focused}
            frame={placement?.frame}
            fullscreen={fullscreen}
            hasKeyboard={hasKeyboard}
            motion={motion}
            onMotionEnded={ended}
            popups={popups}
            rect={contents?.rect}
            resizing={unheld}
            restack={restack}
            syncedFrame={window.syncedFrame}
            tab={placement?.bar}
          />
        ) : (
          <BrowserWindow
            behindPanel={behindPanel}
            clickThrough={clickThrough}
            covered={placement?.behind !== undefined}
            crossing={crossing}
            depth={contents?.depth ?? 0}
            domicile={domicile}
            dragging={dragging}
            focused={focused}
            frame={placement?.frame}
            fullscreen={fullscreen}
            isApp={window.isApp}
            isPrivate={window.isPrivate}
            motion={motion}
            onDescription={onDescription}
            onFocusRequest={asked}
            onIcon={onIcon}
            onMotionEnded={ended}
            onPageFullscreen={pageFilled}
            onReach={reached}
            popupWindow={window.popupWindow}
            rect={contents?.rect}
            resizing={unheld}
            restack={restack}
            tab={placement?.bar}
            url={window.url}
            window={engineWindowOf(id)}
          />
        )}
      </WindowFrame>
    );
  },
);

type WindowBarProps = {
  /** See `DrawnWindow.crossing`. */
  crossing: boolean;
  /** Where a browser window's page's profile comes from, for its mark. */
  domicile: Pick<Domicile, "browser">;
  description: string | undefined;
  dragging: boolean;
  float: Float | undefined;
  focused: boolean;
  fullscreen: boolean;
  icon: string | undefined;
  motion: WindowMotion;
  onAim: (aim: Aim | undefined) => void;
  onClose: (id: string) => void;
  onDrop: () => void;
  onDropOn: (id: string, aim: Aim) => void;
  onFloat: (id: string) => void;
  onFullscreen: (id: string) => void;
  onGrab: (id: string) => void;
  onHover: (id: string, at: Spot) => void;
  onMove: (id: string, x: number, y: number) => void;
  onPlayedOut: WindowMotions["onPlayedOut"];
  onPress: (id: string) => void;
  onPull: () => void;
  placement: Placement;
  restack: Restack | undefined;
  /** How far into its motion it starts. See `DrawnWindow.rewound`. */
  rewound: number;
  screen: string | undefined;
  /** The box of the screen it is drawn on. */
  screenBox: Rect | undefined;
  /** How the overview shows it, if open. */
  seen: Seen | undefined;
  targets: DropTargets;
  window: ShellWindow;
};

/** One window's title bar, memoized as {@link WindowContents} is. */
const WindowBar = memo(
  ({
    crossing,
    description,
    domicile,
    dragging,
    float,
    focused,
    fullscreen,
    icon,
    motion,
    onAim,
    onClose,
    onDrop,
    onDropOn,
    onFloat,
    onFullscreen,
    onGrab,
    onHover,
    onMove,
    onPlayedOut,
    onPress,
    onPull,
    placement,
    restack,
    rewound,
    screen,
    screenBox,
    seen,
    targets,
    window,
  }: WindowBarProps) => {
    const { id } = window;
    const mark = useProfileMark(
      domicile,
      window.kind === WindowKind.Browser ? engineWindowOf(id) : undefined,
    );
    const hovered = useCallback(
      (at: Spot) => {
        onHover(id, at);
      },
      [id, onHover],
    );
    const reached = useCallback(() => {
      onPress(id);
    }, [id, onPress]);
    const ended = useCallback(() => {
      onPlayedOut(id, motion, screen, "bar");
    }, [id, motion, onPlayedOut, screen]);
    const closed = useCallback(() => {
      onClose(id);
    }, [id, onClose]);
    const droppedOn = useCallback(
      (aim: Aim) => {
        onDropOn(id, aim);
      },
      [id, onDropOn],
    );
    const floated = useCallback(() => {
      onFloat(id);
    }, [id, onFloat]);
    const filled = useCallback(() => {
      onFullscreen(id);
    }, [id, onFullscreen]);
    const grabbed = useCallback(() => {
      onGrab(id);
    }, [id, onGrab]);
    const moved = useCallback(
      (x: number, y: number) => {
        onMove(id, x, y);
      },
      [id, onMove],
    );
    return (
      <WindowFrame
        depth={placement.depth}
        fillsScreen={fullscreen}
        frame={placement.frame}
        motion={motion}
        onHover={hovered}
        onReach={reached}
        rewound={rewound}
        screen={screenBox}
        seen={seen}
      >
        <WindowTitleBar
          crossing={crossing}
          depth={placement.depth}
          description={description}
          dragging={dragging}
          float={float}
          // A hidden tab is not highlighted with its `focus parent` group, or
          // it would look open beside the shown tab. Container tabs are
          // handled in `ContainerTab`.
          focus={titleFocus({
            hasKeyboard: focused,
            inSelection: placement.selected && placement.surface !== undefined,
            isTab: placement.tabbed !== undefined,
            shownByContainer: false,
          })}
          frame={placement.frame}
          fullscreen={fullscreen}
          icon={icon}
          mark={mark}
          motion={barMotion(motion)}
          onAim={onAim}
          onClose={closed}
          onDrop={onDrop}
          onDropOn={droppedOn}
          onFloat={floated}
          onFullscreen={filled}
          onGrab={grabbed}
          onMotionEnded={ended}
          onMove={moved}
          onPull={onPull}
          rect={placement.bar}
          restack={restack}
          strip={placement.strip}
          tabbed={placement.tabbed}
          targets={targets}
          title={window.title}
          window={id}
        />
      </WindowFrame>
    );
  },
);

type ContainerTabProps = {
  /** The page description of the window the tab is named after. */
  description: string | undefined;
  dragging: boolean;
  floating: boolean;
  focused: boolean;
  fullscreen: boolean;
  icon: string | undefined;
  motion: WindowMotion;
  on: StageScreen | undefined;
  onAim: (aim: Aim | undefined) => void;
  /** Closes the tab's group, every window in it. */
  onClose: (group: NodeRef) => void;
  onDrop: () => void;
  /** The tab's group dropped where it was aimed. */
  onDropOn: (group: NodeRef, aim: Aim) => void;
  onFloat: (id: string) => void;
  onFullscreen: (id: string) => void;
  /** The tab's group taken hold of. */
  onGrab: (group: NodeRef) => void;
  onPlayedOut: WindowMotions["onPlayedOut"];
  onPull: () => void;
  onSelect: (id: string) => void;
  restack: Restack | undefined;
  screen: string;
  /** How the overview shows it, if open. */
  seen: Seen | undefined;
  tab: PlacedTab;
  targets: DropTargets;
  /** The title of the window the tab is named after. */
  title: string;
};

/** A container's tab, memoized as {@link WindowContents} is. */
const ContainerTab = memo(
  ({
    description,
    dragging,
    floating,
    focused,
    fullscreen,
    icon,
    motion,
    on,
    onAim,
    onClose,
    onDrop,
    onDropOn,
    onFloat,
    onFullscreen,
    onGrab,
    onPlayedOut,
    onPull,
    onSelect,
    restack,
    screen,
    seen,
    tab,
    targets,
    title,
  }: ContainerTabProps) => {
    const { id, node } = tab;
    const closed = useCallback(() => {
      onClose(node);
    }, [node, onClose]);
    const droppedOn = useCallback(
      (aim: Aim) => {
        onDropOn(node, aim);
      },
      [node, onDropOn],
    );
    const grabbed = useCallback(() => {
      onGrab(node);
    }, [node, onGrab]);
    const floated = useCallback(() => {
      onFloat(id);
    }, [id, onFloat]);
    const filled = useCallback(() => {
      onFullscreen(id);
    }, [id, onFullscreen]);
    const ended = useCallback(() => {
      onPlayedOut(id, motion, screen, "bar");
    }, [id, motion, onPlayedOut, screen]);
    const pressed = useCallback(() => {
      onSelect(id);
    }, [id, onSelect]);
    return (
      <Sliding
        depth={tab.depth}
        frame={undefined}
        motion={motion}
        on={on}
        rewound={0}
        seen={seen}
      >
        <GroupTitleBar
          depth={tab.depth}
          description={description}
          dragging={dragging}
          floating={floating}
          // The shown tab of an unfocused container must not use the accent,
          // which marks keyboard focus.
          focus={titleFocus({
            hasKeyboard: focused,
            inSelection: tab.selected && tab.active,
            isTab: true,
            shownByContainer: tab.active,
          })}
          // A tab is all its window shows, so it scales about its own middle.
          frame={tab.rect}
          fullscreen={fullscreen}
          group={{ layout: tab.group, windows: tab.windows }}
          icon={icon}
          motion={motion}
          node={node}
          onAim={onAim}
          onClose={closed}
          onDrop={onDrop}
          onDropOn={droppedOn}
          onFloat={floated}
          onFullscreen={filled}
          onGrab={grabbed}
          onMiddleClick={closed}
          onMotionEnded={ended}
          onPress={pressed}
          onPull={onPull}
          rect={tab.rect}
          restack={restack}
          strip={tab.strip}
          tabbed={tab.tabbed}
          targets={targets}
          title={title}
          window={id}
        />
      </Sliding>
    );
  },
);

/**
 * Gives its children the distances that slide `frame` off screen `on`, and
 * clips them to it during a workspace switch, outside and inside the slide
 * (see `clippedAlong`). See `screenClipStyles`. In the
 * overview, shows them through their tile; see `seenAt`.
 */
const Sliding = ({
  children,
  depth,
  frame,
  motion,
  on,
  rewound,
  seen,
}: {
  children: ReactNode;
  /** The depth of the part it holds. */
  depth: number;
  frame: Rect | undefined;
  motion: WindowMotion;
  on: StageScreen | undefined;
  rewound: number;
  seen: Seen | undefined;
}) => (
  <div
    className={screenClipStyles}
    style={
      on === undefined
        ? undefined
        : {
            ...slidAcross(on.geometry.screen, frame, motion, rewound),
            ...clippedTo(on.geometry.screen, motion),
            ...seenClip(seen, on.geometry.screen, depth),
          }
    }
  >
    <div
      className={seenStyles({
        arriving: seen?.arriving !== undefined,
        seen: seen !== undefined,
        shut: seen?.shut ?? false,
      })}
      style={seenAt(seen, on?.geometry.screen)}
    >
      <SlidingScreen
        value={
          on === undefined
            ? undefined
            : slidingAcross(on.geometry.screen, motion)
        }
      >
        {children}
      </SlidingScreen>
    </div>
  </div>
);

/**
 * The scratchpad window shown on screen `on`, or one sliding off it back to the
 * scratchpad, if any.
 */
const hangingOn = (
  drawn: readonly DrawnWindow[],
  on: StageScreen,
): DrawnWindow | undefined =>
  drawn.find(
    ({ motion, screen, window }) =>
      screen === on.geometry.name &&
      (motion === "stowing" ||
        on.floats.some(
          (float) => float.scratchpad && floatHolds(float, window.id),
        )),
  );

type GroupStripProps = {
  depth: number;
  dragging: boolean;
  float: Float | undefined;
  /** The open window's whole box. See `TabStrip`. */
  frame: Rect;
  fullscreen: boolean;
  /** The open tab's window, which draws the strip. */
  id: string;
  motion: WindowMotion;
  on: StageScreen | undefined;
  onAim: (aim: Aim | undefined) => void;
  onDrop: () => void;
  onGrab: (id: string) => void;
  onGroupDropOn: (group: NodeRef, aim: Aim) => void;
  onGroupFloat: (group: NodeRef) => void;
  onGroupFullscreen: (group: NodeRef) => void;
  onGroupGrab: (group: NodeRef) => void;
  onHover: (id: string, at: Spot) => void;
  onMove: (id: string, x: number, y: number) => void;
  onNewTab: (id: string) => void;
  onPull: () => void;
  restack: Restack | undefined;
  rewound: number;
  /** How the overview shows it, if open. */
  seen: Seen | undefined;
  strip: StripPlace;
  targets: DropTargets;
};

/**
 * A group's tab strip, drawn by its open tab, memoized as
 * {@link WindowContents} is.
 */
const GroupStrip = memo(
  ({
    depth,
    dragging,
    float,
    frame,
    fullscreen,
    id,
    motion,
    on,
    onAim,
    onDrop,
    onGrab,
    onGroupDropOn,
    onGroupFloat,
    onGroupFullscreen,
    onGroupGrab,
    onHover,
    onMove,
    onNewTab,
    onPull,
    restack,
    rewound,
    seen,
    strip,
    targets,
  }: GroupStripProps) => {
    const { node } = strip.group;
    const floating = float !== undefined;
    const droppedOn = useCallback(
      (aim: Aim) => {
        onGroupDropOn(node, aim);
      },
      [node, onGroupDropOn],
    );
    const floated = useCallback(() => {
      onGroupFloat(node);
    }, [node, onGroupFloat]);
    const filled = useCallback(() => {
      onGroupFullscreen(node);
    }, [node, onGroupFullscreen]);
    // A float moves as one box, by any of its windows.
    const grabbed = useCallback(() => {
      if (floating) {
        onGrab(id);
      } else {
        onGroupGrab(node);
      }
    }, [floating, id, node, onGrab, onGroupGrab]);
    // Focus follows the pointer onto the group's open window.
    const hovered = useCallback(
      (at: Spot) => {
        onHover(id, at);
      },
      [id, onHover],
    );
    const moved = useCallback(
      (x: number, y: number) => {
        onMove(id, x, y);
      },
      [id, onMove],
    );
    const tabbed = useCallback(() => {
      onNewTab(id);
    }, [id, onNewTab]);
    return (
      <Sliding
        depth={depth}
        frame={frame}
        motion={motion}
        on={on}
        rewound={rewound}
        seen={seen}
      >
        <TabStrip
          box={strip.box}
          depth={depth}
          dragging={dragging}
          end={strip.end}
          endDivided={strip.endDivided}
          float={float}
          frame={frame}
          fullscreen={fullscreen}
          group={strip.group}
          motion={motion}
          nested={strip.nested}
          onAim={onAim}
          onDrop={onDrop}
          onDropOn={droppedOn}
          onFloat={floated}
          onFullscreen={filled}
          onGrab={grabbed}
          onHover={hovered}
          onMove={moved}
          onNewTab={tabbed}
          onPull={onPull}
          restack={restack}
          targets={targets}
        />
      </Sliding>
    );
  },
);

/**
 * Whether a window playing `motion` leaves its strip while the strip stays:
 * a tab closing or sent away, not its whole group.
 */
const leavesStrip = (motion: WindowMotion): boolean =>
  motion === "closing-tab" || motion === "sending-tab";

/**
 * The windows a drag of `id` carries with the pointer: a float's every window.
 * A dragged tiled window stays in its slot until it moves, so it eases there.
 */
const heldBy = (desk: Desk, id: string | undefined): ReadonlySet<string> => {
  const float = id === undefined ? undefined : desk.floats.get(id);
  return new Set(float === undefined ? [] : windowsIn(float.root));
};

/** Whether the group of `windows` is fullscreen. */
const groupFills = (
  screens: readonly StageScreen[],
  windows: readonly string[],
): boolean =>
  screens.some(
    ({ fullscreen }) =>
      fullscreen?.group === true &&
      fullscreen.windows.join() === windows.join(),
  );

/** The screen named `name`, if any. */
const screenNamed = (
  desk: Desk,
  name: string | undefined,
): StageScreen | undefined =>
  name === undefined ? undefined : desk.screens.get(name);

/** The tiled windows on screen `on` that a tiled window can be dropped on. */
const targetsOn = (on: StageScreen | undefined): readonly Target[] =>
  on === undefined ? [] : tiledTargets(on.screenful.placements);

/**
 * The visible tiled windows, which can be dragged and dropped on. Excludes
 * hidden tabs and fullscreen windows.
 */
const tiledTargets = (placements: Screenful["placements"]): readonly Target[] =>
  placements
    .filter(({ depth, surface }) => depth === TILED && surface !== undefined)
    .map(({ frame, id }) => ({ frame, id }));

/**
 * Every tab, tiled or floating, hidden ones too, which a window or group can be
 * dropped beside. Excludes fullscreen screens, whose windows are hidden.
 */
const tabTargets = (screens: readonly StageScreen[]): readonly TabTarget[] =>
  screens
    .filter(({ fullscreen }) => fullscreen === undefined)
    .flatMap(({ screenful }) => tabTargetsOf(screenful));

/**
 * The screens with no tiled window to drop on, which a dropped window fills.
 * Excludes fullscreen ones, whose tiling is hidden.
 */
const emptyScreens = (
  screens: readonly StageScreen[],
): DropTargets["screens"] =>
  screens
    .filter(
      ({ fullscreen, screenful }) =>
        fullscreen === undefined &&
        tiledTargets(screenful.placements).length === 0,
    )
    .map(({ geometry }) => ({
      area: geometry.workspace,
      name: geometry.name,
    }));

/**
 * The focus box of whichever screen shows window `id`. It is around `id` unless
 * `id` is a scratchpad window; see `focusBoxIn`.
 */
const focusBoxShowing = (
  screens: readonly StageScreen[],
  id: string | undefined,
): PlacedFocusBox | undefined =>
  screens.find(({ screenful }) =>
    screenful.placements.some((placement) => placement.id === id),
  )?.screenful.focusBox;

/**
 * Window `id`, which a container's tab is named and marked after.
 *
 * Throws if the window is missing: the layout and window list update
 * together, so a missing window means inconsistent shell state.
 */
const windowNamed = (
  windows: ReadonlyMap<string, ShellWindow>,
  id: string,
): ShellWindow => {
  const window = windows.get(id);
  if (window === undefined) {
    throw new Error(`shell: no window ${id} to name`);
  } else {
    return window;
  }
};

/**
 * A window's icon URL: a client's from its desktop entry, an app window's
 * from its app's (an Electron app's, whose page icon isn't its own), else a
 * browser window's page icon.
 */
const iconOf = (
  window: ShellWindow,
  clientIcons: ReadonlyMap<string, string>,
): string | undefined =>
  window.kind === WindowKind.App
    ? clientIcons.get(window.desktopId)
    : ((window.appId === "" ? undefined : clientIcons.get(window.appId)) ??
      window.icon);

/** A browser window's page description; a client's window has none. */
const descriptionOf = (window: ShellWindow): string | undefined =>
  window.kind === WindowKind.App ? undefined : window.description;

/**
 * Returns the engine's id behind a browser window's window id. Every browser
 * window id is built from one, so a missing id is a wiring bug.
 */
const engineWindowOf = (id: string): string => {
  const engine = browserIdOf(id);
  if (engine === undefined) {
    throw new Error(`stage: ${id} is no browser window of the engine's`);
  } else {
    return engine;
  }
};

/** A window to draw, and how the overview shows it, if open. */
type SeenWindow = DrawnWindow & { seen: Seen | undefined };

/**
 * Window `drawn` as the overview shows it: a shown one through its screen's
 * tile, a hidden workspace's one laid out in its own tile.
 */
const seenIn = (
  drawn: DrawnWindow,
  overview: OverviewSight | undefined,
): SeenWindow => {
  const hidden =
    drawn.placement === undefined
      ? overview?.hidden.get(drawn.window.id)
      : undefined;
  if (hidden === undefined) {
    return {
      ...drawn,
      seen:
        drawn.screen === undefined
          ? undefined
          : overview?.shown.get(drawn.screen),
    };
  } else {
    return {
      ...drawn,
      placement: hidden.placement,
      screen: hidden.screen,
      seen: hidden.seen,
    };
  }
};
