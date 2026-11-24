// Generated from the engine's WebIDL by `codegen/generate-domicile-host.ts`.
// Do not edit. Change the IDL in
// `packages/domicile-engine/src/third_party/blink/renderer/modules/domicile/`
// and run `bun run generate` in `packages/chrome-sdk`.
//
// The desktop a shell is handed (`Shell(root, domicile)`). There is no global;
// a shell keeps what it was handed. See `shell.ts`.
//
// Sizes and coordinates are fractional CSS pixels, except in `DomicileDisplay`.
// Keycodes are Linux evdev codes.

/**
 * The cursors a client can ask the chrome to show over its window.
 *
 * The `wp_cursor_shape_v1` shapes, named by the CSS `cursor` keyword the
 * chrome assigns, plus `none` for a hidden cursor. The same set is defined by
 * `domicile_protocol::CursorShape`, `components/domicile/common/cursor_shape.h`
 * and `cursorShapeSchema` in `@domicile-desktop/sdk`.
 *
 * An enum, not a DOMString, so the bindings reject unknown values. CSS ignores
 * an unknown cursor keyword, so a bad value would otherwise show the wrong
 * cursor with no error.
 *
 * Keep the values in the same order as the other lists:
 * `scripts/test-cursor-shapes-agree.sh` compares all four as sequences.
 */
export type DomicileCursorShape =
  | "none"
  | "default"
  | "context-menu"
  | "help"
  | "pointer"
  | "progress"
  | "wait"
  | "cell"
  | "crosshair"
  | "text"
  | "vertical-text"
  | "alias"
  | "copy"
  | "move"
  | "no-drop"
  | "not-allowed"
  | "grab"
  | "grabbing"
  | "e-resize"
  | "n-resize"
  | "ne-resize"
  | "nw-resize"
  | "s-resize"
  | "se-resize"
  | "sw-resize"
  | "w-resize"
  | "ew-resize"
  | "ns-resize"
  | "nesw-resize"
  | "nwse-resize"
  | "col-resize"
  | "row-resize"
  | "all-scroll"
  | "zoom-in"
  | "zoom-out";

/**
 * One of the desk's downloads. See components/domicile/mojom/downloads.mojom.
 *
 * An interface for DomicileBrowserWindow's reason: these are read from the
 * desktop's `downloads` attribute.
 */
export type DomicileDownloadState = "in-progress" | "complete" | "failed";

/**
 * A video in picture-in-picture, which the shell draws. See
 * components/domicile/mojom/picture_in_picture.mojom.
 *
 * An interface for DomicileBrowserWindow's reason: these are read from the
 * desktop's `pictureInPictureVideos` attribute.
 *
 * What actOnPictureInPictureVideo() asks of a video. "back-to-page" ends
 * picture-in-picture and leaves the video playing in its page, whose window
 * asks to come to the front; "close" ends it and pauses the video.
 */
export type DomicilePictureInPictureAction =
  | "play"
  | "pause"
  | "previous-track"
  | "next-track"
  | "back-to-page"
  | "close";

/**
 * The desktop's light or dark theme.
 *
 * One of four copies of this set: `domicile_protocol::Theme`,
 * `components/domicile/common/theme.h`, this enum, and `themeSchema` in
 * `@domicile-desktop/sdk`.
 *
 * An enum rather than a `DOMString` because `setTheme()` takes it, so the
 * bindings reject an invalid value at the call. There is no `system` value:
 * the compositor owns the theme.
 *
 * Keep the order in sync with the other copies. `mojom::Theme` is numbered by
 * position, and `scripts/test-themes-agree.sh` compares the order.
 */
export type DomicileTheme = "dark" | "light";

/**
 * Which button clicked a tray icon: StatusNotifierItem's Activate,
 * SecondaryActivate and ContextMenu.
 *
 * An enum rather than a `DOMString` because activateTrayItem() takes it, so
 * the bindings reject an invalid value at the call.
 *
 * Keep the order in sync with `mojom::TrayAction`, which is numbered by
 * position.
 */
export type DomicileTrayAction = "primary" | "secondary" | "context";

export type DomicileAppEventInit = EventInit & {
  appId?: string;
};

export type DomicileExtensionPopupEventInit = EventInit & {
  extensionId?: string;
  popup?: string;
  profile?: string;
};

/**
 * What DomicileHost.configureExtension() sets on an extension: each member
 * present is set, and the rest are left. The names and values are
 * DomicileInstalledExtension's.
 */
export type DomicileExtensionSettings = {
  fileAccess?: boolean;
  userScripts?: boolean;
  /** "on_click", "specific_sites" or "all_sites". */
  siteAccess?: string;
  /**
   * With "specific_sites" only: hosts, each also as `*.host` for its
   * subdomains.
   */
  sites?: readonly string[];
};

/** A request header `DomicileHost.fetchWithCookies()` sends. */
export type DomicileFetchHeader = {
  name: string;
  value: string;
};

/** What `DomicileHost.fetchWithCookies()` resolves with. */
export type DomicileFetchResponse = {
  /** The HTTP status, such as 200 or 401. */
  readonly status: number;
  /** The address the response came from, after redirects. */
  readonly url: string;
  /** The body, as text. */
  readonly body: string;
};

/** What `DomicileHost.searchFiles()` resolves with. */
export type DomicileFileSearch = {
  /**
   * The front of what matched: paths relative to the home directory the
   * desktop is running as -- `Notes/today.org`, not
   * `/home/you/Notes/today.org` -- already in the order they go on screen, and
   * a directory ends in `/`. Empty is a query that matched nothing.
   */
  readonly files: readonly string[];
  /** How many paths matched, of which `files` is the front. */
  readonly matched: number;
  /**
   * Whether the compositor is still building the index this was found in.
   *
   * When true, the answer may be incomplete. A shell shows that
   * the index is being built, and asks again.
   */
  readonly indexing: boolean;
};

export type DomicileGestureEventInit = EventInit & {
  kind?: string;
  phase?: string;
  fingers?: number;
  dx?: number;
  dy?: number;
  scale?: number;
  rotation?: number;
  canceled?: boolean;
  edge?: string;
};

export type DomicileShortcutEventInit = EventInit & {
  chord?: string;
  keycode?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
};

/**
 * The event behind DomicileHost.onfocusrequested: a client asked for the
 * keyboard.
 */
export type DomicileAppEvent = Event & {
  /** The window that asked: the id an <app> element names. */
  readonly appId: string;
};

/** Every event `DomicileAppHost` fires, by name. */
export type DomicileAppHostEventMap = {
  /** An answer to callSystem(), as a MessageEvent whose `data` is the line. */
  system: MessageEvent<string>;
};

/**
 * The host an app module is handed: system calls and their answers, the
 * shell's system access without its window manager. See
 * docs/architecture/APP-MODULES.md.
 *
 * Not a web standard. It exists in Domicile's engine fork, on an app
 * module's document in its own app window, and nowhere else.
 */
export type DomicileAppHost = {
  /**
   * A system call, as DomicileHost.callSystem(). The compositor answers only
   * files, processes and D-Bus, and fails the rest with permission_denied.
   */
  callSystem(id: number, request: string): void;
  /**
   * Typed by the event map rather than by inheriting `EventTarget`, whose
   * overloads take any name and type every listener's event as `Event`.
   * `dispatchEvent` is left out: a page does not dispatch to it.
   */
  addEventListener<T extends keyof DomicileAppHostEventMap>(
    type: T,
    listener: (event: DomicileAppHostEventMap[T]) => void,
  ): void;
  removeEventListener<T extends keyof DomicileAppHostEventMap>(
    type: T,
    listener: (event: DomicileAppHostEventMap[T]) => void,
  ): void;
};

/**
 * One of the desk's browser profiles, in DomicileHost.browserProfiles: a set
 * of sign-ins, site data and extensions, as the config's `browser.profiles`
 * names it. A page is in one profile, and its new windows are in it too. See
 * docs/architecture/BROWSER-PROFILES.md in the Domicile repository.
 */
