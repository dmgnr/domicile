// The desktop's window state and the pure reducer that updates it.
//
// Windows, workspaces, screens and the binding mode change together, so they
// share one state. `useWindows` feeds host events and keystrokes into it.
//
// Most actions are sway commands parsed by `keyboard/command.ts`, and most
// reducer arms delegate to `workspace.ts`. See
// `packages/manganese-window-management/docs/WINDOW-MANAGEMENT.md`.

import type { CursorShape } from "@domicile-desktop/sdk/cursor-shape";
import type { BrowserWindow as ListedBrowserWindow } from "@domicile-desktop/sdk/desktop/browser";
import type { InhibitorAction } from "@domicile-desktop/sdk/inhibitor-action";
import type { KeymapChoice } from "@domicile-desktop/sdk/keymap-choice";
import type { Axis, Direction } from "./direction";
import type { Float } from "./floating/float";
import { floatHolds, limitedTo, movedTo } from "./floating/float";
import type { MediaKey } from "./keyboard/media-key";
import type { Popup } from "./popup";
import type { Rect } from "./rect";
import { SURFACE_TUCK, TITLE_BAR } from "./rect";
import type { PlacedScreen } from "./screens/screen-toward";
import { screenToward } from "./screens/screen-toward";
import { Beside } from "./tree/drop";
import type { Layout } from "./tree/node";
import { windowsIn } from "./tree/node";
import type { NodeRef } from "./tree/path";
import type { ClientWindow, ShellWindow, SizeLimit } from "./window";
import {
  appWindowId,
  browserIdOf,
  browserWindowId,
  ShellWindow as Window,
  WindowKind,
} from "./window";
import type { Workspace } from "./workspace";
import {
  childFocused,
  closed,
  commandedWindowsOn,
  containerLaidOut,
  containerSplit,
  emptyWorkspace,
  enteredBy,
  floatLanded,
  floatLifted,
  floatMoved,
  floatOn,
  floatSized,
  floatToggled,
  focusedOn,
  focusLeaves,
  focusStepped,
  fullscreenKept,
  fullscreenToggled,
  groupedOn,
  holds,
  modeToggled,
  nodeArrived,
  nodeDropped,
  nodeFullscreenToggled,
  nodeHeld,
  nodeLifted,
  nodeReached,
  nodeTiledIn,
  opened,
  openedCentered,
  openedFloating,
  pageFullscreened,
  parentFocused,
  picked,
  pointedOn,
  pushedOffBy,
  pushedOnBy,
  reached,
  sentOff,
  shown,
  splitFlipped,
  tabSubgrouped,
  tiledStretched,
  windowFloatToggled,
  windowGrown,
  windowMoved,
  windowsOn,
  windowsUnder,
} from "./workspace";

/**
 * The workspace names the config binds keys to.
 *
 * All ten always exist, unlike sway's. The bar only lists non-empty ones, so
 * the user sees the same thing.
 */
export const WORKSPACES: readonly string[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
];

/**
 * The screen name used before the host describes any screens.
 *
 * No real display has this name, so nothing draws it. It gives windows that
 * open before the first description somewhere to live.
 */
export const UNDESCRIBED_SCREEN = "";

/** The empty box for {@link UNDESCRIBED_SCREEN}. */
const NOWHERE: Rect = { height: 0, width: 0, x: 0, y: 0 };

/** One screen of the desk, and the workspace it is showing. */
export type DeskScreen = PlacedScreen & {
  /** The workspace shown on it. No two screens show the same one. */
  current: string;
};

export type WindowState = {
  /**
   * The desk's screens, in order, and the workspace each shows. Never empty
   * (see {@link UNDESCRIBED_SCREEN}).
   *
   * As in sway, selecting a workspace already on screen moves the keyboard
   * there. No two screens may show the same workspace: embedding a window
   * twice takes the first embedding's pixels away.
   */
  screens: readonly DeskScreen[];
  /**
   * The screen with the keyboard, where windows open and keyed commands act.
   */
  focused: string;
  /**
   * The screen each workspace belongs to, whose bar lists it.
   *
   * As with sway's outputs, selecting a workspace shows it on its home
   * screen. A hidden workspace keeps its last screen, or moves to the focused
   * screen if that one is gone. An empty hidden workspace has no home, so it
   * opens on the focused screen next time.
   */
  homes: Readonly<Partial<Record<string, string>>>;
  /**
   * The floating window being dragged, or `undefined`.
   *
   * Kept here because it styles the window, and because releasing the
   * modifier mid-drag must not drop it.
   */
  draggingId: string | undefined;
  /**
   * The app with compositor keyboard focus, or `undefined` when the chrome
   * has it.
   *
   * Can differ from the shell's focused window, for example after a click.
   */
  focusedId: string | undefined;
  /**
   * Whether the compositor has named a window with the keyboard yet.
   *
   * The first window it names ends the replay to a newly bound page, and says
   * where the user was typing, so the shell follows it. Later reports answer
   * the shell's own asks. Following one that lands late would undo a newer
   * choice, such as a window opened from the launcher.
   */
  replayed: boolean;
  /**
   * Whether the launcher is open.
   *
   * Kept here because key commands open it and launches close it.
   */
  launcherOpen: boolean;
  /**
   * The workspace the overview's keys are on, or `undefined` for the shown
   * one. Kept here because `focus` and `move` commands step it.
   */
  overviewAim: string | undefined;
  /**
   * Which card each overview tile shows, by tile name, or the tile's own
   * when missing. Swaps trade them, so a card follows its windows. Never
   * dealt afresh: every card looks alike, and a reset would slide cards
   * still drawn. Kept here because the overview's keys swap workspaces.
   */
  overviewCards: Readonly<Record<string, string>>;
  /**
   * Whether the overview, each screen's workspaces at once, is open.
   * Kept here because key commands and gestures open it.
   */
  overviewOpen: boolean;
  /**
   * Whether the clipboard history is open. Kept here because key commands
   * open it.
   */
  clipboardOpen: boolean;
  /**
   * The binding mode: `default`, or one the config declares such as `resize`.
   *
   * Shared across the desk because consecutive keys can land on different
   * monitors' pages. Each page passes it to the SDK.
   */
  mode: string;
  /**
   * The previously shown workspace, for `workspaceAutoBackAndForth`.
   */
  previous: string | undefined;
  /**
   * Client popups such as menus and tooltips, oldest first. See `popup.ts`.
   */
  popups: readonly Popup[];
  /**
   * How many commands keys have run, and focus requests granted.
   *
   * `usePointerWarp` moves the pointer after each one. A counter lets each
   * monitor tell new presses from ones it has handled.
   */
  pressed: number;
  /** The scratchpad windows, next to show first. */
  scratchpad: readonly string[];
  /**
   * The windows of apps that run in the background, such as an inbox's. Each
   * opens hidden, shows when it asks to be in front, and hides when closed,
   * so its page keeps running.
   */
  background: readonly string[];
  windows: readonly ShellWindow[];
  workspaces: readonly Workspace[];
};

/** The initial state: no windows open. */
export const NO_WINDOWS: WindowState = {
  background: [],
  clipboardOpen: false,
  draggingId: undefined,
  focused: UNDESCRIBED_SCREEN,
  focusedId: undefined,
  homes: { "1": UNDESCRIBED_SCREEN },
  launcherOpen: false,
  mode: "default",
  overviewAim: undefined,
  overviewCards: {},
  overviewOpen: false,
  popups: [],
  pressed: 0,
  previous: undefined,
  replayed: false,
  scratchpad: [],
  screens: [{ box: NOWHERE, current: "1", name: UNDESCRIBED_SCREEN }],
  windows: [],
  workspaces: WORKSPACES.map((name) => emptyWorkspace(name)),
};

/**
 * The workspace `screen` is showing. Throws for an unknown screen, which is a
 * wiring bug.
 */
export const workspaceOn = (state: WindowState, screen: string): Workspace =>
  workspaceNamed(state, currentOn(state, screen));

/** The workspace with the keyboard, which keyed commands act on. */
export const workspaceHere = (state: WindowState): Workspace =>
  workspaceOn(state, state.focused);

/** The workspace `screen` is showing. */
export const currentOn = (state: WindowState, screen: string): string =>
  screenNamed(state, screen).current;

/** The workspace on the focused screen. */
export const currentHere = (state: WindowState): string =>
  currentOn(state, state.focused);

/** The focused screen's box on the desk. */
const screenHere = (state: WindowState): Rect =>
  screenNamed(state, state.focused).box;

/** The screen called `name`. Throws for an unknown screen. */
const screenNamed = (state: WindowState, name: string): DeskScreen => {
  const found = state.screens.find((screen) => screen.name === name);
  if (found === undefined) {
    throw new Error(`shell: no screen ${name}`);
  } else {
    return found;
  }
};

/** The screen showing `workspace`, or `undefined` while none is. */
export const screenShowing = (
  state: Pick<WindowState, "screens">,
  workspace: string,
): string | undefined =>
  state.screens.find(({ current }) => current === workspace)?.name;

/** The workspaces `screen`'s bar lists, in order. */
export const workspacesOn = (
  { homes }: Pick<WindowState, "homes">,
  screen: string,
): readonly string[] => WORKSPACES.filter((name) => homes[name] === screen);

/** The workspace called `name`. Throws for an unknown name. */
export const workspaceNamed = (
  state: Pick<WindowState, "workspaces">,
  name: string,
): Workspace => {
  const workspace = state.workspaces.find((found) => found.name === name);
  if (workspace === undefined) {
    throw new Error(`shell: no workspace ${name}`);
  } else {
    return workspace;
  }
};

/** The workspace the window `id` is on, or `undefined` for a hidden one. */
export const workspaceHolding = (
  state: Pick<WindowState, "workspaces">,
  id: string,
): Workspace | undefined =>
  state.workspaces.find((workspace) => holds(workspace, id));

/**
 * The screen showing the client `appId`'s window, or `undefined` while none
 * is.
 */
export const screenOfApp = (
  state: Pick<WindowState, "screens" | "workspaces">,
  appId: string,
): string | undefined => {
  const workspace = workspaceHolding(state, appWindowId(appId));
  return workspace === undefined
    ? undefined
    : screenShowing(state, workspace.name);
};

/**
 * The screen window `id`'s workspace belongs to: the one showing it, or else
 * its home. `undefined` for a window on no workspace.
 */
