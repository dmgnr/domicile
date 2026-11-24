// Zod schemas for the compositor's JSON wire, mirroring the Rust
// `domicile-protocol` crate. Host frames are untrusted, so they are parsed, not
// cast.
//
// Pages get typed attributes and events on the `DomicileHost` a shell is
// handed instead. These schemas serve `@domicile-desktop/e2e-harness`, which
// reads the compositor's socket directly.
//
// `wire-fixture.test.ts` checks that these schemas accept what Rust writes.
// Schemas ignore unknown keys so a newer host can add fields.

import { cursorShapeSchema } from "@domicile-desktop/sdk/cursor-shape";
import { displayTransformSchema } from "@domicile-desktop/sdk/display-transform";
import { notificationUrgencySchema } from "@domicile-desktop/sdk/notification";
import { themeSchema } from "@domicile-desktop/sdk/theme";
import { z } from "zod";

/** The protocol version this build speaks. Must match the Rust constant. */
export const PROTOCOL_VERSION = 1;

/** A scroll frame sent by the engine, including independent axis stops. */
export const pointerAxisSchema = z.object({
  app_id: z.string(),
  dx: z.number(),
  dy: z.number(),
  source: z.enum(["wheel", "finger", "continuous", "wheel_tilt"]),
  stop_x: z.boolean(),
  stop_y: z.boolean(),
  type: z.literal("pointer_axis"),
  v120_x: z.number().int(),
  v120_y: z.number().int(),
});

const pinchEnvelope = {
  app_id: z.string(),
  device: z.number().int().min(0).max(0xff_ff_ff_ff),
  time: z.number().int().min(0).max(0xff_ff_ff_ff),
  type: z.literal("pointer_pinch"),
};

/** Native pinch phases; scale is absolute and rotation is a relative angle. */
export const pointerPinchSchema = z.discriminatedUnion("phase", [
  z.object({
    ...pinchEnvelope,
    fingers: z.number().int().positive().max(0xff_ff_ff_ff),
    phase: z.literal("begin"),
  }),
  z.object({
    ...pinchEnvelope,
    dx: z.number(),
    dy: z.number(),
    phase: z.literal("update"),
    rotation: z.number(),
    scale: z.number().positive(),
  }),
  z.object({
    ...pinchEnvelope,
    canceled: z.boolean(),
    phase: z.literal("end"),
  }),
]);

const sizeSchema = z.tuple([z.number(), z.number()]);

/**
 * A window's title, or `undefined` when it has none.
 *
 * `null` (unset), `""` (cleared with `set_title("")`) and a missing key all
 * mean no title.
 */
const titleSchema = z
  .string()
  .nullish()
  .transform((title) => title ?? undefined)
  .transform((title) => (title === "" ? undefined : title));

/** A string the sandbox engine may leave unset: `null`, normalized. */
const unsetSchema = z
  .string()
  .nullable()
  .transform((value) => value ?? undefined);

const sandboxSchema = z.looseObject({
  app_id: unsetSchema,
  engine: unsetSchema,
  instance_id: unsetSchema,
});

const ownerSchema = z.looseObject({
  gid: z.number(),
  pid: z.number(),
  // `null` on kernels without pidfs; normalized to `undefined`.
  pidfd_inode: z
    .number()
    .nullable()
    .transform((inode) => inode ?? undefined),
  // The `wp_security_context_v1` the client connected through, or `null`
  // for an unsandboxed client; normalized to `undefined`.
  sandbox: sandboxSchema
    .nullable()
    .transform((sandbox) => sandbox ?? undefined),
  uid: z.number(),
});

const welcomeSchema = z.looseObject({
  protocol_version: z.number(),
  type: z.literal("welcome"),
});

// Can repeat for a known window: the host replays all windows to every chrome
// whenever any chrome connects. Key windows by app id.
// Sent when the window first draws, with what the client said before.
// A surface's synced frame. See
// docs/architecture/WINDOW-COMPOSITING.md#synced-frames.
const frameSchema = z.number().int().nonnegative();

const appFrameSchema = z.looseObject({
  app_id: z.string(),
  frame: frameSchema,
});

const appAppearedSchema = z.looseObject({
  app_id: z.string(),
  // The client asked to draw its own frame.
  client_frame: z.boolean(),
  // Absent when the client set none. A later one arrives in `app_desktop_id`.
  desktop_id: z
    .string()
    .nullish()
    .transform((desktopId) => desktopId ?? undefined),
  // The client has a parent window or a fixed size.
  dialog: z.boolean(),
  // The synced frame to show; absent is 0. Above 0 only for a window that
  // appeared before this page did.
  frame: frameSchema.optional(),
  // The process that connected the window's client, from `SO_PEERCRED`.
  owner: ownerSchema,
  // The size of the first frame.
  size: sizeSchema,
  title: titleSchema,
  // The window's identifier on `ext-foreign-toplevel-list-v1`, for capture
  // tools. Fixed for the window's life.
  toplevel_id: z.string(),
  type: z.literal("app_appeared"),
});