export type DomicileBrowserProfile = {
  /**
   * Lowercase letters, digits and `-`. What DomicileBrowserWindow.profile
   * and openBrowserWindow() name it by.
   */
  readonly id: string;
  /** The name the user gave it. */
  readonly name: string;
  /** Its color, `#rrggbb`. */
  readonly color: string;
  /** Whether it keeps nothing past its last page, as private browsing does. */
  readonly isPrivate: boolean;
  /** Whether a site no profile lists opens here. Exactly one profile is. */
  readonly isDefault: boolean;
  /**
   * Whether a private window that names no profile opens here. Exactly one
   * profile is, and it is private.
   */
  readonly isDefaultPrivate: boolean;
  /**
   * The sites that open here because the user pinned them
   * (DomicileHost.pinBrowserSite). Each is a host, `*.host`, or a host and
   * path, as the config's `browser.sites` keys are.
   */
  readonly pinnedSites: readonly string[];
  /**
   * The sites that open here because the config's `browser.sites` names
   * them. Only the config changes these.
   */
  readonly configSites: readonly string[];
  /**
   * The ids of the extensions in it, each switched on or off there; empty
   * until it loads. Every profile has every extension the config names.
   */
  readonly extensions: readonly string[];
  /** Those of `extensions` switched on here. */
  readonly enabledExtensions: readonly string[];
  /**
   * Those of `extensions` the config switches here, because it names the
   * profile's extensions. Only the config changes these
   * (DomicileHost.setBrowserProfileExtensionEnabled refuses them).
   */
  readonly lockedExtensions: readonly string[];
};

/**
 * One of the desk's browser windows: a page the browser holds, drawn with
 * `<webview window="id">`. See components/domicile/mojom/browser_windows.mojom.
 *
 * An interface for DomicileDisplay's reason: these are read from the
 * desktop's `browserWindows` attribute, and WebIDL forbids a dictionary as an
 * attribute type.
 */
export type DomicileBrowserWindow = {
  /**
   * The id `<webview window>` and closeBrowserWindow() use. Never reused while
   * the browser runs.
   */
  readonly id: string;
  /** The page's address. Empty before it has shown anything. */
  readonly url: string;
  /** The page's title. Empty when the page has none. */
  readonly title: string;
  /**
   * The extension popup window (chrome.windows) whose one tab this is. Null
   * for a tab of the desk's own window.
   */
  readonly popupWindow: number | null;
  /**
   * The size the popup window, or a page's window.open(), asked for, in CSS
   * pixels. 0 on an axis it left unset. For a view, the size its app gave it.
   */
  readonly width: number;
  readonly height: number;
  /**
   * Whether the page is private: in a private profile, off the record,
   * sharing nothing with the user's other pages and storing nothing past the
   * profile's last page. A private window's new windows are private too.
   */
  readonly isPrivate: boolean;
  /**
   * The id of the browser profile the page is in, one of
   * DomicileHost.browserProfiles; null for a page in none, such as an
   * Electron app's. A window's new windows are in its profile.
   */
  readonly profile: string | null;
  /**
   * The page's storage partition, as a <webview>'s `partition` attribute
   * names it: "persist:<name>" on disk, any other name in memory. Empty for
   * the profile's own. A window's new windows share it.
   */
  readonly partition: string;
  /**
   * Whether this is an app window, opened by `domicile open-app`. Draw it as
   * an application: no address bar. Its page's new windows are browser
   * windows. See docs/architecture/WEB-APPS.md.
   */
  readonly isApp: boolean;
  /**
   * The app window's id, as openAppWindow() or `domicile open --app --id`
   * gave it. Empty for none, and for every other window.
   */
  readonly appId: string;
  /**
   * Whether a capture of the page alone is running: a screenshot, a picker's
   * preview or a screen cast of it. A page draws only while laid out, so keep
   * a window you hide, such as behind a tab, laid out while it is captured.
   */
  readonly isCaptured: boolean;
  /**
   * The window's identifier on ext-foreign-toplevel-list-v1, which a capture
   * tool such as `grim -T` names it by, as DomicileWindow.toplevelId. Null
   * until the compositor has listed the window.
   */
  readonly toplevelId: string | null;
  /**
   * For an Electron app's view (a WebContentsView): the id of the window
   * that holds it. Null for every window. A view is part of its window, not a
   * window: it is listed right after the window, bottom first, only while
   * the window holds it, and is never a capture source of its own. Draw it
   * with `<webview window>` as any window, where its app asks (`x`, `y`,
   * `width`, `height`, in CSS pixels from the top left of the window's page)
   * or wherever the shell lays it out. See docs/architecture/ELECTRON-APPS.md.
   */
  readonly parent: string | null;
  readonly x: number;
  readonly y: number;
  /**
   * Whether its Electron app hid it. Keep a hidden view laid out, out of
   * sight, as a page draws only while laid out. A hidden window is open, its
   * page running, but the app wants it out of sight (win.hide, or `show:
   * false`): don't show it until it is shown again. Its app shows it and
   * then asks for focus. False for every other window.
   */
  readonly isHidden: boolean;
  /**
   * An Electron app window's menu bar, for the shell to draw under its tab:
   * the menu's entries as JSON, null for none. Each entry has a whole `id`
   * from 1, a `type` (normal, separator, submenu, checkbox or radio), a
   * `label` with Electron's `&` mnemonics, `enabled`, `visible` and
   * `checked`, and maybe an `accelerator` as the app wrote it, an `icon` (a
   * PNG data: URL) and a `submenu` of entries. Click an entry with
   * DomicileHost.clickBrowserWindowMenu.
   */
  readonly menu: string | null;
  /**
   * Whether the bar shows, as setMenuBarVisibility says. With
   * `menuBarAutoHide`, as Electron's autoHideMenuBar, it shows while Alt is
   * held or after Alt is tapped. A window with no menu has true and false.
   */
  readonly menuBarVisible: boolean;
  readonly menuBarAutoHide: boolean;
  /**
   * The message box an Electron app asks over this window, as JSON, null for
   * none: `type` (none, info, error, question or warning), `title`,
   * `message`, `detail`, `buttons` (1 to 16 labels, in the app's order),
   * `defaultId` (the button Enter presses, -1 for none), `cancelId` (the
   * button Escape presses), `checkboxLabel` (empty for no checkbox) and
   * `checkboxChecked`. Show it over the window's page, and answer it with
   * DomicileHost.answerBrowserWindowMessageBox; the window then lists its
   * next box, if its app asked more.
   */
  readonly messageBox: string | null;
  /**
   * The popup menu an Electron app shows over this window (Menu.popup), as
   * JSON, null for none: `menu`, its entries as `menu`'s are, and `x` and
   * `y`, where it goes in CSS pixels from the page's top left. Draw it over
   * the page there, and answer it with
   * DomicileHost.answerBrowserWindowPopupMenu.
   */
  readonly popupMenu: string | null;
  /**
   * What an Electron app asks this window to be (win.maximize, minimize,
   * setFullScreen). The shell decides, and says what it made the window with
   * DomicileHost.setBrowserWindowState. Each is false for any other window.
   */
  readonly wantsMaximized: boolean;
  readonly wantsMinimized: boolean;
  readonly wantsFullscreen: boolean;
};

/**
 * A TV the desktop can cast to: a Google Cast receiver the browser's Media
 * Router found. See components/domicile/mojom/cast_sinks.mojom.
 *
 * An interface for DomicileBrowserWindow's reason: these are read from the
 * desktop's `castSinks` attribute.
 */
export type DomicileCastSink = {
  /** The id startCasting() takes. */
  readonly id: string;
  /** What the TV calls itself. */
  readonly name: string;
  /**
   * The cast to it from this browser, which stopCasting() takes. Null while
   * none runs.
   */
  readonly route: string | null;
};

/**
 * One thing that was copied, as a row of the clipboard's history.
 *
 * An interface rather than a dictionary because WebIDL will not have a
 * dictionary as the element type of an attribute's array, which is how these
 * are read -- off DomicileHost.clipboard rather than handed over in a call.
 */
export type DomicileClipboardEntry = {
  /**
   * What DomicileHost.copyClipboardEntry() and removeClipboardEntry() name
   * this row by.
   *
   * Assigned by the compositor and never reused, so an id a shell holds names
   * the row it was told about or nothing. Not a position: reordering the list
   * keeps every id.
   */
  readonly id: number;
  /**
   * Whether the copy is an image with no text, so a panel can draw it as one.
   * Its preview then names its size or format.
   */
  readonly image: boolean;
  /**
   * Enough of what was copied to recognize it by, and not necessarily all of
   * it: a long copy is cut down to a row, because this is what a panel draws
   * and the rest of a copied file is not a row.
   *
   * What goes back on the clipboard is always the whole thing, which is the
   * reason a row is an id and a preview rather than the text: the bytes stay
   * in the compositor, and a password manager's copy is a row in this list.
   */
  readonly preview: string;
  /**
   * A small picture of an image with no text, as a PNG `data:` URL, so a
   * panel can show what was copied. Empty for text, and for an image the
   * compositor could not read; its preview still names it.
   */
  readonly thumbnail: string;
  /**
   * Whether this is what the clipboard holds. Only the newest row can be, and
   * none is after removeClipboardEntry() removes it, until the next copy.
   */
  readonly current: boolean;
};

