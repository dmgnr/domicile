// Portal dialogs for a shell: the requests applications make through
// `xdg-desktop-portal`, and the shell's answers. See
// docs/PORTALS.md.
//
// The engine relays each request's body untyped; it is parsed here, by kind.
// A new kind is one schema in `KINDS`, one `PortalKind` and one constructor.
// The same push lists the sessions that control or capture input.

export enum PortalKind {
  /** A yes/no question, such as whether an application may use the camera. */
  Access,
  /** Pick an application to open a file or URI with. */
  AppChooser,
  /** Files to open, or where to save. */
  FileChooser,
  /**
   * An application holding off logout, user switching or suspend, until it
   * lets go. Not a question: the compositor refuses answers to it.
   */
  Inhibit,
  /** Which input devices, and the clipboard, an application may control. */
  RemoteDesktop,
  /** Whether an application may take input that crosses a screen edge. */
  InputCapture,
  /**
   * A launcher an application would install. Answer with
   * {@link PortalAnswer.DynamicLauncher} and the name to install it under.
   */
  DynamicLauncher,
  /** USB devices an application would open. Allow them all with {@link PortalAnswer.Access}. */
  Usb,
  /**
   * Whether an application may have the user's name and picture. Allow it
   * with {@link PortalAnswer.Access}.
   */
  Account,
  /** Chords an application asks to hold while it is not focused. */
  GlobalShortcuts,
  /**
   * A picture to preview before it becomes the wallpaper. Allow it with
   * {@link PortalAnswer.Access}.
   */
  Wallpaper,
  /** A source picker: what an application may record. */
  ScreenCast,
  /** Pick a printer and its options. */
  Print,
  /** Pick the area of a frozen desk to save as a screenshot. */
  Screenshot,
  /** Pick a pixel of a frozen desk, for its color. */
  PickColor,
  /**
   * An agent, such as Claude Code through `domicile mcp`, asks to see and use
   * the desk: all of it, or only the windows the user checks. Answer with
   * {@link PortalAnswer.Agent}.
   */
  Agent,
  /** A kind this SDK cannot parse. Answer it with {@link PortalAnswer.Refused}. */
  Unknown,
}

/**
 * The {@link PortalRequestBase.appId} of a dialog the shell asked for itself,
 * such as the one `system(host).screenshot()` puts up. No application can have
 * it.
 */
export const SHELL_APP_ID = "domicile:shell";

/** What every request carries. */
export type PortalRequestBase = {
  /** The id {@link answerPortalRequest} takes. */
  id: number;
  /** The asking application's desktop file id. Empty when unknown. */
  appId: string;
  /** The `<app>` to show the dialog over, or the focused screen when absent. */
  parentAppId: string | undefined;
};

/** An access dialog's texts. A missing label is the shell's to choose. */
export type AccessBody = {
  title: string;
  subtitle: string;
  body: string;
  grantLabel: string | undefined;
  denyLabel: string | undefined;
  /** Allowing cannot be undone, such as shutting down. */
  destructive: boolean;
};

/** What an app chooser opens, and the applications it offers. */
export type AppChooserBody = {
  /** Desktop file IDs without `.desktop`. May change while the dialog is up. */
  choices: readonly string[];
  /** The application chosen last time for this content type. */
  lastChoice: string | undefined;
  /** The MIME type being opened. */
  contentType: string | undefined;
  uri: string | undefined;
  /** The file's name, without its directory. */
  filename: string | undefined;
};

/** Which `FileChooser` method asked. */
export enum FileChooserMode {
  /** Existing files, or a folder when `directory` is set. */
  Open,
  /** One new path. */
  Save,
  /** A folder to save `files` into. */
  SaveFiles,
}

/** A named group of accepted extensions, such as "Images". */
export type FileChooserFilter = {
  /** Lowercase and without the dot; empty accepts any file. */
  extensions: readonly string[];
  name: string;
};

/**
 * A question asked beside the files. No options means a checkbox, answered
 * `"true"` or `"false"`.
 */
export type FileChoice = {
  id: string;
  /** The option id, or `"true"`/`"false"`, selected at first. */
  initial: string;
  label: string;
  options: readonly { id: string; label: string }[];
};

