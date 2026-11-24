import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";

import { css, cva } from "../../styled-system/css";
import "../stylesheet";

/**
 * Calls `onWidth` with `element`'s width now and whenever it changes, until
 * the returned function stops it.
 */
export type ObserveWidth = (
  element: Element,
  onWidth: (width: number) => void,
) => () => void;

type Props = {
  /**
   * The edge its content keeps while it opens, closes and resizes: `end`
   * grows it toward the start, as for items packed against a row's end.
   */
  anchor?: Anchor | undefined;
  /** What it shows. Nothing, such as `null` or `false`, closes it. */
  children: ReactNode;
  /**
   * The space between it and its neighbors: `narrow` is 1.5 spacing steps,
   * as between icons; `wide` is 4, as between bar items. Half sits on
   * each side and closes with it, so the row sets no gap of its own and
   * pulls its ends in by half of this.
   */
  gap?: Gap | undefined;
  /** Injectable for tests; defaults to a `ResizeObserver`. */
  observeWidth?: ObserveWidth | undefined;
  /**
   * Whether its content shows past the eased width: `visible` for an item
   * with open space beside it, whose own motion would otherwise be cut off
   * while it resizes.
   */
  overflow?: Overflow | undefined;
};

/** The edges a `FluidItem` can keep still. */
export type Anchor = "start" | "end";

/** What a `FluidItem` does with content past its eased width. */
export type Overflow = "clip" | "visible";

/** The gaps a row of `FluidItem`s can have. */
export type Gap = "none" | "narrow" | "wide";

/**
 * An item in a row that eases between widths: it opens and fades in when
 * its content appears, follows its content as that grows and shrinks, and
 * closes and fades out when its content goes. What goes is still drawn, out
 * of reach, until it has faded.
 *
 * Its content can be any component, and needs no motion of its own: one that
 * returns nothing to hide is enough.
 */
export const FluidItem = ({
  anchor = "start",
  children,
  gap = "none",
  observeWidth = resizeObserverWidth,
  overflow = "clip",
}: Props) => {
  const slot = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const live = useRef<HTMLSpanElement>(null);
  const leaving = useRef<HTMLSpanElement>(null);

  // In a layout effect, and by hand rather than through state, so what
  // leaves is back in place before the frame that would show it gone.
  useLayoutEffect(() => {
    const parts = {
      content: content.current,
      leaving: leaving.current,
      live: live.current,
      slot: slot.current,
    };
    if (
      parts.slot === null ||
      parts.content === null ||
      parts.live === null ||
      parts.leaving === null
    ) {
      throw new Error("FluidItem rendered without its parts");
    }
    const { leaving: left, live: shown, slot: box } = parts;
    let width = 0;
    const draw = () => {
      const showing = shown.hasChildNodes();
      box.toggleAttribute("data-shown", showing);
      box.style.setProperty("--fluid-width", `${showing ? width : 0}px`);
    };
    const mutations = new MutationObserver((records) => {
      if (shown.hasChildNodes()) {
        left.replaceChildren();
      } else {
        const gone = records
          .flatMap((record) => [...record.removedNodes])
          .filter((node) => !node.isConnected);
        if (gone.length > 0) {
          left.replaceChildren(...gone);
        }
      }
      draw();
    });
    mutations.observe(shown, { childList: true });
    const stopWatchingWidth = observeWidth(parts.content, (measured) => {
      width = measured;
      draw();
    });
    return () => {
      mutations.disconnect();
      stopWatchingWidth();
    };
  }, [observeWidth]);

  return (
    <span
      className={slotStyles({ anchor, overflow })}
      onTransitionEnd={(event) => {
        // It has faded out, so what left can go.
        if (
          event.target === event.currentTarget &&
          event.propertyName === "opacity" &&
          !event.currentTarget.hasAttribute("data-shown")
        ) {
          leaving.current?.replaceChildren();
        }
      }}
      ref={slot}
    >
      <span className={contentStyles({ gap })} ref={content}>
        <span className={layerStyles} ref={live}>
          {children}
        </span>
        <span aria-hidden className={layerStyles} inert ref={leaving} />
      </span>
    </span>
  );
};

// The width eases to the measured one. Before the first measurement it is
// `auto`, which does not animate, so what shows from the start does not open.
// Clipped across only, so nothing above or below is cut.
const slotStyles = cva({
  base: {
    "&:not([data-shown])": { opacity: 0 },
    display: "inline-flex",
    flexShrink: 0,
    inlineSize: "var(--fluid-width, auto)",
    opacity: 1,
    // main-thread animation: opens to its content's width once, moving its
    // neighbors.
    transition:
      "inline-size {durations.normal} {easings.in-out}, opacity {durations.normal} {easings.default}",
  },
  variants: {
    anchor: {
      end: { justifyContent: "flex-end" },
      start: {},
    },
    overflow: {
      clip: { overflowX: "clip" },
      visible: { overflowX: "visible" },
    },
  },
});

// Its own width, so it can be measured whatever the slot is eased to. The gap
// is inside, so it closes with the content.
const contentStyles = cva({
  base: {
    alignItems: "center",
    display: "inline-flex",
    flexShrink: 0,
    inlineSize: "max-content",
  },
  variants: {
    gap: {
      narrow: { paddingInline: 0.75 },
      none: {},
      wide: { paddingInline: 2 },
    },
  },
});

// Lays the content out as if the wrapper were not there.
const layerStyles = css({ display: "contents" });

/** `ObserveWidth` through a `ResizeObserver`. */
const resizeObserverWidth: ObserveWidth = (element, onWidth) => {
  const observer = new ResizeObserver(() => {
    onWidth(element.getBoundingClientRect().width);
  });
  observer.observe(element);
  onWidth(element.getBoundingClientRect().width);
  return () => {
    observer.disconnect();
  };
};
