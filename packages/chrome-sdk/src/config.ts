// Generated from `config.schema.json` by `codegen/generate-config.ts`. Do not
// edit. Change `packages/domicile-config` and run `bun run generate` in
// `packages/chrome-sdk`.
//
// The config's sections, for a TypeScript config module's exports:
//
//   import type { OutputConfig } from "@domicile-desktop/sdk/config";
//   export const output: OutputConfig = { max_scale: 1 };
//
// See `docs/SHELL-CONFIG.md`.

/** The full compositor configuration. */
export type Config = {
  /** Where editors find this file's JSON Schema. Domicile ignores it. */
  $schema?: string | null;
  agents?: AgentsConfig;
  browser?: BrowserConfig;
  electron?: ElectronConfig;
  extensions?: ExtensionsConfig;
  files?: FilesConfig;
  idle?: IdleConfig;
  input?: InputConfig;
  lock?: LockConfig;
  lockdown?: LockdownConfig;
  output?: OutputConfig;
  /**
   * The shell `domicile` runs when given none: a path or a package, as
   * `domicile load-shell` takes. The compositor ignores it.
   */
  shell?: string | null;
  /**
   * The values of the options the shell declares, by key. The compositor
   * sends them to the shell without reading them. See
   * `docs/WRITING-A-SHELL.md#options`.
   */
  shell_options?: Record<string, unknown>;
  spellcheck?: SpellcheckConfig;
  startup?: StartupConfig;
  /**
   * The terminal applications such as htop and vim run in
   * (`Terminal=true` in their desktop entries): its argv, which the
   * application's own follows, as `["kitty", "--"]` or `["foot"]`. The
   * launcher and `domicile open` offer such applications only when it is
   * set, and a shell's terminal key opens it. Unset, there is no terminal.
   */
  terminal?: string[] | null;
  theme?: ThemeConfig;
};

/** How movement speed affects pointer acceleration. */
export type AccelProfile = "adaptive" | "flat";

/** An sRGB color, written `"#rrggbb"`. */
export type AccentColor = string;

/**
 * Agents that drive the desktop, such as Claude Code. See
 * `docs/AGENTS.md`.
 */
export type AgentsConfig = {
  /**
   * Whether agents on the web, such as claude.ai, can reach the desktop
   * through Domicile's relay: while it is set, the compositor runs
   * `domicile mcp --relay`. Each agent still signs in only once the user
   * allows it on the desktop, and asks before it uses anything. Off by
   * default. See
   * `docs/AGENTS.md#agents-on-the-web`.
   */
  web?: boolean;
};

/**
 * Browser profiles: sets of sign-ins, site data and extensions, and the
 * sites each opens. See `docs/architecture/BROWSER-PROFILES.md`.
 */
export type BrowserConfig = {
  /** The profile a new private window opens in. Private. */
  default_private_profile?: string;
  /** The profile a site opens in when `sites` names none. Not private. */
  default_profile?: string;
  /**
   * The order the shell lists the profiles in, by id. Profiles it leaves
   * out follow, by id.
   */
  order?: string[];
  /**
   * The profiles, by id. An id is a directory name: lowercase letters,
   * digits and `-`.
   */
  profiles?: Record<string, BrowserProfile>;
  /**
   * The profile each site opens in, by site: a host, `*.host` for it and
   * its subdomains, or a host and path such as `github.com/acme` for the
   * addresses under it. The most specific match wins. A site is never in
   * `default_profile`, which opens every unlisted site.
   */
  sites?: Record<string, string>;
};

/** One browser profile. See [`BrowserConfig::profiles`]. */
export type BrowserProfile = {
  /** The color the shell marks the profile's pages with. */
  color: AccentColor;
  /**
   * The ids of the extensions it turns on, from those `extensions`
   * installs; the rest are off, and the shell cannot switch them. Unset
   * leaves the switches to the user: each starts on, or off in a private
   * profile, whose pages stay away from extensions unless allowed.
   */
  extensions?: string[] | null;
  /** The name the shell shows. */
  name: string;
  /** Keeps no history, sign-ins or site data after its last page closes. */
  private?: boolean;
};

/** Buttons assigned to one-, two- and three-finger taps. */
export type ButtonMap = "lrm" | "lmr";

/** How a touchpad's physical button chooses a mouse button. */
export type ClickMethod = "default" | "clickfinger" | "button_areas";

