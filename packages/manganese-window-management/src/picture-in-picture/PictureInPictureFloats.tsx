/// <reference types="@domicile-desktop/manganese-host/domicile-elements" />
import { IconButton } from "@domicile-desktop/component-library/IconButton";
import { Slider } from "@domicile-desktop/component-library/Slider";
import type { PictureInPicture } from "@domicile-desktop/sdk/desktop/picture-in-picture";
import { PICTURE_IN_PICTURE_SHOWN_EVENT } from "@domicile-desktop/sdk/desktop/picture-in-picture";
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
import type { Offset, Shape } from "./pip-box";
import {
  inPage,
  movedBox,
  offsetTo,
  openingBox,
  reshapedBox,
  resizedBox,
} from "./pip-box";
import { clockOf, playheadAt } from "./playhead";

type Props = {
  /**
   * Where browser window `window`'s page is drawn on the desktop, or
   * undefined while it is drawn nowhere.
   */
  pageFor: (window: string) => Rect | undefined;
  pictureInPicture: PictureInPicture;
  /** False while the desk is locked, so no video shows on the lock screen. */
  shown: boolean;
  /**
   * The workspace a video of browser window `window` opens on: its screen's,
   * or the focused screen's while the window is on none.
   */
  workspaceFor: (window: string) => Rect;
};

/**
 * Where a video floats, the workspace it stays on, the size of the video it
 * was placed for, and how far from its box it grows out of its page, if it
 * does.
 */
type Placed = {
  box: Rect;
  grownFrom: Offset | undefined;
  shape: Shape;
  workspace: Rect;
};

/**
 * The videos pages put in picture-in-picture, each a small float over every
 * window, on every workspace of its screen. A video opens in its screen's
 * bottom-right corner; it is dragged to move it, and by an edge to resize it
 * in its shape. Its controls show under the pointer. It grows out of its
 * place in its page, and shrinks back into it on "Back to tab".
 */
