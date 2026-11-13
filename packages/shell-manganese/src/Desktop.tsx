import { useDisplays } from "@domicile-desktop/component-library/DisplayProvider";
import { applyFont } from "@domicile-desktop/component-library/font";
import { createHandle } from "@domicile-desktop/component-library/Popover";
import { PortalDialogs } from "@domicile-desktop/component-library/PortalDialogs";
import { useTheme } from "@domicile-desktop/component-library/ThemeProvider";
import { createToastManager } from "@domicile-desktop/component-library/Toaster";
import { usePictureUrl } from "@domicile-desktop/component-library/usePictureUrl";
import { usePortalWallpaper } from "@domicile-desktop/component-library/usePortalWallpaper";
import type { BarLayout } from "@domicile-desktop/manganese-bar/bar-layout";
import type { HoldKeyboard } from "@domicile-desktop/manganese-bar/panel-keyboard";
import { PanelKeyboardContext } from "@domicile-desktop/manganese-bar/panel-keyboard";
import { deskNightLight } from "@domicile-desktop/manganese-bar-module-brightness/desk-night-light";
import { useBrightnessKeys } from "@domicile-desktop/manganese-bar-module-brightness/useBrightnessKeys";
import { useNightLight } from "@domicile-desktop/manganese-bar-module-brightness/useNightLight";
import type { ClockOptions } from "@domicile-desktop/manganese-bar-module-clock/clock-options";
import { ClockOptionsContext } from "@domicile-desktop/manganese-bar-module-clock/clock-options";
import { deskIdleInhibitor } from "@domicile-desktop/manganese-bar-module-idle-inhibitor/desk-idle-inhibitor";
import { deskKeymaps } from "@domicile-desktop/manganese-bar-module-keymap/desk-keymaps";
import type { KeymapOptions } from "@domicile-desktop/manganese-bar-module-keymap/keymap-options";
import { KeymapOptionsContext } from "@domicile-desktop/manganese-bar-module-keymap/keymap-options";
import { PortalSignIn } from "@domicile-desktop/manganese-bar-module-network/PortalSignIn";
import { useCaptivePortal } from "@domicile-desktop/manganese-bar-module-network/useCaptivePortal";
import { useExtensions } from "@domicile-desktop/manganese-bar-module-tray/extensions/useExtensions";
import { useOpenedPopup } from "@domicile-desktop/manganese-bar-module-tray/extensions/useOpenedPopup";
import type { TrayState } from "@domicile-desktop/manganese-bar-module-tray/tray-context";
import { TrayContext } from "@domicile-desktop/manganese-bar-module-tray/tray-context";
import { trayEntries } from "@domicile-desktop/manganese-bar-module-tray/tray-entry";
import { useTray } from "@domicile-desktop/manganese-bar-module-tray/useTray";
import { useTrayOrder } from "@domicile-desktop/manganese-bar-module-tray/useTrayOrder";
import { useVolumeKeys } from "@domicile-desktop/manganese-bar-module-volume/useVolumeKeys";
import { Clipboard } from "@domicile-desktop/manganese-clipboard/Clipboard";
import { useClipboard } from "@domicile-desktop/manganese-clipboard/useClipboard";
import { sharedIconTheme } from "@domicile-desktop/manganese-host/followed-icon-theme";
import { useShellOptions } from "@domicile-desktop/manganese-host/useShellOptions";
import { appSearch } from "@domicile-desktop/manganese-launcher/app-search";
import type { ApplicationsConfig } from "@domicile-desktop/manganese-launcher/applications-config";
import { Launcher } from "@domicile-desktop/manganese-launcher/Launcher";
import type { Launch } from "@domicile-desktop/manganese-launcher/launch";
import { LaunchKind } from "@domicile-desktop/manganese-launcher/launch";
import type { LauncherControl } from "@domicile-desktop/manganese-launcher/launcher-context";
import { LauncherContext } from "@domicile-desktop/manganese-launcher/launcher-context";
import { OpenWith } from "@domicile-desktop/manganese-launcher/OpenWith";
import { useOpeningApps } from "@domicile-desktop/manganese-launcher/useOpeningApps";
import { Lock } from "@domicile-desktop/manganese-lock/Lock";
import { LockBar } from "@domicile-desktop/manganese-lock/LockBar";
import { useLocked } from "@domicile-desktop/manganese-lock/useLocked";
import type { Inbox } from "@domicile-desktop/manganese-notifications/inbox";
import { NotificationDrawer } from "@domicile-desktop/manganese-notifications/NotificationDrawer";
import { NotificationToasts } from "@domicile-desktop/manganese-notifications/NotificationToasts";
import type { NotificationsDrawer } from "@domicile-desktop/manganese-notifications/notifications-context";
import { NotificationsContext } from "@domicile-desktop/manganese-notifications/notifications-context";
import { useNotifications } from "@domicile-desktop/manganese-notifications/useNotifications";
import { useNow } from "@domicile-desktop/manganese-notifications/useNow";
import { useWallpapers } from "@domicile-desktop/manganese-wallpaper/useWallpapers";
import { Wallpaper } from "@domicile-desktop/manganese-wallpaper/Wallpaper";
import type { Wallpapers } from "@domicile-desktop/manganese-wallpaper/wallpapers";
import { desktopClientIcons } from "@domicile-desktop/manganese-window-management/client-icons";
import type { Direction } from "@domicile-desktop/manganese-window-management/direction";
import type { FloatingRules } from "@domicile-desktop/manganese-window-management/floating/floating-rules";
import { useKeybindings } from "@domicile-desktop/manganese-window-management/keyboard/useKeybindings";
import { useModifiers } from "@domicile-desktop/manganese-window-management/keyboard/useModifiers";
import { OverviewBackdrop } from "@domicile-desktop/manganese-window-management/overview/OverviewBackdrop";
import { OverviewPicker } from "@domicile-desktop/manganese-window-management/overview/OverviewPicker";
import { screenOverviewsOf } from "@domicile-desktop/manganese-window-management/overview/overview";
import { sightOf } from "@domicile-desktop/manganese-window-management/overview/sight";
import { steeredInOverview } from "@domicile-desktop/manganese-window-management/overview/steering";
import { useOverviewPhase } from "@domicile-desktop/manganese-window-management/overview/useOverviewPhase";
import { PictureInPictureFloats } from "@domicile-desktop/manganese-window-management/picture-in-picture/PictureInPictureFloats";
import type { Geometry } from "@domicile-desktop/manganese-window-management/placement";
import type {
  Focus,
  Spot,
} from "@domicile-desktop/manganese-window-management/pointer-warp";
import type { Rect } from "@domicile-desktop/manganese-window-management/rect";
import { Stage } from "@domicile-desktop/manganese-window-management/Stage";
import { shownWindowsOf } from "@domicile-desktop/manganese-window-management/screens/shown-windows";
import type { StageScreen } from "@domicile-desktop/manganese-window-management/screens/stage-screens";
import { useScreenFollowsPointer } from "@domicile-desktop/manganese-window-management/screens/useScreenFollowsPointer";
import { useShared } from "@domicile-desktop/manganese-window-management/screens/useShared";
import { useStageScreens } from "@domicile-desktop/manganese-window-management/screens/useStageScreens";
import type { Aim } from "@domicile-desktop/manganese-window-management/tiled/aim";
import { AimKind } from "@domicile-desktop/manganese-window-management/tiled/aim";
import type { NodeRef } from "@domicile-desktop/manganese-window-management/tree/path";
import { useClientIcons } from "@domicile-desktop/manganese-window-management/useClientIcons";
import { usePointerLock } from "@domicile-desktop/manganese-window-management/usePointerLock";
import { usePointerWarp } from "@domicile-desktop/manganese-window-management/usePointerWarp";
import { useWindows } from "@domicile-desktop/manganese-window-management/useWindows";
import {
  browserWindowId,
  WindowKind,
} from "@domicile-desktop/manganese-window-management/window";
import {
  activeIsPrivate,
  closedBrowsersOf,
  screenHolding,
  screenOfApp,
  shutIdsOf,
  WindowAction,
  WindowActionKind,
} from "@domicile-desktop/manganese-window-management/window-state";
import type { Workspaces } from "@domicile-desktop/manganese-window-management/workspaces-context";
import { WorkspacesContext } from "@domicile-desktop/manganese-window-management/workspaces-context";
import { useDomicile } from "@domicile-desktop/react/domicile-provider";
import { useSharedWatch } from "@domicile-desktop/react/use-shared-watch";
import { previewFile } from "@domicile-desktop/sdk/file-preview";
import { DEFAULT_NOTIFICATION_ACTION } from "@domicile-desktop/sdk/notification";
import type { ShellKeybindings } from "@domicile-desktop/sdk/own-keybindings";
import { ownedChords } from "@domicile-desktop/sdk/own-keybindings";
import { opens } from "@domicile-desktop/system-apps/opens";
import { deskSound } from "@domicile-desktop/system-audio/react";
import {
  deskBacklight,
  useAutoBrightness,
} from "@domicile-desktop/system-backlight/react";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useCastHolds } from "./cast-holds";
import { LOCK_BAR } from "./default-bars";
import {
  backgroundAppsOf,
  launcherAppsOf,
  useInboxDrawer,
} from "./inbox-drawer";
import { KeymapNotice } from "./KeymapNotice";
import type { LevelPress } from "./LevelNotice";
import { LevelNotice } from "./LevelNotice";
import { launcherGlancesOf } from "./launcher-glances";
import { pressMediaKey } from "./media-keys";
import { options } from "./options";
import { usePageDuplicates } from "./page-duplicates";
import { Monitor } from "./screens/Monitor";
import { NoScreens } from "./screens/NoScreens";
import { showsSharing } from "./shows-sharing";
import { deskVirtualMonitors } from "./virtual-monitors";

