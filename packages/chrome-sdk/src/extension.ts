// One browser extension, as a shell's tray draws it, and as a menu that
// switches and configures it lists it.
//
// `extensionSchema` parses the rows of `DomicileHost.extensions`, and
// `installedExtensionSchema` the rows of `DomicileHost.installedExtensions`.
// The engine and the SDK ship separately, so the data is validated rather than
// trusted.

import { z } from "zod";

/** A Chromium extension id: 32 letters `a` through `p`. */
const EXTENSION_ID = /^[a-p]{32}$/;

/** The engine renders every icon as a PNG data URL. */
const PNG_DATA_URL = "data:image/png;base64,";

export const extensionSchema = z.object({
  /** A CSS color, `#rrggbbaa`; transparent when the extension set none. */
  badgeColor: z.string(),
  badgeText: z.string(),
  /** `false` after the extension's `action.disable()`. */
  enabled: z.boolean(),
  /** A PNG at the page's device pixel ratio, as a data URL. */
  icon: z.string().startsWith(PNG_DATA_URL),
  /** The id to pass to `DomicileHost.activateExtension`. */
  id: z.string().regex(EXTENSION_ID),
  name: z.string(),
  /**
   * The popup to open in a `<webview>` on click, or `undefined` when the click
   * fires `action.onClicked`. Either way, call
   * `DomicileHost.activateExtension`. The engine sends `null`.
   */
  popup: z
    .string()
    .nullable()
    .transform((popup) => popup ?? undefined),
  /**
   * The id of the browser profile it is in, as `Extensions.setProfile` named
   * it once that loaded. Its popup opens in a `<webview>` in this profile.
   */
  profile: z.string(),
  /** The action's tooltip. */
  title: z.string(),
});

export type Extension = z.infer<typeof extensionSchema>;

/** An extension's `action.openPopup()`: the popup to open, and whose. */
export const extensionPopupSchema = z.object({
  id: z.string().regex(EXTENSION_ID),
  popup: z.string().startsWith("chrome-extension://"),
  /** The browser profile the extension is in, which the popup opens in. */
  profile: z.string(),
});

export type ExtensionPopup = z.infer<typeof extensionPopupSchema>;

/** Which sites an extension can read and change. */
export const siteAccessSchema = z.enum([
  "on_click",
  "specific_sites",
  "all_sites",
]);

export type SiteAccess = z.infer<typeof siteAccessSchema>;

/** The engine sends `null` for a setting; the SDK says `undefined`. */
const unset = <T extends z.ZodType>(schema: T) =>
  schema.nullable().transform((value) => value ?? undefined);

/**
 * One installed extension, switched on or off. Each setting is `undefined`
 * when the extension cannot use it, such as `fileAccess` for one that asks for
 * no local files. Private windows are a private browser profile's, whose
 * switches say what runs there.
 */
export const installedExtensionSchema = z.object({
  /**
   * The settings the desk's config sets. A shell shows them locked: the
   * engine refuses to change them.
   */
  configured: z.array(z.enum(["fileAccess", "userScripts", "siteAccess"])),
  /** `false` when switched off: it runs nowhere and has no action. */
  enabled: z.boolean(),
  fileAccess: unset(z.boolean()),
  /** Installed by the desk's config, which the engine will not uninstall. */
  fromConfig: z.boolean(),
  /** The manifest's icon, as a PNG data URL. */
  icon: z.string().startsWith(PNG_DATA_URL),
  id: z.string().regex(EXTENSION_ID),
  name: z.string(),
  /** The page to open for the extension's own options. */
  optionsUrl: unset(z.string().startsWith("chrome-extension://")),
  siteAccess: unset(siteAccessSchema),
  /** The sites it can read, when `siteAccess` is `"specific_sites"`. */
  sites: z.array(z.string()),
  userScripts: unset(z.boolean()),
});

export type InstalledExtension = z.infer<typeof installedExtensionSchema>;

/** The settings to change on one installed extension. Absent ones are kept. */
export type ExtensionSettings = {
  fileAccess?: boolean;
  siteAccess?: SiteAccess;
  sites?: readonly string[];
  userScripts?: boolean;
};
