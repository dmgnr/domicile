// The tray's state, held once for every bar's tray.

import { useProvided } from "@domicile-desktop/manganese-host/use-provided";
import type { BrowserProfile } from "@domicile-desktop/sdk/desktop/browser";
import type {
  Extension,
  ExtensionPopup,
  InstalledExtension,
} from "@domicile-desktop/sdk/extension";
import type { TrayItem } from "@domicile-desktop/sdk/tray";
import { createContext } from "react";
import type { OpenedPopup } from "./extensions/useOpenedPopup";
import type { TrayOrder } from "./useTrayOrder";
import type { TrayPins } from "./useTrayPins";

export type TrayState = {
  /** The extensions with an action. */
  extensions: readonly Extension[];
  /** Every installed extension, for the tray's menu. */
  installed: readonly InstalledExtension[];
  /**
   * The browser profile of the page last focused, whose extensions the tray
   * shows and switches; `undefined` until the engine lists its profiles.
   */
  profile: BrowserProfile | undefined;
  /** The applications' tray icons. */
  items: readonly TrayItem[];
  /** Extension `id`'s action was clicked on the bar on `screen`. */
  clicked: (screen: string, id: string) => void;
  /** Open an extension's popup on `screen`, or close it with `undefined`. */
  open: (screen: string, popup: ExtensionPopup | undefined) => void;
  /** The open extension popup and the screen it is on. */
  opened: OpenedPopup | undefined;
  /** The icon order, shared so a drag on one bar reorders every bar. */
  order: TrayOrder;
  /** Which icons are pinned, shared so every bar's tray agrees. */
  pins: TrayPins;
};

export const TrayContext = createContext<TrayState | undefined>(undefined);

/** The tray from {@link TrayContext}. */
export const useTrayState = (): TrayState =>
  useProvided(TrayContext, "the tray (TrayContext)");