/** No photographs, while the config's folders are listed. */
const NO_WALLPAPERS: Wallpapers = { dark: [], light: [] };

/** A workspace with no screen, which never shows: see `shown` below. */
const NOWHERE: Rect = { height: 0, width: 0, x: 0, y: 0 };

type Props = {
  /** What the launcher offers beside files. */
  applications: ApplicationsConfig;
  /** The layout of every monitor's bar. */
  bar: BarLayout;
  /** Which client windows open floating, besides dialogs. */
  floating: FloatingRules;
  /** The inboxes listed in the notification drawer, if any. */
  inboxes: readonly Inbox[];
  /** The keys this desktop binds, merged under the config's. */
  keybindings: ShellKeybindings;
  /** Each theme's wallpaper photographs. */
  wallpapers: Wallpapers;
};

/**
 * The desktop: a bar on every monitor, the windows of each monitor's
 * workspace, and the panels over them.
 *
 * One page spans every monitor. It renders a {@link Monitor} per display and
 * one {@link Stage} that draws every window. Workspaces are shared across
 * monitors, as in sway. See `docs/architecture/ONE-PAGE-FOR-THE-DESK.md`.
 */
export const Desktop = ({
  applications,
  bar,
  floating,
  inboxes,
  keybindings,
  wallpapers,
}: Props) => {
  const domicile = useDomicile();
  const displays = useDisplays();
  // What the config sets under `shell_options`.
  const shellOptions = useShellOptions(domicile, options);
  // The wallpaper advances only this theme's rotation, and holds it while
  // the theme wipe plays.
  const { flipping, theme } = useTheme();
  // Inboxes in a window run in the background, and the launcher lists them.
  const backgroundApps = useMemo(() => backgroundAppsOf(inboxes), [inboxes]);
  const launcherApps = useMemo(() => launcherAppsOf(inboxes), [inboxes]);
  const windows = useWindows(domicile, displays, floating, backgroundApps);
  const { act } = windows;
  const clientIcons = useClientIcons(
    domicile,
    windows.windows.flatMap((window) =>
      window.kind === WindowKind.App ? [window.desktopId] : [],
    ),
    desktopClientIcons,
  );

  // Super returns the pointer to the page; Shift turns a drag into a resize.
  // Read from this page's key events and from the engine's report for browser
  // windows, whose keys this page never sees.
  const { modifiers, spendShift } = useModifiers(domicile);

  // The compositor indexes the home directory and returns matches; the page
  // has no filesystem. Memoized because a new function would restart the
  // search.
  const search = useCallback(
    (query: string) => domicile.files.search(query),
    [domicile],
  );
  // The pictures applications set through the Wallpaper portal. `desktop`
  // answers the same object for a host, so they are not read again.
  const { files } = domicile;
  const portalWallpaper = usePortalWallpaper(domicile);
  const backgroundPicture = usePictureUrl(files, portalWallpaper.background);
  const lockPicture = usePictureUrl(files, portalWallpaper.lockscreen);
  // The config's folders listed.
  const listedWallpapers = useWallpapers(files, wallpapers);
  // Installed apps, the inboxes and bookmarks, read through the desktop.
  // Memoized because it holds what was read and the bookmarks' icons.
  const apps = useMemo(
    () =>
      appSearch(
        domicile,
        applications,
        sharedIconTheme(domicile),
        undefined,
        launcherApps,
      ),
    [applications, domicile, launcherApps],
  );
  // Read while the launcher is closed so its rows render with it rather than
  // a moment later.
  const opening = useOpeningApps(apps.opening, windows.launcherOpen);
  // The file the launcher asked what to open with, while that is asked.
  const [openingWith, setOpeningWith] = useState<string | undefined>();
  // The launcher's pick, held until it has closed and the screen shows it
  // gone, so nothing it opens sees it. A screenshot app would shoot it.
  const [picked, setPicked] = useState<Launch | undefined>();
  // Whether an app opens a file, asked before the launcher opens one.
  const opensFile = useCallback(
    async (path: string) =>
      (await opens(domicile, path)).unwrapOrElse((error) => {
        throw new Error(`Cannot tell what opens ${path}`, { cause: error });
      }),
    [domicile],
  );
  // File previews, read through the desktop's files.
  const preview = useCallback(
    (path: string) => previewFile(domicile, path),
    [domicile],
  );

  // Clipboard history is pushed by the compositor, so it is ready before the
  // panel opens.
  const clipboard = useClipboard(domicile);

  // Subscribed once for the desk, not per bar: there is a bar per monitor.
  const extensions = useExtensions(domicile);

  // Tray icons, subscribed once for the desk.
  const tray = useTray(domicile);
  // Tray order is shared so a drag on one bar reorders every bar.
  const trayOrder = useTrayOrder(
    trayEntries(tray, extensions, []).map(({ key }) => key),
  );

  // Notifications, subscribed once for the desk. One toast manager for the
  // page's life, because the toaster subscribes to it once.
  const [toasts] = useState(createToastManager);
  // An inbox's notifications stay out of the bell, which counts its unread
  // conversations already.
  const inboxSenders = useMemo(
    () => inboxes.map(({ notifiesAs }) => notifiesAs),
    [inboxes],
  );
  // An inbox's window whose page notifies what the inbox notifies already
  // notifies nothing.
  const pageDuplicates = usePageDuplicates(domicile, inboxes);
  const notifications = useNotifications(
    domicile,
    toasts,
    inboxSenders,
    pageDuplicates,
  );
  const { dismiss: dismissNotifications, read } = notifications;
  // What `notifications clear` dismisses, as the drawer's "Clear all" does.
  const notificationIds = useMemo(
    () => notifications.items.map(({ id }) => id),
    [notifications.items],
  );
  const now = useNow();
  // The screen whose bell last opened the drawer. Kept after it closes, so the
  // drawer closes under that bell. Opening it marks everything read and closes
  // all toasts, which the drawer already shows. Every bar's bell opens it
  // through the handle.
  const [notificationsHandle] = useState(createHandle);
  const [notificationsOn, setNotificationsOn] = useState<string | undefined>(
    undefined,
  );
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const openNotifications = useCallback(
    (screen: string) => {
      setNotificationsOn(screen);
      setNotificationsOpen(true);
      read();
      toasts.close();
    },
    [read, toasts],
  );
  const closeNotifications = useCallback(() => {
    setNotificationsOpen(false);
  }, []);
  const inboxDrawer = useInboxDrawer({
    domicile,
    inboxes,
    onClose: closeNotifications,
  });
  // Pressing an inbox's notification brings up its window too.
  const { invoke: invokeNotification, items: notificationItems } =
    notifications;
  const { notificationPressed } = inboxDrawer;
  // The launcher previews each inbox it lists by its unread mail.
  const glances = useMemo(
    () => launcherGlancesOf(inboxes, inboxDrawer.drawer.readings, now),
    [inboxDrawer.drawer.readings, inboxes, now],
  );
  const pressNotification = useCallback(
    (id: number, action: string) => {
      invokeNotification(id, action);
      // Not found if it cleared since it was drawn.
      const pressed = notificationItems.find((item) => item.id === id);
      if (action === DEFAULT_NOTIFICATION_ACTION && pressed !== undefined) {
        notificationPressed(pressed.appName);
      }
    },
    [invokeNotification, notificationItems, notificationPressed],
  );

  // Lock state belongs to the compositor, which is what blocks input. The page
  // cannot set it, and reloading the page does not unlock the desk.
  const lock = useLocked(domicile);

  // While a TV is cast to, idle blanking is held off and banners are held, so
  // a notification does not show on the TV.
  const casting = useCastHolds(domicile);

  const screens = useStageScreens(windows, displays);

  // Each screen's workspaces at once, while open and while it closes.
  const { closed: overviewClosed, phase: overviewPhase } = useOverviewPhase(
    windows.overviewOpen,
  );
  const overviews = useMemo(
    () =>
      overviewPhase === undefined
        ? undefined
        : screenOverviewsOf(windows, screens, overviewPhase === "closing"),
    [overviewPhase, screens, windows],
  );
  const sight = useMemo(
    () => (overviews === undefined ? undefined : sightOf(overviews)),
    [overviews],
  );
  // With no screen there is no backdrop to end the closing fade.
  useEffect(() => {
    if (overviewPhase === "closing" && overviews?.length === 0) {
      overviewClosed();
    }
  }, [overviewClosed, overviewPhase, overviews]);

  // The pointer follows the keyboard. Focus follows the pointer, so otherwise
  // the next pointer event would undo a keyboard focus change. See
  // `pointer-warp.ts`.
  const focus = useMemo(
    () => focusOf(screens, windows.focused, windows.activeId),
    [screens, windows.activeId, windows.focused],
  );
  const open = useMemo(
    () => windows.windows.map(({ id }) => id),
    [windows.windows],
  );
  // Bars count: a window is under the pointer from its title bar down.
  const shown = useMemo(
    () =>
      screens.flatMap(({ screenful }) =>
        screenful.placements.map(({ frame, id }) => ({ box: frame, id })),
      ),
    [screens],
  );
  const { pointing } = usePointerWarp({
    domicile,
    focus,
    pressed: windows.pressed,
    shown,
    windows: open,
  });

  // The open extension popup and the bar it belongs to.
  const {
    clicked: clickedExtension,
    open: openExtension,
    opened,
  } = useOpenedPopup(domicile, extensions, windows.focused);

  const volumeKeys = useVolumeKeys(deskSound(domicile));
  const brightnessKeys = useBrightnessKeys(deskBacklight(domicile));
  useAutoBrightness(domicile, shellOptions.brightness.automatic);
  useNightLight(domicile, shellOptions.nightLight);
  usePointerLock(domicile.windows);
  // Before the paint, so text never shows in the old face.
  useLayoutEffect(() => {
    applyFont(shellOptions.font);
  }, [shellOptions.font]);
  // How many bar items' panels, and applications' dialogs, hold the keyboard;
  // see `useKeepsKeyboard`.
  const [heldPanels, setHeldPanels] = useState(0);
  const holdKeyboard = useCallback(() => {
    setHeldPanels((held) => held + 1);
    return () => {
      setHeldPanels((held) => held - 1);
    };
  }, []);

  // The level the last media key set, counted so each press keeps it up.
  const [levelPress, setLevelPress] = useState<LevelPress | undefined>();
  // How many `keymap` commands switched the keymap, so each keeps its notice
  // up. The notice names the keymap the desktop reports.
  const [keymapSwitches, setKeymapSwitches] = useState(0);
  const keymaps = useSharedWatch(deskKeymaps(domicile));
  // Once for the desk, so a portal's sign-in page opens once, not per bar.
  const portal = useCaptivePortal(domicile);

  // Shift is spent whether or not a window was floated: the user pressed it
  // for the chord, so it should not carry over to the next window. Both the
  // page's keydown and the compositor's forwarded chords come through here.
  // A media key or a keymap changes no window, so neither spends Shift nor
  // moves the pointer.
  const onAction = useCallback(
    (action: WindowAction) => {
      switch (action.kind) {
        case WindowActionKind.KeymapSelected: {
          domicile.keyboard
            .selectKeymap(action.choice)
            .then((result) => {
              result.match({
                Err: logKeymapFailure,
                Ok: () => {
                  setKeymapSwitches((switches) => switches + 1);
                },
              });
            })
            .catch(logKeymapFailure);
          break;
        }
        case WindowActionKind.MediaKeyPressed: {
          const level = pressMediaKey(
            { brightness: brightnessKeys, volume: volumeKeys },
            action.key,
          );
          if (level !== undefined) {
            setLevelPress((last) => ({
              count: (last?.count ?? 0) + 1,
              level,
            }));
          }
          break;
        }
        // Like a media key, these change no window.
        case WindowActionKind.NotificationsToggled: {
          if (notificationsOpen) {
            closeNotifications();
          } else {
            openNotifications(windows.focused);
          }
          break;
        }
        case WindowActionKind.NotificationsCleared: {
          dismissNotifications(notificationIds);
          break;
        }
        case WindowActionKind.IdleInhibitorToggled: {
          deskIdleInhibitor(domicile).toggle();
          break;
        }
        case WindowActionKind.NightLightToggled: {
          deskNightLight(domicile).toggle();
          break;
        }
        case WindowActionKind.ShortcutsInhibitorSwitched: {
          domicile.keyboard
            .switchShortcutsInhibitor(action.action)
            .then((result) => {
              result.match({ Err: logInhibitorFailure, Ok: () => undefined });
            })
            .catch(logInhibitorFailure);
          break;
        }
        case WindowActionKind.VirtualMonitorAdded: {
          deskVirtualMonitors(domicile)
            .add(action.size)
            .then((result) => {
              result.match({
                Err: logVirtualMonitorFailure,
                Ok: () => undefined,
              });
            })
            .catch(logVirtualMonitorFailure);
          break;
        }
        case WindowActionKind.VirtualMonitorRemoved: {
          deskVirtualMonitors(domicile)
            .remove()
            .match({ Err: logVirtualMonitorFailure, Ok: () => undefined });
          break;
        }
        default: {
          spendShift();
          // In the overview, `focus` and `move` step its workspaces.
          act(
            windows.overviewOpen && overviews !== undefined
              ? steeredInOverview(
                  action,
                  overviews,
                  windows.overviewAim,
                  windows.focused,
                )
              : action,
          );
          // Moves the pointer with the keyboard; see `usePointerWarp`.
          // Dispatched in the same turn so both land in one render.
          act(WindowAction.KeyPressed());
        }
      }
    },
    [
      act,
      brightnessKeys,
      dismissNotifications,
      domicile,
      closeNotifications,
      notificationIds,
      notificationsOpen,
      openNotifications,
      overviews,
      spendShift,
      volumeKeys,
      windows.focused,
      windows.overviewAim,
      windows.overviewOpen,
    ],
  );

  // Memoized so the stage redraws only when what it shows changes.
  const stageActions = useMemo(
    () => stageActionsOf(act, pointing),
    [act, pointing],
  );

  // The panels' callbacks and the lock screen's bar, memoized so a panel
  // redraws only when what it shows changes.
  const launcherClosed = useCallback(() => {
    if (picked !== undefined) {
      setPicked(undefined);
      afterAFramePainted(() => {
        launch(picked, act, setOpeningWith);
      });
    }
  }, [act, picked]);
  const launcherDismissed = useCallback(() => {
    act(WindowAction.LauncherDismissed());
  }, [act]);
  const launched = useCallback(
    (pick: Launch) => {
      setPicked(pick);
      act(WindowAction.LauncherDismissed());
    },
    [act],
  );
  const overviewAimed = useCallback(
    (workspace: string) => {
      act(WindowAction.OverviewAimed(workspace));
    },
    [act],
  );
  const overviewDismissed = useCallback(() => {
    act(WindowAction.OverviewDismissed());
  }, [act]);
  const overviewPicked = useCallback(
    (workspace: string) => {
      act(WindowAction.OverviewPicked(workspace));
    },
    [act],
  );
  const overviewWindowPicked = useCallback(
    (id: string) => {
      act(WindowAction.OverviewWindowPicked(id));
    },
    [act],
  );
  const windowMovedTo = useCallback(
    (id: string, workspace: string) => {
      act(WindowAction.WindowMovedToWorkspace(id, workspace));
    },
    [act],
  );
  const copied = useCallback(
    (entry: number) => {
      domicile.clipboard.copy(entry);
    },
    [domicile],
  );
  const clipboardDismissed = useCallback(() => {
    act(WindowAction.ClipboardDismissed());
  }, [act]);
  const { screens: deskScreens, workspaces } = windows;
  const screenOf = useCallback(
    (appId: string) => screenOfApp({ screens: deskScreens, workspaces }, appId),
    [deskScreens, workspaces],
  );
  // A video in picture-in-picture opens on its window's screen, or on the
  // focused one while its window is on none.
  const pictureInPictureWorkspace = useCallback(
    (window: string): Rect => {
      const name =
        screenHolding(windows, browserWindowId(window)) ?? windows.focused;
      const screen =
        screens.find(({ geometry }) => geometry.name === name) ?? screens[0];
      return screen?.geometry.workspace ?? NOWHERE;
    },
    [screens, windows],
  );
  // Frames with their bars; the page's own boxes leave those out and still
  // count a hidden tab.
  const shownWindows = useCallback(() => shownWindowsOf(screens), [screens]);
  // Closed inboxes' windows, which keep running, are no one's to pick.
  const closedBrowsers = useMemo(() => closedBrowsersOf(windows), [windows]);
  // Shared, so the stage sees a change only when one is shown or hidden.
  const shutIds = useMemo(() => shutIdsOf(windows), [windows]);
  const shut = useShared(shutIds);
  // What the bars' items read. Each is its own context, so an item redraws
  // only when what it reads changes.
  const launcherControl = useMemo(
    () => ({
      toggle: () => {
        act(WindowAction.LauncherToggled());
      },
    }),
    [act],
  );
  const drawer = useMemo(
    () => ({
      handle: notificationsHandle,
      paused: notifications.pause !== undefined,
      unread: notifications.unread + inboxDrawer.unread,
    }),
    [
      inboxDrawer.unread,
      notifications.pause,
      notifications.unread,
      notificationsHandle,
    ],
  );
  const trayState = useMemo(
    () => ({
      clicked: clickedExtension,
      extensions,
      items: tray,
      open: openExtension,
      opened,
      order: trayOrder,
    }),
    [clickedExtension, extensions, opened, openExtension, tray, trayOrder],
  );
  // Kept while each screen shows the same workspace, though `screens` changes
  // with every window.
  const current = useShared(
    Object.fromEntries(
      screens.map((shown) => [shown.geometry.name, shown.current]),
    ),
  );
  const shownWorkspaces = useMemo(
    () => ({
      current,
      focused: windows.focused,
      homes: windows.homes,
      mode: windows.mode,
      overviewOpen: windows.overviewOpen,
      select: (workspace: string) => {
        act(WindowAction.WorkspaceSelected(workspace));
      },
      toggleOverview: () => {
        act(WindowAction.OverviewToggled());
      },
    }),
    [
      act,
      current,
      windows.focused,
      windows.homes,
      windows.mode,
      windows.overviewOpen,
    ],
  );

  // A global shortcuts review flags these.
  const shellChords = useMemo(() => ownedChords(keybindings), [keybindings]);

  // The binding mode is desk-wide.
  useKeybindings({
    domicile,
    keybindings,
    launcherOpen: windows.launcherOpen,
    mode: windows.mode,
    onAction,
    onModeChanged: (mode) => {
      act(WindowAction.ModeSet(mode));
    },
    overviewOpen: windows.overviewOpen,
  });

  useScreenFollowsPointer({ act, displays, focused: windows.focused });

  return (
    <BarProviders
      clock={shellOptions.clock}
      drawer={drawer}
      holdKeyboard={holdKeyboard}
      keymap={shellOptions.keymap}
      launcher={launcherControl}
      tray={trayState}
      workspaces={shownWorkspaces}
    >
      {/*
        First, so it paints under everything. It does not wait for the
        desktop to connect.
      */}
      <Wallpaper
        files={files}
        held={flipping}
        photos={listedWallpapers ?? NO_WALLPAPERS}
        picture={backgroundPicture}
        theme={theme}
      />
      {/*
        Every display the desktop has taken up. A new display appears one
        render after the host reports it, once the reducer gives it a
        workspace.
      */}
      {screens.map(({ geometry: { name } }) => (
        <Monitor
          bar={bar}
          focused={name === windows.focused}
          key={name}
          name={name}
        />
      ))}
      {/*
        Under every window and over the wallpaper: the overview's dimmed
        screens, tiles and names.
      */}
      {overviews !== undefined && (
        <OverviewBackdrop
          cards={windows.overviewCards}
          closing={overviewPhase === "closing"}
          onClosed={overviewClosed}
          overviews={overviews}
        />
      )}
      {/*
        Every window, once for the desk and after every bar, so a window wins a
        tie with a bar it overlaps; see `Stage`.
      */}
      {screens.length > 0 && (
        <Stage
          activeId={windows.activeId}
          behindPanel={
            windows.launcherOpen ||
            windows.overviewOpen ||
            windows.clipboardOpen ||
            opened !== undefined ||
            portal.url !== undefined ||
            notificationsOpen ||
            heldPanels > 0 ||
            lock.locked
          }
          // While a desktop panel is open the page keeps the keyboard; see
          // `AppWindow`. Extension popups, a portal's sign-in page,
          // applications' dialogs and the lock screen count.
          clientIcons={clientIcons}
          domicile={domicile}
          draggingId={windows.draggingId}
          focusedId={windows.focusedId}
          handed={windows.handed}
          modifiers={modifiers}
          {...stageActions}
          overview={sight}
          popups={windows.popups}
          scratchpad={windows.scratchpad}
          screens={screens}
          shut={shut}
          windows={windows.windows}
        />
      )}
      {/*
        Over every window and under the toasts and panels, on every
        workspace. Not on the lock screen.
      */}
      <PictureInPictureFloats
        pictureInPicture={domicile.pictureInPicture}
        shown={screens.length > 0 && !lock.locked}
        workspaceFor={pictureInPictureWorkspace}
      />
      {/* Over every window, while the overview is open. */}
      {overviews !== undefined && overviewPhase === "open" && (
        <OverviewPicker
          aim={windows.overviewAim}
          cards={windows.overviewCards}
          focused={windows.focused}
          onAim={overviewAimed}
          onDismiss={overviewDismissed}
          onMove={windowMovedTo}
          onPick={overviewPicked}
          onPickWindow={overviewWindowPicked}
          overviews={overviews}
        />
      )}
      {/* Panels cover the whole desktop, not one screen. */}
      <Launcher
        fromPrivate={activeIsPrivate(windows)}
        glances={glances}
        onClosed={launcherClosed}
        onDismiss={launcherDismissed}
        onLaunch={launched}
        open={windows.launcherOpen}
        opening={opening}
        opens={opensFile}
        preview={preview}
        screen={windows.focused}
        search={search}
        searchApps={apps.search}
      />
      {openingWith !== undefined && (
        <OpenWith
          domicile={domicile}
          onClose={() => {
            setOpeningWith(undefined);
          }}
          onOpen={(argv) => {
            setOpeningWith(undefined);
            act(WindowAction.AppLaunched(argv));
          }}
          path={openingWith}
          screen={windows.focused}
        />
      )}
      {/* Over the windows, on the screen with the keyboard. */}
      <PortalSignIn
        onDismiss={portal.dismiss}
        screen={windows.focused}
        url={portal.url}
      />
      {/* Over the whole desktop, like the launcher. */}
      <Clipboard
        entries={clipboard}
        onCopy={copied}
        onDismiss={clipboardDismissed}
        open={windows.clipboardOpen}
        screen={windows.focused}
      />
      {/*
        Over the windows and under every panel, so a toast never covers the
        launcher. On the screen with the keyboard. Hidden while locked or
        casting so notifications are not shown on the lock screen or a TV.
      */}
      <NotificationToasts
        manager={toasts}
        now={now}
        onAction={pressNotification}
        onReply={notifications.reply}
        screen={windows.focused}
        shown={!(lock.locked || casting)}
      />
      {/* Like the toasts, on the screen with the keyboard. */}
      <LevelNotice press={levelPress} screen={windows.focused} />
      <KeymapNotice
        press={
          keymapSwitches === 0 || keymaps === undefined
            ? undefined
            : {
                count: keymapSwitches,
                description: keymaps.keymaps.find(
                  ({ name }) => name === keymaps.active,
                )?.description,
                keymap: keymaps.active,
              }
        }
        screen={windows.focused}
      />
      {/* Under the bell that opened it. */}
      <NotificationDrawer
        handle={notificationsHandle}
        inboxes={inboxes.length === 0 ? undefined : inboxDrawer.drawer}
        items={notifications.items}
        now={now}
        onAction={pressNotification}
        onClose={closeNotifications}
        onDismiss={notifications.dismiss}
        onOpen={openNotifications}
        onPause={notifications.pauseFor}
        onReply={notifications.reply}
        onResume={notifications.resume}
        open={notificationsOpen && !lock.locked}
        pause={notifications.pause}
        screen={notificationsOn}
      />
      {/*
        Applications' dialogs, over every panel, on the screen of the window
        that asked. A dialog with no parent window goes on the focused screen.
        Screen casts show in the bar's sharing item when it has one.
      */}
      <PortalDialogs
        closedBrowsers={closedBrowsers}
        domicile={domicile}
        holdKeyboard={holdKeyboard}
        omitScreenCasts={showsSharing(bar)}
        screen={windows.focused}
        screenOf={screenOf}
        shellChords={shellChords}
        shownWindows={shownWindows}
      />
      {/*
        Last, over every panel, so the modal launcher and clipboard cannot take
        input on a locked desk.

        Input is already blocked by the compositor; only the compositor
        unlocks. See `lock/Lock.tsx`.
      */}
      <Lock
        bar={lockBar}
        checking={lock.checking}
        locked={lock.locked}
        onUnlock={lock.unlock}
        picture={lockPicture}
        refusals={lock.refusals}
        refused={lock.refused}
        screen={windows.focused}
      />
      <NoScreens />
    </BarProviders>
  );
};

