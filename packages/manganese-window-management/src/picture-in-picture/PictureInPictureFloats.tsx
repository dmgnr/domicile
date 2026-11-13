/// <reference types="@domicile-desktop/manganese-host/domicile-elements" />
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import type { PictureInPicture } from "@domicile-desktop/sdk/desktop/picture-in-picture";
import type {
  DomicilePictureInPictureAction,
  DomicilePictureInPictureVideo,
} from "@domicile-desktop/sdk/domicile-host";
import { ArrowSquareInIcon } from "@phosphor-icons/react/dist/ssr/ArrowSquareIn";
import { PauseIcon } from "@phosphor-icons/react/dist/ssr/Pause";
import { PlayIcon } from "@phosphor-icons/react/dist/ssr/Play";
import { SkipBackIcon } from "@phosphor-icons/react/dist/ssr/SkipBack";
import { SkipForwardIcon } from "@phosphor-icons/react/dist/ssr/SkipForward";
import { XIcon } from "@phosphor-icons/react/dist/ssr/X";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { css, cva } from "../../styled-system/css";
import { Direction } from "../direction";
import type { Grip } from "../floating/float";
import { followPress } from "../follow-press";
import type { Rect } from "../rect";
import { movedBox, openingBox, resizedBox } from "./pip-box";
import { clockOf, playheadAt } from "./playhead";

type Props = {
  pictureInPicture: PictureInPicture;
  /** False while the desk is locked, so no video shows on the lock screen. */
  shown: boolean;
  /**
   * The workspace a video of browser window `window` opens on: its screen's,
   * or the focused screen's while the window is on none.
   */
  workspaceFor: (window: string) => Rect;
};

/** Where a video floats, and the workspace it stays on. */
type Placed = { box: Rect; workspace: Rect };

/**
 * The videos pages put in picture-in-picture, each a small float over every
 * window, on every workspace of its screen. A video opens in its screen's
 * bottom-right corner; it is dragged to move it, and by an edge to resize it
 * in its shape. Its controls show under the pointer.
 */
export const PictureInPictureFloats = ({
  pictureInPicture,
  shown,
  workspaceFor,
}: Props) => {
  const subscribe = useCallback(
    (changed: () => void) => pictureInPicture.on("change", changed),
    [pictureInPicture],
  );
  const videos = useSyncExternalStore(subscribe, () => pictureInPicture.videos);
  const [placed, setPlaced] = useState<ReadonlyMap<string, Placed>>(
    () => new Map(),
  );
  // A new video takes its opening box once, and a gone one's is dropped, so
  // a video listed again later opens in the corner again.
  const listed = placedFor(videos, placed, workspaceFor);
  if (listed !== placed) {
    setPlaced(listed);
  }
  const place = useCallback((id: string, box: Rect) => {
    setPlaced((before) => {
      const was = before.get(id);
      return was === undefined
        ? before
        : new Map(before).set(id, { ...was, box });
    });
  }, []);

  return shown
    ? videos.map((video) => {
        const at = listed.get(video.id);
        return at === undefined ? undefined : (
          <Float
            at={at}
            key={video.id}
            onBox={place}
            pictureInPicture={pictureInPicture}
            video={video}
          />
        );
      })
    : undefined;
};

/** `placed` for `videos`, or `placed` itself when no video came or went. */
const placedFor = (
  videos: readonly DomicilePictureInPictureVideo[],
  placed: ReadonlyMap<string, Placed>,
  workspaceFor: (window: string) => Rect,
): ReadonlyMap<string, Placed> => {
  const same =
    videos.length === placed.size && videos.every(({ id }) => placed.has(id));
  return same
    ? placed
    : new Map(
        videos.map((video) => {
          const was = placed.get(video.id);
          if (was === undefined) {
            const workspace = workspaceFor(video.window);
            return [
              video.id,
              { box: openingBox(workspace, video), workspace },
            ] as const;
          } else {
            return [video.id, was] as const;
          }
        }),
      );
};

type FloatProps = {
  at: Placed;
  onBox: (id: string, box: Rect) => void;
  pictureInPicture: PictureInPicture;
  video: DomicilePictureInPictureVideo;
};

/** The edges and corners that resize a float. */
type Edge =
  | "bottom"
  | "bottom-left"
  | "bottom-right"
  | "left"
  | "right"
  | "top"
  | "top-left"
  | "top-right";