/**
 * One screen of the desktop.
 *
 * An interface because WebIDL does not allow a dictionary as an attribute type.
 *
 * Sizes are integers because the desktop config uses whole pixels. Other sizes
 * on this channel come from layout boxes and are fractional.
 */
export type DomicileDisplay = {
  /**
   * The compositor's name for this screen from the config, such as `left`.
   * `domicile-0` when Domicile runs in a window instead of driving displays.
   */
  readonly name: string;
  /**
   * The top-left corner in desktop coordinates. The origin is the top-left of
   * the displays' bounding box. Signed because the config can place a display
   * left of or above the origin.
   */
  readonly x: number;
  readonly y: number;
  /** The logical size, in the CSS pixels a shell lays out in. */
  readonly width: number;
  readonly height: number;
  /**
   * The scale advertised to Wayland clients on this screen. This is not the
   * shell's `devicePixelRatio`: the shell is one page at one density across
   * all screens.
   */
  readonly scale: number;
  /**
   * The panel's mode in physical pixels, before rotation. A portrait 4K
   * panel has a 3840x2160 mode and an 1800x3200 logical size. The mode does
   * not follow from the size because `scale` is an integer.
   *
   * Zero when the desktop has no modes, such as when running in a window.
   */
  readonly modeWidth: number;
  readonly modeHeight: number;
  /**
   * The rate the panel scans out at, in mHz (60000 for 60 Hz), as
   * `wl_output.mode` states it. Zero when unknown, such as when running in a
   * window.
   */
  readonly refreshMhz: number;
  /**
   * Whether the panel scans out with a variable refresh rate: `unsupported`
   * (the panel, its connector or its driver cannot, or Domicile runs in a
   * window), `off` or `on`. A DOMString for the reason `transform` is.
   */
  readonly adaptiveSync: string;
  /**
   * Whether the panel is driven in HDR10: `unsupported` (its EDID takes no
   * PQ, its connector cannot scan out in 10 bits, or Domicile runs in a
   * window), `off` or `on`. A DOMString for the reason `transform` is.
   */
  readonly hdr: string;
  /**
   * The panel's peak luminance from its EDID, in cd/m². Zero when it reports
   * none.
   */
  readonly peakLuminance: number;
  /**
   * While `hdr` is `on`, the luminance SDR content's white is shown at, in
   * cd/m². Zero otherwise.
   */
  readonly sdrWhite: number;
  /**
   * The monitor's rotation: `normal`, `rotate-90`, `rotate-180` or
   * `rotate-270`, as the config file spells them.
   *
   * Follows `wl_output.transform`: the name is the counterclockwise turn
   * applied to content, not the panel's turn. `rotate-270` is for a panel on
   * its left side. A shell applies it as written.
   *
   * A DOMString because an enum would need another IDL file and another patched
   * entry in `bindings/idl_in_modules.gni`. The browser maps any other name to
   * `normal`.
   */
  readonly transform: string;
};

export type DomicileDownload = {
  /** The id cancelDownload() and removeDownload() take. */
  readonly id: string;
  readonly state: DomicileDownloadState;
  /** Where it is saved. */
  readonly path: string;
  readonly receivedBytes: number;
  /** 0 when the server sent no size. */
  readonly totalBytes: number;
  /**
   * The browser window whose page started it, as a DomicileBrowserWindow's
   * `id`; empty for a <webview> that is not one. It may have closed since.
   */
  readonly window: string;
  /** The address of the page that started it. */
  readonly page: string;
};

/**
 * One extension with an action, as a shell's tray draws it.
 *
 * An interface rather than a dictionary for DomicileClipboardEntry's reason:
 * WebIDL will not have a dictionary as the element type of an attribute's
 * array, and these are read off DomicileHost.extensions.
 *
 * The state is the active tab's -- the <webview> that last had focus -- or the
 * action's default where there is none. See docs/architecture/EXTENSIONS.md.
 */
export type DomicileExtension = {
  /** What DomicileHost.activateExtension() names it by. */
  readonly id: string;
  readonly name: string;
  /** The action's tooltip. */
  readonly title: string;
  /**
   * data:image/png;base64,..., drawn at this page's device pixel ratio. Not a
   * chrome-extension:// URL: action.setIcon({imageData}) sets an icon that has
   * none.
   */
  readonly icon: string;
  readonly badgeText: string;
  /** A CSS color, #rrggbbaa. Fully transparent when the extension set none. */
  readonly badgeColor: string;
  /**
   * The popup a click opens, in a <webview> the shell draws; null for an
   * action whose click is its `action.onClicked`. Either way the click is
   * activateExtension().
   */
  readonly popup: string | null;
  /** False after the extension's action.disable(). */
  readonly enabled: boolean;
  /**
   * The id of the browser profile it is in: the one setExtensionsProfile()
   * named, once that has loaded. Its popup opens in a <webview> in it.
   */
  readonly profile: string;
};

/**
 * The event behind DomicileHost.onextensionpopuprequested: an extension called
 * `action.openPopup()`.
 */
export type DomicileExtensionPopupEvent = Event & {
  /** The extension: the id its `extensions` entry has. */
  readonly extensionId: string;
  /**
   * The popup to open, a chrome-extension:// URL. Carried here rather than
   * read from the entry, because an extension may clear its popup again as
   * soon as the call answers.
   */
  readonly popup: string;
  /**
   * The id of the browser profile the extension is in, which the popup opens
   * in, as a <webview>'s `profile`.
   */
  readonly profile: string;
};

/**
 * A phase of a gesture claimed with grabGesture().
 *
 * Its own type, like DomicileShortcutEvent: a gesture belongs to no window.
 */
export type DomicileGestureEvent = Event & {
  /**
   * `swipe`, `pinch` or `hold` on a touchpad, or `edge`: one touchscreen
   * finger in from a display's edge.
   */
  readonly kind: string;
  /** `begin`, `update` or `end`. */
  readonly phase: string;
  readonly fingers: number;
  /**
   * This update's motion, in the touchpad's accelerated pointer units, or an
   * edge swipe's in the display's pixels.
   */
  readonly dx: number;
  readonly dy: number;
  /**
   * A pinch's scale relative to its begin, and this update's rotation in
   * degrees clockwise.
   */
  readonly scale: number;
  readonly rotation: number;
  /** On an end: the gesture was abandoned rather than finished. */
  readonly canceled: boolean;
  /**
   * An edge swipe's: the side it came in from, `left`, `right`, `top` or
   * `bottom`. Empty for every other kind.
   */
  readonly edge: string;
};

