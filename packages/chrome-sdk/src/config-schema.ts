// Generated from `config.schema.json` by `codegen/generate-config.ts`. Do not
// edit. Change `packages/domicile-config` and run `bun run generate` in
// `packages/chrome-sdk`.
//
// The config's Zod schema: it reads a config as the compositor does, filling
// in every default and refusing every key the compositor refuses.

import { z } from "zod";

/** How movement speed affects pointer acceleration. */
export const accelProfileSchema = z.enum(["adaptive", "flat"]);

/** An sRGB color, written `"#rrggbb"`. */
export const accentColorSchema = z
  .string()
  .regex(new RegExp("^#[0-9a-fA-F]{6}$"));

/** Buttons assigned to one-, two- and three-finger taps. */
export const buttonMapSchema = z.enum(["lrm", "lmr"]);

/** How a touchpad's physical button chooses a mouse button. */
export const clickMethodSchema = z.enum([
  "default",
  "clickfinger",
  "button_areas",
]);

/** How strongly clients set text and edges apart from their background. */
export const contrastSchema = z.enum(["normal", "high"]);

/** A cursor theme's directory name for each mode. */
export const perModeCursorThemesSchema = z.strictObject({
  dark: z.string(),
  light: z.string(),
});

/**
 * An XCursor theme's directory name, such as `Adwaita`, for both modes or
 * for each.
 */
export const cursorThemeNameSchema = z.union([
  z.string(),
  perModeCursorThemesSchema,
]);

/** How typing suppression selects touchpads and handles contacts. */
export const disableWhileTypingSchema = z.enum([
  "enabled",
  "disabled",
  "internal",
  "libinput",
]);

/**
 * One display, described in the config rather than discovered.
 *
 * A nested compositor has no monitors to enumerate. Each display becomes a
 * `wl_output` and a region of the chrome page, which the shell addresses by
 * `name`. `position` and `size` are logical units.
 */
export const displayConfigSchema = z.strictObject({
  name: z.string(),
  position: z
    .tuple([
      z.number().int().min(-2_147_483_648).max(2_147_483_647),
      z.number().int().min(-2_147_483_648).max(2_147_483_647),
    ])
    .prefault([0, 0]),
  scale: z.number().int().min(1).max(4_294_967_295).prefault(1),
  size: z.tuple([
    z.number().int().min(0).max(4_294_967_295),
    z.number().int().min(0).max(4_294_967_295),
  ]),
});

/**
 * Which way up a monitor is, named for the matching `wl_output.transform`.
 *
 * Rotations only; nothing needs flips.
 */
export const transformSchema = z.union([
  z.literal("normal"),
  z.literal("rotate-90"),
  z.literal("rotate-180"),
  z.literal("rotate-270"),
]);

/**
 * One display of a profile: which monitor, and what to do with it.
 *
 * Every field but `display` defaults to leaving the monitor as it is.
 */
export const displayPlacementSchema = z.strictObject({
  adaptive_sync: z.boolean().prefault(false),
  display: z.string(),
  enabled: z.boolean().prefault(true),
  mode: z
    .tuple([
      z.number().int().min(0).max(4_294_967_295),
      z.number().int().min(0).max(4_294_967_295),
    ])
    .nullish()
    .transform((value) => value ?? undefined),
  position: z
    .tuple([
      z.number().int().min(-2_147_483_648).max(2_147_483_647),
      z.number().int().min(-2_147_483_648).max(2_147_483_647),
    ])
    .nullish()
    .transform((value) => value ?? undefined),
  refresh: z
    .number()
    .gt(0)
    .nullish()
    .transform((value) => value ?? undefined),
  scale: z.number().gt(0).prefault(1),
  transform: transformSchema.prefault("normal"),
});

/** [`SiteAccess`] other than a list of hosts. */
export const siteAccessModeSchema = z.union([
  z.literal("on_click"),
  z.literal("all_sites"),
]);

/**
 * Which sites an extension runs on: `"on_click"`, `"all_sites"`, or a list
 * of hosts, each also as `*.host` for its subdomains.
 */
export const siteAccessSchema = z.union([
  siteAccessModeSchema,
  z.array(z.string()),
]);