/** A file chooser's request. Paths are absolute. */
export type FileChooserBody = {
  /** The confirm button's label; the shell's own when absent. */
  acceptLabel: string | undefined;
  choices: readonly FileChoice[];
  /** The index in `filters` to start with. */
  currentFilter: number | undefined;
  /** The folder to start in; the home when absent. */
  currentFolder: string | undefined;
  /** The suggested name for {@link FileChooserMode.Save}. */
  currentName: string | undefined;
  /** Open a folder rather than a file. */
  directory: boolean;
  /** The names {@link FileChooserMode.SaveFiles} saves into the folder. */
  files: readonly string[];
  /** Empty accepts any file. */
  filters: readonly FileChooserFilter[];
  /** The user's home directory, where the picker's places are. */
  home: string;
  mode: FileChooserMode;
  multiple: boolean;
  title: string;
};

/** What the user chose in a file chooser. */
export type FileChosen = {
  /** Each {@link FileChoice}'s answer, by id. */
  choices: ReadonlyMap<string, string>;
  /** The index in the request's `filters` in use. */
  currentFilter: number | undefined;
  /** Absolute paths: the files, or the folder for `SaveFiles`. */
  paths: readonly string[];
};

/** A session change an inhibitor holds off. */
export enum Inhibited {
  Logout,
  UserSwitch,
  Suspend,
}

/** What an inhibitor holds off, and the application's reason. */
export type InhibitBody = {
  what: readonly Inhibited[];
  reason: string | undefined;
};

/** Input devices a session asks for or holds. */
export type Devices = {
  keyboard: boolean;
  pointer: boolean;
  touchscreen: boolean;
};

/** What a remote desktop session asks to control. */
export type RemoteDesktopBody = {
  devices: Devices;
  clipboard: boolean;
};

/** A window an agent may be let reach. */
export type AgentWindow = {
  /** Its `domicile list-windows` id. */
  id: string;
  /** A browser window rather than a native one. */
  browser: boolean;
  /** Empty when it has none. */
  title: string;
  /** A native window's desktop entry id, or a browser window's app id. */
  app: string | undefined;
};

/** An agent's ask: its name, and the windows the user may pick from. */
export type AgentBody = {
  /** What the agent calls itself, such as "Claude Code". Not checked. */
  agent: string;
  /** Every window open but private browser windows, which no agent reaches. */
  windows: readonly AgentWindow[];
  /**
   * What it reaches now, when the user asked to change it with
   * {@link PortalAnswer.Change}; canceling keeps it. `undefined` when it
   * asks to come in.
   */
  current: AgentReach | undefined;
  /** Whether it comes in without asking now, so Remember starts on. */
  remembered: boolean;
};

/** What an agent may reach. */
export type AgentReach =
  /** Every window, the pointer and the keyboard. */
  | { kind: "desk" }
  /**
   * These windows alone, through their accessibility trees and their own
   * screenshots. Never the pointer or the keyboard.
   */
  | { kind: "windows"; windows: readonly AgentWindow[] };

/** An agent let in now. */
export type ConnectedAgent = {
  /** Its {@link CapturingKind.Agent} session's id. */
  session: number;
  agent: string;
  reach: AgentReach;
};

/** An agent let reach the whole desk without asking, until forgotten. */
export type RememberedAgent = {
  agent: string;
  /** When it was last let in, in milliseconds since the Unix epoch. */
  lastUsedMs: number;
};

/** The agents the desk knows. */
export type KnownAgents = {
  /** Let in now, oldest first. */
  connected: readonly ConnectedAgent[];
  /** Let in without asking, most recently used first. */
  remembered: readonly RememberedAgent[];
};

/** One thing an agent did, in its words. */
export type AgentAction = {
  said: string;
  /** When, in milliseconds since the Unix epoch, as `Date.now()` counts. */
  atMs: number;
};

/** An agent the user let in. */
export type AgentSessionBody = {
  agent: string;
  reach: AgentReach;
  /** What it did last, newest first; a handful at most. */
  actions: readonly AgentAction[];
};

/** What an input capture session asks to take. */
export type InputCaptureBody = {
  devices: Devices;
};

/** What an application would get of the user, and why it asks. */
export type AccountBody = {
  /** In the application's own words. */
  reason: string | undefined;
  name: string;
  /** The picture's path, or `undefined` for none. */
  image: string | undefined;
};

/** A shortcut an application asks for. */
export type ProposedShortcut = {
  id: string;
  description: string;
  /**
   * The chord the user chose before, else the one the application prefers,
   * as it wrote it; it may not parse. Absent for neither.
   */
  trigger: string | undefined;
};