// Sent on each `set_title` after `app_appeared`.
const appTitledSchema = z.looseObject({
  app_id: z.string(),
  title: titleSchema,
  type: z.literal("app_titled"),
});

// Sent on each `set_app_id`, which names the client's desktop entry.
const appDesktopIdSchema = z.looseObject({
  app_id: z.string(),
  desktop_id: z.string(),
  type: z.literal("app_desktop_id"),
});

// Whether the window holds a `zwp_keyboard_shortcuts_inhibitor_v1`. Sent after
// `app_appeared` when it does, then on each change.
const appInhibitsShortcutsSchema = z.looseObject({
  app_id: z.string(),
  inhibits: z.boolean(),
  type: z.literal("app_inhibits_shortcuts"),
});

const appResizedSchema = z.looseObject({
  app_id: z.string(),
  size: sizeSchema,
  type: z.literal("app_resized"),
});

// A client popup, placed at `position` relative to `parent`. Sent again when
// it moves; closed with `app_closed`.
const popupPlacedSchema = z.looseObject({
  app_id: z.string(),
  // The synced frame of each surface the move goes with.
  frames: z.array(appFrameSchema).optional(),
  grab: z.boolean(),
  parent: z.string(),
  position: sizeSchema,
  size: sizeSchema,
  type: z.literal("popup_placed"),
});

// A window's size limits, as xdg-shell sends them: `0` on an axis means no
// limit.
const appMinSizeSchema = z.looseObject({
  app_id: z.string(),
  size: sizeSchema,
  type: z.literal("app_min_size"),
});

const appMaxSizeSchema = z.looseObject({
  app_id: z.string(),
  size: sizeSchema,
  type: z.literal("app_max_size"),
});

const appClosedSchema = z.looseObject({
  app_id: z.string(),
  type: z.literal("app_closed"),
});

// The window a toplevel is a dialog for (`xdg_toplevel.set_parent`), sent on
// change. `null` on the wire for none; normalized to `undefined`.
const appTransientForSchema = z.looseObject({
  app_id: z.string(),
  transient_for: z
    .string()
    .nullable()
    .transform((parent) => parent ?? undefined),
  type: z.literal("app_transient_for"),
});

// The page anchor a window asked to be laid out at, sent on change. `null` on
// the wire for none; normalized to `undefined`.
const appAnchoredSchema = z.looseObject({
  anchor: z
    .string()
    .nullable()
    .transform((anchor) => anchor ?? undefined),
  app_id: z.string(),
  type: z.literal("app_anchored"),
});

// Whether a window wants attention: set when the compositor drops its
// activation request, cleared when it gets the keyboard.
const appUrgentSchema = z.looseObject({
  app_id: z.string(),
  type: z.literal("app_urgent"),
  urgent: z.boolean(),
});

// The held modifiers, sent on change. The page cannot see them while a window
// has keyboard focus, but needs them for gestures such as alt-drag.
const modifiersSchema = z.looseObject({
  alt: z.boolean(),
  ctrl: z.boolean(),
  logo: z.boolean(),
  shift: z.boolean(),
  type: z.literal("modifiers"),
});

// The window with keyboard focus. Focus also moves without `focus_app` (clicks,
// closed clients), so track this rather than your own requests.
const focusChangedSchema = z.looseObject({
  // `null` on the wire when the chrome has focus; normalized to `undefined`.
  app_id: z
    .string()
    .nullable()
    .transform((appId) => appId ?? undefined),
  type: z.literal("focus_changed"),
});

// A client requests keyboard focus. The shell grants it with `focus_app` or
// ignores it; the compositor does not decide.
const focusRequestedSchema = z.looseObject({
  app_id: z.string(),
  type: z.literal("focus_requested"),
});

// One display, in logical (CSS) pixels except `mode`. `position` is relative
// to the top-left of all displays' bounding box. See `docs/DISPLAYS.md`.
const displayInfoSchema = z.looseObject({
  // Whether the monitor scans out with a variable refresh rate.
  adaptive_sync: z
    .enum(["unsupported", "off", "on"])
    .nullish()
    .transform((adaptiveSync) => adaptiveSync ?? "unsupported"),
  // Whether the monitor is driven in HDR10. See `docs/COLOR.md`.
  hdr: z
    .enum(["unsupported", "off", "on"])
    .nullish()
    .transform((hdr) => hdr ?? "unsupported"),
  // The scanout mode in physical pixels, before rotation. It cannot be derived
  // from `size` and `scale`, since `scale` is rounded to an integer.
  // Informational only; `[0, 0]` when unknown.
  mode: z
    .tuple([z.int().nonnegative(), z.int().nonnegative()])
    .nullish()
    .transform((mode) => mode ?? ([0, 0] as const)),
  // Non-empty: `<Screen name="…">` matches on it, and an empty name would
  // silently match nothing.
  name: z.string().min(1),
  // The panel's peak luminance from its EDID in cd/m²; zero when unreported.
  peak_luminance: z
    .int()
    .nonnegative()
    .nullish()
    .transform((peak) => peak ?? 0),
  // Signed, mirroring `xdg_output.logical_position`.
  position: z.tuple([z.int(), z.int()]),
  // The `wl_output` refresh rate in mHz; zero when unknown.
  refresh_mhz: z
    .int()
    .nonnegative()
    .nullish()
    .transform((refresh) => refresh ?? 0),
  // The integer `wl_output` scale clients draw at. The chrome renders every
  // display at one `devicePixelRatio`.
  scale: z.int().positive(),
  // While `hdr` is `on`, the cd/m² SDR white is shown at; zero otherwise.
  sdr_white: z
    .int()
    .nonnegative()
    .nullish()
    .transform((white) => white ?? 0),
  // Integer, unlike `sizeSchema`, which holds `f64` client sizes.
  size: z.tuple([z.int().positive(), z.int().positive()]),
  // The rotation applied to content, per the `wl_output` convention. Apply it
  // as given.
  transform: displayTransformSchema
    .nullish()
    .transform((transform) => transform ?? "normal"),
});