export const screenHolding = (
  state: Pick<WindowState, "homes" | "screens" | "workspaces">,
  id: string,
): string | undefined => {
  const workspace = workspaceHolding(state, id);
  return workspace === undefined
    ? undefined
    : (screenShowing(state, workspace.name) ?? state.homes[workspace.name]);
};

/** The focused window, or `undefined` on an empty workspace. */
export const activeIdOf = (state: WindowState): string | undefined =>
  focusedOn(workspaceHere(state));

/** The windows `kill` closes: every window in the node commands target. */
export const killedIdsOf = (state: WindowState): readonly string[] =>
  commandedWindowsOn(workspaceHere(state));

/**
 * The background windows shown as closed: off every workspace and the
 * scratchpad, though their pages keep running. See
 * {@link WindowState.background}.
 */
export const shutIdsOf = (state: WindowState): readonly string[] =>
  state.background.filter(
    (id) =>
      workspaceHolding(state, id) === undefined &&
      !state.scratchpad.includes(id),
  );

/** The engine's ids of the windows {@link shutIdsOf} names. */
export const closedBrowsersOf = (state: WindowState): readonly string[] =>
  shutIdsOf(state).map(engineIdOf);

/**
 * Of `ids`, the windows a close request closes: all but a background app's,
 * which hide instead. See {@link WindowState.background}.
 */
export const closedIdsOf = (
  state: WindowState,
  ids: readonly string[],
): readonly string[] => ids.filter((id) => !state.background.includes(id));

/** Every window in the group `group` names. Throws for one no workspace holds. */
export const windowsInGroup = (
  state: WindowState,
  group: NodeRef,
): readonly string[] => {
  const workspace = workspaceHolding(state, group.id);
  if (workspace === undefined) {
    throw new Error(`windows: no workspace holds group ${group.id}`);
  } else {
    return windowsUnder(workspace, group);
  }
};

/** The window `id`, or `undefined` for one that has closed. */
export const windowOf = (
  state: WindowState,
  id: string,
): ShellWindow | undefined => state.windows.find((window) => window.id === id);

/** Whether the active window is a private browser window. */
export const activeIsPrivate = (state: WindowState): boolean => {
  const id = activeIdOf(state);
  const active = id === undefined ? undefined : windowOf(state, id);
  return active?.kind === WindowKind.Browser && active.isPrivate;
};

export enum WindowActionKind {
  AppAppeared,
  AppAppearedFloating,
  AppClosed,
  AppCursorChanged,
  AppDesktopIdChanged,
  AppFrameSynced,
  AppMaxSize,
  AppMinSize,
  AppTitled,
  AppLaunched,
  BrowserDescribed,
  BrowserIconChanged,
  BrowserOpened,
  BrowserWindowsListed,
  ChildFocused,
  ClipboardDismissed,
  ClipboardSearched,
  ClipboardToggled,
  CommandExecuted,
  ContainerSplit,
  DeskLocked,
  FileOpened,
  FloatToggled,
  FocusChanged,
  FocusRequested,
  FocusStepped,
  FullscreenToggled,
  GroupClosed,
  GroupDroppedOn,
  GroupDroppedOnScreen,
  GroupFloated,
  GroupFullscreened,
  GroupGrabbed,
  IdleInhibitorToggled,
  KeymapSelected,
  KeyPressed,
  LauncherDismissed,
  LauncherToggled,
  LayoutSet,
  MediaKeyPressed,
  ModeSet,
  ModeSwapped,
  NewTabPressed,
  NightLightToggled,
  NotificationsCleared,
  NotificationsToggled,
  OverviewAimed,
  OverviewDismissed,
  OverviewPicked,
  OverviewShown,
  OverviewToggled,
  OverviewWindowPicked,
  PageFullscreened,
  ParentFocused,
  PopupPlaced,
  ScratchpadBrought,
  ScratchpadDismissed,
  ScratchpadHidden,
  ScratchpadShown,
  ScreenHovered,
  ScreenshotTaken,
  ScreensDescribed,
  ShortcutsInhibitorSwitched,
  SplitToggled,
  TabSubgrouped,
  TerminalOpened,
  VirtualMonitorAdded,
  VirtualMonitorRemoved,
  WindowBarPressed,
  WindowClosed,
  WindowDropped,
  WindowDroppedOn,
  WindowDroppedOnScreen,
  WindowFloated,
  WindowFullscreened,
  WindowGrabbed,
  WindowGrown,
  WindowHovered,
  WindowKilled,
  WindowMoved,
  WindowMovedToWorkspace,
  WindowResized,
  WindowSelected,
  WindowSentToScratchpad,
  WindowSentToWorkspace,
  WindowStepped,
  WindowStretched,
  WorkspaceSelected,
  WorkspacesSwapped,
  WorkspaceStepped,
}

