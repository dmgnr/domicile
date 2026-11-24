import type { Extension } from "@domicile-desktop/sdk/extension";
import type { TrayItem } from "@domicile-desktop/sdk/tray";

import { shownInTray } from "./extensions/shown";
import { arrange } from "./tray-order";

/** A tray icon: an application's or an extension's. */
export enum TrayEntryKind {
  Extension,
  StatusNotifier,
}

/** The key extension `id`'s icon is remembered by, pinned or not. */
export const extensionKey = (id: string): string => `extension:${id}`;

/** The key application `id`'s icon is remembered by, pinned or not. */
export const statusNotifierKey = (id: string): string =>
  `status-notifier:${id}`;

/**
 * One tray icon, with the key its position is remembered by.
 *
 * The key is stable across restarts, so an application reopened or an extension
 * re-enabled returns to its place. The compositor keys application icons by the
 * application's own id, not its bus name or its title, which can change.
 */
export const TrayEntry = {
  Extension: (extension: Extension) => ({
    extension,
    key: extensionKey(extension.id),
    kind: TrayEntryKind.Extension as const,
  }),
  StatusNotifier: (item: TrayItem) => ({
    item,
    key: statusNotifierKey(item.id),
    kind: TrayEntryKind.StatusNotifier as const,
  }),
};

export type TrayEntry = ReturnType<(typeof TrayEntry)[keyof typeof TrayEntry]>;

/**
 * Every tray icon in the user's `order`; unplaced ones go after, applications
 * before extensions.
 */
export const trayEntries = (
  items: readonly TrayItem[],
  extensions: readonly Extension[],
  order: readonly string[],
): readonly TrayEntry[] =>
  arrange(
    [
      ...items.map((item) => TrayEntry.StatusNotifier(item)),
      ...shownInTray(extensions).map((extension) =>
        TrayEntry.Extension(extension),
      ),
    ],
    ({ key }) => key,
    order,
  );