// The desktop's displays, sent after `welcome` and on every change. The latest
// message wins; one can arrive before `welcome`, because broadcasts reach
// connections that have not finished the handshake.
//
// Never empty. When Domicile runs in a window, that window is a display named
// `domicile-0`.
const displaysSchema = z.looseObject({
  displays: z.array(displayInfoSchema),
  type: z.literal("displays"),
});

// Each lit monitor under the names a display profile can call it by, and
// whether it is in HDR. Answers `which_monitors` on the asking connection only,
// for Settings.
const monitorsSchema = z.looseObject({
  monitors: z.array(
    z.looseObject({
      hdr: z
        .enum(["unsupported", "off", "on"])
        .nullish()
        .transform((hdr) => hdr ?? "unsupported"),
      names: z.array(z.string().min(1)),
    }),
  ),
  type: z.literal("monitors"),
});

// Every display, with every name `sleep-displays` takes for it and whether it
// is lit. Answers `which_displays` on the asking connection only, for
// `domicile list-displays`.
const displayListSchema = z.looseObject({
  displays: z.array(
    displayInfoSchema.extend({
      lit: z.boolean(),
      names: z.array(z.string().min(1)),
    }),
  ),
  type: z.literal("display_list"),
});

// Every window, native first in the order they opened, then browser windows.
// Answers `which_windows` on the asking connection only, for
// `domicile list-windows`.
const windowListSchema = z.looseObject({
  type: z.literal("window_list"),
  windows: z.array(
    z.looseObject({
      app: z.string().nullable(),
      // A browser window's id in the engine, for `domicile devtools`.
      engine_id: z.string().nullable(),
      focused: z.boolean(),
      // The window's `ext-foreign-toplevel-list-v1` identifier.
      id: z.string().min(1),
      kind: z.enum(["native", "browser"]),
      pid: z.int().nullable(),
      private: z.boolean(),
      size: sizeSchema.nullable(),
      title: z.string(),
      urgent: z.boolean(),
      // A browser window's address.
      url: z.string().nullable(),
      // The views a browser window holds and shows, bottom first: an
      // Electron app's `WebContentsView`s, for `domicile devtools --view`.
      views: z.array(
        z.looseObject({
          id: z.string().min(1),
          position: z.tuple([z.int(), z.int()]),
          size: z.tuple([z.int(), z.int()]),
        }),
      ),
    }),
  ),
});

// Each browser window's identifier on `ext-foreign-toplevel-list-v1`, by the
// engine's window id. Sent after `welcome` and on every change; latest wins.
const browserToplevelIdsSchema = z.looseObject({
  toplevel_ids: z.record(z.string(), z.string()),
  type: z.literal("browser_toplevel_ids"),
});

const appCursorSchema = z.looseObject({
  app_id: z.string(),
  cursor: cursorShapeSchema,
  // A cursor the client drew itself, which the engine shows instead.
  image: z
    .looseObject({
      hotspot: z.tuple([z.number(), z.number()]),
      png: z.string(),
      scale: z.number(),
    })
    .optional(),
  type: z.literal("app_cursor"),
});

// The window under the pointer asked to lock or confine it, or `null` once
// that ask ended.
const appPointerConstraintSchema = z.looseObject({
  app_id: z.string(),
  constraint: z.enum(["lock", "confine"]).nullable(),
  // Rectangles of the surface the constraint holds; null for the whole window.
  region: z
    .array(
      z.looseObject({
        height: z.number(),
        width: z.number(),
        x: z.number(),
        y: z.number(),
      }),
    )
    .nullable(),
  type: z.literal("app_pointer_constraint"),
});

// A window or popup reached the screen: its first frame, or the first frame
// drawn after a configure changed its size.
const appPresentedSchema = z.looseObject({
  app_id: z.string(),
  type: z.literal("app_presented"),
});

// The compositor marked a window `suspended`, or cleared it.
const appSuspendedSchema = z.looseObject({
  app_id: z.string(),
  suspended: z.boolean(),
  type: z.literal("app_suspended"),
});