/** A global shortcuts review: the shortcuts, and chords other apps hold. */
export type ShortcutsBody = {
  shortcuts: readonly ProposedShortcut[];
  taken: readonly { chord: string; appId: string }[];
};

/** The chord the user chose for a shortcut; `undefined` clears it. */
export type ChosenTrigger = { id: string; trigger: string | undefined };

/** A rectangle of a {@link FrozenDesk}'s frame, in its pixels. */
export type ShotRect = { x: number; y: number; width: number; height: number };

/** A monitor of a {@link FrozenDesk}. */
export type ShotArea = {
  /** Its `wl_output` name. */
  name: string;
  /** Its make, model and serial, or empty. */
  description: string;
  area: ShotRect;
};

/**
 * An open window of a {@link FrozenDesk}, shown or not. The shell finds a
 * shown one on the frame itself; one it does not show is saved from its own
 * last frame with {@link PortalAnswer.ScreenshotWindow}.
 */
export type ShotWindow = {
  /** Its host app id, as an `<app>`'s `app-id` names it. */
  id: string;
  /** Empty until the client names it. */
  title: string;
  /** Its Wayland app id, which names its desktop entry; empty if unset. */
  appId: string;
};

/**
 * A frame of the whole desk, frozen while the user picks from it. Every
 * rectangle, and the answer, is in the frame's pixels.
 */
export type FrozenDesk = {
  /** The frame, as a `data:` URL. */
  frame: string;
  width: number;
  height: number;
  monitors: readonly ShotArea[];
  windows: readonly ShotWindow[];
  /**
   * Where the frame is on the desktop, in logical pixels, which are the
   * shell page's CSS pixels.
   */
  desk: {
    position: readonly [number, number];
    size: readonly [number, number];
  };
};

/** A chord an application holds, for the shell to grab. */
export type BoundShortcut = {
  /** The id a press is reported under. */
  id: number;
  appId: string;
  chord: string;
};

/** Where a Wallpaper portal picture goes. */
export enum WallpaperTarget {
  Background,
  Lockscreen,
  Both,
}

/** A wallpaper preview: the picture, as a path to read, and where it goes. */
export type WallpaperBody = {
  path: string;
  setOn: WallpaperTarget;
};

/**
 * The pictures applications set through the Wallpaper portal, as paths to read
 * with the SDK's `system`. `undefined` where none was set.
 */
export type PortalWallpaper = {
  background: string | undefined;
  lockscreen: string | undefined;
};

/** What a launcher starts. */
export enum LauncherType {
  Application,
  Webapp,
}

/** A launcher install: its suggested name, icon and, for a web app, address. */
export type LauncherBody = {
  /** Whether the user may rename it. */
  editableName: boolean;
  /** A `data:` URL; absent when the icon is no picture a page draws. */
  icon: string | undefined;
  launcherType: LauncherType;
  name: string;
  /** A web app's address. */
  target: string | undefined;
};

/** One USB device, as udev names it. */
export type UsbDevice = {
  id: string;
  product: string | undefined;
  vendor: string | undefined;
  /** Whether the application would write to it. */
  writable: boolean;
};

/** The USB devices an application would open. */
export type UsbBody = { devices: readonly UsbDevice[] };
export enum CastSourceKind {
  Window,
  Monitor,
  Region,
  BrowserWindow,
}

export const CastSource = {
  /**
   * A browser window's page alone, picked from `DomicileHost.browserWindows`.
   * The compositor does not list these; see {@link ScreenCastBody}.
   */
  BrowserWindow: (window: {
    /** Its id, as `DomicileHost.browserWindows` lists it. */
    id: string;
    /** Its title as the shell named it, for the sharing indicator. */
    title: string;
    /** Part of its page alone, as a window's `area` is. */
    area?: ShotRect | undefined;
  }) => ({ ...window, kind: CastSourceKind.BrowserWindow as const }),
  Monitor: (monitor: {
    /** Its `wl_output` name, as `DomicileHost.displays` names it. */
    name: string;
    /** Its make, model and serial, or empty. */
    description: string;
    /** In page pixels. */
    size: readonly [number, number];
  }) => ({ ...monitor, kind: CastSourceKind.Monitor as const }),
  /** A rectangle of the desktop the user drew, in page pixels. */
  Region: (region: {
    position: readonly [number, number];
    size: readonly [number, number];
  }) => ({ ...region, kind: CastSourceKind.Region as const }),
  Window: (window: {
    /** The window's id, as `DomicileHost.windows` lists it. */
    id: string;
    /** Empty until the client names it. */
    title: string;
    /** Its Wayland app id, which names its desktop entry; empty if unset. */
    appId: string;
    /**
     * Part of the window alone, in pixels of its frame as
     * `System.previewWindow` draws it. All of it when unset.
     */
    area?: ShotRect | undefined;
  }) => ({ ...window, kind: CastSourceKind.Window as const }),
};