/** One extension's settings. See [`ExtensionsConfig::settings`]. */
export const extensionSettingsSchema = z.strictObject({
  file_access: z
    .boolean()
    .nullish()
    .transform((value) => value ?? undefined),
  private: z
    .boolean()
    .nullish()
    .transform((value) => value ?? undefined),
  site_access: siteAccessSchema
    .nullish()
    .transform((value) => value ?? undefined),
  user_scripts: z
    .boolean()
    .nullish()
    .transform((value) => value ?? undefined),
});

/**
 * Chrome extensions the engine installs into the browser windows' profile.
 * See `docs/architecture/EXTENSIONS.md`.
 *
 * Listing an extension is consent: there is no install prompt. Removing one
 * from the list uninstalls it.
 */
export const extensionsConfigSchema = z.strictObject({
  settings: z.record(z.string(), extensionSettingsSchema).prefault({}),
  unpacked: z.array(z.string()).prefault([]),
  web_store: z.array(z.string()).prefault([]),
});

/**
 * The paths the file index leaves out, and everything under them.
 *
 * Patterns follow gitignore's rules:
 * - Each is a glob over a path relative to the home. `*` stops at `/`; `**`
 *   does not.
 * - A pattern starting with `!` takes a path back.
 * - The last matching pattern wins.
 * - An omitted directory is not walked, so nothing under it can be taken
 *   back.
 *
 * The default is `**\/.*`, which omits hidden paths. A configured list
 * replaces the default.
 */
export const filesOmitSchema = z.array(z.string());

/** What the file index is built from. */
export const filesConfigSchema = z.strictObject({
  omit: filesOmitSchema.prefault(["**/.*"]),
});

/**
 * When an idle desktop turns its screens off, and when it locks.
 *
 * Absent means neither, and that is the default: a blank screen looks like a
 * crash, so a shell must opt in. The two timeouts run on separate clocks
 * from the same input and inhibitors, so either may be the shorter. See
 * `docs/IDLE.md`.
 *
 * The unit is in the key name because a generator writes this file.
 */
export const idleConfigSchema = z.strictObject({
  blank_after_seconds: z
    .number()
    .int()
    .min(1)
    .nullish()
    .transform((value) => value ?? undefined),
  lock_after_seconds: z
    .number()
    .int()
    .min(1)
    .nullish()
    .transform((value) => value ?? undefined),
});

/**
 * One keymap the desktop can switch to, in `input.keyboard.keymaps`.
 *
 * The `xkb_*` fields are as in `input.keyboard`, with the same defaults.
 */
export const keymapSchema = z.strictObject({
  name: z.string().prefault(""),
  xkb_layout: z.string().prefault("us"),
  xkb_model: z.string().prefault(""),
  xkb_options: z.array(z.string()).prefault([]),
  xkb_rules: z.string().prefault(""),
  xkb_variant: z.string().prefault(""),
});

/** How a held key repeats. */
export const keyRepeatSchema = z.strictObject({
  delay_ms: z.number().int().min(0).max(65_535).prefault(500),
  rate: z.number().int().min(0).max(65_535).prefault(25),
});

/**
 * Keyboard settings, named after SwayWM's `xkb_*` options.
 *
 * The string fields go to xkb verbatim, so sway's multi-layout form
 * (`xkb_layout = "us,de"`) works. Empty `xkb_rules` and `xkb_model` use the
 * libxkbcommon defaults. The default layout is `us`.
 *
 * To switch between layouts, list them in `keymaps` instead.
 */
export const keyboardConfigSchema = z.strictObject({
  keymaps: z.array(keymapSchema).prefault([]),
  repeat: keyRepeatSchema.prefault({ delay_ms: 500, rate: 25 }),
  xkb_layout: z.string().prefault("us"),
  xkb_model: z.string().prefault(""),
  xkb_options: z.array(z.string()).prefault([]),
  xkb_rules: z.string().prefault(""),
  xkb_variant: z.string().prefault(""),
});