// The compositor's XKB keymap, in `XKB_KEYMAP_FORMAT_TEXT_V1`. The browser
// process uses it for its `KeyboardLayoutEngine`; pages do not read it.
// Non-empty, since an empty keymap types nothing.
const keymapSchema = z.looseObject({
  keymap: z.string().min(1),
  type: z.literal("keymap"),
});

// The configured Chrome extensions: Web Store ids, absolute paths to unpacked
// ones, and each extension's settings by id. Sent with the handshake and on
// config reload. The browser process installs them; see
// `docs/architecture/EXTENSIONS.md`.
const extensionsSchema = z.looseObject({
  settings: z.record(
    z.string(),
    z.looseObject({
      file_access: z.boolean().optional(),
      site_access: z
        .union([z.enum(["on_click", "all_sites"]), z.array(z.string())])
        .optional(),
      user_scripts: z.boolean().optional(),
    }),
  ),
  type: z.literal("extensions"),
  unpacked: z.array(z.string()),
  web_store: z.array(z.string()),
});

// The browser profiles and the profile each site opens in: the config's
// `browser`. Sent with the handshake and on config reload. The browser process
// reads it; see `docs/architecture/BROWSER-PROFILES.md`.
const browserProfilesSchema = z.looseObject({
  default_private_profile: z.string(),
  default_profile: z.string(),
  profiles: z.array(
    z.looseObject({
      color: z.string(),
      extensions: z.array(z.string()).nullable(),
      id: z.string(),
      name: z.string(),
      private: z.boolean(),
    }),
  ),
  sites: z.record(z.string(), z.string()),
  type: z.literal("browser_profiles"),
});

// Host names of sites the browser draws dark while the theme is dark: the
// config's `theme.force_dark`. Sent with the handshake and on config reload.
// The browser process reads it.
const forceDarkSchema = z.looseObject({
  sites: z.array(z.string()),
  type: z.literal("force_dark"),
});

// Whether the browser checks spelling in pages' text fields, and in which
// languages: the config's `spellcheck`. Sent with the handshake and on config
// reload. The browser process reads it.
const spellcheckSchema = z.looseObject({
  enabled: z.boolean(),
  languages: z.array(z.string()),
  type: z.literal("spellcheck"),
});

// Whether the desk's input method composes for the browser's focused field.
// While it does, the browser sends it each key (`key_for_input_method`). The
// browser process reads these three; see `docs/architecture/TEXT-INPUT.md`.
const inputMethodSchema = z.looseObject({
  composing: z.boolean(),
  type: z.literal("input_method"),
});

// What the input method composed for the browser's field, applied together:
// delete `[before, after]` bytes around the cursor, commit, then show the
// preedit. `serial` lets each page's channel apply it once.
const compositionSchema = z.looseObject({
  commit: z.string().optional(),
  delete: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
  preedit: z
    .looseObject({
      cursor_begin: z.number().int(),
      cursor_end: z.number().int(),
      text: z.string(),
    })
    .optional(),
  serial: z.number().int().nonnegative(),
  type: z.literal("composition"),
});

// A key from `key_for_input_method` the input method did not take, for the
// browser to dispatch past it.
const keyPassedSchema = z.looseObject({
  keycode: z.number().int().nonnegative(),
  pressed: z.boolean(),
  serial: z.number().int().nonnegative(),
  type: z.literal("key_passed"),
});

// The reply to `search_files`. `files` holds the first matches, relative to
// home, in byte order, with directories ending in `/`. `matched` is the total
// count. `indexing` is true while the home directory is still being indexed.
// No reply is sent if the home directory cannot be read.
const foundFilesSchema = z.looseObject({
  files: z.array(z.string()),
  indexing: z.boolean(),
  matched: z.number().int().nonnegative(),
  query: z.string(),
  type: z.literal("found_files"),
});

// Clipboard history, newest first. Pushed on change and on connect.
//
// Entries carry a preview and an id, not the full text, which limits exposure
// of copied passwords. Copy one back with `copy_clipboard_entry`; drop one
// with `remove_clipboard_entry`. `current` marks what the clipboard holds.
const clipboardEntrySchema = z.looseObject({
  current: z.boolean(),
  id: z.number(),
  image: z.boolean(),
  preview: z.string(),
  thumbnail: z.string().optional(),
});

const clipboardSchema = z.looseObject({
  entries: z.array(clipboardEntrySchema),
  type: z.literal("clipboard"),
});

// The full system tray (StatusNotifierItem), in registration order. Pushed on
// change and on connect. Activate an item with `activate_tray_item`. `icon` is
// a `data:` URL, absent when it could not be rendered. `menu` is the object
// path of its dbusmenu on `bus`, absent when it has none. `item_is_menu` is its
// `ItemIsMenu` property.
const trayItemSchema = z.looseObject({
  bus: z.string(),
  icon: z.string().optional(),
  id: z.string(),
  item_is_menu: z.boolean(),
  menu: z.string().optional(),
  title: z.string(),
});

const traySchema = z.looseObject({
  items: z.array(trayItemSchema),
  type: z.literal("tray"),
});

