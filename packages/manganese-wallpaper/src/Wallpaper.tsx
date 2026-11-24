import {
  useDisplays,
  useScreenRegion,
} from "@domicile-desktop/component-library/DisplayProvider";
import type { Theme } from "@domicile-desktop/component-library/theme-core";
import { THEMES } from "@domicile-desktop/component-library/theme-core";
import { usePictureUrl } from "@domicile-desktop/component-library/usePictureUrl";
import type { Files } from "@domicile-desktop/sdk/desktop/files";
import { useEffect, useEffectEvent, useState } from "react";

import { css } from "../styled-system/css";
import { token } from "../styled-system/tokens";
import { Layer, layerStyles } from "./layer";
import type { Order } from "./order";
import { shuffledOrder } from "./order";
import { Photo } from "./Photo";
import { DEFAULT_WALLPAPERS, photoSizes, WALLPAPER_FALLBACKS } from "./photos";
import type { Wallpapers } from "./wallpapers";
import { isWebAddress } from "./wallpapers";

type FileCalls = Pick<Files, "read">;

/** How long each photograph shows before the next fades in. */
const DWELL_MS = 60_000;

/**
 * How long the first photographs have to load before the photograph from the
 * repository shows. Shown at once, it would flash on every start.
 */
const FALLBACK_DELAY_MS = 3000;

/**
 * Crossfade duration in ms. Read from the same token as the CSS transition so
 * the two stay in sync.
 */
const CROSSFADE_MS = Number.parseFloat(token("durations.crossfade")) * 1000;

type Props = {
  /** Reads the photographs given by path. */
  files: FileCalls;
  /**
   * Holds the rotation, as while the theme wipe plays: a crossfade under it
   * would show through the new theme's frame. A photograph due meanwhile
   * fades in once released.
   */
  held?: boolean;
  /**
   * Keeps the photograph on screen: the rotation never advances, so
   * nothing redraws the wallpaper while the desktop is idle.
   */
  still?: boolean;
  /**
   * The order each pass through a rotation shows its photographs in.
   * Defaults to a fresh shuffle each pass.
   */
  order?: Order;
  /**
   * A picture an application set through the Wallpaper portal, as a URL. Shown
   * on every screen in place of the rotation.
   */
  picture?: string | undefined;
  /** Each theme's photographs. Defaults to the built-in ones. */
  photos?: Wallpapers;
  /** The theme shown, whose rotation advances. */
  theme: Theme;
};

/** Each rotation's first step. */
const STARTS: Readonly<Record<Theme, number>> = { dark: 0, light: 0 };

/**
 * The desktop wallpaper: a photograph rotation that changes every minute, or
 * the picture an application set. See
 * `packages/manganese-wallpaper/docs/WALLPAPER.md`.
 *
 * - Each screen gets its own copy, cropped to that monitor, so nothing is
 *   drawn in the gaps between monitors. The copies are not `<Screen>`s, which
 *   would add a second region per display and break lookups by
 *   `data-screen`.
 * - Every copy shows the same step, so the screens change together.
 * - Both themes' rotations stay mounted and CSS shows one, so a theme switch
 *   shows a loaded photograph and needs only the `data-theme` attribute. The
 *   shown rotation mounts only the photographs on screen and the next one.
 *   The other holds its photograph and loads no next one until it is shown.
 * - It takes no pointer events.
 */