/** Every event `DomicileHost` fires, by name. */
export type DomicileHostEventMap = {
  /** A grabbed shortcut fired, as a DomicileShortcutEvent. */
  shortcut: DomicileShortcutEvent;
  /**
   * A shortcut that fired was let go: its key came up, or one of its
   * modifiers did, wherever the keyboard is. As a DomicileShortcutEvent.
   */
  shortcutrelease: DomicileShortcutEvent;
  /** A phase of a grabbed gesture, as a DomicileGestureEvent. */
  gesture: DomicileGestureEvent;
  /**
   * A client asked for the keyboard, as a DomicileAppEvent naming it; nothing
   * has moved. The shell answers by calling focusApp(), or does not, which
   * refuses it.
   */
  focusrequested: DomicileAppEvent;
  /**
   * The desktop changed: a screen arrived or left, a display was resized, or
   * its density moved. Read `displays` for what it is now.
   */
  displayschanged: Event;
  /**
   * A window appeared, closed, or changed: its title, size, limits, cursor or
   * popup placement. Read `windows` for what they are now.
   */
  windowschanged: Event;
  /**
   * The compositor said where the keyboard is: `focusedWindow` may have
   * changed. Every time, and once after the windows already running are
   * replayed to a page that has just connected -- which is how a page tells a
   * window opened now from one that was running.
   */
  focusedwindowchanged: Event;
  clipboardchanged: Event;
  traychanged: Event;
  notificationschanged: Event;
  extensionschanged: Event;
  /**
   * An extension called `action.openPopup()`, as a
   * DomicileExtensionPopupEvent. The shell opens the popup it names as it
   * opens a clicked action's. Not held for a late listener: a popup the user
   * did not see asked for is not one to open later.
   */
  extensionpopuprequested: DomicileExtensionPopupEvent;
  /**
   * Fires when one is installed, uninstalled, switched on or off, or
   * reconfigured, or its icon loads.
   */
  installedextensionschanged: Event;
  idlechanged: Event;
  lockedchanged: Event;
  themechanged: Event;
  windowsthemechanged: Event;
  modifierschanged: Event;
  appearancechanged: Event;
  shelloptionschanged: Event;
  /**
   * Fires when a window opens, closes, navigates or changes title. Read
   * `browserWindows` for the current list.
   */
  browserwindowschanged: Event;
  /**
   * Fires when a profile is added, removed, renamed or recolored, the
   * defaults move, a site is pinned, or an extension is installed,
   * uninstalled or switched in one. Read `browserProfiles` for the current
   * list.
   */
  browserprofileschanged: Event;
  /**
   * Fires when a TV appears or goes, or a cast to one starts or ends. Read
   * `castSinks` for the current list.
   */
  castsinkschanged: Event;
  /**
   * Fires when a download starts, progresses, finishes, fails, or leaves the
   * list. Read `downloads` for the current list.
   */
  downloadschanged: Event;
  /**
   * Fires when a video enters or leaves picture-in-picture, plays, pauses,
   * or changes shape or controls. Read `pictureInPictureVideos` for the
   * current list.
   */
  pictureinpicturevideoschanged: Event;
  /**
   * An answer to callSystem(), as a MessageEvent whose `data` is the
   * compositor's `system_reply`, `system_event` or `system_end` line.
   */
  system: MessageEvent<string>;
  /**
   * Every unanswered portal request, as a MessageEvent whose `data` is the
   * compositor's `portal_requests` line. Fired on every change. A listener
   * added later is sent the latest line, so a shell that listens late still
   * sees pending dialogs.
   */
  portalrequests: MessageEvent<string>;
  /**
   * The compositor exited and a new one took over. Fired after every window
   * of the old one has closed and every system call it had has ended with
   * `compositor_gone`; the new one's windows and desk state follow. The page's
   * size and density go to the new one on their own, and the SDK's watches
   * listen again. Wayland clients do not survive a compositor: their windows
   * open again only if something starts them.
   */
  compositorreplaced: Event;
};

/**
 * The desktop a shell is handed — the shell's control channel to the compositor.
 *
 * Not a web standard and not proposed as one. It exists in Domicile's engine
 * fork, on documents served over domicile://, and nowhere else.
 *
 * This is the typed surface rather than a message pipe: the page calls methods
 * and listens for events, and the wire protocol lives in the browser process.
 * The reason is that the protocol carries Spawn, and a page that cannot
 * construct a message cannot construct a malformed one. The cost, which is
 * real, is that adding a message means an engine release rather than editing a
 * TypeScript file.
 */