// All uncleared notifications, oldest first. Pushed on change and on connect.
// Clear with `dismiss_notifications`; press an action with
// `invoke_notification_action`; send an `inline-reply` action's text with
// `reply_to_notification`. `icon` is a `data:` URL. Without
// `timeout_ms`, the shell picks the timeout. `browser_window` names the
// browser window whose page sent it. See
// `docs/architecture/NOTIFICATIONS.md`.
const notificationSchema = z.looseObject({
  actions: z.array(z.looseObject({ key: z.string(), label: z.string() })),
  app_name: z.string(),
  body: z.string(),
  browser_window: z.string().optional(),
  clickable: z.boolean(),
  icon: z.string().optional(),
  id: z.number(),
  summary: z.string(),
  time: z.number(),
  timeout_ms: z.number().optional(),
  urgency: notificationUrgencySchema,
});

const notificationsSchema = z.looseObject({
  items: z.array(notificationSchema),
  type: z.literal("notifications"),
});

// Every unanswered portal dialog and held inhibitor, oldest first. Pushed on
// change and on connect. `body` is per `kind`; the SDK's `portal` module parses it. Answer
// with `answer_portal_request`. `shortcuts` lists the chords applications hold
// through the GlobalShortcuts portal; a press is answered `pressed` under its
// id, and its release `released`. See `docs/PORTALS.md`.
const portalRequestSchema = z.looseObject({
  app_id: z.string(),
  body: z.unknown(),
  id: z.number(),
  kind: z.string(),
  parent_app_id: z.string().optional(),
});

// A session that controls or captures input. `body` is per `kind`; stop it by
// answering its `id` with `{"kind":"stop"}`. A `recording` also takes
// `pause`, `resume` and `discard`.
const portalCapturingSchema = z.looseObject({
  app_id: z.string(),
  body: z.unknown(),
  id: z.number(),
  kind: z.string(),
});

// How the desktop is. Answers `which_status` on the asking connection only, for
// `domicile status`.
const statusSchema = z.looseObject({
  capturing: z.array(portalCapturingSchema),
  held_awake_by: z.array(z.string()),
  keymap: z.string().nullable(),
  locked: z.boolean(),
  screens_off: z.boolean(),
  theme: z.enum(["dark", "light"]),
  type: z.literal("status"),
});

// The commands the shell's pages run for `domicile send-shell`. Answers
// `which_shell_commands` on the asking connection only, for
// `domicile list-shell-commands`.
const shellCommandListSchema = z.looseObject({
  commands: z.array(
    z.looseObject({ description: z.string(), usage: z.string() }),
  ),
  type: z.literal("shell_command_list"),
});

// The keys and gestures the shell's pages bind. Answers `which_shell_bindings`
// on the asking connection only, for `domicile list-bindings`.
const shellBindingListSchema = z.looseObject({
  bindings: z.array(
    z.looseObject({ action: z.string(), chord: z.string(), mode: z.string() }),
  ),
  type: z.literal("shell_binding_list"),
});

// Whole seconds since the last input, or since the compositor started.
// Answers `which_idle_time` on the asking connection only, for
// `domicile idle-time`.
const idleTimeSchema = z.looseObject({
  seconds: z.number(),
  type: z.literal("idle_time"),
});

// The input devices the engine reads. Answers `which_inputs` on the asking
// connection only, for `domicile list-inputs`.
const inputListSchema = z.looseObject({
  inputs: z.array(
    z.looseObject({
      connection: z.enum(["internal", "usb", "bluetooth", "unknown"]),
      id: z.number(),
      kind: z.enum([
        "keyboard",
        "mouse",
        "touchpad",
        "touchscreen",
        "pointing-stick",
        "tablet",
        "other",
      ]),
      name: z.string(),
      product: z.number(),
      sys_path: z.string(),
      vendor: z.number(),
    }),
  ),
  type: z.literal("input_list"),
});

// Answers `act_on_window` on the asking connection only, for `domicile
// focus-window`, `close-window` and `kill-window`: why not, or nothing.
const windowActedSchema = z.looseObject({
  refused: z.string().optional(),
  type: z.literal("window_acted"),
});

// Answers `configure_display` on the asking connection only, for `domicile
// configure-display`: why not, or nothing.
const displayConfiguredSchema = z.looseObject({
  refused: z.string().optional(),
  type: z.literal("display_configured"),
});

// Answers `set_log_levels` on the asking connection only, for `domicile
// set-log-level`: why not, or nothing.
const logLevelsSetSchema = z.looseObject({
  refused: z.string().optional(),
  type: z.literal("log_levels_set"),
});

// Answers `shoot_desk` on the asking connection only, for `domicile
// screenshot --fit`: what the PNG shows, or why there is none.
const deskShotSchema = z.looseObject({
  refused: z.string().optional(),
  shot: z
    .looseObject({
      height: z.number(),
      place: z.looseObject({
        position: z.tuple([z.number(), z.number()]),
        size: z.tuple([z.number(), z.number()]),
      }),
      width: z.number(),
    })
    .optional(),
  type: z.literal("desk_shot"),
});

