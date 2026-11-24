import { PopupBoundary } from "@domicile-desktop/component-library/PopupBoundary";
import { APP_KEY_DELIVERED_EVENT } from "@domicile-desktop/sdk/app-element";
import { WEBVIEW_KEY_DELIVERED_EVENT } from "@domicile-desktop/sdk/webview-element";
import type { ReactNode } from "react";
import { useEffect, useEffectEvent, useRef } from "react";

import { seenAt, seenClip, seenStyles } from "./overview/seen-styles";
import type { Seen } from "./overview/sight";
import type { Spot } from "./pointer-warp";
import type { Rect } from "./rect";
import { SlidingScreen } from "./sliding-screen";
import type { WindowMotion } from "./window-motion";
import {
  clippedTo,
  screenClipStyles,
  slidAcross,
  slidingAcross,
  unedgedOn,
} from "./window-styles";

type Props = {
  /** The window's contents or its bar. */
  children: ReactNode;
  /** The depth of the contents or bar it holds. */
  depth: number;
  /**
   * Whether the window fills its screen, alone or in its group. See
   * `unedgedOn`.
   */
  fillsScreen: boolean;
  /**
   * The window's frame, which the scratchpad slides lift and popups opened in
   * the window stay inside.
   */
  frame: Rect | undefined;
  /** The window's motion; a workspace switch clips it to its screen. */
  motion: WindowMotion;
  /**
   * Called when the pointer enters any part of this window, with the page
   * position. Focus follows the cursor; `usePointerWarp` uses the position to
   * tell a real pointer move from a window appearing under a still pointer.
   */
  onHover: (at: Spot) => void;
  /**
   * Called on every press in this window, even when it is already active:
   * focus follows the cursor, but only a press raises the window. Also on
   * every key its client or page gets, since typing in a window ends a
   * selection around it as a click does.
   */
  onReach: () => void;
  /** How far into its motion the window starts. See `slidAcross`. */
  rewound: number;
  /** Its screen, which the window's slides move it off. See `slidAcross`. */
  screen: Rect | undefined;
  /** How the overview shows it, if open. See `seenAt`. */
  seen: Seen | undefined;
};

/**
 * Marks window frames, so document listeners can tell a window from the bare
 * desk. See `useScreenFollowsPointer`.
 */
export const WINDOW_FRAME = "data-window-frame";

/**
 * The events a window's `<app>` or `<webview>` fires when a key reaches it.
 */
const KEY_DELIVERED = new Set([
  APP_KEY_DELIVERED_EVENT,
  WEBVIEW_KEY_DELIVERED_EVENT,
]);

/**
 * Wraps a window's bar and contents to handle pointer hover, press and keys
 * for every kind of window in one place.
 *
 * Keeps popups opened in the window inside its frame, so they never cover
 * the windows beside it.
 *
 * Takes no space, stacking or pointer of its own (see `screenClipStyles`).
 * Its children inherit the slide distances and tab edge from it, and it clips
 * them to their screen during a workspace switch. Each part also clips itself
 * to its workspace then (see `clippedAlong`). In the overview, it shows
 * them through their workspace's tile.
 */
export const WindowFrame = ({
  children,
  depth,
  fillsScreen,
  frame,
  motion,
  onHover,
  onReach,
  rewound,
  screen,
  seen,
}: Props) => {
  const element = useRef<HTMLDivElement>(null);
  const reached = useEffectEvent(() => {
    onReach();
  });
  // Custom events, which React has no prop for.
  useEffect(() => {
    const frame = element.current;
    if (frame === null) {
      throw new Error("WindowFrame: no element to hear keys on");
    } else {
      const heard = () => {
        reached();
      };
      for (const type of KEY_DELIVERED) {
        frame.addEventListener(type, heard);
      }
      return () => {
        for (const type of KEY_DELIVERED) {
          frame.removeEventListener(type, heard);
        }
      };
    }
  }, []);
  return (
    <div
      className={screenClipStyles}
      ref={element}
      {...{ [WINDOW_FRAME]: "" }}
      onPointerDown={onReach}
      // `pointerover` bubbles from whichever part the pointer entered.
      onPointerOver={(event) => {
        onHover([event.clientX, event.clientY]);
      }}
      style={{
        ...unedgedOn(fillsScreen),
        ...(screen === undefined
          ? {}
          : {
              ...slidAcross(screen, frame, motion, rewound),
              ...clippedTo(screen, motion),
              ...seenClip(seen, screen, depth),
            }),
      }}
    >
      <div
        className={seenStyles({
          arriving: seen?.arriving !== undefined,
          placed: frame !== undefined,
          seen: seen !== undefined,
          shut: seen?.shut ?? false,
        })}
        style={seenAt(seen, screen)}
      >
        <SlidingScreen
          value={
            screen === undefined ? undefined : slidingAcross(screen, motion)
          }
        >
          <PopupBoundary box={frame}>{children}</PopupBoundary>
        </SlidingScreen>
      </div>
    </div>
  );
};
