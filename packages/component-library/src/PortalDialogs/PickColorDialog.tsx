import type { FrozenDesk, PortalAnswer } from "@domicile-desktop/sdk/portal";
import { PortalAnswer as Answer } from "@domicile-desktop/sdk/portal";
import type { KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";
import { css } from "../../styled-system/css";
import { flex } from "../../styled-system/patterns";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import type { FramePoint } from "./frame-point";
import { framePoint } from "./frame-point";
import type { Presence } from "./presence";

/** How many times the magnifier enlarges the frame. */
const ZOOM = 12;

/** The magnifier's side, in page pixels. Its styles say the same. */
const MAGNIFIER = 120;

/** How far each arrow key moves the crosshair, in frame pixels. */
const STEPS: Readonly<Record<string, FramePoint>> = {
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
};

type Props = {
  answer: (answer: PortalAnswer) => void;
  /** Who asks, as the dialog names them. */
  asker: string;
  body: FrozenDesk;
  /** Whether it is up; see {@link Presence}. */
  presence: Presence;
  screen: string | undefined;
};

/**
 * Picks a pixel of a frozen desk, with a magnifier around the crosshair. The
 * pointer or the arrow keys move it; a click or Enter picks. Dismissing it
 * cancels.
 */
export const PickColorDialog = ({
  answer,
  asker,
  body,
  presence,
  screen,
}: Props) => {
  const [at, setAt] = useState<FramePoint>({
    x: Math.floor(body.width / 2),
    y: Math.floor(body.height / 2),
  });
  const pointAt = (event: PointerEvent<HTMLButtonElement>) =>
    framePoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      body,
    );
  return (
    <ModalDialog
      closeButton={false}
      footer={
        <Button
          onClick={() => {
            answer(Answer.Canceled());
          }}
          variant="outline"
        >
          Cancel
        </Button>
      }
      onOpenChange={(open) => {
        if (!open) {
          answer(Answer.Canceled());
        }
      }}
      {...presence}
      screen={screen}
      size="xl"
      title="Pick a color"
    >
      <p className={askerStyles}>{`${asker} asks`}</p>
      <div className={layoutStyles}>
        <button
          aria-label={`Pick the pixel at ${String(at.x)}, ${String(at.y)}`}
          className={deskStyles}
          // The pointer moves the crosshair, so a click or Enter picks it.
          onClick={() => {
            answer(Answer.PickColor(at));
          }}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            const step = STEPS[event.key];
            if (step !== undefined) {
              event.preventDefault();
              setAt(moved(at, step, body));
            }
          }}
          onPointerMove={(event) => {
            setAt(pointAt(event));
          }}
          type="button"
        >
          <img
            alt="The desk"
            className={frameStyles}
            draggable={false}
            src={body.frame}
          />
        </button>
        <div
          aria-hidden
          className={magnifierStyles}
          style={magnified(body, at)}
        />
      </div>
    </ModalDialog>
  );
};

const askerStyles = css({ color: "muted", fontSize: "sm", margin: 0 });

const layoutStyles = flex({ align: "start", gap: 3, marginBlockStart: 3 });

const deskStyles = css({
  background: "none",
  border: "none",
  cursor: "crosshair",
  flex: 1,
  padding: 0,
});

const frameStyles = css({ display: "block", width: "full" });

const magnifierStyles = css({
  // The pixel that is picked: one enlarged pixel in the middle.
  _after: {
    content: '""',
    height: "12px",
    left: "54px",
    outlineColor: "accent",
    outlineStyle: "solid",
    outlineWidth: "1px",
    position: "absolute",
    top: "54px",
    width: "12px",
  },
  backgroundRepeat: "no-repeat",
  borderColor: "accent",
  borderRadius: "md",
  borderStyle: "solid",
  borderWidth: "2px",
  flexShrink: 0,
  height: "120px",
  imageRendering: "pixelated",
  position: "relative",
  width: "120px",
});

/** `at` moved by `step`, kept inside `frame`. */
const moved = (
  at: FramePoint,
  step: FramePoint,
  frame: { width: number; height: number },
): FramePoint => ({
  x: Math.min(frame.width - 1, Math.max(0, at.x + step.x)),
  y: Math.min(frame.height - 1, Math.max(0, at.y + step.y)),
});

/** The magnifier's view of `desk`, centered on pixel `at`. */
const magnified = (
  desk: FrozenDesk,
  at: FramePoint,
): {
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
} => {
  const offset = (pixel: number) =>
    `${String(MAGNIFIER / 2 - (pixel + 0.5) * ZOOM)}px`;
  return {
    backgroundImage: `url("${desk.frame}")`,
    backgroundPosition: `${offset(at.x)} ${offset(at.y)}`,
    backgroundSize: `${String(desk.width * ZOOM)}px ${String(desk.height * ZOOM)}px`,
  };
};
