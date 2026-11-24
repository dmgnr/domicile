// Browser extensions: those with an action, which a shell's tray draws, and
// every installed one, which a shell's menu switches and configures. See
// docs/architecture/EXTENSIONS.md.

import { z } from "zod";

import type {
  DomicileExtension,
  DomicileHost,
  DomicileInstalledExtension,
} from "../domicile-host";
import type {
  Extension,
  ExtensionPopup,
  ExtensionSettings,
  InstalledExtension,
} from "../extension";
import {
  extensionPopupSchema,
  extensionSchema,
  installedExtensionSchema,
} from "../extension";
import { memoizeLast } from "./memoize-last";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";

export type ExtensionsListeners = {
  change: () => void;
  /** `installed` changed. */
  installed: () => void;
  /**
   * An extension called `action.openPopup()`. Open `popup` as a clicked
   * action's popup. Parsed: throws on a request a shell cannot open.
   */
  popup: (request: ExtensionPopup) => void;
};

export type Extensions = {
  /**
   * `undefined` until the engine says. Parsed, since the engine and the SDK
   * ship apart: throws on an action a shell cannot draw.
   */
  readonly list: readonly Extension[] | undefined;
  /**
   * Every installed extension, switched on or off. `undefined` until the
   * engine says. Parsed: throws on a row a shell cannot draw.
   */
  readonly installed: readonly InstalledExtension[] | undefined;
  /** Click extension `id`'s action. One with a popup is the shell's to open. */
  activate: (id: string) => void;
  /**
   * Changes `settings` on extension `id`. Rejects with an `OperationError`
   * for a setting the desk's config sets, or an extension not installed.
   */
  configure: (id: string, settings: ExtensionSettings) => Promise<void>;
  on: On<ExtensionsListeners>;
  /** Switches extension `id` on or off. Rejects for one not installed. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /**
   * Shows browser profile `profile`'s extensions in `list`, and has
   * `activate` click them there, on its active page: as a browser's toolbar
   * shows its window's profile's. Name the profile of the page last focused.
   * The default profile's until called, and while `profile` loads.
   */
  setProfile: (profile: string) => void;
  /**
   * Uninstalls extension `id`. Rejects for one the desk's config installed,
   * which comes back on the next start.
   */
  uninstall: (id: string) => Promise<void>;
};

export type ExtensionsHost = Pick<
  DomicileHost,
  | "activateExtension"
  | "addEventListener"
  | "configureExtension"
  | "extensions"
  | "installedExtensions"
  | "removeEventListener"
  | "setExtensionEnabled"
  | "setExtensionsProfile"
  | "uninstallExtension"
>;

export const extensions = (host: ExtensionsHost): Extensions => {
  const listOf = memoizeLast((list: readonly DomicileExtension[] | null) =>
    list === null ? undefined : z.array(extensionSchema).parse(list),
  );
  const installedOf = memoizeLast(
    (list: readonly DomicileInstalledExtension[] | null) =>
      list === null ? undefined : z.array(installedExtensionSchema).parse(list),
  );
  return {
    activate: (id) => {
      host.activateExtension(id);
    },
    configure: (id, settings) => host.configureExtension(id, settings),
    get installed() {
      return installedOf(host.installedExtensions);
    },
    get list() {
      return listOf(host.extensions);
    },
    on: on<ExtensionsListeners>({
      change: (listener) =>
        hostEvent(host, "extensionschanged", () => listener()),
      installed: (listener) =>
        hostEvent(host, "installedextensionschanged", () => listener()),
      popup: (listener) =>
        hostEvent(
          host,
          "extensionpopuprequested",
          ({ extensionId, popup, profile }) =>
            listener(
              extensionPopupSchema.parse({ id: extensionId, popup, profile }),
            ),
        ),
    }),
    setEnabled: (id, enabled) => host.setExtensionEnabled(id, enabled),
    setProfile: (profile) => {
      host.setExtensionsProfile(profile);
    },
    uninstall: (id) => host.uninstallExtension(id),
  };
};