export const WindowAction = {
  /** The host announced a Wayland client. */
  AppAppeared: (appId: string, title: string | undefined) => ({
    appId,
    kind: WindowActionKind.AppAppeared as const,
    title,
  }),

  /**
   * The host announced a Wayland client that opens floating, at the `size` it
   * drew. `bare` drops the title bar for a client that draws its own frame.
   */
  AppAppearedFloating: (
    appId: string,
    title: string | undefined,
    size: readonly [width: number, height: number],
    bare: boolean,
  ) => ({
    appId,
    bare,
    kind: WindowActionKind.AppAppearedFloating as const,
    size,
    title,
  }),

  /** The host says the client is gone. */
  AppClosed: (appId: string) => ({
    appId,
    kind: WindowActionKind.AppClosed as const,
  }),

  /**
   * The client asked for a cursor to be shown over its window: a shape, or
   * `image`, the CSS cursor for one it drew itself.
   */
  AppCursorChanged: (
    appId: string,
    cursor: CursorShape,
    image?: string | undefined,
  ) => ({
    appId,
    cursor,
    image,
    kind: WindowActionKind.AppCursorChanged as const,
  }),

  /**
   * The client named its desktop entry (`set_app_id`), which the shell draws
   * its icon from.
   */
  AppDesktopIdChanged: (appId: string, desktopId: string) => ({
    appId,
    desktopId,
    kind: WindowActionKind.AppDesktopIdChanged as const,
  }),

  /**
   * The compositor synced a frame of the client's window, which its `<app>`
   * shows from the same render.
   */
  AppFrameSynced: (appId: string, frame: number) => ({
    appId,
    frame,
    kind: WindowActionKind.AppFrameSynced as const,
  }),

  /**
   * The user picked an application in the launcher. The compositor runs
   * `command`; the reducer only closes the launcher.
   */
  AppLaunched: (command: readonly string[]) => ({
    command,
    kind: WindowActionKind.AppLaunched as const,
  }),

  /** The client said the largest it will draw its window. */
  AppMaxSize: (appId: string, size: SizeLimit) => ({
    appId,
    kind: WindowActionKind.AppMaxSize as const,
    size,
  }),

  /** The client said the smallest it will draw its window. */
  AppMinSize: (appId: string, size: SizeLimit) => ({
    appId,
    kind: WindowActionKind.AppMinSize as const,
    size,
  }),

  /**
   * The client set or cleared its window title.
   *
   * Separate from {@link WindowAction.AppAppeared} because `set_title` comes
   * after creation and repeats on every change.
   */
  AppTitled: (appId: string, title: string | undefined) => ({
    appId,
    kind: WindowActionKind.AppTitled as const,
    title,
  }),

  /**
   * The view of the engine's browser window `windowId` reported its page's
   * description, `""` for none.
   */
  BrowserDescribed: (windowId: string, description: string) => ({
    description,
    kind: WindowActionKind.BrowserDescribed as const,
    windowId,
  }),

  /**
   * The view of the engine's browser window `windowId` reported its page's
   * icon URL, `""` for none.
   */
  BrowserIconChanged: (windowId: string, icon: string) => ({
    icon,
    kind: WindowActionKind.BrowserIconChanged as const,
    windowId,
  }),

  /**
   * The user opened a browser window at `src`, private or not. `useWindows`
   * asks the engine, and the window arrives in the next
   * {@link WindowAction.BrowserWindowsListed}.
   */
  BrowserOpened: (src: string, isPrivate: boolean) => ({
    isPrivate,
    kind: WindowActionKind.BrowserOpened as const,
    src,
  }),

  /**
   * The engine sent the full browser window list. New windows open, missing
   * ones close, and the rest take their page's address and title. A new app
   * window whose app id is in `backgroundApps` opens hidden; see
   * {@link WindowState.background}.
   */
  BrowserWindowsListed: (
    windows: readonly ListedBrowserWindow[],
    backgroundApps: readonly string[] = [],
  ) => ({
    backgroundApps,
    kind: WindowActionKind.BrowserWindowsListed as const,
    windows,
  }),

  /** `focus child`. */
  ChildFocused: () => ({ kind: WindowActionKind.ChildFocused as const }),

  /**
   * The clipboard history closed itself: Escape, a backdrop click, or a row
   * being chosen.
   *
   * Not a toggle, which could reopen the panel as it closes.
   */
  ClipboardDismissed: () => ({
    kind: WindowActionKind.ClipboardDismissed as const,
  }),

  /**
   * `search-clipboard`: open the newest copy as a site if it is a URL, else
   * search for it. The window is private when the active one is.
   *
   * Changes no state; `useWindows` asks the engine for the browser window.
   */
  ClipboardSearched: () => ({
    kind: WindowActionKind.ClipboardSearched as const,
  }),

  /**
   * `mod+shift+v`, which opens and closes the clipboard history.
   */
  ClipboardToggled: () => ({
    kind: WindowActionKind.ClipboardToggled as const,
  }),

  /**
   * `exec <argv…>`: the compositor spawns `argv`.
   *
   * Changes no state; the new window arrives as a host announcement. It is an
   * action so every key command is one.
   */
  CommandExecuted: (argv: readonly string[]) => ({
    argv,
    kind: WindowActionKind.CommandExecuted as const,
  }),

  /** `splith` / `splitv`: moves the focus out of its tab group. */
  ContainerSplit: (axis: Axis) => ({
    axis,
    kind: WindowActionKind.ContainerSplit as const,
  }),

  /**
   * The user asked the compositor to lock the desk.
   *
   * Changes no state; the lock screen follows the host's `locked` message.
   */
  DeskLocked: () => ({ kind: WindowActionKind.DeskLocked as const }),

  /**
   * The user picked a file in the launcher; the compositor opens it with the
   * default application.
   *
   * Only closes the launcher; the app's window arrives from the host. `path`
   * is relative to the home directory or absolute (see
   * `launcher/open-command.ts`).
   */
  FileOpened: (path: string) => ({
    kind: WindowActionKind.FileOpened as const,
    path,
  }),

  /** `floating toggle`. */
  FloatToggled: () => ({ kind: WindowActionKind.FloatToggled as const }),

  /**
   * The compositor moved keyboard focus. `undefined` means the chrome has it.
   *
   * Also reports focus changes the shell did not request, such as clicks.
   */
  FocusChanged: (appId: string | undefined) => ({
    appId,
    kind: WindowActionKind.FocusChanged as const,
  }),

  /**
   * Window `id` asked for the keyboard: a client over `xdg-activation`, or a
   * browser window's page or an extension. The compositor leaves the decision
   * to the shell; Manganese grants it, shows the window's workspace and tab,
   * and warps the pointer to it.
   */
  FocusRequested: (id: string) => ({
    id,
    kind: WindowActionKind.FocusRequested as const,
  }),

  /** `focus <direction>`. */
  FocusStepped: (direction: Direction) => ({
    direction,
    kind: WindowActionKind.FocusStepped as const,
  }),

  /** `fullscreen`, or `fullscreen toggle global` across every screen. */
  FullscreenToggled: (global: boolean) => ({
    global,
    kind: WindowActionKind.FullscreenToggled as const,
  }),

  /**
   * The user closed group `group` from its tab, which closes every window in
   * it. A request only, as {@link WindowAction.WindowClosed} is.
   */
  GroupClosed: (group: NodeRef) => ({
    group,
    kind: WindowActionKind.GroupClosed as const,
  }),

  /**
   * The user dropped the tiled group `group`, dragged by its tab strip, on
   * `target`. See {@link WindowAction.WindowDroppedOn}.
   */
  GroupDroppedOn: (
    group: NodeRef,
    target: NodeRef,
    edge: Direction | undefined,
    beside: Beside = Beside.InStrip,
  ) => ({
    beside,
    edge,
    group,
    kind: WindowActionKind.GroupDroppedOn as const,
    target,
  }),

  /**
   * The user dropped the tiled group `group` on screen `screen`, which has
   * nothing tiled on it.
   */
  GroupDroppedOnScreen: (group: NodeRef, screen: string) => ({
    group,
    kind: WindowActionKind.GroupDroppedOnScreen as const,
    screen,
  }),

  /**
   * The user pressed the float button on the tab strip of group `group`. It is
   * selected, as by `focus parent`, and floated or tiled whole.
   */
  GroupFloated: (group: NodeRef) => ({
    group,
    kind: WindowActionKind.GroupFloated as const,
  }),

  /**
   * The user pressed the fullscreen button on the tab strip of group `group`.
   * It is selected, as by `focus parent`, and fills its screen or gives it
   * back. Never global, as for {@link WindowAction.WindowFullscreened}.
   */
  GroupFullscreened: (group: NodeRef) => ({
    group,
    kind: WindowActionKind.GroupFullscreened as const,
  }),

  /**
   * The user started dragging the tiled group `group` by its tab strip. Its
   * open tab is focused, as by a click; a selection around it stays.
   */
  GroupGrabbed: (group: NodeRef) => ({
    group,
    kind: WindowActionKind.GroupGrabbed as const,
  }),

  /** `idle-inhibitor`. The shell holds or lets go of the screens. */
  IdleInhibitorToggled: () => ({
    kind: WindowActionKind.IdleInhibitorToggled as const,
  }),

  /** `keymap next` or `keymap <name>`. The shell switches the keymap. */
  KeymapSelected: (choice: KeymapChoice) => ({
    choice,
    kind: WindowActionKind.KeymapSelected as const,
  }),

  /**
   * A key ran a command. See {@link WindowState.pressed}.
   */
  KeyPressed: () => ({ kind: WindowActionKind.KeyPressed as const }),

  /**
   * The launcher closed itself without launching: Escape or a backdrop click.
   *
   * Not a toggle, which could reopen the panel as it closes.
   */
  LauncherDismissed: () => ({
    kind: WindowActionKind.LauncherDismissed as const,
  }),

  /**
   * `mod+space`, which opens and closes the launcher.
   */
  LauncherToggled: () => ({ kind: WindowActionKind.LauncherToggled as const }),

  /** `layout tabbed` / `layout stacking`. */
  LayoutSet: (layout: Layout) => ({
    kind: WindowActionKind.LayoutSet as const,
    layout,
  }),

  /** A volume, microphone or brightness key. The shell sets the level. */
  MediaKeyPressed: (key: MediaKey) => ({
    key,
    kind: WindowActionKind.MediaKeyPressed as const,
  }),

  /**
   * A key changed the binding mode, such as `mode resize` or `mode default`.
   */
  ModeSet: (mode: string) => ({
    kind: WindowActionKind.ModeSet as const,
    mode,
  }),

  /** `focus mode_toggle`: switch focus between floating and tiled windows. */
  ModeSwapped: () => ({ kind: WindowActionKind.ModeSwapped as const }),

  /**
   * The new-tab button at the end of the strip that holds tab `id`. Focuses
   * the strip's open tab, so the window launched opens beside it, and opens
   * the launcher.
   */
  NewTabPressed: (id: string) => ({
    id,
    kind: WindowActionKind.NewTabPressed as const,
  }),

  /** `night-light`. The shell turns the night light on or off. */
  NightLightToggled: () => ({
    kind: WindowActionKind.NightLightToggled as const,
  }),

  /** `notifications clear`. The shell clears the drawer. */
  NotificationsCleared: () => ({
    kind: WindowActionKind.NotificationsCleared as const,
  }),

  /**
   * `notifications`. The shell opens the drawer on the screen with the
   * keyboard, or closes it.
   */
  NotificationsToggled: () => ({
    kind: WindowActionKind.NotificationsToggled as const,
  }),

  /** The overview's keys moved onto workspace `name`. */
  OverviewAimed: (name: string) => ({
    kind: WindowActionKind.OverviewAimed as const,
    name,
  }),

  /** Escape, or a press on no workspace, in the overview. */
  OverviewDismissed: () => ({
    kind: WindowActionKind.OverviewDismissed as const,
  }),

  /** A workspace pressed in the overview, which goes there. */
  OverviewPicked: (name: string) => ({
    kind: WindowActionKind.OverviewPicked as const,
    name,
  }),

  /** `overview show`: `overview` that never closes. */
  OverviewShown: () => ({ kind: WindowActionKind.OverviewShown as const }),

  /** `overview`, which opens and closes the overview. */
  OverviewToggled: () => ({ kind: WindowActionKind.OverviewToggled as const }),

  /** A window pressed in the overview, which goes to it. */
  OverviewWindowPicked: (id: string) => ({
    id,
    kind: WindowActionKind.OverviewWindowPicked as const,
  }),

  /**
   * The page in browser window `id`, or the client of app window `id`, asked
   * to enter or leave fullscreen. See `pageFullscreened`.
   */
  PageFullscreened: (id: string, fullscreen: boolean, display?: string) => ({
    display,
    fullscreen,
    id,
    kind: WindowActionKind.PageFullscreened as const,
  }),

  /** `focus parent`. */
  ParentFocused: () => ({ kind: WindowActionKind.ParentFocused as const }),

  /** A client opened a popup over one of its windows, or moved one. */
  PopupPlaced: (popup: Popup) => ({
    kind: WindowActionKind.PopupPlaced as const,
    popup,
  }),

  /** `scratchpad bring`: `scratchpad show` that never hides. */
  ScratchpadBrought: () => ({
    kind: WindowActionKind.ScratchpadBrought as const,
  }),

  /** A click on the backdrop behind scratchpad window `id`, which hides it. */
  ScratchpadDismissed: (id: string) => ({
    id,
    kind: WindowActionKind.ScratchpadDismissed as const,
  }),

  /** `scratchpad hide`: `scratchpad show` that never shows. */
  ScratchpadHidden: () => ({
    kind: WindowActionKind.ScratchpadHidden as const,
  }),

  /** `scratchpad show`. */
  ScratchpadShown: () => ({ kind: WindowActionKind.ScratchpadShown as const }),

  /**
   * The pointer moved on a screen, which focuses it even with no window under
   * the pointer. See {@link WindowAction.WindowHovered} for windows. Ignored
   * during a drag, as that is.
   */
  ScreenHovered: (name: string) => ({
    kind: WindowActionKind.ScreenHovered as const,
    name,
  }),

  /**
   * The host described the desk's screens, in order.
   *
   * Only changes which workspaces are visible. Existing screens keep their
   * workspace, a replacement monitor takes over its predecessor's, and a new
   * monitor gets an unused one.
   */
  ScreensDescribed: (screens: readonly PlacedScreen[]) => ({
    kind: WindowActionKind.ScreensDescribed as const,
    screens,
  }),

  /**
   * The user asked for a screenshot.
   *
   * Changes no state; the compositor freezes the desk and `<PortalDialogs />`
   * draws the dialog.
   */
  ScreenshotTaken: () => ({
    kind: WindowActionKind.ScreenshotTaken as const,
  }),

  /**
   * `shortcuts-inhibitor activate|deactivate|toggle`. The shell switches the
   * keyboard window's shortcuts inhibitor: the way back from a VM.
   */
  ShortcutsInhibitorSwitched: (action: InhibitorAction) => ({
    action,
    kind: WindowActionKind.ShortcutsInhibitorSwitched as const,
  }),

  /** `layout toggle split`. */
  SplitToggled: () => ({ kind: WindowActionKind.SplitToggled as const }),

  /** `group`: turns the focused tab into a group of its own. */
  TabSubgrouped: () => ({ kind: WindowActionKind.TabSubgrouped as const }),

  /**
   * `terminal`: open the terminal the desk's config names.
   *
   * Changes no state; `useWindows` launches it, and the host announces its
   * window. Does nothing on a desk that names none.
   */
  TerminalOpened: () => ({
    kind: WindowActionKind.TerminalOpened as const,
  }),

  /** `virtual-monitor add`. The shell adds a monitor of `size`. */
  VirtualMonitorAdded: (size: {
    readonly width: number;
    readonly height: number;
  }) => ({
    kind: WindowActionKind.VirtualMonitorAdded as const,
    size,
  }),

  /** `virtual-monitor remove`. The shell removes the newest it added. */
  VirtualMonitorRemoved: () => ({
    kind: WindowActionKind.VirtualMonitorRemoved as const,
  }),

  /**
   * The user pressed window `id`'s title bar or tab. Unlike
   * {@link WindowAction.WindowSelected}, it ends a `focus parent` selection
   * around the window.
   */
  WindowBarPressed: (id: string) => ({
    id,
    kind: WindowActionKind.WindowBarPressed as const,
  }),

  /** The user closed a window from its title bar. */
  WindowClosed: (id: string) => ({
    id,
    kind: WindowActionKind.WindowClosed as const,
  }),

  /** The user released the window being dragged. */
  WindowDropped: () => ({ kind: WindowActionKind.WindowDropped as const }),

  /**
   * The user dropped a tiled window on the `edge` of the node `target` names,
   * or its middle when `edge` is `undefined`, in or `beside` its strip.
   *
   * Sent alongside {@link WindowAction.WindowDropped}, which ends the drag.
   */
  WindowDroppedOn: (
    id: string,
    target: NodeRef,
    edge: Direction | undefined,
    beside: Beside = Beside.InStrip,
  ) => ({
    beside,
    edge,
    id,
    kind: WindowActionKind.WindowDroppedOn as const,
    target,
  }),

  /**
   * The user dropped a tiled window on screen `screen`, which has nothing
   * tiled on it.
   *
   * Sent alongside {@link WindowAction.WindowDropped}, which ends the drag.
   */
  WindowDroppedOnScreen: (id: string, screen: string) => ({
    id,
    kind: WindowActionKind.WindowDroppedOnScreen as const,
    screen,
  }),

  /**
   * The user pressed the float button on window `id`'s title bar.
   *
   * Unlike {@link WindowAction.FloatToggled}, it targets a named window.
   */
  WindowFloated: (id: string) => ({
    id,
    kind: WindowActionKind.WindowFloated as const,
  }),

  /**
   * The user pressed the fullscreen button on window `id`'s title bar.
   *
   * Unlike {@link WindowAction.FullscreenToggled}, it targets a named window.
   * Never global, so the button cannot spread a window onto screens the user
   * is not looking at.
   */
  WindowFullscreened: (id: string) => ({
    id,
    kind: WindowActionKind.WindowFullscreened as const,
  }),

  /**
   * The user started dragging a floating window to move or resize it. Both
   * are the same drag here.
   */
  WindowGrabbed: (id: string) => ({
    id,
    kind: WindowActionKind.WindowGrabbed as const,
  }),

  /** `resize grow` / `resize shrink`. */
  WindowGrown: (direction: Direction) => ({
    direction,
    kind: WindowActionKind.WindowGrown as const,
  }),

  /**
   * The pointer entered a window, which focuses it. A hidden tab counts as
   * its container's open tab (see `pointedOn`).
   *
   * Ignored during a drag: focus stays with the dragged window, and its
   * screen is where its middle is, not the pointer (see `floatDragged`).
   *
   * Clicks are {@link WindowAction.WindowSelected}.
   */
  WindowHovered: (id: string) => ({
    id,
    kind: WindowActionKind.WindowHovered as const,
  }),

  /** `kill`: close the focused window. */
  WindowKilled: () => ({ kind: WindowActionKind.WindowKilled as const }),

  /**
   * The user dragged a floating window to `x`, `y` in desk pixels (see
   * `floatDragged`).
   */
  WindowMoved: (id: string, x: number, y: number) => ({
    id,
    kind: WindowActionKind.WindowMoved as const,
    x,
    y,
  }),

  /**
   * Window `id` dropped on workspace `name` in the overview, from whichever
   * workspace holds it. The screens keep showing what they showed.
   */
  WindowMovedToWorkspace: (id: string, name: string) => ({
    id,
    kind: WindowActionKind.WindowMovedToWorkspace as const,
    name,
  }),

  /**
   * The user resized a floating window by a corner, which can also move it.
   */
  WindowResized: (id: string, box: Rect) => ({
    box,
    id,
    kind: WindowActionKind.WindowResized as const,
  }),

  /** The user clicked in a window. A selection around it stays. */
  WindowSelected: (id: string) => ({
    id,
    kind: WindowActionKind.WindowSelected as const,
  }),

  /** `move scratchpad`. */
  WindowSentToScratchpad: () => ({
    kind: WindowActionKind.WindowSentToScratchpad as const,
  }),

  /** `move container to workspace <name>`. */
  WindowSentToWorkspace: (name: string) => ({
    kind: WindowActionKind.WindowSentToWorkspace as const,
    name,
  }),

  /** `move <direction>`. */
  WindowStepped: (direction: Direction) => ({
    direction,
    kind: WindowActionKind.WindowStepped as const,
  }),

  /**
   * The user dragged a tiled window's `edge` `by` pixels (positive is right
   * or down).
   *
   * `area` is the workspace's layout box, needed to convert pixels to the
   * tree's shares. Only the showing monitor knows it.
   */
  WindowStretched: (id: string, edge: Direction, by: number, area: Rect) => ({
    area,
    by,
    edge,
    id,
    kind: WindowActionKind.WindowStretched as const,
  }),

  /** `workspace <name>`. */
  WorkspaceSelected: (name: string) => ({
    kind: WindowActionKind.WorkspaceSelected as const,
    name,
  }),

  /** `workspace next_on_output` or `workspace prev_on_output`. */
  WorkspaceStepped: (way: "next" | "prev") => ({
    kind: WindowActionKind.WorkspaceStepped as const,
    way,
  }),

  /**
   * In the overview, the windows of workspaces `from` and `to` trade places.
   * On one monitor, so do the screens showing them: what the screen showed
   * stays shown, under its new name. Across two, each monitor keeps showing
   * the same place, now holding the other's windows.
   */
  WorkspacesSwapped: (from: string, to: string) => ({
    from,
    kind: WindowActionKind.WorkspacesSwapped as const,
    to,
  }),
};

