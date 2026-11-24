/// <reference types="@domicile-desktop/manganese-host/domicile-elements" />

import type { AppFocusReleaseRequest } from "@domicile-desktop/sdk/app-element";
import {
  APP_FOCUS_RELEASE_REQUESTED_EVENT,
  APP_FOCUS_REQUESTED_EVENT,
} from "@domicile-desktop/sdk/app-element";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import { WindowState } from "@domicile-desktop/sdk/window-state";
import { useContext, useEffect, useRef, useState } from "react";

import { css, cx } from "../styled-system/css";
import { AppPopup } from "./AppPopup";
import { endsOwnAnimation } from "./own-animation";
import { CROSSING, raised } from "./placement";
import type { WindowPopup } from "./popup";
import type { Rect } from "./rect";
import type { Restack } from "./restacking";
import { SlidingScreen } from "./sliding-screen";
import { useLowered } from "./useLowered";
import { usePointerConfinement } from "./usePointerConfinement";
import type { Settler } from "./useSettling";
import { UPRIGHT, useSettling } from "./useSettling";
import { appWindowId } from "./window";
import type { WindowMotion } from "./window-motion";
import { isLeaving, isMoving, isSlidingIn } from "./window-motion";
import {
  bottomCornerStyles,
  clickThroughStyles,
  clippedAlong,
  contentsScaledAbout,
  edgeStyles,
  heldStyles,
  keptAt,
  movingStyles,
  originOf,
  placedAt,
  settlingStyles,
  shuffledBy,
  windowStyles,
} from "./window-styles";

/** What a tiled window tells its client: something touches every edge. */
const TILED: readonly WindowState[] = [
  WindowState.TiledLeft,
  WindowState.TiledRight,
  WindowState.TiledTop,
  WindowState.TiledBottom,
];

/**
 * The box a window off screen reports. Empty, so the compositor stops its
 * client drawing; it keeps its last monitor.
 */
const OFF_SCREEN: Rect = { height: 0, width: 0, x: 0, y: 0 };

type Props = {
  /**
   * Whether a shell panel (such as the launcher) is open over the windows.
   * The page takes the keyboard while it is.
   */
  behindPanel: boolean;
  /**
   * Whether the pointer passes through this window to the page.
   *
   * Needed for drags: the client owns the pointer over its surface, so the
   * shell cannot track a drag over it otherwise.
   */
  clickThrough: boolean;
  /**
   * Whether the user is dragging or resizing this window, so its box follows
   * the pointer.
   */
  dragging: boolean;
  /** Whether this window floats rather than tiles. */
  floating: boolean;
  /** The host's id for this window's client. */
  appId: string;
  /**
   * The CSS cursor the client requested: a shape's keyword, or an image it
   * drew. `undefined` uses the page's cursor.
   */
  cursor: string | undefined;
  /**
   * Whether it just moved to another tab group, so it eases there over the
   * strips it passes. See `crossing.ts`.
   */
  crossing?: boolean | undefined;
  /** The window's `z-index`, which the SDK reports to the host. */
  depth: number;
  /** Used to request keyboard focus. */
  domicile: Domicile;
  /**
   * The box spanning the title bar and contents; the transform origin (see
   * {@link scaledAbout}). `undefined` when {@link Props.rect} is.
   */
  frame: Rect | undefined;
  /**
   * Its tab in the strip, which its contents grow out of as it opens and
   * shrink into as it closes (see {@link contentsScaledAbout}).
   */
  tab?: Rect | undefined;
  /** Whether the shell considers this window focused. */
  focused: boolean;
  /** Whether this window is fullscreen, which removes its edge and corners. */
  fullscreen: boolean;
  /**
   * Whether the compositor gives this window keyboard focus.
   *
   * Can differ from {@link Props.focused} when something else takes the
   * keyboard; the focus effect uses this to reclaim it.
   */
  hasKeyboard: boolean;
  /**
   * The window's current animation, if any.
   *
   * A leaving window is drawn only: it requests no keyboard, takes no pointer
   * and is inert.
   */
  motion: WindowMotion;
  /**
   * Called when the motion's animation ends, so a closed window can be
   * removed. Uses the animation event so the duration lives only in CSS.
   */
  onMotionEnded: () => void;
  /** Its client's popups, drawn over it. See `AppPopup`. */
  popups: readonly WindowPopup[];
  /**
   * The contents' box, or `undefined` when off screen (another workspace, or
   * behind a tab).
   */
  rect: Rect | undefined;
  /**
   * Whether the user is resizing windows with the pointer. Sets the `<app>`'s
   * `resizing` attribute, so the engine shows each new box without waiting for
   * the client to draw at it.
   */
  resizing: boolean;
  /** The restack shuffle in progress, if any. See `shuffledBy`. */
  restack?: Restack | undefined;
  /** Eases the window into a new box; see `useSettling`. */
  settler?: Settler | undefined;
  /**
   * The synced frame its `<app frame>` shows, set in the same render as the
   * moves of its popups. See `DomicileWindow.frame`.
   */
  syncedFrame: number;
};

