import type { FrozenDesk } from "@domicile-desktop/sdk/portal";
import type { PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { css } from "../../styled-system/css";
import { hstack } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { SizeTag } from "./SizeTag";

// Room the buttons take under the area, in page pixels; with less below it,
// they go inside the area's foot.
const BUTTONS_ROOM = 56;

type Pair = readonly [number, number];

/** A rectangle in page pixels: the desktop's logical pixels. */
export type Region = { position: Pair; size: Pair };

/** A button that takes the region selected, and a key that presses it. */
export type RegionAction = {
  label: string;
  pick: (region: Region) => void;
  shortcut?: ((event: KeyboardEvent) => boolean) | undefined;
};

type Props = {
  /** The buttons beside Back and Cancel; the last is the main one. */
  actions: readonly RegionAction[];
  /** Back to the picker: the Back button, or Escape. */
  back: () => void;
  cancel: () => void;
  /** The desk to draw under the selection; the live desk shows without it. */
  frozen?: FrozenDesk | undefined;
  /**
   * Whether it is up. Turned off, it fades out, out of reach, then calls
   * `onOpenChangeComplete(false)`.
   */
  open: boolean;
  onOpenChangeComplete: (open: boolean) => void;
};

enum GrabKind {
  Corner,
  Inside,
}

const Grab = {
  /** A corner dragged, or a new area drawn, from the `anchor` that stays. */
  Corner: (anchor: Pair) => ({ anchor, kind: GrabKind.Corner as const }),
  /** The area dragged `from` a point inside it, as it was `before`. */
  Inside: (from: Pair, before: Region) => ({
    before,
    from,
    kind: GrabKind.Inside as const,
  }),
};

type Grab = ReturnType<(typeof Grab)[keyof typeof Grab]>;

/**
 * Covers the whole page, which spans the desk, and lets the user select a
 * rectangle on it. The rectangle stays, with a corner to drag at each corner
 * and the buttons that take it below; dragging inside moves it, and dragging
 * outside draws a new one. A click that drags nothing selects nothing. It
 * fades in and out.
 */
export const RegionPicker = ({
  actions,
  back,
  cancel,
  frozen,
  onOpenChangeComplete,
  open,
}: Props) => {
  const [selected, setSelected] = useState<Region | undefined>(undefined);
  const [grab, setGrab] = useState<Grab | undefined>(undefined);
  const desk = useRef<HTMLDivElement>(null);

  // Takes the keyboard, and takes it back from a browser window's page. Keys
  // sent to a focused page never reach this document, so Ctrl+C and Escape
  // would go to the page. Closing the picker's dialog returns focus to the
  // window under the desk, and the engine refocuses the last page when the
  // shell regains the keyboard. Focus elsewhere in the shell, such as the lock
  // screen's field, stays where it is.
  // Fading out, it lets the keyboard go.
  useEffect(() => {
    const root = desk.current;
    if (root === null) {
      throw new Error("region picker: no desk to focus");
    } else if (open) {
      const keep = (event: FocusEvent) => {
        if (
          event.target instanceof Element &&
          event.target.localName === "webview"
        ) {
          root.focus({ preventScroll: true });
        }
      };
      root.focus({ preventScroll: true });
      document.addEventListener("focusin", keep);
      return () => {
        document.removeEventListener("focusin", keep);
      };
    } else {
      return undefined;
    }
  }, [open]);

  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const pressed = actions.find(({ shortcut }) => shortcut?.(event));
      if (event.key === "Escape") {
        back();
      } else if (pressed !== undefined && selected !== undefined) {
        event.preventDefault();
        pressed.pick(selected);
      }
    };
    if (open) {
      document.addEventListener("keydown", press);
    }
    return () => {
      document.removeEventListener("keydown", press);
    };
  }, [actions, back, open, selected]);

  // On the page's body, after any dialog already up, such as the launcher,
  // so it draws over that dialog and takes the pointer from it.
  return createPortal(
    <div
      aria-label="Drag to select an area"
      className={deskStyles}
      data-leaving={open ? undefined : ""}
      data-selected={selected === undefined ? undefined : ""}
      inert={!open}
      onPointerDown={(event) => {
        const point = pointAt(event);
        setGrab(Grab.Corner(point));
        setSelected(rectangle(point, point));
      }}
      onPointerMove={(event) => {
        if (grab !== undefined) {
          setSelected(dragged(grab, pointAt(event)));
        }
      }}
      onPointerUp={(event) => {
        if (grab !== undefined) {
          const region = dragged(grab, pointAt(event));
          setGrab(undefined);
          setSelected(
            region.size[0] > 0 && region.size[1] > 0 ? region : undefined,
          );
        }
      }}
      onTransitionEnd={(event) => {
        if (
          !open &&
          event.target === event.currentTarget &&
          event.propertyName === "opacity"
        ) {
          onOpenChangeComplete(false);
        }
      }}
      ref={desk}
      role="application"
      // Focusable, so it can hold the keyboard.
      tabIndex={-1}
    >
      {frozen !== undefined && (
        <img
          alt="The desk"
          className={frozenStyles}
          draggable={false}
          src={frozen.frame}
          style={{
            height: `${String(frozen.desk.size[1])}px`,
            left: `${String(frozen.desk.position[0])}px`,
            top: `${String(frozen.desk.position[1])}px`,
            width: `${String(frozen.desk.size[0])}px`,
          }}
        />
      )}
      {selected !== undefined && (
        <div
          aria-label="Selected area"
          className={selectedStyles}
          onPointerDown={(event) => {
            event.stopPropagation();
            setGrab(Grab.Inside(pointAt(event), selected));
          }}
          role="group"
          style={{
            height: `${String(selected.size[1])}px`,
            left: `${String(selected.position[0])}px`,
            top: `${String(selected.position[1])}px`,
            width: `${String(selected.size[0])}px`,
          }}
        >
          <SizeTag height={selected.size[1]} width={selected.size[0]} />
          {CORNERS.map((corner) => (
            <span
              className={cornerStyles}
              data-corner={corner}
              key={corner}
              onPointerDown={(event) => {
                event.stopPropagation();
                setGrab(Grab.Corner(opposite(selected, corner)));
              }}
            />
          ))}
          {grab === undefined && (
            <div
              aria-label="Selected area"
              className={buttonsStyles}
              data-inside={
                selected.position[1] + selected.size[1] + BUTTONS_ROOM >
                window.innerHeight
                  ? ""
                  : undefined
              }
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              role="toolbar"
            >
              <Button onClick={back} size="sm" variant="ghost">
                Back
              </Button>
              <Button onClick={cancel} size="sm" variant="outline">
                Cancel
              </Button>
              {actions.map(({ label, pick }, index) => (
                <Button
                  key={label}
                  onClick={() => {
                    pick(selected);
                  }}
                  size="sm"
                  variant={index === actions.length - 1 ? "primary" : "outline"}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      <p className={hintStyles}>Drag to select an area. Escape goes back.</p>
    </div>,
    document.body,
  );
};

const CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;

type Corner = (typeof CORNERS)[number];

const deskStyles = css({
  _starting: { opacity: 0 },
  "&[data-leaving]": {
    opacity: 0,
    transition: "opacity {durations.fast} {easings.in}",
  },
  "&[data-selected]": { backgroundColor: "transparent" },
  backgroundColor: "backdrop",
  cursor: "crosshair",
  inset: 0,
  opacity: 1,
  overflow: "hidden",
  position: "fixed",
  touchAction: "none",
  transition: "opacity {durations.normal} {easings.out}",
  userSelect: "none",
  zIndex: "modal",
});

// Placed by the desk's own position on the page, which is physical.
const frozenStyles = css({ pointerEvents: "none", position: "absolute" });

const hintStyles = css({
  backgroundColor: "card",
  borderRadius: "full",
  color: "foreground",
  fontSize: "sm",
  insetBlockStart: 4,
  insetInline: 0,
  margin: 0,
  marginInline: "auto",
  paddingBlock: 1,
  paddingInline: 4,
  pointerEvents: "none",
  position: "absolute",
  width: "fit-content",
});

// Shades the rest of the page, as the picker's preview shades the rest of
// the desk.
const selectedStyles = css({
  border: "2px solid {colors.accent}",
  boxShadow: "0 0 0 100vmax {colors.backdrop}",
  cursor: "move",
  position: "absolute",
});

const cornerStyles = css({
  "&[data-corner=bottom-left]": {
    cursor: "nesw-resize",
    insetBlockEnd: -1.5,
    insetInlineStart: -1.5,
  },
  "&[data-corner=bottom-right]": {
    cursor: "nwse-resize",
    insetBlockEnd: -1.5,
    insetInlineEnd: -1.5,
  },
  "&[data-corner=top-left]": {
    cursor: "nwse-resize",
    insetBlockStart: -1.5,
    insetInlineStart: -1.5,
  },
  "&[data-corner=top-right]": {
    cursor: "nesw-resize",
    insetBlockStart: -1.5,
    insetInlineEnd: -1.5,
  },
  backgroundColor: "accent",
  blockSize: 3,
  border: "2px solid {colors.background}",
  borderRadius: "xs",
  inlineSize: 3,
  position: "absolute",
});

// As the recording toolbar looks.
const buttonsStyles = hstack({
  "&[data-inside]": { insetBlockEnd: 2, insetBlockStart: "auto" },
  backgroundColor: "card",
  border: "1px solid {colors.border}",
  borderRadius: "full",
  boxShadow: "{shadows.lifted}",
  cursor: "default",
  gap: 2,
  insetBlockStart: "calc(100% + {spacing.2})",
  insetInlineStart: "50%",
  paddingBlock: 1,
  paddingInline: 2,
  position: "absolute",
  transform: "translateX(-50%)",
  whiteSpace: "nowrap",
});

/** Where `event` is on the page, in whole pixels. */
const pointAt = (event: PointerEvent): Pair => [
  Math.round(event.clientX),
  Math.round(event.clientY),
];

/** The area `grab` gives with the pointer at `point`. */
const dragged = (grab: Grab, point: Pair): Region => {
  switch (grab.kind) {
    case GrabKind.Corner:
      return rectangle(grab.anchor, point);
    case GrabKind.Inside:
      return {
        position: [
          grab.before.position[0] + point[0] - grab.from[0],
          grab.before.position[1] + point[1] - grab.from[1],
        ],
        size: grab.before.size,
      };
  }
};

/** The corner of `region` across from `corner`, which stays as it is dragged. */
const opposite = (region: Region, corner: Corner): Pair => {
  const [left, top] = region.position;
  const right = left + region.size[0];
  const bottom = top + region.size[1];
  switch (corner) {
    case "top-left":
      return [right, bottom];
    case "top-right":
      return [left, bottom];
    case "bottom-left":
      return [right, top];
    case "bottom-right":
      return [left, top];
  }
};

/** The rectangle with corners `a` and `b`. */
const rectangle = (a: Pair, b: Pair): Region => ({
  position: [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
  size: [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])],
});