/** One source a screen cast picker offers. */
export type CastSource = ReturnType<
  (typeof CastSource)[keyof typeof CastSource]
>;

/** A screen cast picker's choices. */
export type ScreenCastBody = {
  /** Whether the user may pick more than one source. */
  multiple: boolean;
  /** Windows and monitors. */
  sources: readonly CastSource[];
  /** Whether the user may draw a region instead. */
  region: boolean;
  /**
   * Whether the user may pick a browser window's page alone, which the
   * shell offers from `DomicileHost.browserWindows`.
   */
  browserWindows: boolean;
  /**
   * A frame of the desk to preview the sources on, as a screenshot's.
   * `undefined` when the desk could not be shot.
   */
  desk: FrozenDesk | undefined;
};

export enum CapturedKind {
  Window,
  Monitor,
  Desk,
  Region,
  BrowserWindow,
}

/** A monitor a screen cast records. */
export type CapturedMonitor = {
  /** Its `wl_output` name. */
  name: string;
  /** Its make and model, or empty when it reports none. */
  description: string;
};

export const Captured = {
  /** A browser window's page, with its title when it was picked. */
  BrowserWindow: (window: { id: string; title: string }) => ({
    ...window,
    kind: CapturedKind.BrowserWindow as const,
  }),
  /** A region that covers every monitor of a desktop with several. */
  Desk: () => ({ kind: CapturedKind.Desk as const }),
  /** A monitor, or a region that covers one exactly. */
  Monitor: (monitor: CapturedMonitor) => ({
    ...monitor,
    kind: CapturedKind.Monitor as const,
  }),
  /**
   * A rectangle of the desktop, in page pixels, with the monitor it is mostly
   * on, or `undefined` when it is on none.
   */
  Region: (region: {
    position: readonly [number, number];
    size: readonly [number, number];
    monitor: CapturedMonitor | undefined;
  }) => ({ ...region, kind: CapturedKind.Region as const }),
  /**
   * A window, with its title and its application's Wayland app id when the
   * cast started. The app id is empty when the window has none.
   */
  Window: (window: { appId: string; id: string; title: string }) => ({
    ...window,
    kind: CapturedKind.Window as const,
  }),
};

/** One source a running screen cast records. */
export type Captured = ReturnType<(typeof Captured)[keyof typeof Captured]>;

/** A {@link CapturingKind.Recording}: what it records, where, and for how long. */
export type RecordingBody = {
  sources: readonly Captured[];
  /** The absolute path of the WebM it records into. */
  file: string;
  /** How long it recorded until `runningSinceMs`, or until it paused. */
  recordedMs: number;
  /**
   * When it last started or resumed, in milliseconds since the Unix epoch, as
   * `Date.now()` counts. Undefined while it is paused.
   */
  runningSinceMs: number | undefined;
};

/** IPP's `sides`. */
export enum Sides {
  OneSided,
  /** Bound along the long edge, as a book. */
  TwoSidedLongEdge,
  /** Bound along the short edge, as a notepad. */
  TwoSidedShortEdge,
}

/** IPP's `print-color-mode`, as far as a dialog offers it. */
export enum ColorMode {
  Color,
  Monochrome,
}

/** IPP's `orientation-requested`. */
export enum Orientation {
  Portrait,
  Landscape,
  ReverseLandscape,
  ReversePortrait,
}

/** IPP's `print-quality`. */
export enum PrintQuality {
  Draft,
  Normal,
  High,
}

/** Pages `first` to `last`, counted from 1, both included. */
export type PageRange = { first: number; last: number };

/** A print job's options. An absent option is the printer's default. */
export type PrintOptions = {
  colorMode: ColorMode | undefined;
  /** At least 1. */
  copies: number;
  /** A {@link PrintMedia} `name`. */
  media: string | undefined;
  orientation: Orientation | undefined;
  /** Empty prints every page. */
  pages: readonly PageRange[];
  quality: PrintQuality | undefined;
  sides: Sides | undefined;
};