const logKeymapFailure = (error: unknown): void => {
  // biome-ignore lint/suspicious/noConsole: the desktop keeps the keymap it had
  console.error("could not switch the keymap", error);
};

const logInhibitorFailure = (error: unknown): void => {
  // biome-ignore lint/suspicious/noConsole: a key has no answer to show, and the window keeps its inhibitor
  console.error("could not switch the shortcuts inhibitor", error);
};

const logVirtualMonitorFailure = (error: unknown): void => {
  // biome-ignore lint/suspicious/noConsole: a key or terminal has no answer to show
  console.error("could not add or remove a virtual monitor", error);
};

/** The lock screen's bar on monitor `screen`. */
const lockBar = (screen: string) => (
  <LockBar layout={LOCK_BAR} screen={screen} />
);

/** Everything the bars' items read, desktop-wide. */
const BarProviders = ({
  children,
  clock,
  drawer,
  holdKeyboard,
  keymap,
  launcher,
  tray,
  workspaces,
}: {
  children: ReactNode;
  clock: ClockOptions;
  drawer: NotificationsDrawer;
  holdKeyboard: HoldKeyboard;
  keymap: KeymapOptions;
  launcher: LauncherControl;
  tray: TrayState;
  workspaces: Workspaces;
}) => (
  <WorkspacesContext value={workspaces}>
    <LauncherContext value={launcher}>
      <NotificationsContext value={drawer}>
        <TrayContext value={tray}>
          <PanelKeyboardContext value={holdKeyboard}>
            <ClockOptionsContext value={clock}>
              <KeymapOptionsContext value={keymap}>
                {children}
              </KeymapOptionsContext>
            </ClockOptionsContext>
          </PanelKeyboardContext>
        </TrayContext>
      </NotificationsContext>
    </LauncherContext>
  </WorkspacesContext>
);