export type WindowAction = ReturnType<
  (typeof WindowAction)[keyof typeof WindowAction]
>;

export const reduceWindows = (
  state: WindowState,
  action: WindowAction,
): WindowState =>
  isShutInOverview(state, action)
    ? state
    : aimForgotten(
        rehomed(limited(state, regrouped(reduceAction(state, action)))),
      );

/**
 * Whether `action` does nothing in `state`, the overview being open: the
 * reducer ignores it, and so must its side effects (see `useWindows`).
 */
export const isShutInOverview = (
  state: Pick<WindowState, "overviewOpen">,
  action: WindowAction,
): boolean => state.overviewOpen && SHUT_IN_OVERVIEW.has(action.kind);

/**
 * The commands that change windows or workspaces, which do nothing while the
 * overview is open: its picker and its own keys handle them (see
 * `steeredInOverview`).
 */
const SHUT_IN_OVERVIEW: ReadonlySet<WindowActionKind> = new Set([
  WindowActionKind.ChildFocused,
  WindowActionKind.ContainerSplit,
  WindowActionKind.FloatToggled,
  WindowActionKind.FocusStepped,
  WindowActionKind.FullscreenToggled,
  WindowActionKind.LayoutSet,
  WindowActionKind.ModeSwapped,
  WindowActionKind.ParentFocused,
  WindowActionKind.ScratchpadBrought,
  WindowActionKind.ScratchpadHidden,
  WindowActionKind.ScratchpadShown,
  WindowActionKind.SplitToggled,
  WindowActionKind.TabSubgrouped,
  WindowActionKind.WindowGrown,
  WindowActionKind.WindowKilled,
  WindowActionKind.WindowSentToScratchpad,
  WindowActionKind.WindowSentToWorkspace,
  WindowActionKind.WindowStepped,
  WindowActionKind.WorkspaceSelected,
  WindowActionKind.WorkspaceStepped,
]);

// The overview's aim lasts only while it is open and its workspace has a
// tile, which a workspace has while it has a home. Otherwise the keys go back
// to the shown workspace.
const aimForgotten = (state: WindowState): WindowState => {
  const { homes, overviewAim, overviewOpen } = state;
  if (overviewAim === undefined) {
    return state;
  } else if (overviewOpen && homes[overviewAim] !== undefined) {
    return state;
  } else {
    return { ...state, overviewAim: undefined };
  }
};

/**
 * `from` and `to` trade windows, and on one monitor the screen showing them;
 * see `WorkspacesSwapped`.
 */
const swapped = (state: WindowState, from: string, to: string): WindowState => {
  // On one monitor, its screen follows what it showed. Across two, each keeps
  // its places: what crosses is shown only if its new place is.
  const across = state.homes[from] !== state.homes[to];
  const other = (name: string | undefined) => {
    if (name === from) {
      return to;
    } else if (name === to) {
      return from;
    } else {
      return name;
    }
  };
  return {
    ...state,
    previous: across ? state.previous : other(state.previous),
    screens: across
      ? state.screens
      : state.screens.map((screen) => ({
          ...screen,
          current: other(screen.current) ?? screen.current,
        })),
    workspaces: state.workspaces.map((workspace) =>
      workspace.name === from || workspace.name === to
        ? {
            ...workspaceNamed(state, other(workspace.name) ?? workspace.name),
            name: workspace.name,
          }
        : workspace,
    ),
  };
};

// Keeps every window in a tab group after any change (see `groupedOn`).
const regrouped = (state: WindowState): WindowState => {
  const workspaces = state.workspaces.map((workspace) => groupedOn(workspace));
  return workspaces.every(
    (workspace, index) => workspace === state.workspaces[index],
  )
    ? state
    : { ...state, workspaces };
};