/** Settings applied to every relative mouse on a tty. */
export const mouseConfigSchema = z.strictObject({
  accel_profile: accelProfileSchema.prefault("adaptive"),
  middle_emulation: z.boolean().prefault(false),
  natural_scroll: z.boolean().prefault(false),
  scroll_factor: z.number().gt(0).prefault(1),
  speed: z.number().min(-1).max(1).prefault(0),
});

/** A tablet or touchscreen, and the display it covers. */
export const pointerConfigSchema = z.strictObject({
  device: z.string(),
  display: z.string(),
});

/** How a touchpad generates scrolling. */
export const scrollMethodSchema = z.enum([
  "default",
  "two_finger",
  "edge",
  "on_button_down",
]);

/** Settings applied to every touchpad on a tty, including newly attached ones. */
export const touchpadConfigSchema = z.strictObject({
  accel_profile: accelProfileSchema.prefault("adaptive"),
  click_method: clickMethodSchema.prefault("default"),
  disable_while_typing: disableWhileTypingSchema.prefault("enabled"),
  drag_lock: z.boolean().prefault(false),
  middle_emulation: z.boolean().prefault(false),
  natural_scroll: z.boolean().prefault(false),
  scroll_acceleration: z.boolean().prefault(true),
  scroll_factor: z.number().gt(0).prefault(1),
  scroll_method: scrollMethodSchema.prefault("default"),
  speed: z.number().min(-1).max(1).prefault(0),
  tap: z.boolean().prefault(true),
  tap_button_map: buttonMapSchema.prefault("lrm"),
  tap_drag: z.boolean().prefault(true),
  typing_pause_ms: z.number().int().min(0).max(2_147_483_647).prefault(200),
  typing_repeat_pause_ms: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .prefault(500),
});

/** Input-device settings. */
export const inputConfigSchema = z.strictObject({
  keyboard: keyboardConfigSchema.prefault({
    keymaps: [],
    repeat: { delay_ms: 500, rate: 25 },
    xkb_layout: "us",
    xkb_model: "",
    xkb_options: [],
    xkb_rules: "",
    xkb_variant: "",
  }),
  mouse: mouseConfigSchema.prefault({
    accel_profile: "adaptive",
    middle_emulation: false,
    natural_scroll: false,
    scroll_factor: 1,
    speed: 0,
  }),
  pointers: z.array(pointerConfigSchema).prefault([]),
  touchpad: touchpadConfigSchema.prefault({
    accel_profile: "adaptive",
    click_method: "default",
    disable_while_typing: "enabled",
    drag_lock: false,
    middle_emulation: false,
    natural_scroll: false,
    scroll_acceleration: true,
    scroll_factor: 1,
    scroll_method: "default",
    speed: 0,
    tap: true,
    tap_button_map: "lrm",
    tap_drag: true,
    typing_pause_ms: 200,
    typing_repeat_pause_ms: 500,
  }),
});

/**
 * What unlocks this desk: the user's password, checked by PAM.
 *
 * If `/etc/pam.d` lacks the service, the desk does not lock, since nothing
 * could unlock it, until the file is added. See `docs/LOCK.md#verifiers`.
 */
export const lockConfigSchema = z.strictObject({
  pam_service: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
});

/**
 * What applications are told not to do, through the
 * `org.freedesktop.impl.portal.Lockdown` portal. Every switch defaults to
 * off.
 *
 * Applications enforce these themselves; the compositor only reports them.
 * See `docs/SHELL-CONFIG.md#lockdown`.
 */
export const lockdownConfigSchema = z.strictObject({
  disable_application_handlers: z.boolean().prefault(false),
  disable_camera: z.boolean().prefault(false),
  disable_location: z.boolean().prefault(false),
  disable_microphone: z.boolean().prefault(false),
  disable_printing: z.boolean().prefault(false),
  disable_save_to_disk: z.boolean().prefault(false),
  disable_sound_output: z.boolean().prefault(false),
});

/**
 * One arrangement of monitors, and where each goes.
 *
 * Applies when the displays it names are exactly the connected ones.
 */
export const profileSchema = z.strictObject({
  displays: z.array(displayPlacementSchema),
  name: z.string(),
});