/**
 * The focused window's place in the layout, or the whole screen when it has
 * no focused window.
 *
 * The warp aims for the middle of its contents. A window hidden behind a tab
 * has only its bar. An empty screen uses its center, as sway does.
 *
 * `undefined` while the keyboard is on no screen the desktop has taken up.
 */
const focusOf = (
  screens: readonly StageScreen[],
  focused: string,
  activeId: string | undefined,
): Focus | undefined => {
  const screen = screens.find(({ geometry }) => geometry.name === focused);
  const placement = screen?.screenful.placements.find(
    ({ id }) => id === activeId,
  );
  if (screen === undefined) {
    return undefined;
  } else if (activeId === undefined) {
    return {
      box: screen.geometry.screen,
      frame: screen.geometry.screen,
      id: undefined,
    };
  } else if (placement === undefined) {
    throw new Error(`shell: window ${activeId} is not laid out on its screen`);
  } else {
    return {
      box: placement.surface ?? placement.bar,
      frame: placement.frame,
      id: placement.id,
    };
  }
};

/**
 * Runs `then` once a frame drawn after now has been painted: the second
 * animation frame from now runs after the first one's paint.
 */
const afterAFramePainted = (then: () => void) => {
  requestAnimationFrame(() => {
    requestAnimationFrame(then);
  });
};