const reduceAction = (
  state: WindowState,
  action: WindowAction,
): WindowState => {
  switch (action.kind) {
    case WindowActionKind.AppAppeared: {
      return openApp(state, action.appId, action.title);
    }
    case WindowActionKind.AppAppearedFloating: {
      return openFloatingApp(state, action);
    }
    case WindowActionKind.AppClosed: {
      // Popups and windows share one id space without overlap.
      return state.popups.some(({ appId }) => appId === action.appId)
        ? {
            ...state,
            popups: state.popups.filter(({ appId }) => appId !== action.appId),
          }
        : closeWindow(state, appWindowId(action.appId));
    }
    case WindowActionKind.AppCursorChanged: {
      return reshapeApp(state, action.appId, (window) => ({
        ...window,
        cursor: action.cursor,
        cursorImage: action.image,
      }));
    }
    case WindowActionKind.AppFrameSynced: {
      return reshapeApp(state, action.appId, (window) => ({
        ...window,
        syncedFrame: action.frame,
      }));
    }
    case WindowActionKind.AppDesktopIdChanged: {
      return reshapeApp(state, action.appId, (window) => ({
        ...window,
        desktopId: action.desktopId,
      }));
    }
    case WindowActionKind.AppMaxSize: {
      return reshapeApp(state, action.appId, (window) => ({
        ...window,
        maxSize: action.size,
      }));
    }
    case WindowActionKind.AppMinSize: {
      return reshapeApp(state, action.appId, (window) => ({
        ...window,
        minSize: action.size,
      }));
    }
    case WindowActionKind.AppTitled: {
      // Same fallback as on open; the SDK reads `set_title("")` as no title.
      return renameWindow(
        state,
        appWindowId(action.appId),
        action.title ?? action.appId,
      );
    }
    case WindowActionKind.BrowserDescribed: {
      return describeBrowser(
        state,
        browserWindowId(action.windowId),
        action.description === "" ? undefined : action.description,
      );
    }
    case WindowActionKind.BrowserIconChanged: {
      return markBrowser(
        state,
        browserWindowId(action.windowId),
        action.icon === "" ? undefined : action.icon,
      );
    }
    case WindowActionKind.BrowserOpened: {
      // Closes the launcher, since opening a URL is one of its results. The
      // window itself arrives with the engine's next list.
      return { ...state, launcherOpen: false };
    }
    case WindowActionKind.BrowserWindowsListed: {
      return listBrowsers(state, action.windows, action.backgroundApps);
    }
    case WindowActionKind.ChildFocused: {
      return onCurrent(state, childFocused);
    }
    case WindowActionKind.ClipboardDismissed: {
      return { ...state, clipboardOpen: false };
    }
    case WindowActionKind.ClipboardSearched: {
      // The engine opens the window and lists it.
      return state;
    }
    case WindowActionKind.ClipboardToggled: {
      return {
        ...state,
        clipboardOpen: !state.clipboardOpen,
        overviewOpen: false,
      };
    }
    case WindowActionKind.ContainerSplit: {
      return onCurrent(state, (workspace) =>
        containerSplit(workspace, action.axis),
      );
    }
    case WindowActionKind.AppLaunched:
    case WindowActionKind.FileOpened: {
      // The host announces the new window. Only the launcher closes here.
      return { ...state, launcherOpen: false };
    }
    case WindowActionKind.FloatToggled: {
      return onCurrent(state, (workspace) =>
        floatToggled(workspace, screenHere(state)),
      );
    }
    case WindowActionKind.FocusChanged: {
      const focusedId =
        action.appId === undefined ? undefined : appWindowId(action.appId);
      // Return the same object when unchanged so React skips re-rendering.
      // A newly connected chrome is told the current holder, usually a no-op.
      if (focusedId === state.focusedId) {
        return state;
      } else {
        const told = { ...state, focusedId };
        return state.replayed ? told : followFocus(told, focusedId);
      }
    }
    case WindowActionKind.FocusRequested: {
      return grantFocus(state, action.id);
    }
    case WindowActionKind.FocusStepped: {
      return stepFocus(state, action.direction);
    }
    case WindowActionKind.FullscreenToggled: {
      return onCurrent(state, (workspace) =>
        fullscreenToggled(workspace, action.global),
      );
    }
    // A request only, but for a background app's windows; see `WindowClosed`.
    case WindowActionKind.GroupClosed: {
      return hideBackground(state, windowsInGroup(state, action.group));
    }
    case WindowActionKind.GroupDroppedOn: {
      return dropNode(
        state,
        action.group,
        action.target,
        action.edge,
        action.beside,
      );
    }
    case WindowActionKind.GroupDroppedOnScreen: {
      return dropOnScreen(state, action.group, action.screen);
    }
    case WindowActionKind.GroupFloated: {
      const held = groupHeld(state, action.group);
      return onWorkspaceWith(held, action.group.id, (workspace) =>
        floatToggled(workspace, screenHere(held)),
      );
    }
    case WindowActionKind.GroupFullscreened: {
      return onWorkspaceWith(
        reachWindow(state, action.group.id),
        action.group.id,
        (workspace) => nodeFullscreenToggled(workspace, action.group, false),
      );
    }
    case WindowActionKind.GroupGrabbed: {
      const { id } = action.group;
      return {
        ...reachWindow(state, id, (workspace) =>
          nodeReached(workspace, action.group),
        ),
        draggingId: id,
      };
    }
    case WindowActionKind.KeyPressed: {
      return { ...state, pressed: state.pressed + 1 };
    }
    case WindowActionKind.LauncherDismissed: {
      return { ...state, launcherOpen: false };
    }
    case WindowActionKind.LauncherToggled: {
      return {
        ...state,
        launcherOpen: !state.launcherOpen,
        overviewOpen: false,
      };
    }
    case WindowActionKind.LayoutSet: {
      return onCurrent(state, (workspace) =>
        containerLaidOut(workspace, action.layout),
      );
    }
    case WindowActionKind.ModeSet: {
      return { ...state, mode: action.mode };
    }
    case WindowActionKind.ModeSwapped: {
      return onCurrent(state, modeToggled);
    }
    case WindowActionKind.NewTabPressed: {
      return {
        ...reachWindow(state, openTabBeside(state, action.id)),
        launcherOpen: true,
      };
    }
    case WindowActionKind.OverviewAimed: {
      return { ...state, overviewAim: action.name };
    }
    case WindowActionKind.OverviewDismissed: {
      return { ...state, overviewOpen: false };
    }
    case WindowActionKind.OverviewPicked: {
      // Not `selectWorkspace`: picking the shown one stays on it.
      return { ...showWorkspace(state, action.name), overviewOpen: false };
    }
    case WindowActionKind.OverviewShown: {
      return state.overviewOpen
        ? state
        : reduceAction(state, WindowAction.OverviewToggled());
    }
    case WindowActionKind.OverviewToggled: {
      return {
        ...state,
        clipboardOpen: false,
        // Its handles go away under the overview, so its drop never comes.
        draggingId: undefined,
        launcherOpen: false,
        overviewOpen: !state.overviewOpen,
      };
    }
    case WindowActionKind.OverviewWindowPicked: {
      // Counted as a press, so the pointer moves to the window.
      return {
        ...reachWindow(state, action.id, picked),
        overviewOpen: false,
        pressed: state.pressed + 1,
      };
    }
    case WindowActionKind.PopupPlaced: {
      // Moved in place rather than appended, so a menu keeps its order.
      const placed = action.popup;
      return {
        ...state,
        popups: state.popups.some(({ appId }) => appId === placed.appId)
          ? state.popups.map((popup) =>
              popup.appId === placed.appId ? placed : popup,
            )
          : [...state.popups, placed],
      };
    }
    case WindowActionKind.PageFullscreened: {
      const placed = action.fullscreen
        ? onRequestedScreen(state, action.id, action.display)
        : state;
      return onWorkspaceWith(placed, action.id, (workspace) =>
        pageFullscreened(workspace, action.id, action.fullscreen),
      );
    }
    case WindowActionKind.ParentFocused: {
      return onCurrent(state, parentFocused);
    }
    case WindowActionKind.ScratchpadDismissed: {
      return restowed(state, action.id);
    }
    case WindowActionKind.ScratchpadShown: {
      return showScratchpad(state);
    }
    case WindowActionKind.ScratchpadBrought: {
      return scratchpadShownHere(state) === undefined
        ? showScratchpad(state)
        : state;
    }
    case WindowActionKind.ScratchpadHidden: {
      const id = scratchpadShownHere(state);
      return id === undefined ? state : restowed(state, id);
    }
    case WindowActionKind.SplitToggled: {
      return onCurrent(state, splitFlipped);
    }
    case WindowActionKind.TabSubgrouped: {
      return onCurrent(state, tabSubgrouped);
    }
    case WindowActionKind.DeskLocked: {
      // The compositor locks it and the host says so.
      return state;
    }
    case WindowActionKind.ScreenshotTaken: {
      // The compositor takes it, through the portal dialog.
      return state;
    }
    case WindowActionKind.TerminalOpened: {
      // `useWindows` launches it; the host announces its window.
      return state;
    }
    case WindowActionKind.MediaKeyPressed:
    case WindowActionKind.NotificationsToggled:
    case WindowActionKind.NotificationsCleared:
    case WindowActionKind.IdleInhibitorToggled:
    case WindowActionKind.NightLightToggled:
    case WindowActionKind.VirtualMonitorAdded:
    case WindowActionKind.VirtualMonitorRemoved: {
      // The shell carries these out; no window changes.
      return state;
    }
    case WindowActionKind.KeymapSelected:
    case WindowActionKind.ShortcutsInhibitorSwitched: {
      // The shell switches the keymap or the inhibitor; no window changes.
      return state;
    }
    case WindowActionKind.CommandExecuted: {
      // The compositor spawns it and the host announces the window it opens.
      return state;
    }
    // A request only. A client may refuse, for example with unsaved work, and
    // the engine closes a browser window. The window is removed on the next
    // `app_closed` or `browser_windows`. `useWindows` sends the request.
    // A request only: `useWindows` asks the window to close, and the host's
    // or engine's report removes it. A background app's window hides now.
    case WindowActionKind.WindowClosed: {
      return hideBackground(state, [action.id]);
    }
    case WindowActionKind.WindowDropped: {
      return { ...state, draggingId: undefined };
    }
    case WindowActionKind.WindowDroppedOn: {
      return dropNode(
        state,
        { id: action.id, up: 0 },
        action.target,
        action.edge,
        action.beside,
      );
    }
    case WindowActionKind.WindowDroppedOnScreen: {
      return dropOnScreen(state, { id: action.id, up: 0 }, action.screen);
    }
    case WindowActionKind.WindowFloated: {
      // Focus the window first, as for `WindowFullscreened`. Reaching it also
      // focuses its screen, which the float is placed on.
      const reached = reachWindow(state, action.id, picked);
      return onWorkspaceWith(reached, action.id, (workspace) =>
        windowFloatToggled(workspace, action.id, screenHere(reached)),
      );
    }
    case WindowActionKind.WindowFullscreened: {
      // Focus the window first: `fullscreenToggled` acts on the focused
      // window, and pressing a bar focuses its window anyway.
      return onWorkspaceWith(
        reachWindow(state, action.id, picked),
        action.id,
        (workspace) => fullscreenToggled(workspace, false),
      );
    }
    case WindowActionKind.WindowGrabbed: {
      // A grab focuses and raises the window, like a click.
      return { ...reachWindow(state, action.id), draggingId: action.id };
    }
    case WindowActionKind.WindowGrown: {
      return onCurrent(state, (workspace) =>
        windowGrown(workspace, action.direction),
      );
    }
    case WindowActionKind.WindowHovered: {
      return state.draggingId === undefined
        ? pointAtWindow(state, action.id)
        : state;
    }
    // A request only, but for a background app's windows; see `WindowClosed`.
    case WindowActionKind.WindowKilled: {
      return hideBackground(state, killedIdsOf(state));
    }
    case WindowActionKind.WindowMoved: {
      return floatDragged(state, action.id, action.x, action.y);
    }
    case WindowActionKind.WindowMovedToWorkspace: {
      return moveToWorkspace(state, action.id, action.name);
    }
    case WindowActionKind.WindowResized: {
      return onWorkspaceWith(state, action.id, (workspace) =>
        floatSized(workspace, action.id, action.box),
      );
    }
    case WindowActionKind.WindowBarPressed: {
      return reachWindow(state, action.id, picked);
    }
    case WindowActionKind.WindowSelected: {
      return reachWindow(state, action.id);
    }
    case WindowActionKind.WindowSentToScratchpad: {
      return hideInScratchpad(state);
    }
    case WindowActionKind.WindowSentToWorkspace: {
      return sendToWorkspace(state, action.name);
    }
    case WindowActionKind.WindowStepped: {
      return stepWindow(state, action.direction);
    }
    case WindowActionKind.WindowStretched: {
      return onWorkspaceWith(state, action.id, (workspace) =>
        tiledStretched(
          workspace,
          action.id,
          action.edge,
          action.by,
          action.area,
        ),
      );
    }
    case WindowActionKind.ScreenHovered: {
      return state.draggingId === undefined
        ? pointAtScreen(state, action.name)
        : state;
    }
    case WindowActionKind.ScreensDescribed: {
      return describeScreens(state, action.screens);
    }
    case WindowActionKind.WorkspaceSelected: {
      return selectWorkspace(state, action.name);
    }
    case WindowActionKind.WorkspacesSwapped: {
      const after = swapped(state, action.from, action.to);
      return {
        ...after,
        // Following the windows, unless they left nothing to follow: an
        // empty workspace swapped off its monitor's screen leaves the
        // overview.
        overviewAim:
          rehomed(after).homes[action.to] === undefined
            ? action.from
            : action.to,
        overviewCards: {
          ...state.overviewCards,
          [action.from]: state.overviewCards[action.to] ?? action.to,
          [action.to]: state.overviewCards[action.from] ?? action.from,
        },
      };
    }
    case WindowActionKind.WorkspaceStepped: {
      return stepWorkspace(state, action.way);
    }
  }
};