/** How strongly clients set text and edges apart from their background. */
export type Contrast = "normal" | "high";

/**
 * An XCursor theme's directory name, such as `Adwaita`, for both modes or
 * for each.
 */
export type CursorThemeName = string | PerModeCursorThemes;

/** How typing suppression selects touchpads and handles contacts. */
export type DisableWhileTyping =
  | "enabled"
  | "disabled"
  | "internal"
  | "libinput";

/**
 * One display, described in the config rather than discovered.
 *
 * A nested compositor has no monitors to enumerate. Each display becomes a
 * `wl_output` and a region of the chrome page, which the shell addresses by
 * `name`. `position` and `size` are logical units.
 */
export type DisplayConfig = {
  /**
   * The name the chrome and the compositor use for this display.
   *
   * Matched exactly, so a name padded with whitespace is rejected.
   */
  name: string;
  /**
   * The top-left corner in the config's coordinate space.
   *
   * May be negative.
   */
  position?: [number, number];
  /**
   * The `wl_output` scale for clients on this display.
   *
   * `output.max_scale` does not apply to described displays.
   */
  scale?: number;
  /**
   * Width and height in logical units. The `wl_output` mode is this times
   * `scale`.
   */
  size: [number, number];
};

/**
 * One display of a profile: which monitor, and what to do with it.
 *
 * Every field but `display` defaults to leaving the monitor as it is.
 */
export type DisplayPlacement = {
  /**
   * Whether to scan out with a variable refresh rate (adaptive sync,
   * FreeSync, G-Sync Compatible), so a frame that runs late is shown as
   * soon as it is ready instead of at the next fixed refresh.
   *
   * Off by default. Asked for only where the monitor, its connector and
   * its driver report they can; a driver that refuses it gets the same
   * mode without it. Each display reports whether it took.
   */
  adaptive_sync?: boolean;
  /**
   * The connected display this entry places, matched by exact name.
   *
   * On a tty the output name is `drm-<id>`, or the connector (`HDMI-A-1`)
   * for a monitor with no EDID name. Ozone derives the id from the EDID, so
   * it survives a replug. A panel name or connector (`DP-1`) also matches.
   */
  display: string;
  /**
   * Whether the display is part of the desktop.
   *
   * A disabled display must still be connected for the profile to match.
   * This lets a profile match a docked laptop and keep windows off its
   * closed lid.
   */
  enabled?: boolean;
  /**
   * Whether to drive the monitor in HDR (HDR10: BT.2020 primaries with the
   * PQ curve), so HDR video and images reach its full brightness and
   * color.
   *
   * Off by default. Asked for only where the monitor's EDID says it takes
   * PQ and the connector scans out in 10 bits; elsewhere it stays SDR.
   */
  hdr?: boolean;
  /**
   * The mode to scan out, in physical pixels. Absent means the monitor's
   * native mode.
   *
   * Applying the profile fails when the monitor offers no mode of this
   * size. An engine that reports no modes (an older one, or a desktop in a
   * window) cannot set one, so there it is a check: the profile applies
   * only while the monitor is at this mode.
   */
  mode?: [number, number] | null;
  /**
   * The top-left corner in the profile's coordinate space. May be negative.
   *
   * Absent puts the display in a row right of the positioned ones, in
   * profile order and level with their top. The row uses logical widths
   * and follows each monitor's current mode.
   */
  position?: [number, number] | null;
  /**
   * The refresh rate to scan out, in Hz, such as `59.94` or `120`. The
   * monitor's advertised rate nearest it is used, at `mode` or else the
   * native size.
   *
   * Absent means the native mode's rate when `mode` is absent or the
   * native size, and otherwise the highest rate the monitor offers at
   * `mode`, as sway picks.
   */
  refresh?: number | null;
  /**
   * Device pixels per logical pixel.
   *
   * Fractional, because real scales are: 1.5 on a 2880x1920 panel gives a
   * 1920x1280 desktop. This differs from the integer `wl_output.scale`; the
   * compositor's `Screens` advertises that, and `xdg_output` carries the
   * logical size.
   */
  scale?: number;
  /**
   * In HDR, how bright ordinary (SDR) content's white is, in cd/m² (nits).
   * Raise it if SDR windows look dim beside the monitor in SDR.
   *
   * Absent is 203, the reference white of ITU-R BT.2408. Ignored in SDR.
   */
  sdr_white?: number | null;
  /** Which way up the monitor is. */
  transform?: Transform;
};

