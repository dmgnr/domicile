import type { PlacedScreen } from "./screen-toward";

/**
 * `screens` in reading order: by row, top row first, then left to right.
 *
 * A screen whose top is above the bottom of the row's first screen joins that
 * row, so a laptop bottom-aligned beside taller monitors reads with them.
 */
export const readingOrder = <Screen extends PlacedScreen>(
  screens: readonly Screen[],
): readonly Screen[] =>
  rowsOf(screens.toSorted((one, other) => one.box.y - other.box.y)).flatMap(
    (row) => row.toSorted((one, other) => one.box.x - other.box.x),
  );

/** One row of screens, sorted by top edge. Never empty. */
type Row<Screen> = readonly [Screen, ...Screen[]];

/** Screens sorted by their top edge, split into rows. */
const rowsOf = <Screen extends PlacedScreen>(
  sorted: readonly Screen[],
): readonly Row<Screen>[] =>
  sorted.reduce<readonly Row<Screen>[]>((rows, screen) => {
    const last = rows.at(-1);
    return last === undefined ||
      screen.box.y >= last[0].box.y + last[0].box.height
      ? [...rows, [screen]]
      : [...rows.slice(0, -1), [...last, screen]];
  }, []);