// Applies `into` to the focused screen's workspace, as most commands do.
const onCurrent = (
  state: WindowState,
  into: (workspace: Workspace) => Workspace,
): WindowState => onWorkspace(state, currentHere(state), into);

// Applies `into` to workspace `name`. A fullscreen group follows its windows
// through the change; see `fullscreenKept`.
const onWorkspace = (
  state: WindowState,
  name: string,
  into: (workspace: Workspace) => Workspace,
): WindowState => ({
  ...state,
  workspaces: state.workspaces.map((workspace) =>
    workspace.name === name
      ? fullscreenKept(workspace, into(workspace))
      : workspace,
  ),
});

// Applies `into` to the workspace holding `id`. No-op for a window on no
// workspace, such as a scratchpad or already closed one.
const onWorkspaceWith = (
  state: WindowState,
  id: string,
  into: (workspace: Workspace) => Workspace,
): WindowState => {
  const workspace = workspaceHolding(state, id);
  return workspace === undefined
    ? state
    : onWorkspace(state, workspace.name, into);
};

/**
 * `focus <direction>`: within the current workspace, then on to the next
 * screen before wrapping, as in sway. Empty screens are valid targets.
 */
const stepFocus = (state: WindowState, direction: Direction): WindowState => {
  const beyond = screenToward(state.screens, state.focused, direction);
  if (beyond !== undefined && focusLeaves(workspaceHere(state), direction)) {
    return onWorkspace(
      { ...state, focused: beyond },
      currentOn(state, beyond),
      (workspace) => enteredBy(workspace, direction),
    );
  } else {
    return onCurrent(state, (workspace) => focusStepped(workspace, direction));
  }
};

/**
 * `move <direction>`: within the current workspace, then on to the next
 * screen, as in sway. Focus follows the window.
 */
const stepWindow = (state: WindowState, direction: Direction): WindowState => {
  const beyond = screenToward(state.screens, state.focused, direction);
  const leaving =
    beyond === undefined
      ? undefined
      : pushedOffBy(workspaceHere(state), direction);
  if (beyond === undefined || leaving === undefined) {
    return onCurrent(state, (workspace) => windowMoved(workspace, direction));
  } else {
    const left = onCurrent(state, () => leaving.rest);
    return onWorkspace(
      { ...left, focused: beyond },
      currentOn(state, beyond),
      (workspace) => pushedOnBy(workspace, leaving.node, direction),
    );
  }
};

// Ignores a re-announcement of a known client; portals are keyed by app id.
const openApp = (
  state: WindowState,
  appId: string,
  title: string | undefined,
): WindowState => {
  const window = Window.App(appId, title ?? appId);
  return windowOf(state, window.id) === undefined
    ? openWindow(state, window)
    : state;
};

/**
 * Opens a client floating in the middle of the screen, its contents at the
 * size it drew, as sway opens a dialog.
 */
const openFloatingApp = (
  state: WindowState,
  {
    appId,
    bare,
    size: [width, height],
    title,
  }: ReturnType<typeof WindowAction.AppAppearedFloating>,
): WindowState => {
  const window = Window.App(appId, title ?? appId);
  return windowOf(state, window.id) === undefined
    ? onCurrent(
        { ...state, windows: [...state.windows, window] },
        (workspace) =>
          openedCentered(
            workspace,
            window.id,
            screenHere(state),
            width,
            bare ? height : height + TITLE_BAR - SURFACE_TUCK,
            bare,
          ),
      )
    : state;
};

// Applies the engine's list: closes windows it no longer lists, updates the
// ones the shell has, then opens the rest. The list is in open order, so
// windows tile in that order.
const listBrowsers = (
  state: WindowState,
  listed: readonly ListedBrowserWindow[],
  backgroundApps: readonly string[],
): WindowState => {
  const browsers = listed.map((entry) => ({ entry, window: browserOf(entry) }));
  const ids = new Set(browsers.map(({ window }) => window.id));
  const kept = state.windows
    .filter(({ id, kind }) => kind === WindowKind.Browser && !ids.has(id))
    .reduce((left, { id }) => closeWindow(left, id), state);
  const known = new Set(kept.windows.map(({ id }) => id));
  return browsers
    .filter(({ window }) => !known.has(window.id))
    .reduce(
      (opening, { entry, window }) => {
        if (entry.isApp && backgroundApps.includes(entry.appId)) {
          return openHidden(opening, window);
        }
        return entry.width === 0 && entry.height === 0
          ? openWindow(opening, window)
          : openPopupWindow(opening, window, entry.width, entry.height);
      },
      pagesShown(
        kept,
        new Map(browsers.map(({ window }) => [window.id, window])),
      ),
    );
};

/** A browser window as the shell holds it. */
type BrowserRecord = ReturnType<typeof Window.Browser>;

/** A listed browser window as the shell holds it, before its view's icon. */
const browserOf = ({
  id,
  isApp,
  isPrivate,
  popupWindow,
  title,
  url,
}: ListedBrowserWindow): BrowserRecord =>
  Window.Browser(id, url, title, popupWindow, isPrivate, isApp);

// Updates each browser window the shell has to its listed address and title,
// keeping the icon and description its view reported.
const pagesShown = (
  state: WindowState,
  listed: ReadonlyMap<string, BrowserRecord>,
): WindowState =>
  windowsChanged(state, (drawn) => {
    const now = listed.get(drawn.id);
    return now === undefined || drawn.kind !== WindowKind.Browser
      ? drawn
      : { ...now, description: drawn.description, icon: drawn.icon };
  });

// Extension popup windows and pages' windows opened at a size (`window.open()`
// with `width` or `height`) float at that size, as sway floats dialogs; a tile
// would ignore the size the page was designed for. One that asked for no size,
// such as an extension's side panel, tiles.
const openPopupWindow = (
  state: WindowState,
  window: ShellWindow,
  width: number,
  height: number,
): WindowState =>
  onCurrent({ ...state, windows: [...state.windows, window] }, (workspace) =>
    openedFloating(workspace, window.id, screenHere(state), width, height),
  );

// New windows tile on the current workspace and take focus, as in sway.
const openWindow = (state: WindowState, window: ShellWindow): WindowState =>
  onCurrent({ ...state, windows: [...state.windows, window] }, (workspace) =>
    opened(workspace, window.id),
  );

// A background app's window, listed but on no workspace until it asks to be
// in front.
const openHidden = (state: WindowState, window: ShellWindow): WindowState => ({
  ...state,
  background: [...state.background, window.id],
  windows: [...state.windows, window],
});

// The engine's id behind background window `id`, which is always a browser's.
const engineIdOf = (id: string): string => {
  const browser = browserIdOf(id);
  if (browser === undefined) {
    throw new Error(`shell: background window ${id} is not a browser's`);
  } else {
    return browser;
  }
};

// Shows background window `id` on the current workspace, if it is hidden.
const showBackground = (state: WindowState, id: string): WindowState =>
  state.background.includes(id) && workspaceHolding(state, id) === undefined
    ? onCurrent(state, (workspace) => opened(workspace, id))
    : state;

// Takes each background window of `ids` off its workspace, keeping it, so its
// page keeps running. Other windows close when the host or engine says so.
const hideBackground = (
  state: WindowState,
  ids: readonly string[],
): WindowState =>
  ids
    .filter((id) => state.background.includes(id))
    .reduce(
      (hiding, id) => ({
        ...hiding,
        draggingId: hiding.draggingId === id ? undefined : hiding.draggingId,
        workspaces: hiding.workspaces.map((workspace) =>
          holds(workspace, id) ? closed(workspace, id) : workspace,
        ),
      }),
      state,
    );