export const PictureInPictureFloats = ({
  pageFor,
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
  // A new video takes its opening box once its page says its size, so it
  // grows out of the page in its shape, and a gone one's is dropped, so a
  // video listed again later opens in the corner again. A video whose size
  // changed takes its new shape.
  const listed = placedFor(videos, placed, workspaceFor, pageFor);
  if (listed !== placed) {
    setPlaced(listed);
  }
  // A video that left picture-in-picture keeps its float while it fades, in
  // case the page's own video takes a frame or two to draw again.
  const [seen, setSeen] = useState(videos);
  const [leaving, setLeaving] = useState<ReadonlyMap<string, Left>>(
    () => new Map(),
  );
  if (seen !== videos) {
    setSeen(videos);
    const gone = seen.filter(
      ({ id }) => placed.has(id) && !videos.some((video) => video.id === id),
    );
    if (gone.length > 0) {
      setLeaving((before) => {
        const after = new Map(before);
        for (const video of gone) {
          const at = placed.get(video.id);
          if (at !== undefined) {
            after.set(video.id, { at, video });
          }
        }
        return after;
      });
    }
  }
  const forget = useCallback((id: string) => {
    setLeaving((before) => {
      const after = new Map(before);
      after.delete(id);
      return after;
    });
  }, []);
  const place = useCallback((id: string, box: Rect) => {
    setPlaced((before) => {
      const was = before.get(id);
      return was === undefined
        ? before
        : new Map(before).set(id, { ...was, box });
    });
  }, []);

  // One list, so a float keeps its element, and its <app> its last frame,
  // as it moves from listed to leaving.
  return shown
    ? [
        ...videos.map((video) => {
          const at = listed.get(video.id);
          return at === undefined ? undefined : (
            <Float
              at={at}
              key={video.id}
              leaving={false}
              onBox={place}
              onGone={forget}
              pageFor={pageFor}
              pictureInPicture={pictureInPicture}
              video={video}
            />
          );
        }),
        ...[...leaving.values()].map(({ at, video }) => (
          <Float
            at={at}
            key={video.id}
            leaving
            onBox={place}
            onGone={forget}
            pageFor={pageFor}
            pictureInPicture={pictureInPicture}
            video={video}
          />
        )),
      ]
    : undefined;
};

/** A video that left picture-in-picture, where its float was. */
type Left = { at: Placed; video: DomicilePictureInPictureVideo };

/**
 * `placed` for the `videos` with a size, or `placed` itself when no video
 * came, went or changed size.
 */
const placedFor = (
  listed: readonly DomicilePictureInPictureVideo[],
  placed: ReadonlyMap<string, Placed>,
  workspaceFor: (window: string) => Rect,
  pageFor: (window: string) => Rect | undefined,
): ReadonlyMap<string, Placed> => {
  const videos = listed.filter(({ height, width }) => height > 0 && width > 0);
  const same =
    videos.length === placed.size &&
    videos.every((video) => {
      const was = placed.get(video.id);
      return was !== undefined && sameShape(was.shape, video);
    });
  return same
    ? placed
    : new Map(
        videos.map((video) => {
          const was = placed.get(video.id);
          const shape = { height: video.height, width: video.width };
          if (was === undefined) {
            const workspace = workspaceFor(video.window);
            const box = openingBox(workspace, shape);
            const from = sourceOnDesktop(video, pageFor);
            return [
              video.id,
              {
                box,
                grownFrom: from === undefined ? undefined : offsetTo(box, from),
                shape,
                workspace,
              },
            ] as const;
          } else if (sameShape(was.shape, shape)) {
            return [video.id, was] as const;
          } else {
            return [
              video.id,
              {
                ...was,
                box: reshapedBox(was.box, was.workspace, shape),
                shape,
              },
            ] as const;
          }
        }),
      );
};

const sameShape = (a: Shape, b: Shape): boolean =>
  a.height === b.height && a.width === b.width;

/**
 * Where `video` is drawn in its page on the desktop now, or undefined when it
 * has no place there or its page is drawn nowhere.
 */
const sourceOnDesktop = (
  video: DomicilePictureInPictureVideo,
  pageFor: (window: string) => Rect | undefined,
): Rect | undefined => {
  const page = pageFor(video.window);
  return page === undefined || video.source === null
    ? undefined
    : inPage(page, video.source, video);
};

/** How a float moves on its own: out of its page, or back into it. */
/** An action that ends picture-in-picture, which a float shrinks before. */
type Ending = Extract<DomicilePictureInPictureAction, "back-to-page" | "close">;

/**
 * How a float moves on its own: hidden until its video is drawn, out of its
 * page, back into it before `ending`, and fading once the video left, from its
 * page's place when it went back there.
 */
type Motion =
  | { name: "waiting" }
  | { name: "growing"; offset: Offset }
  | { name: "returning"; offset: Offset; ending: Ending }
  | { name: "leaving"; offset: Offset | undefined };

/** The float's `data-motion`, for its styles. */
const motionName = (motion: Motion | undefined): string | undefined =>
  motion?.name === "leaving" && motion.offset !== undefined
    ? "leaving-page"
    : motion?.name;

/** The offset `motion` moves by, if any. */
const offsetOf = (motion: Motion | undefined): Offset | undefined => {
  switch (motion?.name) {
    case "growing":
    case "returning":
    case "leaving": {
      return motion.offset;
    }
    case "waiting":
    case undefined: {
      return undefined;
    }
  }
};

/** Custom properties for the `pictureInPicture*` keyframes. */
const motionStyle = (offset: Offset | undefined): Record<string, string> =>
  offset === undefined
    ? {}
    : {
        "--pip-scale": offset.scale.toString(),
        "--pip-x": `${offset.x.toString()}px`,
        "--pip-y": `${offset.y.toString()}px`,
      };

type FloatProps = {
  at: Placed;
  /** True once the video left picture-in-picture: the float fades, then goes. */
  leaving: boolean;
  onBox: (id: string, box: Rect) => void;
  /** The float faded after its video left. */
  onGone: (id: string) => void;
  pageFor: (window: string) => Rect | undefined;
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
  at: { box, grownFrom, workspace },
  leaving,
  onBox,
  onGone,
  pageFor,
  pictureInPicture,
  video,
}: FloatProps) => {
  const { id } = video;
  const [hovered, setHovered] = useState(false);
  const [motion, setMotion] = useState<Motion | undefined>({
    name: "waiting",
  });
  // A float whose video left fades where it is: in its page's place when it
  // shrank back there, so the page's own video shows through as it fades.
  if (leaving && motion?.name !== "leaving") {
    setMotion({
      name: "leaving",
      offset: motion?.name === "returning" ? motion.offset : undefined,
    });
  }
  // Hidden until its <app> draws the video, so it never grows as an empty
  // box over the page.
  const [app, setApp] = useState<Element | null>(null);
  useEffect(() => {
    if (app === null) {
      return undefined;
    } else {
      const drawnMotion: Motion | undefined =
        grownFrom === undefined
          ? undefined
          : { name: "growing", offset: grownFrom };
      const drawn = () => {
        setMotion((was) => (was?.name === "waiting" ? drawnMotion : was));
      };
      app.addEventListener(PICTURE_IN_PICTURE_SHOWN_EVENT, drawn);
      return () => {
        app.removeEventListener(PICTURE_IN_PICTURE_SHOWN_EVENT, drawn);
      };
    }
  }, [app, grownFrom]);
  const act = useCallback(
    (action: DomicilePictureInPictureAction) => {
      pictureInPicture.act(id, action);
    },
    [id, pictureInPicture],
  );

  /**
   * Shrinks back into where its page shows the video now, which may have
   * moved, then does `action`; at once while the page is drawn nowhere.
   */
  const end = (action: Ending) => {
    const into = sourceOnDesktop(video, pageFor);
    if (into === undefined) {
      act(action);
    } else {
      setMotion({
        ending: action,
        name: "returning",
        offset: offsetTo(box, into),
      });
    }
  };

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
      data-motion={motionName(motion)}
      data-picture-in-picture={id}
      onAnimationEnd={(event) => {
        // The shadow's and the controls' fades end here too.
        if (event.target === event.currentTarget) {
          switch (motion?.name) {
            case "growing": {
              setMotion(undefined);
              break;
            }
            case "returning": {
              act(motion.ending);
              break;
            }
            case "leaving": {
              onGone(id);
              break;
            }
            case "waiting":
            case undefined: {
              break;
            }
          }
        }
      }}
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
      // Inline because the box is a runtime value Panda cannot extract.
      style={{
        ...motionStyle(offsetOf(motion)),
        blockSize: `${box.height.toString()}px`,
        inlineSize: `${box.width.toString()}px`,
        insetBlockStart: `${box.y.toString()}px`,
        insetInlineStart: `${box.x.toString()}px`,
      }}
    >
      <div aria-hidden className={shadowStyles} />
      <div className={clipStyles}>
        <app className={videoStyles} picture-in-picture={id} ref={setApp} />
        <div
          className={controlsStyles({
            shown: hovered && motion === undefined,
          })}
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
                end("back-to-page");
              }}
            >
              <ArrowSquareInIcon size={16} />
            </IconButton>
          </div>
          <div className={cornerStyles({ side: "end" })}>
            <IconButton
              label="Close"
              onClick={() => {
                end("close");
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
          {video.duration > 0 && (
            <Progress
              onSeek={(seconds) => {
                pictureInPicture.seek(id, seconds);
              }}
              ticking={hovered}
              video={video}
            />
          )}
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
    </div>
  );
};