/** Does what the launcher picked, once it has closed. */
const launch = (
  picked: Launch,
  act: (action: WindowAction) => void,
  openWith: (path: string) => void,
) => {
  switch (picked.kind) {
    case LaunchKind.Ran: {
      act(WindowAction.AppLaunched(picked.command));
      break;
    }
    case LaunchKind.Opened: {
      act(WindowAction.FileOpened(picked.path));
      break;
    }
    case LaunchKind.OpenedWith: {
      openWith(picked.path);
      break;
    }
    case LaunchKind.Browsed: {
      act(WindowAction.BrowserOpened(picked.url, picked.isPrivate));
      break;
    }
  }
};

/**
 * What each window's chrome does, as `Stage` takes it: every action goes
 * through `act`.
 *
 * @param pointing - whether a pointer event is the user's; see
 *   `usePointerWarp`.
 */
const stageActionsOf = (
  act: (action: WindowAction) => void,
  pointing: (at: Spot) => boolean,
) => ({
  onBarPress: (id: string) => {
    act(WindowAction.WindowBarPressed(id));
  },
  onClose: (id: string) => {
    act(WindowAction.WindowClosed(id));
  },
  onDescription: (window: string, description: string) => {
    act(WindowAction.BrowserDescribed(window, description));
  },
  onDismiss: (id: string) => {
    act(WindowAction.ScratchpadDismissed(id));
  },
  onDrop: () => {
    act(WindowAction.WindowDropped());
  },
  onDropOn: (id: string, aim: Aim) => {
    switch (aim.kind) {
      case AimKind.Screen: {
        act(WindowAction.WindowDroppedOnScreen(id, aim.name));
        break;
      }
      case AimKind.Group:
      case AimKind.Strip:
      case AimKind.Tab:
      case AimKind.Window: {
        act(WindowAction.WindowDroppedOn(id, aim.node, aim.edge, aim.beside));
        break;
      }
    }
  },
  onFloat: (id: string) => {
    act(WindowAction.WindowFloated(id));
  },
  onFocusRequest: (id: string) => {
    act(WindowAction.FocusRequested(id));
  },
  onFullscreen: (id: string) => {
    act(WindowAction.WindowFullscreened(id));
  },
  onGrab: (id: string) => {
    act(WindowAction.WindowGrabbed(id));
  },
  onGroupClose: (group: NodeRef) => {
    act(WindowAction.GroupClosed(group));
  },
  onGroupDropOn: (group: NodeRef, aim: Aim) => {
    switch (aim.kind) {
      case AimKind.Screen: {
        act(WindowAction.GroupDroppedOnScreen(group, aim.name));
        break;
      }
      case AimKind.Group:
      case AimKind.Strip:
      case AimKind.Tab:
      case AimKind.Window: {
        act(WindowAction.GroupDroppedOn(group, aim.node, aim.edge, aim.beside));
        break;
      }
    }
  },
  onGroupFloat: (group: NodeRef) => {
    act(WindowAction.GroupFloated(group));
  },
  onGroupFullscreen: (group: NodeRef) => {
    act(WindowAction.GroupFullscreened(group));
  },
  onGroupGrab: (group: NodeRef) => {
    act(WindowAction.GroupGrabbed(group));
  },
  // Only when the pointer actually moved. A window sliding under a still
  // pointer also fires `pointerover`, and following it would steal focus. See
  // `usePointerWarp`.
  onHover: (id: string, at: Spot) => {
    if (pointing(at)) {
      act(WindowAction.WindowHovered(id));
    }
  },
  onIcon: (window: string, icon: string) => {
    act(WindowAction.BrowserIconChanged(window, icon));
  },
  // In page pixels, so a float can be dragged to another screen; see
  // `floatDragged`.
  onMove: (id: string, x: number, y: number) => {
    act(WindowAction.WindowMoved(id, x, y));
  },
  onNewTab: (id: string) => {
    act(WindowAction.NewTabPressed(id));
  },
  onPageFullscreen: (id: string, fullscreen: boolean) => {
    act(WindowAction.PageFullscreened(id, fullscreen));
  },
  // Converted to the float's screen's pixels.
  onResize: (id: string, box: Rect, on: Geometry) => {
    act(
      WindowAction.WindowResized(id, {
        ...box,
        x: box.x - on.screen.x,
        y: box.y - on.screen.y,
      }),
    );
  },
  onSelect: (id: string) => {
    act(WindowAction.WindowSelected(id));
  },
  // The tiling is laid out in the screen's workspace box, so a dragged pixel
  // is a share of that.
  onStretch: (id: string, edge: Direction, by: number, on: Geometry) => {
    act(WindowAction.WindowStretched(id, edge, by, on.workspace));
  },
});