// Removes a window from the list, its workspace and the scratchpad. Unknown
// ids are a no-op, since the host may drain events for a torn-down portal.
const closeWindow = (state: WindowState, id: string): WindowState => ({
  ...state,
  background: state.background.filter((kept) => kept !== id),
  draggingId: state.draggingId === id ? undefined : state.draggingId,
  scratchpad: state.scratchpad.filter((hidden) => hidden !== id),
  windows: state.windows.filter((window) => window.id !== id),
  workspaces: state.workspaces.map((workspace) =>
    holds(workspace, id) ? closed(workspace, id) : workspace,
  ),
});

// Grants window `id`'s request for the keyboard, showing it if hidden.
//
// - A window asking for the keyboard it has asks for nothing. A client may
//   ask whenever the keyboard enters it, so heeding that would take the
//   keyboard back from a window opened since, before its grant lands.
// - A change is counted as a key press, so the pointer follows: it is
//   elsewhere, and focus follows the pointer.
const grantFocus = (state: WindowState, id: string): WindowState => {
  const reached =
    id === state.focusedId ? state : reachWindow(showBackground(state, id), id);
  return reached === state ? state : { ...reached, pressed: state.pressed + 1 };
};

// Follows compositor focus to its window and that window's workspace, so the
// user can see where they are typing, and ends the replay (see
// `WindowState.replayed`). Focus on the chrome or an unknown window keeps the
// current focus, since a stale value beats `undefined`.
const followFocus = (
  state: WindowState,
  focusedId: string | undefined,
): WindowState =>
  focusedId === undefined || windowOf(state, focusedId) === undefined
    ? state
    : reachWindow({ ...state, replayed: true }, focusedId);

/**
 * Reaches the group `group` names and selects it, tiled or floating, as
 * `focus parent` would.
 */
const groupHeld = (state: WindowState, group: NodeRef): WindowState =>
  onWorkspaceWith(reachWindow(state, group.id), group.id, (workspace) =>
    nodeHeld(workspace, group),
  );

/**
 * Focuses a window, raising it if it floats, and shows its workspace. `reach`
 * focuses it on its workspace: {@link picked} for a click, which also ends a
 * selection around it.
 *
 * Only `xdg-activation` can reach an off-screen window, and switching to its
 * workspace is what makes granting that request visible.
 */
const reachWindow = (
  state: WindowState,
  id: string,
  reach: typeof reached = reached,
): WindowState => {
  const workspace = workspaceHolding(state, id);
  if (workspace === undefined) {
    return state;
  } else {
    const found = reach(workspace, id);
    const shown = showWorkspace(state, workspace.name);
    if (found === workspace && shown === state) {
      // Return the same object when nothing changed. `AppWindow` relies on
      // this to avoid re-rendering the desktop on every click in the focused
      // window. Floats never hit this branch, since reaching one raises it.
      return state;
    } else {
      return onWorkspace(shown, workspace.name, () => found);
    }
  }
};

/**
 * Shows workspace `name` and focuses its screen.
 *
 * As in sway, a workspace already on screen is reached by moving the keyboard
 * there, so no two screens show it. A hidden one opens on its home screen
 * (see {@link WindowState.homes}), or the focused screen if it has none.
 */
const showWorkspace = (state: WindowState, name: string): WindowState => {
  const shown = screenShowing(state, name);
  const home = state.homes[name] ?? state.focused;
  if (shown === state.focused) {
    // Same object, which `reachWindow` passes on for `AppWindow`.
    return state;
  } else if (shown === undefined) {
    return {
      ...state,
      focused: home,
      previous: currentHere(state),
      screens: state.screens.map((screen) =>
        screen.name === home ? { ...screen, current: name } : screen,
      ),
    };
  } else {
    return { ...state, focused: shown };
  }
};

// Focus follows the pointer, and hovering a float raises it like a click.
// Done here because the compositor does not know about browser windows.
const pointAtWindow = (state: WindowState, id: string): WindowState => {
  // Focus moves to the window's own screen. A window on a hidden workspace
  // cannot be under the pointer, so it is ignored.
  const workspace = workspaceHolding(state, id);
  const screen =
    workspace === undefined ? undefined : screenShowing(state, workspace.name);
  if (workspace === undefined || screen === undefined) {
    return state;
  } else {
    return pointAtShown(state, workspace, screen, pointedOn(workspace, id));
  }
};

/** The open tab of the strip holding tab `id`. */
const openTabBeside = (state: WindowState, id: string): string => {
  const workspace = workspaceHolding(state, id);
  if (workspace === undefined) {
    throw new Error(`window state: no window ${id} for a new tab beside`);
  } else {
    return pointedOn(workspace, id);
  }
};

// Focuses `id`, shown on `screen`, when the pointer enters it.
const pointAtShown = (
  state: WindowState,
  workspace: Workspace,
  screen: string,
  id: string,
): WindowState =>
  // Same object when already focused: each element in a window (such as a
  // browser's address bar and page) reports the hover again.
  focusedOn(workspace) === id && state.focused === screen
    ? state
    : onWorkspace({ ...state, focused: screen }, workspace.name, (found) =>
        reached(found, id),
      );

// Focuses the screen under the pointer. Same object when it is already
// focused (this fires on every move) or not yet described by the host.
const pointAtScreen = (state: WindowState, name: string): WindowState =>
  state.focused === name ||
  !state.screens.some((screen) => screen.name === name)
    ? state
    : { ...state, focused: name };

// Updates a client's window record. Unknown clients are a no-op, since the
// host may drain events for a torn-down portal.
const reshapeApp = (
  state: WindowState,
  appId: string,
  into: (window: ClientWindow) => ClientWindow,
): WindowState =>
  windowsChanged(state, (window) =>
    window.kind === WindowKind.App && window.appId === appId
      ? into(window)
      : window,
  );

const renameWindow = (
  state: WindowState,
  id: string,
  title: string,
): WindowState =>
  windowsChanged(state, (window) =>
    window.id === id ? { ...window, title } : window,
  );

/** Sets browser window `id`'s icon. */
const markBrowser = (
  state: WindowState,
  id: string,
  icon: string | undefined,
): WindowState =>
  windowsChanged(state, (window) =>
    window.id === id && window.kind === WindowKind.Browser
      ? { ...window, icon }
      : window,
  );

/** Sets browser window `id`'s description. */
const describeBrowser = (
  state: WindowState,
  id: string,
  description: string | undefined,
): WindowState =>
  windowsChanged(state, (window) =>
    window.id === id && window.kind === WindowKind.Browser
      ? { ...window, description }
      : window,
  );

/**
 * Applies `into` to every window record. Keeps each record whose fields
 * `into` left alone, and the state when it left them all, so only the
 * windows that changed redraw.
 */
const windowsChanged = (
  state: WindowState,
  into: (window: ShellWindow) => ShellWindow,
): WindowState => {
  const windows = state.windows.map((window) => {
    const next = into(window);
    return sameFields(window, next) ? window : next;
  });
  return windows.every((window, at) => window === state.windows[at])
    ? state
    : { ...state, windows };
};

/** Whether two records hold the same value in every field. */
const sameFields = <Fields extends object>(
  one: Fields,
  other: Fields,
): boolean =>
  Object.keys(one).length === Object.keys(other).length &&
  (Object.keys(other) as (keyof Fields)[]).every(
    (key) => one[key] === other[key],
  );

/**
 * Applies the host's screen list, one screen per display, in order.
 *
 * Runs on every hotplug, so workspaces must stay put. An existing screen
 * keeps its workspace. A new display takes over a removed screen's workspace
 * (a different dock renames every monitor), else the lowest unused one. No
 * two screens show one workspace.
 *
 * With no displays, keeps one {@link UNDESCRIBED_SCREEN} so open windows
 * still have a workspace.
 */
const describeScreens = (
  state: WindowState,
  described: readonly PlacedScreen[],
): WindowState => {
  const kept =
    described.length === 0
      ? [{ box: NOWHERE, name: UNDESCRIBED_SCREEN }]
      : described;
  const names = kept.map(({ name }) => name);
  // Workspaces of removed screens, in order, for new displays to inherit.
  const replaced = state.screens
    .filter((screen) => !names.includes(screen.name))
    .map(({ current }) => current);
  const screens = kept.reduce<readonly DeskScreen[]>(
    (placed, { box, name }) => [
      ...placed,
      { box, current: showing(state, placed, replaced, name), name },
    ],
    [],
  );
  return {
    ...state,
    focused: focusedAmong(screens, state.focused),
    screens,
  };
};

/** The workspace a screen shows after the desk is re-described. */
const showing = (
  state: WindowState,
  placed: readonly DeskScreen[],
  replaced: readonly string[],
  name: string,
): string => {
  const before = state.screens.find((screen) => screen.name === name);
  const taken = placed.map(({ current }) => current);
  const inherited = replaced.find((workspace) => !taken.includes(workspace));
  const free = WORKSPACES.find(
    (workspace) =>
      !taken.includes(workspace) &&
      !state.screens.some((screen) => screen.current === workspace),
  );
  if (before !== undefined) {
    return before.current;
  } else if (inherited !== undefined) {
    return inherited;
  } else if (free === undefined) {
    // More than ten monitors. Showing a workspace twice is not allowed.
    throw new Error(`shell: no workspace left for screen ${name}`);
  } else {
    return free;
  }
};

/** The focused screen among `screens`: `focused` if present, else the first. */
const focusedAmong = (
  screens: readonly DeskScreen[],
  focused: string,
): string => {
  const first = screens[0];
  if (first === undefined) {
    throw new Error("shell: a desk is never no screens at all");
  } else {
    return screens.some(({ name }) => name === focused) ? focused : first.name;
  }
};

// `workspace <name>`. With `workspaceAutoBackAndForth`, naming the current
// workspace goes back to the previous one.
const selectWorkspace = (state: WindowState, name: string): WindowState => {
  if (name !== currentHere(state)) {
    return showWorkspace(state, name);
  } else if (state.previous === undefined) {
    return state;
  } else {
    return showWorkspace(state, state.previous);
  }
};

/**
 * Shows the focused screen's next or previous workspace as its bar lists
 * them, wrapping around like sway's `next_on_output`.
 */
const stepWorkspace = (
  state: WindowState,
  way: "next" | "prev",
): WindowState => {
  const listed = workspacesOn(state, state.focused);
  const at = listed.indexOf(currentHere(state));
  const to =
    at === -1
      ? undefined
      : listed[
          (at + (way === "next" ? 1 : -1) + listed.length) % listed.length
        ];
  return to === undefined || to === currentHere(state)
    ? state
    : showWorkspace(state, to);
};