/**
 * Whether a press on `target` landed on one of the float's buttons or its
 * progress bar.
 */
const onControl = (target: EventTarget): boolean =>
  target instanceof Element &&
  target.closest("button, [data-picture-in-picture-progress]") !== null;

/** How often the time moves on while it shows. */
const TICK_MS = 1000;

/**
 * The video's time and how far it is, moved on by the shell's clock. Moving
 * the bar moves the video once it is let go.
 */
const Progress = ({
  onSeek,
  ticking,
  video,
}: {
  onSeek: (seconds: number) => void;
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
  // Where the bar is held, while it is.
  const [held, setHeld] = useState<number | undefined>(undefined);
  const at = held ?? playheadAt(heard, Math.max(now, heard.at));
  return (
    <>
      <span className={clockStyles}>
        {`${clockOf(at)} / ${clockOf(duration)}`}
      </span>
      <div className={progressStyles} data-picture-in-picture-progress="">
        <Slider
          label="Position"
          max={duration}
          min={0}
          onValueChange={setHeld}
          onValueCommitted={(seconds) => {
            setHeld(undefined);
            onSeek(seconds);
          }}
          value={at}
        />
      </div>
    </>
  );
};

// Over every window, as Chrome's picture-in-picture window is, and under the
// panels with the toasts, which come later in the document. The shell's float
// border and shadow, with no title bar: the video is the window.
//
// Hidden until its video is drawn. It grows out of its place in its page and
// shrinks back into it, about its top left, by the offset `motionStyle` sets.
// Long moves, so `emphasized`. Returning holds its last frame until the page
// takes the video back; then it fades there over the page's own video, which
// can take a frame or two to draw again.
const floatStyles = css({
  "&[data-motion=growing]": {
    animationDuration: "token(durations.slow)",
    animationName: "pictureInPictureGrowing",
    animationTimingFunction: "token(easings.emphasized)",
  },
  "&[data-motion=leaving], &[data-motion=leaving-page]": {
    animationDuration: "token(durations.fast)",
    animationFillMode: "forwards",
    animationName: "pictureInPictureLeaving",
    animationTimingFunction: "token(easings.out)",
    pointerEvents: "none",
  },
  "&[data-motion=returning]": {
    animationDuration: "token(durations.slow)",
    animationFillMode: "forwards",
    animationName: "pictureInPictureReturning",
    animationTimingFunction: "token(easings.emphasized)",
  },
  "&[data-motion=waiting]": { opacity: 0 },
  position: "fixed",
  transformOrigin: "top left",
  zIndex: "toast",
});

// A layer of its own, outside the clip, so it fades in as the video grows out
// of its page and out as it shrinks back.
const shadowStyles = css({
  "[data-motion=growing] > &": {
    animationDuration: "token(durations.slow)",
    animationName: "pictureInPictureShadowIn",
    animationTimingFunction: "token(easings.emphasized)",
  },
  // Faded out as it shrank back into its page.
  "[data-motion=leaving-page] > &": { opacity: 0 },
  "[data-motion=returning] > &": {
    animationDuration: "token(durations.slow)",
    animationFillMode: "forwards",
    animationName: "pictureInPictureShadowOut",
    animationTimingFunction: "token(easings.emphasized)",
  },
  borderRadius: "lg",
  boxShadow: "lifted",
  inset: 0,
  position: "absolute",
});

const clipStyles = css({
  border: "1px solid {colors.border}",
  borderRadius: "lg",
  inset: 0,
  overflow: "hidden",
  position: "absolute",
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

// Only as big as its buttons, so it covers neither the corners' buttons nor
// the progress bar.
const middleStyles = css({
  alignItems: "center",
  display: "flex",
  gap: 2.5,
  insetBlockStart: "50%",
  insetInlineStart: "50%",
  position: "absolute",
  translate: "-50% -50%",
});

const clockStyles = css({
  fontSize: "xs",
  fontVariantNumeric: "tabular-nums",
  insetBlockEnd: 5,
  insetInlineStart: 2,
  position: "absolute",
});

// Clear of the bottom edge's resize grip.
const progressStyles = css({
  display: "flex",
  insetBlockEnd: 1.5,
  insetInline: 2,
  position: "absolute",
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