/**
 * Installed Electron apps that run on the desktop's engine instead of the
 * Electron they ship. See `docs/architecture/ELECTRON-APPS.md`.
 */
export type ElectronConfig = {
  /**
   * Desktop file ids, as `slack.desktop`. Whatever starts one of these
   * entries (the launcher, a link, a notification) runs it with
   * `domicile open --electron`. An app the engine can't run yet runs on
   * its own Electron, with a notification saying so.
   */
  apps?: string[];
};

/** One extension's settings. See [`ExtensionsConfig::settings`]. */
export type ExtensionSettings = {
  /** Runs on local files (`file://` pages). Chrome's default is no. */
  file_access?: boolean | null;
  /** Which of the sites it asks for it runs on. Chrome's default is all. */
  site_access?: SiteAccess | null;
  /**
   * May run the user scripts you add to it (`chrome.userScripts`), as
   * userscript managers do. Chrome's default is no.
   */
  user_scripts?: boolean | null;
};

/**
 * Chrome extensions the engine installs into the browser windows' profile.
 * See `docs/architecture/EXTENSIONS.md`.
 *
 * Listing an extension is consent: there is no install prompt. Removing one
 * from the list uninstalls it.
 */
export type ExtensionsConfig = {
  /**
   * Each extension's settings, by id, as chrome://extensions has them. A
   * setting left out is the user's to change in the Settings app; one
   * removed from here goes back to Chrome's default.
   */
  settings?: Record<string, ExtensionSettings>;
  /** Directories holding an unpacked extension, loaded as they are. */
  unpacked?: string[];
  /** Chrome Web Store ids, installed from the Store and updated from it. */
  web_store?: string[];
};

/** What the file index is built from. */
export type FilesConfig = {
  omit?: FilesOmit;
};

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
export type FilesOmit = string[];

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
export type IdleConfig = {
  /**
   * Seconds without input before the screens go dark.
   *
   * Absent means never. Zero is refused.
   */
  blank_after_seconds?: number | null;
  /**
   * Seconds without input before the desktop locks.
   *
   * Absent means the desktop locks only when its shell asks. Zero is
   * refused.
   */
  lock_after_seconds?: number | null;
};

/** Input-device settings. */
export type InputConfig = {
  keyboard?: KeyboardConfig;
  mouse?: MouseConfig;
  /**
   * Tablets and touchscreens, each bound to the display it covers.
   *
   * Read on a tty only, on every hotplug. An unbound one covers no
   * display. See `docs/DISPLAYS.md#tablets-and-touchscreens`.
   */
  pointers?: PointerConfig[];
  touchpad?: TouchpadConfig;
};

/**
 * Keyboard settings, named after SwayWM's `xkb_*` options.
 *
 * The string fields go to xkb verbatim, so sway's multi-layout form
 * (`xkb_layout = "us,de"`) works. Empty `xkb_rules` and `xkb_model` use the
 * libxkbcommon defaults. The default layout is `us`.
 *
 * To switch between layouts, list them in `keymaps` instead.
 */
export type KeyboardConfig = {
  /**
   * Keymaps to switch between, the first the one the desktop starts on.
   *
   * Each is a whole keymap: an entry's unset fields take the defaults, not
   * the fields above, which must stay unset. The shell switches with
   * `keymap next` or `keymap <name>`. See `docs/SHELL-CONFIG.md`.
   */
  keymaps?: Keymap[];
  /** How a held key repeats, in native windows and in pages. */
  repeat?: KeyRepeat;
  xkb_layout?: string;
  xkb_model?: string;
  xkb_options?: string[];
  xkb_rules?: string;
  xkb_variant?: string;
};

/**
 * One keymap the desktop can switch to, in `input.keyboard.keymaps`.
 *
 * The `xkb_*` fields are as in `input.keyboard`, with the same defaults.
 */
export type Keymap = {
  /**
   * What the shell shows and `keymap <name>` selects, such as `dvp`.
   *
   * Unique, and not `next`.
   */
  name?: string;
  xkb_layout?: string;
  xkb_model?: string;
  xkb_options?: string[];
  xkb_rules?: string;
  xkb_variant?: string;
};