/** A paper size: its PWG name, and a label for people. */
export type PrintMedia = { label: string; name: string };

/** A printer and what it supports. An empty list offers no choice. */
export type Printer = {
  colorModes: readonly ColorMode[];
  copiesMax: number;
  /** For people. */
  description: string | undefined;
  /** What the dialog starts with for this printer. */
  initial: PrintOptions;
  media: readonly PrintMedia[];
  /** The CUPS queue name. */
  name: string;
  orientations: readonly Orientation[];
  /** Whether it prints only some pages. */
  pageRanges: boolean;
  qualities: readonly PrintQuality[];
  sides: readonly Sides[];
};

/** A print dialog: the document's title, the printers on offer and Save to PDF. */
export type PrintBody = {
  /** The print button's label; the shell's own when absent. */
  acceptLabel: string | undefined;
  /** The user's home directory, where the PDF's file picker starts. */
  home: string;
  /** What Save to PDF offers, as a printer would. Its `name` is no CUPS queue. */
  pdf: Printer;
  /** The printer to start with. */
  printer: string | undefined;
  /** Empty when CUPS has none or cannot be reached. */
  printers: readonly Printer[];
  title: string;
};

export const PortalRequest = {
  Access: (base: PortalRequestBase, body: AccessBody) => ({
    ...base,
    body,
    kind: PortalKind.Access as const,
  }),
  Account: (base: PortalRequestBase, body: AccountBody) => ({
    ...base,
    body,
    kind: PortalKind.Account as const,
  }),
  Agent: (base: PortalRequestBase, body: AgentBody) => ({
    ...base,
    body,
    kind: PortalKind.Agent as const,
  }),
  AppChooser: (base: PortalRequestBase, body: AppChooserBody) => ({
    ...base,
    body,
    kind: PortalKind.AppChooser as const,
  }),
  DynamicLauncher: (base: PortalRequestBase, body: LauncherBody) => ({
    ...base,
    body,
    kind: PortalKind.DynamicLauncher as const,
  }),
  FileChooser: (base: PortalRequestBase, body: FileChooserBody) => ({
    ...base,
    body,
    kind: PortalKind.FileChooser as const,
  }),
  GlobalShortcuts: (base: PortalRequestBase, body: ShortcutsBody) => ({
    ...base,
    body,
    kind: PortalKind.GlobalShortcuts as const,
  }),
  Inhibit: (base: PortalRequestBase, body: InhibitBody) => ({
    ...base,
    body,
    kind: PortalKind.Inhibit as const,
  }),
  InputCapture: (base: PortalRequestBase, body: InputCaptureBody) => ({
    ...base,
    body,
    kind: PortalKind.InputCapture as const,
  }),
  PickColor: (base: PortalRequestBase, body: FrozenDesk) => ({
    ...base,
    body,
    kind: PortalKind.PickColor as const,
  }),
  Print: (base: PortalRequestBase, body: PrintBody) => ({
    ...base,
    body,
    kind: PortalKind.Print as const,
  }),
  RemoteDesktop: (base: PortalRequestBase, body: RemoteDesktopBody) => ({
    ...base,
    body,
    kind: PortalKind.RemoteDesktop as const,
  }),
  ScreenCast: (base: PortalRequestBase, body: ScreenCastBody) => ({
    ...base,
    body,
    kind: PortalKind.ScreenCast as const,
  }),
  Screenshot: (base: PortalRequestBase, body: FrozenDesk) => ({
    ...base,
    body,
    kind: PortalKind.Screenshot as const,
  }),
  Unknown: (base: PortalRequestBase, wireKind: string) => ({
    ...base,
    kind: PortalKind.Unknown as const,
    wireKind,
  }),
  Usb: (base: PortalRequestBase, body: UsbBody) => ({
    ...base,
    body,
    kind: PortalKind.Usb as const,
  }),
  Wallpaper: (base: PortalRequestBase, body: WallpaperBody) => ({
    ...base,
    body,
    kind: PortalKind.Wallpaper as const,
  }),
};

export type PortalRequest = ReturnType<
  (typeof PortalRequest)[keyof typeof PortalRequest]
>;