export const Wallpaper = ({
  files,
  held = false,
  still = false,
  order: givenOrder,
  photos = DEFAULT_WALLPAPERS,
  picture,
  theme,
}: Props) => {
  const displays = useDisplays();
  const [shuffled] = useState(() =>
    shuffledOrder(Math.floor(Math.random() * 2 ** 32)),
  );
  const order = givenOrder ?? shuffled;
  const [steps, setSteps] = useState(STARTS);
  // Whether the shown rotation's fade has finished.
  const [settled, setSettled] = useState(true);
  // Whether a minute has passed since the last step.
  const [due, setDue] = useState(false);
  // Whether the photograph from the repository shows: once the first
  // photographs are late or one fails.
  const [fallback, setFallback] = useState(false);
  const showFallback = () => {
    setFallback(true);
  };
  // An effect event, so a theme switch does not advance the hidden rotation.
  const advance = useEffectEvent(() => {
    setSteps((previous) => ({ ...previous, [theme]: previous[theme] + 1 }));
    setSettled(false);
    setDue(false);
  });

  useEffect(() => {
    if (still) {
      return;
    }
    const timer = setInterval(() => {
      setDue(true);
    }, DWELL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [still]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFallback(true);
    }, FALLBACK_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (due && !held) {
      advance();
    }
  }, [due, held]);

  useEffect(() => {
    if (settled) {
      return;
    }
    const timer = setTimeout(() => {
      setSettled(true);
    }, CROSSFADE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [settled]);

  return (
    <div className={sheetStyles}>
      {displays === undefined ? (
        // The whole page until the host describes the screens, so the
        // desktop is not blank while it starts.
        <ScreenWallpaper
          fallback={fallback}
          files={files}
          onPhotoError={showFallback}
          order={order}
          photos={photos}
          picture={picture}
          screen={undefined}
          settled={settled}
          shown={theme}
          sizes={photoSizes(undefined)}
          steps={steps}
        />
      ) : (
        displays.map(({ name, size }) => (
          <ScreenWallpaper
            fallback={fallback}
            files={files}
            key={name}
            onPhotoError={showFallback}
            order={order}
            photos={photos}
            picture={picture}
            screen={name}
            settled={settled}
            shown={theme}
            sizes={photoSizes(size)}
            steps={steps}
          />
        ))
      )}
    </div>
  );
};

type RotationProps = {
  /** Whether the photograph from the repository shows. */
  fallback: boolean;
  /** Reads the photographs given by path. */
  files: FileCalls;
  /** Called when a photograph fails to load. */
  onPhotoError: () => void;
  /** The order each pass shows the photographs in. */
  order: Order;
  /** Each theme's photographs. */
  photos: Wallpapers;
  /** Whether the shown rotation's fade has finished. */
  settled: boolean;
  /** How wide the photographs show, as an `<img sizes>`. */
  sizes: string;
  /** The theme shown. */
  shown: Theme;
  /** Each theme's step. */
  steps: Readonly<Record<Theme, number>>;
};

/**
 * The rotation on display `screen`, or the whole page; or `picture` in its
 * place.
 */
const ScreenWallpaper = ({
  picture,
  screen,
  ...rotation
}: RotationProps & {
  picture: string | undefined;
  screen: string | undefined;
}) => (
  <div className={screenStyles} style={useScreenRegion(screen)}>
    {picture === undefined ? (
      <Rotation {...rotation} />
    ) : (
      // Empty `alt` because the wallpaper is decorative.
      <img
        alt=""
        className={layerStyles}
        data-wallpaper={Layer.Current}
        src={picture}
      />
    )}
  </div>
);

/**
 * Both themes' photographs at their steps, over each theme's photograph from
 * the repository once `fallback`.
 */
const Rotation = ({
  fallback,
  files,
  onPhotoError,
  order,
  photos,
  settled,
  shown,
  sizes,
  steps,
}: RotationProps) => (
  <>
    {THEMES.map((theme) => (
      <div
        className={rotationStyles[theme]}
        data-wallpaper-theme={theme}
        key={theme}
      >
        {/* Empty `alt` because the wallpaper is decorative. The role is an
            attribute so one stylesheet covers all states and tests can read
            it. */}
        <img
          alt=""
          className={layerStyles}
          data-wallpaper={fallback ? Layer.Fallback : Layer.Waiting}
          src={WALLPAPER_FALLBACKS[theme]}
        />
        {mountedSteps(
          steps[theme],
          photos[theme].length,
          settled,
          theme === shown,
        ).map((step) => (
          <ConfiguredPhoto
            files={files}
            key={step}
            layer={layerOf(step, steps[theme], settled || theme !== shown)}
            onError={onPhotoError}
            photo={photoAt(order, photos[theme], step)}
            sizes={sizes}
          />
        ))}
      </div>
    ))}
  </>
);

/**
 * The photograph `photo`, a web address or a path. A path is read through
 * `files` once mounted, so only the photographs on screen and next are held.
 */
const ConfiguredPhoto = ({
  files,
  layer,
  onError,
  photo,
  sizes,
}: {
  files: FileCalls;
  layer: Layer;
  onError: () => void;
  photo: string;
  sizes: string;
}) =>
  isWebAddress(photo) ? (
    <Photo layer={layer} onError={onError} sizes={sizes} src={photo} />
  ) : (
    <PathPhoto
      files={files}
      layer={layer}
      onError={onError}
      path={photo}
      sizes={sizes}
    />
  );

/** The photograph at `path`, shown once read. */
const PathPhoto = ({
  files,
  layer,
  onError,
  path,
  sizes,
}: {
  files: FileCalls;
  layer: Layer;
  onError: () => void;
  path: string;
  sizes: string;
}) => {
  const url = usePictureUrl(files, path);
  return url === undefined ? undefined : (
    <Photo layer={layer} onError={onError} sizes={sizes} src={url} />
  );
};

/**
 * The steps whose photographs are mounted at `step`: on screen, fading out,
 * or next in the `shown` rotation. Keyed by step, so the next photograph
 * stays mounted as it becomes current. It mounts a whole step early so it has
 * loaded before it fades in. The rest stay unmounted, so the page does not
 * hold every 4K photograph at once. A hidden rotation mounts only its
 * photograph on screen, which does not change.
 */
const mountedSteps = (
  step: number,
  length: number,
  settled: boolean,
  shown: boolean,
): number[] => {
  if (length === 0) {
    return [];
  } else if (!shown) {
    return [step];
  } else if (settled || step === 0) {
    return [step, step + 1];
  } else {
    return [step - 1, step, step + 1];
  }
};

/** The role of the photograph of `photoStep` on this `step`. */
const layerOf = (photoStep: number, step: number, settled: boolean): Layer => {
  if (photoStep === step) {
    return Layer.Current;
  } else if (!settled && photoStep === step - 1) {
    return Layer.Previous;
  } else {
    return Layer.Waiting;
  }
};

/** The photograph `photos` shows on `step`, in its pass's `order`. */
const photoAt = (
  order: Order,
  photos: readonly string[],
  step: number,
): string => {
  const photo = order(photos, Math.floor(step / photos.length))[
    step % photos.length
  ];
  if (photo === undefined) {
    throw new Error(
      `the wallpaper order has no photograph for step ${step.toString()}`,
    );
  } else {
    return photo;
  }
};

const sheetStyles = css({
  inset: 0,
  // Scopes the layers' `z-index` here. Otherwise the current layer would
  // stack in the page's context, over the chrome and level with floats.
  isolation: "isolate",
  pointerEvents: "none",
  // The viewport is sized to the whole desktop, so the screens' page-space
  // regions land on their monitors.
  position: "fixed",
  // The depth of a tab a tab switch is hiding (`COVERED` in `placement.ts`).
  // It comes later in the document, so it draws over the wallpaper. Higher,
  // the wallpaper would show through a window opening or closing in front.
  zIndex: -2,
});

// The whole sheet, narrowed to a monitor by the region from
// `useScreenRegion`.
const screenStyles = css({
  inset: 0,
  position: "absolute",
});

// `contents` keeps the layers positioned and stacked against the screen.
const rotationStyles: Record<Theme, string> = {
  dark: css({ _light: { display: "none" } }),
  light: css({ _light: { display: "contents" }, display: "none" }),
};