/** How a held key repeats. */
export type KeyRepeat = {
  /** Milliseconds a key is held before it repeats. */
  delay_ms?: number;
  /** Repeats a second. 0 turns repeat off. */
  rate?: number;
};

/**
 * What unlocks this desk: the user's password, checked by PAM.
 *
 * If `/etc/pam.d` lacks the service, the desk does not lock, since nothing
 * could unlock it, until the file is added. See `docs/LOCK.md#verifiers`.
 */
export type LockConfig = {
  /**
   * The PAM service the desk's user authenticates against.
   *
   * Absent means `"domicile"`, which the NixOS module and the distribution
   * packages declare.
   */
  pam_service?: string | null;
};

/**
 * What applications are told not to do, through the
 * `org.freedesktop.impl.portal.Lockdown` portal. Every switch defaults to
 * off.
 *
 * Applications enforce these themselves; the compositor only reports them.
 * See `docs/SHELL-CONFIG.md#lockdown`.
 */
export type LockdownConfig = {
  disable_application_handlers?: boolean;
  disable_camera?: boolean;
  disable_location?: boolean;
  disable_microphone?: boolean;
  disable_printing?: boolean;
  disable_save_to_disk?: boolean;
  disable_sound_output?: boolean;
};

/** Settings applied to every relative mouse on a tty. */
export type MouseConfig = {
  accel_profile?: AccelProfile;
  /** Emulate a middle click by pressing left and right together. */
  middle_emulation?: boolean;
  /** Reverse the mouse wheel's scrolling direction. */
  natural_scroll?: boolean;
  /** Multiplier applied once to both scrolling axes; must be positive. */
  scroll_factor?: number;
  /** Pointer acceleration speed, from -1 to 1. */
  speed?: number;
};

/** Output settings. */
export type OutputConfig = {
  /**
   * The displays that make up the desktop.
   *
   * Empty means one output sized to Domicile's own window.
   */
  displays?: DisplayConfig[];
  /**
   * The highest `wl_output` scale to advertise.
   *
   * Limits cost: a client at scale N renders N² times the pixels. `1` turns
   * scaling off. Applies only while `displays` is empty.
   */
  max_scale?: number;
  /**
   * Placements for real monitors, matched against what is connected.
   *
   * Re-read on every hotplug. Empty leaves the monitors where the engine
   * placed them. See `docs/DISPLAYS.md#profiles`.
   */
  profiles?: Profile[];
};

/** A cursor theme's directory name for each mode. */
export type PerModeCursorThemes = {
  dark: string;
  light: string;
};

/** A tablet or touchscreen, and the display it covers. */
export type PointerConfig = {
  /**
   * The device's evdev name or `phys`, matched exactly.
   *
   * A name every device of a kind shares, such as `QEMU QEMU USB Tablet`,
   * binds all of them; `phys` (`usb-0000:00:04.0-1/input0`) tells them
   * apart. `udevadm info /dev/input/eventN` prints both.
   */
  device: string;
  /** The display the device covers, named as a profile's `display` is. */
  display: string;
};

/**
 * One arrangement of monitors, and where each goes.
 *
 * Applies when the displays it names are exactly the connected ones.
 */
export type Profile = {
  /** Every display this arrangement is for, including the ones it turns off. */
  displays: DisplayPlacement[];
  /**
   * The profile's name, unique in the config. The log prints it when the
   * profile applies.
   */
  name: string;
};

/** How a touchpad generates scrolling. */
export type ScrollMethod = "default" | "two_finger" | "edge" | "on_button_down";

/**
 * Which sites an extension runs on: `"on_click"`, `"all_sites"`, or a list
 * of hosts, each also as `*.host` for its subdomains.
 */
export type SiteAccess = SiteAccessMode | string[];

/** [`SiteAccess`] other than a list of hosts. */
export type SiteAccessMode = "on_click" | "all_sites";

/** Spell checking in pages: in browser windows, web apps and Electron apps. */
export type SpellcheckConfig = {
  /** Underlines misspelled words in text fields and suggests corrections. */
  enabled?: boolean;
  /**
   * The languages words are checked in, as language tags such as `en-US`.
   * A word spelled right in any of them passes.
   */
  languages?: string[];
};

/**
 * The commands a desk starts with.
 *
 * Run once, when the compositor starts. A reload does not rerun them, which
 * would start duplicates, or stop them, which would kill programs in use.
 */