// Answers `exec` on the asking connection only, for `domicile exec` and
// `domicile open`: why the program did not start, or nothing.
const executedSchema = z.looseObject({
  refused: z.string().optional(),
  type: z.literal("executed"),
});

// Answers `emulate` on the asking connection only, for `domicile pointer`,
// `key` and `type`: why not, or nothing.
const emulatedSchema = z.looseObject({
  refused: z.string().optional(),
  type: z.literal("emulated"),
});

const boundShortcutSchema = z.looseObject({
  app_id: z.string(),
  chord: z.string(),
  id: z.number(),
});

// The pictures applications set through the Wallpaper portal, as paths the
// shell reads. Absent until one is set.
const portalWallpaperSchema = z.looseObject({
  background: z.string().optional(),
  lockscreen: z.string().optional(),
});

const portalRequestsSchema = z.looseObject({
  capturing: z.array(portalCapturingSchema).optional(),
  items: z.array(portalRequestSchema),
  shortcuts: z.array(boundShortcutSchema).optional(),
  type: z.literal("portal_requests"),
  wallpaper: portalWallpaperSchema.optional(),
});

// The desktop's light or dark theme. Sent with the handshake, after any
// `setTheme` (to every chrome) and on config reload.
//
// Required, with no default: a wrong default would repaint the desktop in the
// wrong theme.
const themeMessageSchema = z.looseObject({
  theme: themeSchema,
  type: z.literal("theme"),
});

// Whether the desktop is idle: `true` after `idle.blank_after_seconds` with no
// input, `false` on activity. Sent on change and on connect, so a reloaded
// page learns the current state.
//
// `true` arrives as the screens blank, so use it to prepare what shows on
// wake. Not sent when blanking is disabled. See `docs/IDLE.md`.
const idleSchema = z.looseObject({
  // Required: defaulting to `false` could dismiss a lock screen.
  idle: z.boolean(),
  type: z.literal("idle"),
});

// Whether the desktop is locked. While `true`, the compositor drops all input
// to clients, so reloading or editing the page cannot unlock it. The page
// still gets keys, so it can draw a lock screen and send the passphrase with
// `unlock`.
//
// Sent on change and on connect. See `docs/LOCK.md`.
const lockedSchema = z.looseObject({
  // Required: defaulting to `false` would hide the lock screen while input
  // stays blocked.
  locked: z.boolean(),
  type: z.literal("locked"),
});

// The theme client windows use. Sent with the handshake and after a theme
// change, once every chrome has captured its transition frame and the windows
// have repainted. Required, like `theme`.
const windowsThemeMessageSchema = z.looseObject({
  theme: themeSchema,
  type: z.literal("windows_theme"),
});

// The config's accent color, contrast and reduced motion, which the settings
// portal also serves applications, and the pointer's XCursor theme and when to
// hide it, which the browser process reads. Sent with the handshake and on a
// reload that changes them. `accent_color`, `cursor` and `cursor_hiding` are
// absent when unset.
const appearanceSchema = z.looseObject({
  accent_color: z.string().optional(),
  cursor: z.object({ name: z.string(), size: z.number() }).optional(),
  cursor_hiding: z
    .object({ after_ms: z.number().optional(), when_typing: z.boolean() })
    .optional(),
  high_contrast: z.boolean(),
  reduced_motion: z.boolean(),
  type: z.literal("appearance"),
});

// Maps each typeable keysym to its evdev key, for resolving shell shortcuts.
// Sent after the handshake and when the layout changes.
export const shellConfigSchema = z.looseObject({
  keys: z.record(z.string(), z.number().int().nonnegative()),
  /** The config's `shell_options`, as JSON text. */
  options: z.string(),
  type: z.literal("shell_config"),
});

const systemErrorSchema = z.looseObject({
  kind: z.enum([
    "not_found",
    "permission_denied",
    "already_exists",
    "not_a_directory",
    "is_a_directory",
    "invalid_input",
    "locked",
    "dbus",
    "canceled",
    "compositor_gone",
    "other",
  ]),
  message: z.string(),
});

const fileTypeSchema = z.enum(["file", "directory", "symlink", "other"]);

// The answer to a `system_request`. Bytes are base64. See
// `docs/SHELL-SYSTEM-ACCESS.md`.
const systemReplySchema = z.looseObject({
  id: z.number(),
  reply: z.discriminatedUnion("kind", [
    z.looseObject({ data: z.string(), kind: z.literal("read") }),
    z.looseObject({ kind: z.literal("written") }),
    z.looseObject({ kind: z.literal("created") }),
    z.looseObject({
      entries: z.array(
        z.looseObject({ file_type: fileTypeSchema, name: z.string() }),
      ),
      kind: z.literal("entries"),
    }),
    z.looseObject({
      file_type: fileTypeSchema,
      kind: z.literal("stat"),
      modified_ms: z.number().nullable(),
      size: z.number(),
    }),
    z.looseObject({
      body: z.string(),
      kind: z.literal("returned"),
      signature: z.string(),
    }),
    z.looseObject({ kind: z.literal("started") }),
    z.looseObject({ kind: z.literal("saved"), path: z.string() }),
    z.looseObject({ kind: z.literal("copied") }),
    z.looseObject({ kind: z.literal("sent") }),
    z.looseObject({ kind: z.literal("set") }),
    z.looseObject({ kind: z.literal("virtual_monitor"), output: z.string() }),
    z.looseObject({ error: systemErrorSchema, kind: z.literal("failed") }),
  ]),
  type: z.literal("system_reply"),
});