/**
 * Moves a dragged float to `x`, `y` in desk pixels, and onto the screen its
 * center is now over, like sway's `floating_fix_coordinates`.
 *
 * Float coordinates are relative to their screen's box. A center over no
 * screen keeps the current one. A float on a hidden workspace (switched away
 * mid-drag) does not move.
 */
const floatDragged = (
  state: WindowState,
  id: string,
  x: number,
  y: number,
): WindowState => {
  const workspace = workspaceHolding(state, id);
  const home =
    workspace === undefined ? undefined : screenShowing(state, workspace.name);
  if (workspace === undefined || home === undefined) {
    return state;
  } else {
    const here = boxOf(state, home);
    const moved = movedTo(floatHeld(workspace, id), x - here.x, y - here.y);
    const onto = screenAt(state, middleOf(moved, here)) ?? home;
    if (onto === home) {
      return onWorkspace(state, workspace.name, (found) =>
        floatMoved(found, id, moved.x, moved.y),
      );
    } else {
      const there = boxOf(state, onto);
      const arrived = movedTo(moved, x - there.x, y - there.y);
      // Focus follows, since the pointer is already on that screen.
      return onWorkspace(
        onWorkspace({ ...state, focused: onto }, workspace.name, (found) =>
          floatLifted(found, id),
        ),
        currentOn(state, onto),
        (found) => floatLanded(found, arrived),
      );
    }
  }
};

/**
 * A window or group, tiled or floating, dropped on `target`, on its own
 * workspace or another screen's. Focus goes with it. No-op if either closed
 * during the drag.
 */
const dropNode = (
  state: WindowState,
  moving: NodeRef,
  target: NodeRef,
  edge: Direction | undefined,
  beside: Beside,
): WindowState => {
  const from = workspaceHolding(state, moving.id);
  const to = workspaceHolding(state, target.id);
  const screen = to === undefined ? undefined : screenShowing(state, to.name);
  if (from === undefined || to === undefined || screen === undefined) {
    return state;
  } else if (from.name === to.name) {
    return onWorkspace(state, from.name, (workspace) =>
      nodeDropped(workspace, moving, target, edge, beside),
    );
  } else {
    const { node, rest, selected } = nodeLifted(from, moving);
    const left = onWorkspace(state, from.name, () => rest);
    return onWorkspace({ ...left, focused: screen }, to.name, (workspace) =>
      nodeArrived(workspace, node, selected, target, edge, beside),
    );
  }
};

/**
 * Window `id` moved to the screen its client asked to fullscreen on, where it
 * stays after fullscreen ends. No-op without a request, or for a screen the
 * desk no longer has.
 */
const onRequestedScreen = (
  state: WindowState,
  id: string,
  display: string | undefined,
): WindowState => {
  if (
    display === undefined ||
    !state.screens.some((screen) => screen.name === display) ||
    workspaceHolding(state, id)?.name === currentOn(state, display)
  ) {
    return state;
  } else {
    return dropOnScreen(state, { id, up: 0 }, display);
  }
};

/**
 * A window or group, tiled or floating, dropped on a screen with nothing tiled
 * on it. Focus goes with it. No-op if it closed during the drag.
 */
const dropOnScreen = (
  state: WindowState,
  moving: NodeRef,
  screen: string,
): WindowState => {
  const from = workspaceHolding(state, moving.id);
  if (from === undefined) {
    return state;
  } else {
    const { node, rest } = nodeLifted(from, moving);
    return onWorkspace(
      onWorkspace({ ...state, focused: screen }, from.name, () => rest),
      currentOn(state, screen),
      (workspace) => nodeTiledIn(workspace, node),
    );
  }
};

/** The box of screen `name` on the desk. */
const boxOf = (state: WindowState, name: string): Rect => {
  const screen = state.screens.find((found) => found.name === name);
  if (screen === undefined) {
    throw new Error(`shell: no screen ${name}`);
  } else {
    return screen.box;
  }
};

/** The float holding `id`. Throws for a tiled window. */
const floatHeld = (workspace: Workspace, id: string): Float => {
  const float = floatOn(workspace, id);
  if (float === undefined) {
    throw new Error(`shell: window ${id} is not floating`);
  } else {
    return float;
  }
};

/** The center of a float on the screen at `box`, in desk pixels. */
const middleOf = (float: Float, box: Rect): readonly [number, number] => [
  box.x + float.x + float.width / 2,
  box.y + float.y + float.height / 2,
];

/**
 * The screen at `point`, or `undefined`. Edges are half-open like
 * `screenUnder`, so a shared edge belongs to the screen that starts there.
 */
const screenAt = (
  state: WindowState,
  [x, y]: readonly [number, number],
): string | undefined =>
  state.screens.find(
    ({ box }) =>
      x >= box.x &&
      x < box.x + box.width &&
      y >= box.y &&
      y < box.y + box.height,
  )?.name;

// `move container to workspace <name>`: the window, or the container `focus
// parent` selected, moves and focus stays, as in sway. It always arrives tiled.
const sendToWorkspace = (state: WindowState, name: string): WindowState => {
  const leaving =
    name === currentHere(state) ? undefined : sentOff(workspaceHere(state));
  if (leaving === undefined) {
    return state;
  } else {
    return onWorkspace(
      onCurrent(state, () => leaving.rest),
      name,
      (workspace) => nodeTiledIn(workspace, leaving.node),
    );
  }
};

/**
 * Moves window `id` to workspace `name`, tiled, from wherever it is, as
 * `move container to workspace` would after focusing it. Unlike that command,
 * no screen changes what it shows.
 */
const moveToWorkspace = (
  state: WindowState,
  id: string,
  name: string,
): WindowState => {
  const from = workspaceHolding(state, id);
  const leaving =
    from === undefined || from.name === name
      ? undefined
      : sentOff(picked(from, id));
  if (from === undefined || leaving === undefined) {
    return state;
  } else {
    return onWorkspace(
      onWorkspace(state, from.name, () => leaving.rest),
      name,
      (workspace) => nodeTiledIn(workspace, leaving.node),
    );
  }
};

// `move scratchpad`: removes the focused window from its workspace without
// closing it.
const hideInScratchpad = (state: WindowState): WindowState => {
  const id = activeIdOf(state);
  if (id === undefined) {
    return state;
  } else {
    return onCurrent(
      { ...state, scratchpad: [...state.scratchpad, id] },
      (workspace) => closed(workspace, id),
    );
  }
};

/**
 * `scratchpad show`: hides the focused scratchpad float to the back of the
 * scratchpad, or else shows the front one as a float, so presses rotate through
 * the windows as in sway.
 */
const showScratchpad = (state: WindowState): WindowState => {
  const workspace = workspaceHere(state);
  const id = focusedOn(workspace);
  const up = id === undefined ? undefined : floatOn(workspace, id);
  const [hidden, ...rest] = state.scratchpad;
  if (up?.scratchpad === true && id !== undefined) {
    return restowed(state, id);
  } else if (hidden === undefined) {
    return state;
  } else {
    return onCurrent({ ...state, scratchpad: rest }, (found) =>
      shown(found, hidden, screenHere(state)),
    );
  }
};

/**
 * The scratchpad window shown on the workspace on screen: the focused one, or
 * else the frontmost, or `undefined` while none is out.
 */
const scratchpadShownHere = (state: WindowState): string | undefined => {
  const workspace = workspaceHere(state);
  const focused = focusedOn(workspace);
  if (
    focused !== undefined &&
    floatOn(workspace, focused)?.scratchpad === true
  ) {
    return focused;
  } else {
    const front = workspace.floats.findLast((float) => float.scratchpad);
    return front === undefined ? undefined : windowsIn(front.root)[0];
  }
};

// Hides the shown scratchpad window `id` at the back of the scratchpad.
const restowed = (state: WindowState, id: string): WindowState =>
  onWorkspaceWith(
    { ...state, scratchpad: [...state.scratchpad, id] },
    id,
    (found) => closed(found, id),
  );

/**
 * Updates {@link WindowState.homes} after a reduction. Returns the same object
 * when nothing changed, which no-op reductions rely on.
 */
const rehomed = (state: WindowState): WindowState => {
  const homes = Object.fromEntries(
    state.workspaces.flatMap((workspace) => {
      const home = homeOf(state, workspace);
      return home === undefined ? [] : [[workspace.name, home]];
    }),
  );
  return WORKSPACES.every((name) => homes[name] === state.homes[name])
    ? state
    : { ...state, homes };
};

/** The screen `workspace` now belongs to, or `undefined` for none. */
const homeOf = (
  state: WindowState,
  workspace: Workspace,
): string | undefined => {
  const shown = screenShowing(state, workspace.name);
  const before = state.homes[workspace.name];
  if (shown !== undefined) {
    return shown;
  } else if (windowsOn(workspace).length === 0) {
    return undefined;
  } else if (
    before !== undefined &&
    state.screens.some(({ name }) => name === before)
  ) {
    return before;
  } else {
    return state.focused;
  }
};

/**
 * Clamps each float holding one window to its client's size limits (see
 * `limitedTo`).
 *
 * Runs after every action because a client can report limits after it
 * floats. Floating groups are skipped, since no one client's limits apply to
 * the shared box.
 */
const limited = (before: WindowState, after: WindowState): WindowState => {
  const workspaces = after.workspaces.map((workspace) =>
    limitedFloats(before, after, workspace),
  );
  return workspaces.every(
    (workspace, index) => workspace === after.workspaces[index],
  )
    ? after
    : { ...after, workspaces };
};

const limitedFloats = (
  before: WindowState,
  after: WindowState,
  workspace: Workspace,
): Workspace => {
  const floats = workspace.floats.map((float) => {
    const [only, ...others] = windowsIn(float.root);
    const window =
      others.length === 0
        ? after.windows.find(({ id }) => id === only)
        : undefined;
    return window?.kind === WindowKind.App
      ? limitedTo(
          float,
          floatBefore(before, window.id),
          window.minSize,
          window.maxSize,
        )
      : float;
  });
  return floats.every((float, index) => float === workspace.floats[index])
    ? workspace
    : { ...workspace, floats };
};

/** The float holding `id` before the action, if any. */
const floatBefore = (state: WindowState, id: string) =>
  state.workspaces
    .flatMap(({ floats }) => floats)
    .find((float) => floatHolds(float, id));