export type StartupConfig = {
  /**
   * Each an argv, run without a shell. For shell syntax, use
   * `["sh", "-c", "…"]`.
   */
  commands?: string[][];
};

/**
 * How the desktop is themed.
 *
 * Clients read every field but `mode` through the settings portal; see the
 * compositor's `portals::settings`.
 */
export type ThemeConfig = {
  /** The color clients highlight with, or their own when unset. */
  accent_color?: AccentColor | null;
  contrast?: Contrast;
  /**
   * Hides the engine's pointer after this many milliseconds without
   * pointer input. Unset never hides it. Zero is refused.
   */
  cursor_hide_after_ms?: number | null;
  /**
   * Hides the engine's pointer on a typing key press, until the pointer is
   * next used.
   */
  cursor_hide_when_typing?: boolean;
  /**
   * The cursor size in logical pixels, for clients and the engine's
   * pointer. Unset leaves clients their own. Zero is refused.
   */
  cursor_size?: number | null;
  /**
   * The XCursor theme for clients and the engine's pointer, in both modes
   * or one per mode. Unset leaves clients their own.
   */
  cursor_theme?: CursorThemeName | null;
  /**
   * The interface font as a Pango description, such as `Inter 11`. Unset
   * leaves clients their own.
   */
  font_name?: string | null;
  /**
   * Host names of sites the browser draws dark while the theme is dark,
   * for sites with no dark theme of their own. A host covers its
   * subdomains.
   */
  force_dark?: string[];
  /**
   * The freedesktop icon theme's directory name, such as `Papirus-Dark`.
   * Unset leaves shells with `hicolor`.
   */
  icon_theme?: string | null;
  mode?: ThemeMode;
  /**
   * The fixed-width font as a Pango description, such as `Iosevka 12`.
   * Unset leaves clients their own.
   */
  monospace_font_name?: string | null;
  /** Asks clients to keep animation to a minimum. */
  reduced_motion?: boolean;
};

/**
 * Whether the desktop is drawn dark or light.
 *
 * There is no "follow the system" option: the chrome is the system, so there
 * is nothing to follow. Clients follow this value through the settings
 * portal; see the compositor's `portals::settings`.
 */
export type ThemeMode = "dark" | "light";

/** Settings applied to every touchpad on a tty, including newly attached ones. */
export type TouchpadConfig = {
  accel_profile?: AccelProfile;
  /**
   * Physical click behavior; `default` uses the device's libinput default.
   * Clickfinger uses left, right and middle for one, two and three fingers.
   */
  click_method?: ClickMethod;
  /**
   * Typing suppression policy; `libinput` preserves native keyboard pairing and contacts.
   * Custom `internal` excludes external pads; `enabled` includes every touchpad.
   */
  disable_while_typing?: DisableWhileTyping;
  /** Keep a tap drag held when the fingers lift briefly. */
  drag_lock?: boolean;
  /** Emulate a middle click by pressing left and right together. */
  middle_emulation?: boolean;
  /** Move content in the direction the fingers move. */
  natural_scroll?: boolean;
  /** Increase page scroll distance with gesture speed, up to four times. */
  scroll_acceleration?: boolean;
  /** Multiplier applied once to both scrolling axes; must be positive. */
  scroll_factor?: number;
  /** Scrolling gesture; `default` uses the device's libinput default. */
  scroll_method?: ScrollMethod;
  /** Pointer acceleration speed, from -1 to 1. */
  speed?: number;
  /** Tap to click. */
  tap?: boolean;
  /** Buttons for one-, two- and three-finger taps. */
  tap_button_map?: ButtonMap;
  /** Drag by tapping, then holding a second tap. */
  tap_drag?: boolean;
  /**
   * Custom pause after one typing key; zero means no pause.
   * Native `libinput` mode requires the default 200 and uses its own timers.
   */
  typing_pause_ms?: number;
  /**
   * Custom pause during continued typing; zero means no pause.
   * Native `libinput` mode requires the default 500 and uses its own timers.
   */
  typing_repeat_pause_ms?: number;
};

/**
 * Which way up a monitor is, named for the matching `wl_output.transform`.
 *
 * Rotations only; nothing needs flips.
 */
export type Transform = "normal" | "rotate-90" | "rotate-180" | "rotate-270";