// Output from a running process, a change a watch saw, a D-Bus signal, a
// shell command, an idle warning, a passphrase the lock did not take, a
// client's window request, or the keymaps.
const systemEventSchema = z.looseObject({
  event: z.discriminatedUnion("kind", [
    z.looseObject({
      data: z.string(),
      kind: z.literal("output"),
      stream: z.enum(["stdout", "stderr"]),
    }),
    z.looseObject({ kind: z.literal("changed"), path: z.string() }),
    z.looseObject({
      body: z.string(),
      interface: z.string(),
      kind: z.literal("signal"),
      member: z.string(),
      path: z.string(),
      sender: z.string(),
      signature: z.string(),
    }),
    z.looseObject({
      command: z.array(z.string()),
      kind: z.literal("shell_command"),
      sent: z.number(),
    }),
    z.looseObject({
      idle: z.boolean(),
      kind: z.literal("idle"),
    }),
    z.looseObject({
      failures: z.number(),
      kind: z.literal("unlock_refused"),
      refusal: z.enum(["wrong_passphrase", "unverifiable", "too_soon"]),
      retry_in_ms: z.number(),
    }),
    z.looseObject({
      // `null` when the ring named no window.
      app_id: z.string().nullable(),
      kind: z.literal("bell"),
    }),
    z.looseObject({
      app_id: z.string(),
      kind: z.literal("window_request"),
      request: z.discriminatedUnion("kind", [
        z.looseObject({ kind: z.literal("maximize") }),
        z.looseObject({ kind: z.literal("unmaximize") }),
        z.looseObject({
          display: z.string().nullable(),
          kind: z.literal("fullscreen"),
        }),
        z.looseObject({ kind: z.literal("unfullscreen") }),
        z.looseObject({ kind: z.literal("minimize") }),
      ]),
    }),
    z.looseObject({
      active: z.string(),
      keymaps: z.array(
        z.looseObject({
          description: z.string().optional(),
          name: z.string(),
        }),
      ),
      kind: z.literal("keymaps"),
    }),
  ]),
  id: z.number(),
  type: z.literal("system_event"),
});

// The last message for a watch or process.
const systemEndSchema = z.looseObject({
  end: z.discriminatedUnion("kind", [
    z.looseObject({
      code: z.number().nullable(),
      kind: z.literal("exited"),
      signal: z.number().nullable(),
    }),
    z.looseObject({ kind: z.literal("stopped") }),
    z.looseObject({ error: systemErrorSchema, kind: z.literal("failed") }),
  ]),
  id: z.number(),
  type: z.literal("system_end"),
});

/**
 * A host message this build understands. {@link parseHostMessage} returns
 * `undefined` for unknown types so a newer host can add messages.
 */
export const hostMessageSchema = z.discriminatedUnion("type", [
  welcomeSchema,
  appAppearedSchema,
  appTitledSchema,
  appDesktopIdSchema,
  appInhibitsShortcutsSchema,
  appResizedSchema,
  popupPlacedSchema,
  appMinSizeSchema,
  appMaxSizeSchema,
  appClosedSchema,
  appCursorSchema,
  appPointerConstraintSchema,
  appPresentedSchema,
  appSuspendedSchema,
  appTransientForSchema,
  appAnchoredSchema,
  appUrgentSchema,
  displaysSchema,
  monitorsSchema,
  displayListSchema,
  windowListSchema,
  statusSchema,
  shellCommandListSchema,
  shellBindingListSchema,
  inputListSchema,
  idleTimeSchema,
  windowActedSchema,
  displayConfiguredSchema,
  logLevelsSetSchema,
  deskShotSchema,
  emulatedSchema,
  executedSchema,
  browserToplevelIdsSchema,
  keymapSchema,
  browserProfilesSchema,
  extensionsSchema,
  forceDarkSchema,
  spellcheckSchema,
  inputMethodSchema,
  compositionSchema,
  keyPassedSchema,
  focusChangedSchema,
  focusRequestedSchema,
  modifiersSchema,
  foundFilesSchema,
  clipboardSchema,
  traySchema,
  notificationsSchema,
  portalRequestsSchema,
  themeMessageSchema,
  idleSchema,
  lockedSchema,
  windowsThemeMessageSchema,
  appearanceSchema,
  shellConfigSchema,
  systemReplySchema,
  systemEventSchema,
  systemEndSchema,
]);

/** A decoded host message. */
export type HostMessage = z.infer<typeof hostMessageSchema>;