/** Output settings. */
export const outputConfigSchema = z.strictObject({
  displays: z.array(displayConfigSchema).prefault([]),
  max_scale: z.number().int().min(1).max(4_294_967_295).prefault(2),
  profiles: z.array(profileSchema).prefault([]),
});

/**
 * The commands a desk starts with.
 *
 * Run once, when the compositor starts. A reload does not rerun them, which
 * would start duplicates, or stop them, which would kill programs in use.
 */
export const startupConfigSchema = z.strictObject({
  commands: z.array(z.array(z.string())).prefault([]),
});

/**
 * Whether the desktop is drawn dark or light.
 *
 * There is no "follow the system" option: the chrome is the system, so there
 * is nothing to follow. Clients follow this value through the settings
 * portal; see the compositor's `portals::settings`.
 */
export const themeModeSchema = z.union([z.literal("dark"), z.literal("light")]);

/**
 * How the desktop is themed.
 *
 * Clients read every field but `mode` through the settings portal; see the
 * compositor's `portals::settings`.
 */
export const themeConfigSchema = z.strictObject({
  accent_color: accentColorSchema
    .nullish()
    .transform((value) => value ?? undefined),
  contrast: contrastSchema.prefault("normal"),
  cursor_hide_after_ms: z
    .number()
    .int()
    .min(1)
    .max(4_294_967_295)
    .nullish()
    .transform((value) => value ?? undefined),
  cursor_hide_when_typing: z.boolean().prefault(false),
  cursor_size: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .nullish()
    .transform((value) => value ?? undefined),
  cursor_theme: cursorThemeNameSchema
    .nullish()
    .transform((value) => value ?? undefined),
  font_name: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  force_dark: z.array(z.string()).prefault([]),
  icon_theme: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  mode: themeModeSchema.prefault("dark"),
  monospace_font_name: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  reduced_motion: z.boolean().prefault(false),
});

/** The full compositor configuration. */
export const configSchema = z.strictObject({
  $schema: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  extensions: extensionsConfigSchema.prefault({
    settings: {},
    unpacked: [],
    web_store: [],
  }),
  files: filesConfigSchema.prefault({ omit: ["**/.*"] }),
  idle: idleConfigSchema.prefault({
    blank_after_seconds: null,
    lock_after_seconds: null,
  }),
  input: inputConfigSchema.prefault({
    keyboard: {
      keymaps: [],
      repeat: { delay_ms: 500, rate: 25 },
      xkb_layout: "us",
      xkb_model: "",
      xkb_options: [],
      xkb_rules: "",
      xkb_variant: "",
    },
    mouse: {
      accel_profile: "adaptive",
      middle_emulation: false,
      natural_scroll: false,
      scroll_factor: 1,
      speed: 0,
    },
    pointers: [],
    touchpad: {
      accel_profile: "adaptive",
      click_method: "default",
      disable_while_typing: "enabled",
      drag_lock: false,
      middle_emulation: false,
      natural_scroll: false,
      scroll_acceleration: true,
      scroll_factor: 1,
      scroll_method: "default",
      speed: 0,
      tap: true,
      tap_button_map: "lrm",
      tap_drag: true,
      typing_pause_ms: 200,
      typing_repeat_pause_ms: 500,
    },
  }),
  lock: lockConfigSchema.prefault({ pam_service: null }),
  lockdown: lockdownConfigSchema.prefault({
    disable_application_handlers: false,
    disable_camera: false,
    disable_location: false,
    disable_microphone: false,
    disable_printing: false,
    disable_save_to_disk: false,
    disable_sound_output: false,
  }),
  output: outputConfigSchema.prefault({
    displays: [],
    max_scale: 2,
    profiles: [],
  }),
  shell: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  shell_options: z.record(z.string(), z.unknown()).prefault({}),
  startup: startupConfigSchema.prefault({ commands: [] }),
  terminal: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? undefined),
  theme: themeConfigSchema.prefault({
    accent_color: null,
    contrast: "normal",
    cursor_hide_after_ms: null,
    cursor_hide_when_typing: false,
    cursor_size: null,
    cursor_theme: null,
    font_name: null,
    force_dark: [],
    icon_theme: null,
    mode: "dark",
    monospace_font_name: null,
    reduced_motion: false,
  }),
});