export type DomicileHost = {
  /**
   * Run a command on the machine running the desktop.
   *
   * Sequence<DOMString> rather than a single string: splitting a command line
   * is a shell's job and there is no shell in this path.
   */
  spawn(command: readonly string[]): void;
  /**
   * Ask what in the compositor's index of the home matches `query`. Resolves
   * with the answer. A newer call supersedes this one, which rejects with an
   * AbortError: a launcher wants the answer to what is typed now.
   *
   * The compositor matches, and only what matched crosses: the index is the
   * whole home, too large to send. See `domicile_host::file_search`. A file's
   * contents are read with callSystem().
   */
  searchFiles(query: string): Promise<DomicileFileSearch>;
  /**
   * A system call: a file, a directory, a watch or a process. `request` is
   * the call as JSON, such as `{"call":"read_file","path":"/sys/x"}`. Answered
   * with `system` events whose `data` carries `id`. The compositor checks
   * every call, the lock included. See docs/SHELL-SYSTEM-ACCESS.md and
   * the SDK's `system` module, which is the way to call this.
   */
  callSystem(id: number, request: string): void;
  /**
   * Answer portal request `id`, which a `portalrequests` event listed.
   * `answer` is JSON with a string `kind`, such as `{"kind":"access"}`. One
   * that is not is dropped in the browser. The compositor checks the rest. See
   * docs/PORTALS.md.
   */
  answerPortalRequest(id: number, answer: string): void;
  /**
   * Put a row of the clipboard's history back on the clipboard.
   *
   * `entry` is an id `clipboard` lists. The compositor holds each row's full
   * text, and the page sees only its preview. No answer: the next paste in any
   * window is that row, served by the compositor. An id the history has since
   * dropped sets nothing.
   */
  copyClipboardEntry(entry: number): void;
  /**
   * Drop a row of the clipboard's history and the copy it holds.
   *
   * Removing the current row also empties the clipboard, so nothing pastes it
   * again. No answer: the next `clipboard` leaves the row out. An id the
   * history has since dropped removes nothing.
   */
  removeClipboardEntry(entry: number): void;
  /**
   * Click an icon in the system tray, with the button `action` names.
   *
   * It names an icon `tray` lists and a button. What the click does is the
   * application's. An id that names no icon now is a click that raced the
   * application going away, and does nothing; an empty one throws.
   */
  activateTrayItem(id: string, action: DomicileTrayAction): void;
  /**
   * Clear notifications: ids `notifications` lists. Each application hears
   * its notification was dismissed, and the next `notificationschanged`
   * leaves them out. An id already gone is passed over.
   */
  dismissNotifications(ids: readonly number[]): void;
  /**
   * Press one of a notification's actions -- "default" for the notification
   * itself. It names a notification and a key it offered. What the press does
   * is the application's. An empty action throws.
   */
  invokeNotificationAction(id: number, action: string): void;
  /**
   * Send `text` from a notification's reply field: the field its
   * "inline-reply" action stands for. The application hears it, if it offered
   * the field.
   */
  replyToNotification(id: number, text: string): void;
  /**
   * Which window has the keyboard: the compositor's seat, and where the keys
   * this page hears are sent. focusChrome() takes it back to the page.
   */
  focusApp(appId: string): void;
  focusChrome(): void;
  /**
   * Say this page renders each window's `frame` as its `<app frame>`, until it
   * loads again. Only then does the compositor sync a window's content with
   * the moves of its popups. A page that sets `frame` some other way, such as
   * always 0, would show a synced window's old frame. An <app> with no `frame`
   * shows the newest.
   */
  syncFrames(): void;
  /**
   * Put the pointer at a place in this page, in the page's own coordinates --
   * the ones a PointerEvent reports as clientX/clientY.
   *
   * For focus that follows the cursor: when a key moves the focus, the shell
   * moves the cursor too, or the next pointer event hands the focus back to
   * whatever the pointer is still over. A page cannot otherwise move the
   * pointer.
   *
   * Doubles because a place in a page is a CSS pixel, which is fractional. A
   * coordinate outside this page is clamped to its own box -- what a page may
   * move is the pointer over itself -- and NaN throws.
   *
   * `unlessOver`, a box in the same coordinates, skips the warp while the
   * pointer is over it. The page cannot see the pointer over a browser
   * window's page; the browser process can.
   */
  warpPointer(x: number, y: number, unlessOver?: DOMRectReadOnly | null): void;
  /**
   * Ask a client to close. Not a kill -- the client decides, which is why a
   * window can refuse and show a save dialog instead.
   */
  closeApp(appId: string): void;
  /**
   * Say this page took the pointer for a window's `pointerConstraint`
   * (`active`), as a pointer lock on its <app>, or let it go. Only once taken
   * is the client told its pointer is locked or confined; letting go unlocks
   * it. The compositor drops an answer for a window it is not offering one
   * to.
   */
  pointerConstrained(appId: string, active: boolean): void;
  /**
   * Hold the pointer inside `boxes`, in this page's CSS pixels, for a window
   * whose `pointerConstraint` is "confine": the pointer stops at their edges,
   * even where a box reaches onto another monitor. An empty list lets go; so
   * does this page going away. A later call replaces the boxes. Clipped to
   * this page's own box.
   *
   * Resolves true once the pointer is held, and false where this engine does
   * not move the pointer itself -- nested in another compositor, or headless
   * -- or none of the boxes is on this page. The shell still answers
   * `pointerConstrained` either way; the client's own motion stays its own.
   * A box with a NaN or infinite edge throws.
   */
  confinePointer(boxes: readonly DOMRectReadOnly[]): Promise<boolean>;
  /**
   * Where the page put an <app>, in the page's CSS pixels. The client draws at
   * the scale of the monitor holding most of that box. Layout still places the
   * window; this only tells the compositor where it ended up.
   */
  setAppBounds(
    appId: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
  /**
   * Draw the desktop the other way round.
   *
   * Answered with `themechanged` to every chrome on the desk, this one
   * included, so a shell renders from `theme` rather than from its own click.
   *
   * The theme lives in the compositor because it also answers the settings
   * portal that GTK, Qt and Electron read a color scheme from. A theme kept in
   * the page would leave client windows light while the shell went dark.
   *
   * A DomicileTheme rather than a DOMString, so a word that is not one of the
   * two is refused at the call instead of at the socket -- see
   * domicile_theme.idl.
   */
  setTheme(theme: DomicileTheme): void;
  /**
   * Offer a passphrase at a locked desk.
   *
   * While the desk is locked, the compositor passes nothing this page forwards
   * to the Wayland seat, and this call is the only way to unlock it. The page
   * still gets its own keys, so a lock screen can take a passphrase.
   *
   * Answered with `lockedchanged` to every chrome, and only when the desk
   * unlocked. A wrong passphrase produces no event; the compositor logs it,
   * without the passphrase. A shell clears its lock screen on `lockedchanged`,
   * never on its own check, or anyone with the devtools could open it.
   */
  unlock(passphrase: string): void;
  /**
   * Lock the desk now, whoever is at it. Answered like unlock(): with
   * `lockedchanged` to every chrome, and only when the desk actually shut.
   */
  lock(): void;
  /**
   * This page's old frame is held for `theme`: turn the desk's windows now.
   *
   * Called from inside a shell's wipe, once the frame it wipes away from is
   * captured, so that the wipe passes across windows that turn inside it
   * rather than over windows that had already turned. Answered with a
   * `windowsthemechanged` once every chrome has called it and the windows have
   * had their chance to repaint -- or once the compositor stopped waiting.
   */
  themeCaptured(theme: DomicileTheme): void;
  /**
   * Route a key combination to the page rather than to the focused client, by
   * name: `grabShortcut("Meta+Shift+l")`, in sway's grammar. The
   * engine finds the key the keysym is on, from the keyboard the compositor
   * describes, and finds it again whenever the layout changes. The press comes
   * back as a `shortcut` event whose `chord` is this string -- pressed in a
   * `<webview>` or on this page, where it is taken from the page.
   *
   * Throws a SyntaxError for a chord written wrong, and a NotFoundError for a
   * keysym the keyboard cannot type; before any keyboard is described, that
   * one is a console warning once it is.
   *
   * A modifier alone, `grabShortcut("Meta")` (or `Super`, `Alt`, `Ctrl`,
   * `Shift`, in any spelling a chord takes), is a tap of it: either side's key
   * pressed and let go with nothing else in between. Another key, a click, a
   * scroll, a pinch, a touch or a touchpad gesture the shell takes makes it no
   * tap, so `Meta+Return` and Super-dragging a window still work. Nor does a
   * hold longer than `longestTap` milliseconds, 300 unless given, as on
   * GNOME: Super held and let go does nothing. A tap comes back as a
   * `shortcut` and then a `shortcutrelease` with `keyCode` 0, once the key is
   * up. The engine hears it before any page or window does, and the key still
   * reaches the focused client as it always did. `longestTap` means nothing
   * to a chord.
   */
  grabShortcut(
    chord: string,
    whileInhibited?: boolean,
    longestTap?: number,
  ): void;
  /**
   * Answer one grabShortcut() of that name. Once every grab of it is
   * answered, its key reaches the focused client or site again, so two parts
   * of a shell can grab one chord and each give it back. A chord not grabbed
   * is a no-op. Throws a SyntaxError for a chord written wrong.
   *
   * While the window with the keyboard holds a shortcuts inhibitor
   * (`DomicileWindow.inhibitsShortcuts`), a grabbed chord pressed on this
   * page is its key, not a `shortcut`, unless a grab of it passed
   * `whileInhibited`, as sway's `bindsym --inhibited` does.
   */
  ungrabShortcut(chord: string): void;
  /**
   * Route a touchpad gesture to the page rather than to the window under the
   * pointer, in sway's grammar without the direction: `swipe:3`, `pinch:4`,
   * `hold`. A count left out is any of three fingers or more; two are the
   * page's, for its scrolling, zoom and history. Or a touchscreen finger in
   * from a display's edge: `edge:left`, `right`, `top` or `bottom`, or `edge`
   * for any. Each phase comes back as a `gesture` event. Counted, like
   * grabShortcut(). While the window with the keyboard holds a shortcuts
   * inhibitor, a grabbed gesture fires nothing.
   *
   * Throws a SyntaxError for a gesture written wrong, or of fewer than three
   * fingers.
   */
  grabGesture(gesture: string): void;
  /**
   * Answer one grabGesture() of that name. A gesture not grabbed is a no-op.
   * Throws a SyntaxError for a gesture written wrong.
   */
  ungrabGesture(gesture: string): void;
  /**
   * Click an extension's action, popup or not: the extension is granted
   * activeTab on the active tab, as a toolbar click grants it in Chrome. Then
   * an action with no popup has its `action.onClicked` dispatched; one with a
   * popup is the shell's to open, as a <webview> at the `popup` its
   * `extensions` entry names, and is opened after this call.
   *
   * Handled by the browser process, not the compositor, over the tray's own
   * pipe: see components/domicile/mojom/extension_tray.mojom. An id that
   * names no extension with an action now is a click that raced an
   * uninstall, and does nothing; an empty one throws.
   */
  activateExtension(id: string): void;
  /**
   * Show the actions of browser profile `profile`'s extensions in
   * `extensions`, and have activateExtension() click them there, on the
   * active tab of its pages: as Chrome's toolbar shows its window's
   * profile's. A shell names the profile of the page it last focused. The
   * default profile's until called, and while `profile` loads; one the desk
   * does not have shows the default's. Each entry's `profile` says which it
   * is. Over the tray's pipe, as activateExtension(). An empty id throws.
   */
  setExtensionsProfile(profile: string): void;
  /**
   * Switch installed extension `id` on or off, as chrome://extensions does.
   * Resolves once switched; `installedExtensions` and `extensions` follow.
   * Rejects with an OperationError saying why, in words to show, when it is
   * not. Over the tray's pipe, as activateExtension().
   */
  setExtensionEnabled(id: string, enabled: boolean): Promise<void>;
  /**
   * Set each of `settings` present on installed extension `id`, or none.
   * Rejects with an OperationError saying why, in words to show: a setting
   * the extension cannot use, one the desk's config sets (its `configured`),
   * or a site that is not a host. Throws a TypeError for a `siteAccess` that
   * is not one of its three, or `sites` without "specific_sites".
   */
  configureExtension(
    id: string,
    settings: DomicileExtensionSettings,
  ): Promise<void>;
  /**
   * Uninstall extension `id`, as its user would. Rejects with an
   * OperationError saying why, in words to show: one the config installed
   * (its `fromConfig`) is only the config's to remove.
   */
  uninstallExtension(id: string): Promise<void>;
  /**
   * Opens a browser window at `url`, for the shell's own UI such as a `+`
   * button or a launcher. It appears in the next `browserwindowschanged`. A
   * domicile:// address shows blocked, as in a <webview>.
   *
   * `partition` gives its page storage of its own, as a <webview>'s
   * `partition` attribute does. Throws TypeError for "persist:" with no name.
   *
   * `profile` opens it in that browser profile, one of `browserProfiles`;
   * empty for the one `url`'s site opens in (browserProfileFor). A profile
   * the desk no longer has opens in the default one.
   */
  openBrowserWindow(url: string, partition?: string, profile?: string): void;
  /**
   * Opens a private browser window at `url`, as openBrowserWindow does, in
   * the default private profile; see DomicileBrowserWindow's `isPrivate`. To
   * open one in another private profile, name it to openBrowserWindow.
   */
  openPrivateBrowserWindow(url: string): void;
  /**
   * Opens an app window at `url`, as `domicile open --app` does, for a
   * shell's own launcher. It appears in the next `browserwindowschanged` with
   * `isApp` set and `appId`. A domicile:// address shows blocked, as in a
   * <webview>.
   *
   * `reuse` says what to do when an app window with `appId` is open: "new"
   * opens another, "focus" brings the oldest such window to the front, as
   * its page's window.focus() would, and "navigate" also loads `url` in it.
   * The browser matches the window, so two quick calls never open two.
   * Throws TypeError for another `reuse`, and for "focus" or "navigate" with
   * no `appId`.
   *
   * `profile` opens a new window in that browser profile, one of
   * `browserProfiles`; empty for the one `url`'s site opens in
   * (browserProfileFor), as for openBrowserWindow.
   */
  openAppWindow(
    url: string,
    appId?: string,
    reuse?: string,
    profile?: string,
  ): void;
  /**
   * How many elements in browser window `id`'s main document match the CSS
   * `selector`, as a <webview>'s countMatches() counts them. A hidden window
   * answers. Throws SyntaxError for a selector that does not parse. Rejects
   * with InvalidStateError for an unknown window, and when the page gave no
   * number, as when it navigated first.
   */
  countBrowserWindowMatches(id: string, selector: string): Promise<number>;
  /**
   * Clicks the first shown element in browser window `id`'s main document that
   * matches the CSS `selector`, as a <webview>'s clickMatch() clicks it. A
   * hidden window is clicked too. Resolves whether an element matched. Throws
   * SyntaxError for a selector that does not parse. Rejects with
   * InvalidStateError for an unknown window, and when the page gave no answer,
   * as when it navigated first.
   */
  clickBrowserWindowMatch(id: string, selector: string): Promise<boolean>;
  /**
   * Closes window `id`; it leaves the next `browserwindowschanged`. A page
   * with a `beforeunload` handler may first ask to stay, as a `domicile-dialog`
   * on its <webview>; Cancel keeps the window. An unknown id does nothing.
   */
  closeBrowserWindow(id: string): void;
  /**
   * Moves window `id`'s page to browser profile `profile`, one of
   * `browserProfiles`, as a new page under the same id: the window keeps its
   * place, its <webview> shows the new page, and its back and forward list
   * comes along as addresses. The page reloads; what was typed into it is
   * not kept. Throws TypeError for an empty id or profile. An unknown window
   * or profile, or an app window, does nothing: the shell's lists may be a
   * change behind.
   */
  reopenBrowserWindow(id: string, profile: string): void;
  /**
   * The browser profile `url` opens in: the most specific of the config's
   * `browser.sites` that matches it, else the default profile. The engine
   * routes every new window and every page the user takes to another site
   * by this. Throws TypeError for a `url` that is no address.
   */
  browserProfileFor(url: string): Promise<string>;
  /**
   * The site that routes `url` to its profile: the entry of the config's
   * `browser.sites`, or of the sites the user pinned, that browserProfileFor
   * matched. Empty when none did, so it opens in the default profile.
   * Throws TypeError for a `url` that is no address.
   */
  browserSiteFor(url: string): Promise<string>;
  /**
   * Opens `site` in browser profile `profile` from now on, kept across
   * restarts; the default profile unpins it. `site` is a host, `*.host`, or
   * a host and path, as the config's `browser.sites` keys are; it shows in
   * the profile's `pinnedSites` from the next `browserprofileschanged`.
   * Pages already open stay where they are. Throws TypeError for an empty
   * site or profile. Rejects with an OperationError saying why for a site
   * the config's sites name, which only the config changes, for one that is
   * no such key, and for a profile the desk does not have.
   */
  pinBrowserSite(site: string, profile: string): Promise<void>;
  /**
   * Switches extension `id` on or off in browser profile `profile`, kept
   * across restarts: it runs in that profile's pages, or nowhere in them, and
   * keeps its data while off. The profile's `enabledExtensions` shows it from
   * the next `browserprofileschanged`. Throws TypeError for an empty profile
   * or id. Rejects with an OperationError saying why for a profile the desk
   * does not have or has not loaded, an extension it does not have, and one
   * in its `lockedExtensions`, which only the config switches.
   */
  setBrowserProfileExtensionEnabled(
    profile: string,
    id: string,
    enabled: boolean,
  ): Promise<void>;
  /**
   * The user clicked entry `command` of window `id`'s menu bar
   * (DomicileBrowserWindow.menu); its Electron app runs the entry. Throws a
   * TypeError for a `command` below 1. A window that closed meanwhile, or has
   * no menu, does nothing.
   */
  clickBrowserWindowMenu(id: string, command: number): void;
  /**
   * The user chose entry `command` (its `id`) of the popup menu window `id`
   * shows (DomicileBrowserWindow.popupMenu), or put it away with nothing
   * chosen for 0. Throws a TypeError for a negative `command`. A window that
   * closed meanwhile, or shows no popup menu, does nothing.
   */
  answerBrowserWindowPopupMenu(id: string, command: number): void;
  /**
   * The shell made browser window `id` maximized, minimized and fullscreen as
   * these say, whether or not its app asked (DomicileBrowserWindow.
   * wantsMaximized and the rest). An Electron app's window tells its app of
   * each change; any other window, or one that closed meanwhile, does
   * nothing.
   */
  setBrowserWindowState(
    id: string,
    maximized: boolean,
    minimized: boolean,
    fullscreen: boolean,
  ): void;
  /**
   * The user answered the message box window `id` shows
   * (DomicileBrowserWindow.messageBox) with button `response`, an index into
   * its `buttons`, leaving its checkbox `checkboxChecked`. Throws a TypeError
   * for a negative `response`. A window that closed meanwhile, or shows no
   * box, does nothing.
   */
  answerBrowserWindowMessageBox(
    id: string,
    response: number,
    checkboxChecked: boolean,
  ): void;
  /**
   * Casts the desktop to TV `id`: its picture is what the desktop's ScreenCast
   * portal picks, which asks this page, and its sound is the desktop's.
   * Resolves with the cast's route, which the TV's `route` shows from the
   * next `castsinkschanged`, once the TV takes it. Rejects with an
   * OperationError saying why, in words to show, when it does not.
   */
  startCasting(id: string): Promise<string>;
  /**
   * Stops cast `route`; its TV's `route` is null in the next
   * `castsinkschanged`. An unknown route does nothing.
   */
  stopCasting(route: string): void;
  /**
   * Cancels download `id`; it leaves the next `downloadschanged`. An unknown
   * id, or one no longer in progress, does nothing.
   */
  cancelDownload(id: string): void;
  /**
   * Removes download `id` from `downloads`. The file stays. A download in
   * progress, or an unknown id, does nothing.
   */
  removeDownload(id: string): void;
  /** Removes every download not in progress from `downloads`. The files stay. */
  clearDownloads(): void;
  /**
   * Acts on video `id`, as its controls do. "back-to-page" and "close" end
   * picture-in-picture; it leaves the next `pictureinpicturevideoschanged`.
   * An unknown id does nothing.
   */
  actOnPictureInPictureVideo(
    id: string,
    action: DomicilePictureInPictureAction,
  ): void;
  /**
   * Moves video `id` to `seconds` in, as its progress bar does. Throws
   * RangeError for a negative time. An unknown id does nothing.
   */
  seekPictureInPictureVideo(id: string, seconds: number): void;
  /**
   * Says video `id` is shown `width` by `height` CSS pixels big; its page
   * hears it as its PictureInPictureWindow's size. An unknown id does
   * nothing.
   */
  resizePictureInPictureVideo(id: string, width: number, height: number): void;
  /**
   * Sends `method`, "GET" or "POST", to `url` from the browser process with
   * the cookies of browser profile `profile`, one of `browserProfiles`, or
   * for an empty one the default profile's, so a bar item can read a site
   * the user is signed in to. A POST sends `body`, as a
   * same-origin CORS request from `url`'s own origin.
   * Resolves with the response, whatever its status. Rejects with a
   * NetworkError for a network failure or a refusal: an address that is not
   * https, another method, a GET with a body, a `Cookie` or `Origin` header
   * or one the browser sets itself, or a locked desk. A GET follows redirects on https
   * only, and one that leaves the origin drops `headers`; a POST follows
   * none.
   *
   * With `sapisidHashOrigin`, an https origin such as
   * "https://mail.google.com", the browser also sends the `Authorization:
   * SAPISIDHASH` header Google's first-party APIs take, computed from the
   * SAPISID cookie, and follows no redirect. The page never sees the cookie.
   *
   * Also rejects with a NetworkError for a profile the desk does not have,
   * or a private one, which keeps no sign-ins to fetch with.
   *
   * Handled by the browser process, over its own pipe: see
   * components/domicile/mojom/shell_fetch.mojom.
   */
  fetchWithCookies(
    url: string,
    method: string,
    headers: readonly DomicileFetchHeader[],
    body: string | null,
    sapisidHashOrigin: string | null,
    profile?: string,
  ): Promise<DomicileFetchResponse>;
  /**
   * The screens of the desktop.
   *
   * An attribute rather than an event payload, so a component that mounts
   * after the description arrived can still read it.
   *
   * Null until the compositor has described the desktop, and an empty array
   * for a desktop with no screens. A shell renders these differently: null
   * means wait, empty means there is no screen. The compositor always
   * describes at least one output; the `domicile` daemon sends the empty one.
   *
   * A different array after every `displayschanged`: the compositor sends the
   * whole desktop on each change.
   */
  readonly displays: readonly DomicileDisplay[] | null;
  /**
   * Every client window on the desktop, in the order they appeared: what the
   * compositor has said about each so far. Reading it binds the channel, and
   * the compositor announces the windows already running as it does, so a
   * shell that reads late misses nothing -- it reads, then listens for
   * `windowschanged`. A different array after every change, for `displays`'s
   * reason.
   */
  readonly windows: readonly DomicileWindow[];
  /** The window holding the keyboard, or null when the shell's page holds it. */
  readonly focusedWindow: string | null;
  /**
   * The desk's state, as attributes. Each is what the compositor last said,
   * null until it has said anything, and a bare `<name>changed` event says it
   * moved: a shell reads, then listens, and one that listens late misses
   * nothing. See packages/chrome-sdk/README.md.
   */
  readonly clipboard: readonly DomicileClipboardEntry[] | null;
  readonly tray: readonly DomicileTrayItem[] | null;
  readonly notifications: readonly DomicileNotification[] | null;
  readonly extensions: readonly DomicileExtension[] | null;
  /**
   * Every extension installed in the shell's profile, switched on or off,
   * with its settings, for a menu that manages them. Null until the browser
   * lists them, which it does as soon as this page listens. No [SameObject],
   * for `displays`' reason.
   */
  readonly installedExtensions: readonly DomicileInstalledExtension[] | null;
  readonly idle: boolean | null;
  readonly locked: boolean | null;
  readonly theme: DomicileTheme | null;
  readonly windowsTheme: DomicileTheme | null;
  /**
   * The compositor seat's modifiers, which count only keys forwarded to a
   * client. Read a page's own key events instead; see "Reading held
   * modifiers" in packages/chrome-sdk/docs/ELEMENTS.md.
   */
  readonly altKey: boolean | null;
  readonly ctrlKey: boolean | null;
  readonly shiftKey: boolean | null;
  readonly metaKey: boolean | null;
  /**
   * The config's accent color, contrast and reduced motion, which the
   * settings portal also serves applications. `accentColor` is "#rrggbb", or
   * null where the config leaves it to the shell. `highContrast` and
   * `reducedMotion` are null until the compositor says.
   */
  readonly accentColor: string | null;
  readonly highContrast: boolean | null;
  readonly reducedMotion: boolean | null;
  /**
   * The config's `shell_options` as JSON text: the values of the options the
   * shell declares. Null until the compositor says. Text rather than an
   * object, so the page parses it against its own declaration; see the SDK's
   * `watchShellOptions`.
   */
  readonly shellOptions: string | null;
  /**
   * The desk's browser windows, oldest first. Null until the browser lists
   * them, which it does as soon as this page listens. The browser holds each
   * page; draw one with `<webview window="id">`. A shell loaded over this one
   * gets the same windows and pages. See
   * components/domicile/mojom/browser_windows.mojom.
   *
   * A window a program opens (`domicile open-url`, a page's target="_blank",
   * an extension) appears here in the next `browserwindowschanged`. No
   * [SameObject], for `displays`' reason.
   */
  readonly browserWindows: readonly DomicileBrowserWindow[] | null;
  /**
   * The desk's browser profiles, in the config's order: sets of sign-ins,
   * site data and extensions, as the config's `browser.profiles` names them.
   * Null until the browser lists them. No [SameObject], for `displays`'
   * reason. See docs/architecture/BROWSER-PROFILES.md.
   */
  readonly browserProfiles: readonly DomicileBrowserProfile[] | null;
  /**
   * The TVs the desktop can cast to: the Google Cast receivers the browser
   * finds, by name. Null until the browser lists them, which it does as soon
   * as this page listens; empty when the profile turns casting off. No
   * [SameObject], for `displays`' reason. See
   * components/domicile/mojom/cast_sinks.mojom.
   */
  readonly castSinks: readonly DomicileCastSink[] | null;
  /**
   * The desk's downloads, oldest first: each one a browser window's page
   * started while the browser runs, until removeDownload() or
   * clearDownloads(). Null until the browser lists them, which it does as soon
   * as this page listens. No [SameObject], for `displays`' reason. See
   * components/domicile/mojom/downloads.mojom.
   */
  readonly downloads: readonly DomicileDownload[] | null;
  /**
   * The videos in picture-in-picture, oldest first: each one a page's
   * `requestPictureInPicture()` or its video controls' button, until it
   * leaves picture-in-picture. Null until the browser lists them, which it
   * does as soon as this page listens. Show one with
   * `<app picture-in-picture="id">`. No [SameObject], for `displays`'
   * reason. See components/domicile/mojom/picture_in_picture.mojom.
   */
  readonly pictureInPictureVideos:
    | readonly DomicilePictureInPictureVideo[]
    | null;
  /**
   * Typed by the event map rather than by inheriting `EventTarget`, whose
   * overloads take any name and type every listener's event as `Event`.
   * `dispatchEvent` is left out: a page does not dispatch to it.
   */
  addEventListener<T extends keyof DomicileHostEventMap>(
    type: T,
    listener: (event: DomicileHostEventMap[T]) => void,
  ): void;
  removeEventListener<T extends keyof DomicileHostEventMap>(
    type: T,
    listener: (event: DomicileHostEventMap[T]) => void,
  ): void;
};

/**
 * One extension installed in the shell's profile, switched on or off, as a
 * shell's menu of extensions draws it. Apps, themes and Chrome's own are left
 * out, as chrome://extensions leaves them out.
 *
 * An interface rather than a dictionary for DomicileExtension's reason: these
 * are read off DomicileHost.installedExtensions.
 */
export type DomicileInstalledExtension = {
  /**
   * What setExtensionEnabled(), configureExtension() and uninstallExtension()
   * name it by, and the id of its entry in `extensions` when it has an action.
   */
  readonly id: string;
  readonly name: string;
  /**
   * The manifest's icon as data:image/png;base64,..., drawn at this page's
   * device pixel ratio. Chrome's placeholder until the icon loads.
   */
  readonly icon: string;
  /** Switched on. Only a switched-on extension has an action in `extensions`. */
  readonly enabled: boolean;
  /**
   * Its chrome://extensions settings. Each is null where the extension cannot
   * use it: local files and sites where it asks for none, user scripts where
   * it does not ask for chrome.userScripts. Private windows are a private
   * browser profile's, whose switches say what runs there.
   */
  readonly fileAccess: boolean | null;
  readonly userScripts: boolean | null;
  /** "on_click", "specific_sites" or "all_sites". */
  readonly siteAccess: string | null;
  /** With "specific_sites": hosts, each also as `*.host` for its subdomains. */
  readonly sites: readonly string[];
  /**
   * The settings the desk's config sets, by the names above. Only the config
   * changes them: configureExtension() refuses them.
   */
  readonly configured: readonly string[];
  /** The config installed it, so only the config uninstalls it. */
  readonly fromConfig: boolean;
  /** Its options page, or null if it has none. */
  readonly optionsUrl: string | null;
};

/**
 * One notification: an application's call to org.freedesktop.Notifications,
 * which the compositor serves -- a page's own Web Notification included,
 * because the browser shows one by calling that server.
 *
 * An interface rather than a dictionary for DomicileTrayItem's reason: these
 * are read off DomicileHost.notifications.
 */
export type DomicileNotification = {
  /**
   * What DomicileHost.dismissNotifications() and invokeNotificationAction()
   * name this notification by. One its application replaced keeps its id.
   */
  readonly id: number;
  /** Who sent it, as it named itself. May be empty. */
  readonly appName: string;
  /** The one line that says what happened. */
  readonly summary: string;
  /** More, as plain text: the compositor tells senders it takes no markup. */
  readonly body: string;
  /**
   * The picture, as a `data:` URL, or empty for nothing to draw. A URL rather
   * than a path for DomicileTrayItem.icon's reason.
   */
  readonly icon: string;
  /**
   * "low", "normal" or "critical": the spec's urgency hint. A word rather than
   * an enum because it is only ever read, and the SDK parses it.
   */
  readonly urgency: string;
  /** Its buttons. A press on the notification itself is `clickable`. */
  readonly actions: readonly DomicileNotificationAction[];
  /** Whether it offers the "default" action: a press on the notification. */
  readonly clickable: boolean;
  /**
   * How long it asked to stay up, in milliseconds: 0 for until it is
   * dismissed, -1 for the shell's choice.
   */
  readonly timeoutMs: number;
  /**
   * When it arrived or was last replaced, in milliseconds since the epoch on
   * the compositor's clock.
   */
  readonly time: number;
  /**
   * The id of the browser window whose page sent it, as
   * DomicileBrowserWindow.id names it, or empty for anything else.
   */
  readonly browserWindow: string;
};

/**
 * One button of a notification.
 *
 * An interface rather than a dictionary because these are read off a
 * DomicileNotification's array; see DomicileTrayItem.
 */
export type DomicileNotificationAction = {
  /**
   * The id DomicileHost.invokeNotificationAction() takes. "inline-reply" is a
   * reply field rather than a button: DomicileHost.replyToNotification() sends
   * what is typed in it.
   */
  readonly key: string;
  /** The button's label, or the reply field's. */
  readonly label: string;
};

export type DomicilePictureInPictureVideo = {
  /**
   * The id actOnPictureInPictureVideo(), resizePictureInPictureVideo() and
   * `<app picture-in-picture>` take.
   */
  readonly id: string;
  /**
   * The browser window whose page plays it, as a DomicileBrowserWindow's
   * `id`; empty for a <webview> that is not one.
   */
  readonly window: string;
  /** The video's own size, in pixels: its shape. */
  readonly width: number;
  readonly height: number;
  /**
   * Where the video was in its page when it entered picture-in-picture, in
   * CSS pixels from the page's top left, so the shell can grow it out of that
   * place; null when the page was drawn nowhere.
   */
  readonly source: DOMRectReadOnly | null;
  readonly playing: boolean;
  /**
   * Which controls the page takes: play and pause, and its media session's
   * previous and next track.
   */
  readonly canPlay: boolean;
  readonly canPreviousTrack: boolean;
  readonly canNextTrack: boolean;
  /**
   * Where the video is, as its page last said: its length and position in
   * seconds, and how fast the position moves while it plays. A `duration` of
   * 0 is unknown, or a live stream: there is no progress to show.
   */
  readonly duration: number;
  readonly position: number;
  readonly playbackRate: number;
};

/**
 * A combination claimed with grabShortcut() was pressed (`shortcut`) or let
 * go (`shortcutrelease`).
 *
 * Its own type rather than a DomicileAppEvent: a shortcut belongs to no
 * window, and fires whatever holds the keyboard.
 */
export type DomicileShortcutEvent = Event & {
  /**
   * The chord as the shell grabbed it -- `Meta+Shift+l` -- or empty for a key
   * its chord has since moved off. See DomicileHost.grabShortcut().
   */
  readonly chord: string;
  /** The Linux evdev code. */
  readonly keycode: number;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
};

/**
 * One icon in the system tray.
 *
 * An interface rather than a dictionary for DomicileClipboardEntry's reason:
 * WebIDL will not have a dictionary as the element type of an attribute's
 * array, and these are read off DomicileHost.tray.
 */
export type DomicileTrayItem = {
  /**
   * What DomicileHost.activateTrayItem() names this icon by: the bus name the
   * application answers on and the object path it answers at, written together.
   */
  readonly id: string;
  /**
   * What the icon is, in words: its tooltip's title, its title, or its id, the
   * first the application said. Never empty.
   */
  readonly title: string;
  /**
   * The picture, as a `data:` URL to draw, or empty for one the compositor
   * could not draw.
   */
  readonly icon: string;
  /** The bus name the application answers on, unique or well-known. */
  readonly bus: string;
  /**
   * The object path of the icon's `com.canonical.dbusmenu` menu on `bus`, or
   * empty for an icon with none. A shell draws the menu itself, with D-Bus
   * calls through callSystem().
   */
  readonly menu: string;
  /**
   * The icon's `ItemIsMenu`: it only has a menu, so a shell opens the menu on
   * the primary button rather than activating it.
   */
  readonly itemIsMenu: boolean;
};

/**
 * One client window on the desktop, as `DomicileHost.windows` lists it: what
 * the compositor has said about it so far. Replaced, never edited: a change to
 * any window is a new `windows` array and a `windowschanged` event.
 */
export type DomicileWindow = {
  readonly appId: string;
  /** Empty until the client names itself. */
  readonly title: string;
  /**
   * The client's Wayland app id, which names its desktop entry. Empty when the
   * client set none.
   */
  readonly desktopId: string;
  /**
   * The window's identifier on ext-foreign-toplevel-list-v1, which a capture
   * tool such as `grim -T` names it by. Fixed for the window's life. Null for
   * a popup, which is not listed.
   */
  readonly toplevelId: string | null;
  /**
   * The process that connected the window's client, as the kernel recorded
   * it. The client cannot forge these, unlike the fields above. Null for a
   * popup: read its parent's.
   */
  readonly pid: number | null;
  readonly uid: number | null;
  readonly gid: number | null;
  /**
   * The inode of the process's pidfd, which tells a reused pid apart. Null on
   * kernels without pidfs (before Linux 6.9).
   */
  readonly pidfdInode: number | null;
  /**
   * Whether the client connected through a sandbox engine's
   * wp_security_context_v1 listener. A sandboxed client sees no clipboard
   * or screen capture globals. Null for a popup.
   */
  readonly sandboxed: boolean | null;
  /**
   * What the sandbox engine said about the client, such as `org.flatpak`, its
   * app id and its instance id. Null where it said nothing, or for no sandbox.
   */
  readonly sandboxEngine: string | null;
  readonly sandboxAppId: string | null;
  readonly sandboxInstanceId: string | null;
  /**
   * The size the client last committed, in CSS pixels; null until it has
   * committed one.
   */
  readonly width: number | null;
  readonly height: number | null;
  /** The limits the client asked for; null where it asked for none. */
  readonly minWidth: number | null;
  readonly minHeight: number | null;
  readonly maxWidth: number | null;
  readonly maxHeight: number | null;
  /**
   * The client gave the window a parent or a fixed size, so shells float it
   * at its first frame's size.
   */
  readonly dialog: boolean;
  /** The client asked to draw its own frame (client-side decorations). */
  readonly clientFrame: boolean;
  /**
   * The synced frame to set as its `<app frame>`, in the same update as the
   * move that came with it. 0 until the compositor syncs a frame. Moves name
   * frames only for a page that called syncFrames().
   */
  readonly frame: number;
  /**
   * The window this one is a dialog for (xdg_toplevel.set_parent), following
   * every change; null for none, and for a popup. When the parent closes, this
   * names the parent's own parent.
   */
  readonly transientFor: string | null;
  /**
   * The page anchor the client asked to lay the window out at
   * (domicile_toplevel_anchor_v1), following every change; null for none, and
   * for a popup. The name means what the shell says it does. A shell with no
   * anchor of that name lays the window out as any other.
   */
  readonly anchor: string | null;
  /**
   * The compositor dropped the window's request for the keyboard (a token
   * from before the keyboard last moved, or a stale one), and the window has
   * not had the keyboard since. False while it holds the keyboard.
   */
  readonly urgent: boolean;
  /**
   * The client holds a zwp_keyboard_shortcuts_inhibitor_v1. While the window
   * has the keyboard, the desktop's shortcuts are its keys: grabbed chords
   * reach it, and a shell's own key listeners should let keys through.
   */
  readonly inhibitsShortcuts: boolean;
  readonly cursor: DomicileCursorShape;
  /**
   * A cursor the client drew itself, as a CSS `cursor` value to set on its
   * element in place of `cursor`; null while it uses a named one.
   */
  readonly cursorImage: string | null;
  /**
   * A popup's parent window and its place relative to it, and whether it
   * grabbed the pointer; null and false for a toplevel.
   */
  readonly parent: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly grab: boolean;
  /**
   * What the client asked the pointer to do while it is over the window:
   * "lock" it in place, as a game turning its camera does, or "confine" it to
   * the window; null for neither. Offered only for the window under the
   * pointer. The shell decides whether to grant it, and says so with
   * DomicileHost.pointerConstrained(); only then is the client told.
   */
  readonly pointerConstraint: string | null;
  /**
   * The part of the window `pointerConstraint` holds the pointer to, as boxes
   * in the window's own coordinates, which `width` and `height` measure; null
   * for all of it. The client sets it for a confinement, and for a lock it
   * says where the pointer may be when the lock takes hold.
   */
  readonly pointerRegion: readonly DOMRectReadOnly[] | null;
};
