// The stand-in for Electron's `screen`: the desktop's displays, as
// `domicile list-displays --json` and `domicile subscribe displays` give them.

import { EventEmitter } from "node:events";

/** A display as `domicile list-displays --json` prints it. */
export type ListedDisplay = {
  readonly name: string;
  readonly position: readonly [number, number];
  /** Logical, after rotation. */
  readonly size: readonly [number, number];
  /** Physical, before rotation. */
  readonly mode?: readonly [number, number];
  readonly refresh_mhz?: number;
  readonly transform?: "normal" | "rotate-90" | "rotate-180" | "rotate-270";
  readonly names?: readonly string[];
  readonly lit?: boolean;
};

type Point = { x: number; y: number };
type Rectangle = Point & { width: number; height: number };

/** Electron's `Display`. */
export type Display = {
  readonly id: number;
  readonly label: string;
  readonly bounds: Rectangle;
  readonly workArea: Rectangle;
  readonly size: { width: number; height: number };
  readonly workAreaSize: { width: number; height: number };
  readonly scaleFactor: number;
  readonly rotation: number;
  readonly internal: boolean;
  readonly monochrome: boolean;
  readonly accelerometerSupport: "unknown";
  readonly touchSupport: "unknown";
  readonly colorDepth: number;
  readonly colorSpace: string;
  readonly depthPerComponent: number;
  readonly displayFrequency: number;
  readonly detected: boolean;
  readonly maximumCursorSize: { width: number; height: number };
  readonly nativeOrigin: Point;
};

const ROTATION = {
  normal: 0,
  "rotate-90": 90,
  "rotate-180": 180,
  "rotate-270": 270,
};

/** A stable id from the display's name, as Chromium's comes from its EDID. */
const idOf = (name: string) => {
  let hash = 0;
  for (const char of name) {
    hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
};

export const asElectronDisplay = (listed: ListedDisplay): Display => {
  const [x, y] = listed.position;
  const [width, height] = listed.size;
  const rotation = ROTATION[listed.transform ?? "normal"];
  const sideways = rotation === 90 || rotation === 270;
  const physicalWidth =
    listed.mode === undefined ? width : listed.mode[sideways ? 1 : 0];
  const bounds = { height, width, x, y };
  const names = listed.names ?? [listed.name];
  return {
    accelerometerSupport: "unknown",
    bounds,
    colorDepth: 24,
    colorSpace: "{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}",
    depthPerComponent: 8,
    detected: true,
    displayFrequency: (listed.refresh_mhz ?? 60_000) / 1000,
    id: idOf(listed.name),
    internal: names.some((name) => /^(eDP|LVDS|DSI)-/.test(name)),
    label: names.at(-1) ?? listed.name,
    maximumCursorSize: { height: 0, width: 0 },
    monochrome: false,
    nativeOrigin: { x, y },
    rotation,
    scaleFactor:
      width === 0 ? 1 : Math.round((physicalWidth / width) * 100) / 100,
    size: { height, width },
    touchSupport: "unknown",
    workArea: bounds,
    workAreaSize: { height, width },
  };
};

const distance = (point: Point, { x, y, width, height }: Rectangle) => {
  const dx = Math.max(x - point.x, 0, point.x - (x + width));
  const dy = Math.max(y - point.y, 0, point.y - (y + height));
  return dx * dx + dy * dy;
};

const overlap = (a: Rectangle, b: Rectangle) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Electron's `screen`. `list` reads the displays now; `updates` hands each
 * change to the function it is given.
 */
export const createScreen = (
  list: () => readonly ListedDisplay[],
  updates: (changed: (displays: readonly ListedDisplay[]) => void) => void,
) => {
  let displays: Display[] | undefined;
  const screen = new EventEmitter();

  let following = false;
  const current = () => {
    follow();
    displays ??= list()
      .filter((display) => display.lit !== false)
      .map(asElectronDisplay);
    return displays;
  };

  // Followed once the app looks at the screens or listens for them.
  screen.on("newListener", () => follow());
  const follow = () => {
    if (following) {
      return;
    }
    following = true;
    updates(changed);
  };

  const changed = (listed: readonly ListedDisplay[]) => {
    const before = displays ?? [];
    const after = listed.filter((d) => d.lit !== false).map(asElectronDisplay);
    displays = after;
    for (const display of after) {
      const was = before.find((old) => old.id === display.id);
      if (was === undefined) {
        screen.emit(
          "display-added",
          { preventDefault: () => undefined },
          display,
        );
      } else if (JSON.stringify(was) !== JSON.stringify(display)) {
        const changed = [
          ...(JSON.stringify(was.bounds) === JSON.stringify(display.bounds)
            ? []
            : ["bounds"]),
          ...(was.scaleFactor === display.scaleFactor ? [] : ["scaleFactor"]),
          ...(was.rotation === display.rotation ? [] : ["rotation"]),
        ];
        screen.emit(
          "display-metrics-changed",
          { preventDefault: () => undefined },
          display,
          changed,
        );
      }
    }
    for (const display of before) {
      if (!after.some((now) => now.id === display.id)) {
        screen.emit(
          "display-removed",
          { preventDefault: () => undefined },
          display,
        );
      }
    }
  };

  const primary = () => {
    const all = current();
    const first =
      all.find(({ bounds }) => bounds.x === 0 && bounds.y === 0) ?? all[0];
    if (first === undefined) {
      throw new Error("the desktop has no lit display");
    }
    return first;
  };

  const nearest = (point: Point) =>
    current().reduce(
      (best, display) =>
        distance(point, display.bounds) < distance(point, best.bounds)
          ? display
          : best,
      primary(),
    );

  return Object.assign(screen, {
    dipToScreenPoint: (point: Point) => {
      const { scaleFactor } = nearest(point);
      return {
        x: Math.round(point.x * scaleFactor),
        y: Math.round(point.y * scaleFactor),
      };
    },
    getAllDisplays: () => current(),
    /** Wayland tells no client where the pointer is outside its windows. */
    getCursorScreenPoint: () => {
      const { bounds } = primary();
      return {
        x: bounds.x + Math.round(bounds.width / 2),
        y: bounds.y + Math.round(bounds.height / 2),
      };
    },
    getDisplayMatching: (rect: Rectangle) =>
      current().reduce(
        (best, display) =>
          overlap(rect, display.bounds) > overlap(rect, best.bounds)
            ? display
            : best,
        nearest({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }),
      ),
    getDisplayNearestPoint: nearest,
    getPrimaryDisplay: primary,
    screenToDipPoint: (point: Point) => {
      const display =
        current().find(
          ({ bounds, scaleFactor }) =>
            distance(
              { x: point.x / scaleFactor, y: point.y / scaleFactor },
              bounds,
            ) === 0,
        ) ?? primary();
      return {
        x: point.x / display.scaleFactor,
        y: point.y / display.scaleFactor,
      };
    },
  });
};