/** A host message as decoded from JSON. Same type as {@link HostMessage}. */
export type HostMessageJson = z.infer<typeof hostMessageSchema>;
export type WelcomeMessage = z.infer<typeof welcomeSchema>;
export type AppAppearedMessage = z.infer<typeof appAppearedSchema>;
export type BrowserToplevelIdsMessage = z.infer<
  typeof browserToplevelIdsSchema
>;
export type AppTitledMessage = z.infer<typeof appTitledSchema>;
export type AppDesktopIdMessage = z.infer<typeof appDesktopIdSchema>;
export type AppInhibitsShortcutsMessage = z.infer<
  typeof appInhibitsShortcutsSchema
>;
export type AppResizedMessage = z.infer<typeof appResizedSchema>;
export type PopupPlacedMessage = z.infer<typeof popupPlacedSchema>;
export type AppMinSizeMessage = z.infer<typeof appMinSizeSchema>;
export type AppMaxSizeMessage = z.infer<typeof appMaxSizeSchema>;
export type AppClosedMessage = z.infer<typeof appClosedSchema>;
export type AppCursorMessage = z.infer<typeof appCursorSchema>;
export type AppPointerConstraintMessage = z.infer<
  typeof appPointerConstraintSchema
>;
export type AppTransientForMessage = z.infer<typeof appTransientForSchema>;
export type AppAnchoredMessage = z.infer<typeof appAnchoredSchema>;
export type AppUrgentMessage = z.infer<typeof appUrgentSchema>;
export type DisplaysMessage = z.infer<typeof displaysSchema>;
export type MonitorsMessage = z.infer<typeof monitorsSchema>;
export type DisplayListMessage = z.infer<typeof displayListSchema>;
export type WindowListMessage = z.infer<typeof windowListSchema>;
export type StatusMessage = z.infer<typeof statusSchema>;
export type ShellCommandListMessage = z.infer<typeof shellCommandListSchema>;
export type IdleTimeMessage = z.infer<typeof idleTimeSchema>;
export type ShellBindingListMessage = z.infer<typeof shellBindingListSchema>;
export type InputListMessage = z.infer<typeof inputListSchema>;
export type WindowActedMessage = z.infer<typeof windowActedSchema>;
export type DisplayConfiguredMessage = z.infer<typeof displayConfiguredSchema>;
export type LogLevelsSetMessage = z.infer<typeof logLevelsSetSchema>;
export type KeymapMessage = z.infer<typeof keymapSchema>;
export type FocusChangedMessage = z.infer<typeof focusChangedSchema>;
export type FocusRequestedMessage = z.infer<typeof focusRequestedSchema>;
export type ModifiersMessage = z.infer<typeof modifiersSchema>;
export type FoundFilesMessage = z.infer<typeof foundFilesSchema>;
export type ClipboardMessage = z.infer<typeof clipboardSchema>;
export type TrayMessage = z.infer<typeof traySchema>;
export type NotificationsMessage = z.infer<typeof notificationsSchema>;
export type PortalRequestsMessage = z.infer<typeof portalRequestsSchema>;
export type ThemeMessage = z.infer<typeof themeMessageSchema>;
export type IdleMessage = z.infer<typeof idleSchema>;
export type LockedMessage = z.infer<typeof lockedSchema>;
export type WindowsThemeMessage = z.infer<typeof windowsThemeMessageSchema>;
export type AppearanceMessage = z.infer<typeof appearanceSchema>;
export type ShellConfigMessage = z.infer<typeof shellConfigSchema>;
export type SystemReplyMessage = z.infer<typeof systemReplySchema>;
export type SystemEventMessage = z.infer<typeof systemEventSchema>;
export type SystemEndMessage = z.infer<typeof systemEndSchema>;

/** One thing that was copied, as a row of the clipboard's history. */
export type ClipboardEntry = z.infer<typeof clipboardEntrySchema>;

/** One display of the desktop, in the coordinates the shell lays out in. */
export type DisplayInfo = z.infer<typeof displayInfoSchema>;

/** The `type` tag of every host message this build knows how to decode. */
export type HostMessageType = HostMessage["type"];

/** Narrow a decoded host message to one variant, for a handler signature. */
export type HostMessageOf<T extends HostMessageType> = Extract<
  HostMessage,
  { type: T }
>;

// A frame without a string `type` is malformed, not unknown.
const envelopeSchema = z.looseObject({ type: z.string() });

const KNOWN_TYPES: ReadonlySet<string> = new Set(
  hostMessageSchema.options.map((option) => option.shape.type.value),
);

/**
 * Decode one frame of host JSON.
 *
 * @returns The typed message, or `undefined` for an unknown `type`. Throws on
 *   invalid JSON, a missing `type`, or a known `type` with a bad payload.
 */
export const parseHostMessage = (text: string): HostMessageJson | undefined => {
  const envelope = envelopeSchema.parse(JSON.parse(text));
  return KNOWN_TYPES.has(envelope.type)
    ? hostMessageSchema.parse(envelope)
    : undefined;
};