export enum PortalAnswerKind {
  /**
   * The user allowed an {@link PortalKind.Access} or
   * {@link PortalKind.Account} request.
   */
  Access,
  /** The application the user picked in an {@link PortalKind.AppChooser}. */
  AppChooser,
  /** The user chose in a {@link PortalKind.FileChooser}. */
  FileChooser,
  /** The user granted a {@link PortalKind.RemoteDesktop} no more than it asked. */
  RemoteDesktop,
  /** The user allowed a {@link PortalKind.InputCapture} request. */
  InputCapture,
  /** The user picked sources in a {@link PortalKind.ScreenCast} request. */
  ScreenCast,
  /** The user stopped a {@link Capturing} session. */
  Stop,
  /** The user paused a {@link CapturingKind.Recording}. */
  Pause,
  /** The user resumed a paused {@link CapturingKind.Recording}. */
  Resume,
  /** The user stopped a {@link CapturingKind.Recording} and threw it away. */
  Discard,
  /** The chords the user chose in a {@link PortalKind.GlobalShortcuts} review. */
  GlobalShortcuts,
  /** The name the user installs a {@link PortalKind.DynamicLauncher} under. */
  DynamicLauncher,
  /** The printer and options the user chose in a {@link PortalKind.Print}. */
  Print,
  /** The file a {@link PortalKind.Print} saves its PDF to, and its options. */
  SaveToPdf,
  /** The area of a {@link PortalKind.Screenshot} the user kept. */
  Screenshot,
  /**
   * The window of a {@link PortalKind.Screenshot} the user picked, saved from
   * its own last frame.
   */
  ScreenshotWindow,
  /**
   * A browser window of a {@link PortalKind.Screenshot} the user picked, saved
   * from the engine's capture of its page alone.
   */
  ScreenshotBrowserWindow,
  /** The pixel of a {@link PortalKind.PickColor} the user picked. */
  PickColor,
  /** What the user lets a {@link PortalKind.Agent} reach. */
  Agent,
  /** The user asked to change what a {@link CapturingKind.Agent} reaches. */
  Change,
  /** The user dismissed or denied the dialog. */
  Canceled,
  /** The shell has no dialog for this kind. */
  Refused,
}

export const PortalAnswer = {
  Access: () => ({ kind: PortalAnswerKind.Access as const }),
  /**
   * Windows must be ones the request offered, and at least one. `remember`
   * lets the agent in without asking next time, and takes the whole desk.
   */
  Agent: (reach: AgentReach, remember = false) => ({
    kind: PortalAnswerKind.Agent as const,
    reach,
    remember,
  }),
  /** `choice` must be one of the request's `choices`. */
  AppChooser: (choice: string) => ({
    choice,
    kind: PortalAnswerKind.AppChooser as const,
  }),
  Canceled: () => ({ kind: PortalAnswerKind.Canceled as const }),
  /** Asks the user again what the agent session with this id reaches. */
  Change: () => ({ kind: PortalAnswerKind.Change as const }),
  Discard: () => ({ kind: PortalAnswerKind.Discard as const }),
  /** Not empty; the request's own name unless `editableName`. */
  DynamicLauncher: (name: string) => ({
    kind: PortalAnswerKind.DynamicLauncher as const,
    name,
  }),
  FileChooser: (chosen: FileChosen) => ({
    chosen,
    kind: PortalAnswerKind.FileChooser as const,
  }),
  GlobalShortcuts: (triggers: readonly ChosenTrigger[]) => ({
    kind: PortalAnswerKind.GlobalShortcuts as const,
    triggers,
  }),
  InputCapture: () => ({ kind: PortalAnswerKind.InputCapture as const }),
  Pause: () => ({ kind: PortalAnswerKind.Pause as const }),
  /** A pixel inside the request's frame. */
  PickColor: (at: { x: number; y: number }) => ({
    at,
    kind: PortalAnswerKind.PickColor as const,
  }),
  /** `printer` must be one of the request's `printers`. */
  Print: (printer: string, options: PrintOptions) => ({
    kind: PortalAnswerKind.Print as const,
    options,
    printer,
  }),
  Refused: () => ({ kind: PortalAnswerKind.Refused as const }),
  RemoteDesktop: (devices: Devices, clipboard: boolean) => ({
    clipboard,
    devices,
    kind: PortalAnswerKind.RemoteDesktop as const,
  }),
  Resume: () => ({ kind: PortalAnswerKind.Resume as const }),
  /** An absolute `path`; `options` within the request's `pdf`. */
  SaveToPdf: (path: string, options: PrintOptions) => ({
    kind: PortalAnswerKind.SaveToPdf as const,
    options,
    path,
  }),
  ScreenCast: (sources: readonly CastSource[]) => ({
    kind: PortalAnswerKind.ScreenCast as const,
    sources,
  }),
  /**
   * A non-empty area inside the request's frame. `copy` also puts it on the
   * clipboard; the shell's own screenshot is then not saved.
   */
  Screenshot: (area: ShotRect, copy: boolean) => ({
    area,
    copy,
    kind: PortalAnswerKind.Screenshot as const,
  }),
  /**
   * A browser window, by its `DomicileBrowserWindow` id; `copy` as above.
   * Nothing the shell draws over the window is in the shot.
   */
  ScreenshotBrowserWindow: (
    id: string,
    copy: boolean,
    area?: ShotRect | undefined,
  ) => ({
    area,
    copy,
    id,
    kind: PortalAnswerKind.ScreenshotBrowserWindow as const,
  }),
  /**
   * One of the request's windows, by {@link ShotWindow.id}; `copy` as above.
   * `area` is part of it, in pixels of its frame as `System.previewWindow`
   * draws it; all of it when unset.
   */
  ScreenshotWindow: (
    id: string,
    copy: boolean,
    area?: ShotRect | undefined,
  ) => ({
    area,
    copy,
    id,
    kind: PortalAnswerKind.ScreenshotWindow as const,
  }),
  Stop: () => ({ kind: PortalAnswerKind.Stop as const }),
};