const GRIPS: readonly { grip: Grip; name: Edge }[] = [
  {
    grip: { horizontal: undefined, vertical: Direction.Up },
    name: "top",
  },
  {
    grip: { horizontal: undefined, vertical: Direction.Down },
    name: "bottom",
  },
  {
    grip: { horizontal: Direction.Left, vertical: undefined },
    name: "left",
  },
  {
    grip: { horizontal: Direction.Right, vertical: undefined },
    name: "right",
  },
  {
    grip: { horizontal: Direction.Left, vertical: Direction.Up },
    name: "top-left",
  },
  {
    grip: { horizontal: Direction.Right, vertical: Direction.Up },
    name: "top-right",
  },
  {
    grip: { horizontal: Direction.Left, vertical: Direction.Down },
    name: "bottom-left",
  },
  {
    grip: { horizontal: Direction.Right, vertical: Direction.Down },
    name: "bottom-right",
  },
];

/** One video: the page's own surface, with the shell's controls over it. */
const Float = ({
  at: { box, workspace },
  onBox,
  pictureInPicture,
  video,
}: FloatProps) => {
  const { id } = video;
  const [hovered, setHovered] = useState(false);
  const act = useCallback(
    (action: DomicilePictureInPictureAction) => {
      pictureInPicture.act(id, action);
    },
    [id, pictureInPicture],
  );

  // The page hears its PictureInPictureWindow's size from here.
  useEffect(() => {
    pictureInPicture.resize(id, box.width, box.height);
  }, [box.height, box.width, id, pictureInPicture]);

  /**
   * Follows a press from `box` as pressed, through `moved`. A press on a
   * control is the control's.
   */
  const follow = (
    event: ReactPointerEvent<HTMLElement>,
    moved: (dx: number, dy: number) => Rect,
  ) => {
    if (!onControl(event.target)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      const from = { x: event.clientX, y: event.clientY };
      followPress({
        element: event.currentTarget,
        onEnd: () => undefined,
        onMove: ({ clientX, clientY }) => {
          onBox(id, moved(clientX - from.x, clientY - from.y));
        },
        pointerId: event.pointerId,
      });
    }
  };

  return (
    <div
      className={floatStyles}
      data-picture-in-picture={id}
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
      // Inline because the box is a runtime value Panda cannot extract.
      style={{
        blockSize: `${box.height.toString()}px`,
        inlineSize: `${box.width.toString()}px`,
        insetBlockStart: `${box.y.toString()}px`,
        insetInlineStart: `${box.x.toString()}px`,
      }}
    >
      <app className={videoStyles} picture-in-picture={id} />
      <div
        className={controlsStyles({ shown: hovered })}
        onPointerDown={(event) => {
          follow(event, (dx, dy) => movedBox(box, workspace, dx, dy));
        }}
      >
        <div className={scrimStyles({ edge: "top" })} />
        <div className={scrimStyles({ edge: "bottom" })} />
        <div className={cornerStyles({ side: "start" })}>
          <IconButton
            label="Back to tab"
            onClick={() => {
              act("back-to-page");
            }}
          >
            <ArrowSquareInIcon size={16} />
          </IconButton>
        </div>
        <div className={cornerStyles({ side: "end" })}>
          <IconButton
            label="Close"
            onClick={() => {
              act("close");
            }}
          >
            <XIcon size={16} />
          </IconButton>
        </div>
        <div className={middleStyles}>
          {video.canPreviousTrack && (
            <IconButton
              label="Previous track"
              onClick={() => {
                act("previous-track");
              }}
            >
              <SkipBackIcon size={16} weight="fill" />
            </IconButton>
          )}
          {video.canPlay &&
            (video.playing ? (
              <IconButton
                label="Pause"
                onClick={() => {
                  act("pause");
                }}
              >
                <PauseIcon size={20} weight="fill" />
              </IconButton>
            ) : (
              <IconButton
                label="Play"
                onClick={() => {
                  act("play");
                }}
              >
                <PlayIcon size={20} weight="fill" />
              </IconButton>
            ))}
          {video.canNextTrack && (
            <IconButton
              label="Next track"
              onClick={() => {
                act("next-track");
              }}
            >
              <SkipForwardIcon size={16} weight="fill" />
            </IconButton>
          )}
        </div>
        {video.duration > 0 && <Progress ticking={hovered} video={video} />}
      </div>
      {GRIPS.map(({ grip, name }) => (
        <div
          aria-hidden
          className={gripStyles({ edge: name })}
          key={name}
          onPointerDown={(event) => {
            follow(event, (dx, dy) =>
              resizedBox(box, workspace, video, grip, dx, dy),
            );
          }}
        />
      ))}
    </div>
  );
};

/** Whether a press on `target` landed on one of the float's buttons. */
const onControl = (target: EventTarget): boolean =>
  target instanceof Element && target.closest("button") !== null;

/** How often the time moves on while it shows. */
const TICK_MS = 1000;