/**
 * A Wayland client's window, rendered as an `<app>` element.
 *
 * Hiding the element takes the window off screen. The empty box it reports
 * then stops its client drawing.
 *
 * `<app>` has no hyphen, so React treats it as a plain HTML element and drops
 * unknown properties and `on…` listeners. Focus events are therefore bound
 * with `addEventListener` (as `BrowserWindow` does for `<webview>`), and
 * keyboard focus is requested in an effect.
 */
export const AppWindow = ({
  appId,
  behindPanel,
  clickThrough,
  cursor,
  crossing = false,
  depth,
  domicile,
  dragging,
  floating,
  focused,
  frame,
  fullscreen,
  hasKeyboard,
  motion,
  onMotionEnded,
  popups,
  rect,
  resizing,
  restack,
  settler,
  syncedFrame,
  tab,
}: Props) => {
  // A closed window that is still animating out.
  const leaving = isLeaving(motion);
  // `null` because React passes `null` to a callback ref on unmount.
  const [element, setElement] = useState<HTMLAppElement | null>(null);
  // The box around the element, which `useSettling` eases. A ref because only
  // its layout effect reads it.
  const box = useRef<HTMLDivElement>(null);
  const lowered = useLowered(depth);
  const sliding = useContext(SlidingScreen);
  // The box the window eases from, while it settles.
  const [settlingFrom, setSettlingFrom] = useState<Rect | undefined>(undefined);
  // Its popups, which ease along with it.
  const layer = useRef<HTMLDivElement>(null);
  const settling = {
    origin:
      rect === undefined || frame === undefined
        ? undefined
        : originOf(frame, rect),
    over: crossing ? CROSSING : undefined,
    rect,
    settler,
    still: dragging || isMoving(motion),
  };
  useSettling({ ...settling, element: box, onSettling: setSettlingFrom });
  useSettling({ ...settling, element: layer });

  // Keeps the compositor's keyboard focus in line with the shell's.
  //
  // - Never sends an "unfocus" for an unfocused window; the keyboard always
  //   belongs to someone.
  // - Re-requests whenever `hasKeyboard` goes false, since clicking chrome
  //   (top bar, wallpaper) moves the keyboard to the page without changing the
  //   shell's focused window.
  // - Cannot loop: a granted `focusApp` sets `hasKeyboard`, and a refused one
  //   changes no dependency.
  // - Skips a leaving window, whose keyboard has moved to the next window.
  // - While a shell panel is open, takes the keyboard for the page. Otherwise
  //   the client under the launcher would receive its keystrokes. When the
  //   panel closes, the second branch returns focus without waiting for the
  //   pointer to move.
  useEffect(() => {
    if (behindPanel) {
      if (hasKeyboard) {
        domicile.windows.focusShell();
      }
    } else if (focused && !hasKeyboard && !leaving) {
      domicile.windows.focus(appId);
    }
  }, [appId, behindPanel, domicile, focused, hasKeyboard, leaving]);

  // Tells the compositor where the window is, so the client draws at the
  // scale of the monitor under it. Keyed on the numbers, since `rect` is a new
  // object on every render.
  const { x, y, width, height } = rect ?? OFF_SCREEN;
  useEffect(() => {
    domicile.windows.setBounds(appId, { height, width, x, y });
  }, [appId, domicile, height, width, x, y]);

  // Holds the pointer in the window for a game or VM viewer that asked, while
  // it has the keyboard.
  usePointerConfinement(
    domicile,
    appId,
    rect,
    hasKeyboard && !behindPanel && !leaving,
  );

  // Tells the client how it is laid out, so a tiled window draws no shadow,
  // rounded corners or resize border of its own. Floats get none, as in sway.
  const { windows } = domicile;
  useEffect(() => {
    windows
      .setStates(appId, statesOf(fullscreen, floating))
      .then((set) => {
        set.match({
          Err: (error) => {
            // A window that closed has no states left to set.
            if (error.kind !== SystemErrorKind.NotFound) {
              // biome-ignore lint/suspicious/noConsole: surfacing states the compositor refused
              console.error(`The states of ${appId} were not set`, error);
            }
          },
          Ok: () => undefined,
        });
      })
      .catch((error: unknown) => {
        // biome-ignore lint/suspicious/noConsole: surfacing a broken desktop call
        console.error(`The states of ${appId} were not set`, error);
      });
  }, [appId, floating, fullscreen, windows]);

  // Cancels the engine's default focus-on-click. The shell owns focus:
  // `WindowFrame` reports the press and `focused` drives the effect above.
  useEffect(() => {
    if (element === null) {
      return undefined;
    } else {
      const asked = (event: Event) => {
        event.preventDefault();
      };
      element.addEventListener(APP_FOCUS_REQUESTED_EVENT, asked);
      return () => {
        element.removeEventListener(APP_FOCUS_REQUESTED_EVENT, asked);
      };
    }
  }, [element]);

  // The engine gives the keyboard to the page for a press off every `<app>`.
  // Cancels that for presses on this window's own chrome (title bar, grab
  // sheet), found by its `data-window` attribute, so dragging a window keeps
  // its keyboard.
  //
  // Compares the attribute rather than building a selector from the id,
  // since a client-chosen id with a quote would make the selector throw.
  useEffect(() => {
    if (element === null) {
      return undefined;
    } else {
      const releasing = (event: Event) => {
        const { pressed } = (event as CustomEvent<AppFocusReleaseRequest>)
          .detail;
        const chrome = pressed?.closest("[data-window]");
        if (chrome?.getAttribute("data-window") === appWindowId(appId)) {
          event.preventDefault();
        }
      };
      element.addEventListener(APP_FOCUS_RELEASE_REQUESTED_EVENT, releasing);
      return () => {
        element.removeEventListener(
          APP_FOCUS_RELEASE_REQUESTED_EVENT,
          releasing,
        );
      };
    }
  }, [appId, element]);

  // The box's motion and shuffle, which its popups play too.
  const moved =
    rect === undefined || frame === undefined
      ? undefined
      : {
          ...contentsScaledAbout(motion, frame, tab, rect),
          ...shuffledBy(restack),
        };
  return (
    <>
      {/*
        The box places the window, plays its motions and eases it into a new
        box, clipping the `<app>` to where it is drawn. The `<app>` keeps its
        own size, so a client drawn at its new size is cropped rather than
        stretched while the box gets there.
      */}
      <div
        className={cx(
          windowStyles,
          boxStyles,
          // Neither a line nor rounded corners around the screen's own edge.
          !fullscreen && edgeStyles,
          !fullscreen && bottomCornerStyles,
          movingStyles({ contents: true, motion }),
          (clickThrough || leaving) && clickThroughStyles,
          // The client's box takes its new size at once; `useSettling` eases
          // it. Colors still ease; see `settlingStyles`.
          settlingStyles({ lowered }),
          dragging && heldStyles,
        )}
        // Exposes the motion on the element for tests and debugging.
        data-motion={motion}
        hidden={rect === undefined}
        // A leaving window is unreachable by keyboard.
        inert={leaving}
        // Ignores animations bubbling up from descendants, and the end of a
        // motion this one replaced.
        onAnimationEnd={(event) => {
          if (endsOwnAnimation(event)) {
            onMotionEnded();
          }
        }}
        ref={box}
        // Inline because the box is a runtime value that Panda cannot extract
        // at build time.
        style={
          rect === undefined || frame === undefined
            ? undefined
            : {
                ...placedAt(rect, depth),
                ...clippedAlong(sliding, rect),
                ...moved,
              }
        }
      >
        <app
          app-id={appId}
          className={appStyles}
          frame={String(syncedFrame)}
          ref={setElement}
          // Also while the box settles, so the engine neither holds the page
          // for the client nor stretches its old frame, and while it slides in,
          // so the slide does not wait for the client to draw again.
          resizing={
            resizing || settlingFrom !== undefined || isSlidingIn(motion)
              ? ""
              : undefined
          }
          // Inline because the cursor and size are runtime values that Panda
          // cannot extract at build time.
          style={{
            cursor,
            ...(rect === undefined ? {} : keptAt(settlingFrom, rect)),
          }}
          {...{ [UPRIGHT]: "" }}
        />
      </div>
      {/*
        Its popups, placed, moved and eased as the box is, just over it. Not in
        the box, which would clip a menu reaching past the window.
      */}
      {rect !== undefined && popups.length > 0 && (
        <div
          className={cx(
            movingStyles({ contents: true, motion }),
            (clickThrough || leaving) && clickThroughStyles,
            dragging && heldStyles,
          )}
          data-motion={motion}
          inert={leaving}
          ref={layer}
          style={{
            ...placedAt(rect, raised(depth)),
            ...clippedAlong(sliding, rect),
            ...moved,
          }}
        >
          {popups.map((popup) => (
            <AppPopup key={popup.appId} popup={popup} />
          ))}
        </div>
      )}
    </>
  );
};

/**
 * Clips the `<app>` to the box, rounded corners included, so the client's
 * pixels are clipped too. The title bar draws the top edge, so the surface
 * meets it flush.
 */
const boxStyles = css({ borderBlockStartWidth: 0, overflow: "clip" });

/**
 * Fills the box. Kept upright about its top left corner while the box eases,
 * as the engine keeps a frame the client has not redrawn yet (`resizing`).
 *
 * No background, as {@link windowStyles} says: the compositor draws into it.
 */
const appStyles = css({
  blockSize: "full",
  display: "block",
  inlineSize: "full",
  transformOrigin: "0 0",
});

/** The states a window's client is told, by how the window is laid out. */
const statesOf = (
  fullscreen: boolean,
  floating: boolean,
): readonly WindowState[] => {
  if (fullscreen) {
    return [WindowState.Fullscreen];
  } else if (floating) {
    return [];
  } else {
    return TILED;
  }
};