export type PortalAnswer = ReturnType<
  (typeof PortalAnswer)[keyof typeof PortalAnswer]
>;

export enum CapturingKind {
  /** An application controls input, and the clipboard when `clipboard` is set. */
  RemoteDesktop,
  /** An application takes the user's input once it crosses a screen edge. */
  InputCapture,
  /** An application records windows, monitors or a region. */
  ScreenCast,
  /**
   * The shell's own screen recording, which `System.screenRecord` started.
   * Paused, resumed and discarded as well as stopped.
   */
  Recording,
  /** An agent the user let see and use the desk. */
  Agent,
  /** A kind this SDK cannot parse. It can still be stopped. */
  Unknown,
}

/** What every capturing session carries. */
export type CapturingBase = {
  /** The id {@link stopCapturing} takes. */
  id: number;
  /** The application's desktop file id. Empty when unknown. */
  appId: string;
};

export const Capturing = {
  Agent: (base: CapturingBase, body: AgentSessionBody) => ({
    ...base,
    ...body,
    kind: CapturingKind.Agent as const,
  }),
  InputCapture: (base: CapturingBase, body: InputCaptureBody) => ({
    ...base,
    ...body,
    kind: CapturingKind.InputCapture as const,
  }),
  Recording: (base: CapturingBase, body: RecordingBody) => ({
    ...base,
    ...body,
    kind: CapturingKind.Recording as const,
  }),
  RemoteDesktop: (base: CapturingBase, body: RemoteDesktopBody) => ({
    ...base,
    ...body,
    kind: CapturingKind.RemoteDesktop as const,
  }),
  ScreenCast: (
    base: CapturingBase,
    body: { sources: readonly Captured[] },
  ) => ({
    ...base,
    ...body,
    kind: CapturingKind.ScreenCast as const,
  }),
  Unknown: (base: CapturingBase, wireKind: string) => ({
    ...base,
    kind: CapturingKind.Unknown as const,
    wireKind,
  }),
};

export type Capturing = ReturnType<(typeof Capturing)[keyof typeof Capturing]>;

/** Element Capture's `RestrictionTarget`, which TypeScript's DOM lacks. */
type RestrictionTargets = {
  fromElement: (element: Element) => Promise<unknown>;
};

/**
 * Leave `element` out of every capture of the desk: screen recordings, screen
 * casts and screenshots. It still shows on screen. For the shell's page only;
 * see `docs/PORTALS.md#screen-recording`.
 *
 * The element must be a stacking context and its own group, such as with
 * `isolation: isolate`, or Element Capture ignores it. `targets` is
 * `RestrictionTarget`, absent in an engine without Element Capture, where this
 * does nothing.
 */
export const hideFromCaptures = async (
  element: Element,
  targets: RestrictionTargets | undefined = (
    globalThis as { RestrictionTarget?: RestrictionTargets }
  ).RestrictionTarget,
): Promise<void> => {
  await targets?.fromElement(element);
};