/** The video's time and how far it is, moved on by the shell's clock. */
const Progress = ({
  ticking,
  video,
}: {
  ticking: boolean;
  video: DomicilePictureInPictureVideo;
}) => {
  const { duration, playbackRate, playing, position } = video;
  // When the page last said where it is.
  const heard = useMemo(
    () => ({
      at: performance.now(),
      duration,
      playing,
      position,
      rate: playbackRate,
    }),
    [duration, playbackRate, playing, position],
  );
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (ticking && playing) {
      const tick = setInterval(() => {
        setNow(performance.now());
      }, TICK_MS);
      return () => {
        clearInterval(tick);
      };
    } else {
      return undefined;
    }
  }, [playing, ticking]);
  const at = playheadAt(heard, Math.max(now, heard.at));
  return (
    <>
      <span className={clockStyles}>
        {`${clockOf(at)} / ${clockOf(duration)}`}
      </span>
      <div className={trackStyles}>
        <div
          className={playedStyles}
          // Inline: how far is a runtime value.
          style={{ inlineSize: `${((at / duration) * 100).toString()}%` }}
        />
      </div>
    </>
  );
};

// Over every window, as Chrome's picture-in-picture window is, and under the
// panels with the toasts, which come later in the document. The shell's float
// border and shadow, with no title bar: the video is the window.
const floatStyles = css({
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  boxShadow: "lifted",
  overflow: "hidden",
  position: "fixed",
  zIndex: "toast",
});

const videoStyles = css({
  blockSize: "100%",
  display: "block",
  inlineSize: "100%",
});

// Hidden until the pointer is over the video. Light lettering, as on the
// wallpaper, since a video can be any color.
const controlsStyles = cva({
  base: {
    color: "onPhoto",
    cursor: "move",
    inset: 0,
    position: "absolute",
    textShadow: "textOverPhoto",
    transition: "opacity {durations.fast} {easings.default}",
  },
  variants: {
    shown: {
      false: { opacity: 0 },
      true: { opacity: 1 },
    },
  },
});

// A band darkening the top and the bottom of the video, under the controls.
const scrimStyles = cva({
  base: {
    backgroundImage: "{gradients.scrimOverPhoto}",
    blockSize: 12,
    insetInline: 0,
    position: "absolute",
  },
  variants: {
    edge: {
      bottom: { insetBlockEnd: 0, transform: "scaleY(-1)" },
      top: { insetBlockStart: 0 },
    },
  },
});

const cornerStyles = cva({
  base: { insetBlockStart: 2, position: "absolute" },
  variants: {
    side: {
      end: { insetInlineEnd: 2 },
      start: { insetInlineStart: 2 },
    },
  },
});

const middleStyles = css({
  alignItems: "center",
  display: "flex",
  gap: 2.5,
  inset: 0,
  justifyContent: "center",
  position: "absolute",
});

const clockStyles = css({
  fontSize: "xs",
  fontVariantNumeric: "tabular-nums",
  insetBlockEnd: 3.5,
  insetInlineStart: 2,
  position: "absolute",
});

const trackStyles = css({
  backgroundColor: "color-mix(in oklab, {colors.onPhoto} 30%, transparent)",
  blockSize: 0.75,
  borderRadius: "full",
  insetBlockEnd: 2,
  insetInline: 2,
  overflow: "hidden",
  position: "absolute",
});

const playedStyles = css({
  backgroundColor: "onPhoto",
  blockSize: "100%",
});

// Edges grab 1.5 (6px) into the float, and corners 2 (8px) each way: short
// of the corner buttons, which start 2 in.
const gripStyles = cva({
  base: { position: "absolute" },
  variants: {
    edge: {
      bottom: {
        blockSize: 1.5,
        cursor: "ns-resize",
        insetBlockEnd: 0,
        insetInline: 0,
      },
      "bottom-left": {
        blockSize: 2,
        cursor: "nesw-resize",
        inlineSize: 2,
        insetBlockEnd: 0,
        insetInlineStart: 0,
      },
      "bottom-right": {
        blockSize: 2,
        cursor: "nwse-resize",
        inlineSize: 2,
        insetBlockEnd: 0,
        insetInlineEnd: 0,
      },
      left: {
        cursor: "ew-resize",
        inlineSize: 1.5,
        insetBlock: 0,
        insetInlineStart: 0,
      },
      right: {
        cursor: "ew-resize",
        inlineSize: 1.5,
        insetBlock: 0,
        insetInlineEnd: 0,
      },
      top: {
        blockSize: 1.5,
        cursor: "ns-resize",
        insetBlockStart: 0,
        insetInline: 0,
      },
      "top-left": {
        blockSize: 2,
        cursor: "nwse-resize",
        inlineSize: 2,
        insetBlockStart: 0,
        insetInlineStart: 0,
      },
      "top-right": {
        blockSize: 2,
        cursor: "nesw-resize",
        inlineSize: 2,
        insetBlockStart: 0,
        insetInlineEnd: 0,
      },
    },
  },
});
