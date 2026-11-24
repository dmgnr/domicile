import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import { desktop } from "@domicile-desktop/sdk/desktop/desktop";
import type { PortalsHost } from "@domicile-desktop/sdk/desktop/portals";
import type {
  DomicileBrowserWindow,
  DomicileHost,
} from "@domicile-desktop/sdk/domicile-host";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import type { FakeDesktop } from "@domicile-desktop/system-apps/fake-desktop";
import { fakeDesktop } from "@domicile-desktop/system-apps/fake-desktop";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DialogDesktop, PortalDialogsDesktop } from "./PortalDialogs";
import { PortalDialogs } from "./PortalDialogs";
import { ShownWindow } from "./shown-windows";

/** `fake` with captures that never draw, for dialogs that preview nothing. */
const dialogDesktop = (fake: FakeDesktop): DialogDesktop => ({
  ...fake,
  capture: {
    preview: () =>
      new Promise(() => {
        /* never drawn */
      }),
  },
});

/**
 * A desktop that pushes `items` and `capturing` once, with
 * `browserWindows` open. Answers go to the console; nothing goes away,
 * since no compositor takes it away.
 */
const pushing = (
  items: readonly object[],
  capturing: readonly object[] = [],
  browserWindows: readonly DomicileBrowserWindow[] | null = null,
): Domicile => {
  const fake = new FakeDomicileHost();
  const data = JSON.stringify({ capturing, items, type: "portal_requests" });
  const host: PortalsHost &
    Pick<DomicileHost, "grabShortcut" | "ungrabShortcut"> = {
    addEventListener: (type, listener) => {
      fake.host.addEventListener(type, listener);
      // The engine replays the requests to a late listener.
      if (type === "portalrequests") {
        queueMicrotask(() => {
          fake.dispatch("portalrequests", { data });
        });
      }
    },
    answerPortalRequest: (id, answer) => {
      // biome-ignore lint/suspicious/noConsole: the story shows its answers in the console
      console.info("answered", id, answer);
    },
    grabShortcut: () => undefined,
    removeEventListener: (type, listener) => {
      fake.host.removeEventListener(type, listener);
    },
    ungrabShortcut: () => undefined,
  };
  return desktop({
    ...fake.host,
    ...host,
    browserWindows,
    callSystem: () => undefined,
  });
};

/** `domicile` reading its files and drawing its previews through `dialogs`. */
const reading = (
  domicile: Domicile,
  dialogs: () => DialogDesktop,
): PortalDialogsDesktop => ({
  ...domicile,
  ...dialogs(),
});

const access = {
  app_id: "org.example.Camera",
  body: {
    body: "It can see you until it closes.",
    destructive: false,
    subtitle: "Camera wants to use your webcam",
    title: "Allow the camera?",
  },
  id: 1,
  kind: "access",
};

const appChooser = {
  app_id: "org.example.Mail",
  body: {
    choices: ["org.gnome.Evince", "firefox", "org.example.Unknown"],
    content_type: "application/pdf",
    filename: "invoice.pdf",
  },
  id: 2,
  kind: "app_chooser",
};

const account = {
  app_id: "org.example.Mail",
  body: {
    name: "Ada Lovelace",
    reason: "Mail signs your messages with your name.",
  },
  id: 8,
  kind: "account",
};

const wallpaper = {
  app_id: "org.example.Photos",
  body: { path: "/home/u/Pictures/dusk.png", set_on: "both" },
  id: 3,
  kind: "wallpaper",
};

/** A small dusk gradient, standing in for a photograph. */
const DUSK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAAA3ElEQVR42mOQlCyQlc5Vks1WV8jUUUozUEkxVU+y0oy314l10Yv2MIjwNQ4LMg0JtwiMsfJPsPFNtffKcvTId3ErcXOu8HCs9bZv8rVpD7DqCbKYEGI6Ndx4VqTh/Bi9xXE6KxK01iarM9DU9E2pqgw0NX17hjIDTU3fnaXAQFPTD+TIMdDU9KP5Mgw0Nf1UoSQDTU0/XyLOQFPTL5eJMtDU9BsVQgw0Nf1utQADTU1/VMvHQFPTnzdwM9DU9NdNnAw0Nf1DCzsDTU3/2s7CQFPTf3UyMdDU9P89DACWx2/KpRK5igAAAABJRU5ErkJggg==";

/** A desktop holding the picture `wallpaper` names. */
const withPicture = () =>
  dialogDesktop(
    fakeDesktop({
      "/home/u/Pictures/dusk.png": Uint8Array.from(atob(DUSK_PNG), (c) =>
        c.charCodeAt(0),
      ),
    }),
  );

const launcher = {
  app_id: "org.example.Browser",
  body: {
    editable_name: true,
    // A blue square.
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiIGZpbGw9IiMyNTYzZWIiLz48L3N2Zz4=",
    launcher_type: "webapp",
    name: "Mail",
    target: "https://mail.example.com",
  },
  id: 8,
  kind: "dynamic_launcher",
};

const usb = {
  app_id: "org.example.Keys",
  body: {
    devices: [
      {
        id: "dev-1",
        product: "YubiKey 5",
        vendor: "Yubico.com",
        writable: true,
      },
      { id: "dev-2", writable: false },
    ],
  },
  id: 9,
  kind: "usb",
};

const officePrinter = {
  color_modes: ["color", "monochrome"],
  copies_max: 99,
  description: "Office laser",
  initial: {
    color_mode: "color",
    copies: 1,
    media: "iso_a4_210x297mm",
    orientation: "portrait",
    pages: [],
    sides: "one_sided",
  },
  media: [
    { label: "A4 (210 × 297 mm)", name: "iso_a4_210x297mm" },
    { label: "Letter (8.5 × 11 in)", name: "na_letter_8.5x11in" },
  ],
  name: "office",
  orientations: ["portrait", "landscape"],
  page_ranges: true,
  qualities: ["draft", "normal", "high"],
  sides: ["one_sided", "two_sided_long_edge", "two_sided_short_edge"],
};

const pdfPrinter = {
  color_modes: [],
  copies_max: 1,
  description: "Save to PDF",
  initial: {
    copies: 1,
    media: "na_letter_8.5x11in",
    orientation: "portrait",
    pages: [],
  },
  media: [
    { label: "Letter (8.5 × 11 in)", name: "na_letter_8.5x11in" },
    { label: "A4 (210 × 297 mm)", name: "iso_a4_210x297mm" },
  ],
  name: "pdf",
  orientations: ["portrait", "landscape"],
  page_ranges: true,
  qualities: [],
  sides: [],
};

const print = (printers: readonly object[]) => ({
  app_id: "org.example.Editor",
  body: {
    home: "/home/u",
    pdf: pdfPrinter,
    printer: "office",
    printers,
    title: "Quarterly report",
  },
  id: 9,
  kind: "print",
});

const entry = (name: string): string =>
  `[Desktop Entry]\nType=Application\nName=${name}\nExec=true\n`;

/** Two installed applications; the browser is the default for PDFs. */
const installed = () =>
  dialogDesktop(
    fakeDesktop(
      {
        "/config/mimeapps.list":
          "[Default Applications]\napplication/pdf=firefox.desktop\n",
        "/share/applications/firefox.desktop": entry("Firefox"),
        "/share/applications/org.gnome.Evince.desktop":
          entry("Document Viewer"),
      },
      () => ({
        code: 0,
        stderr: "",
        stdout: "XDG_CONFIG_HOME=/config\0XDG_DATA_DIRS=/share\0",
      }),
    ),
  );

const fileChooser = {
  app_id: "org.example.Editor",
  body: {
    choices: [
      {
        id: "encoding",
        initial: "utf8",
        label: "Encoding",
        options: [
          { id: "utf8", label: "UTF-8" },
          { id: "latin1", label: "Latin-1" },
        ],
      },
      { id: "readonly", initial: "false", label: "Read only", options: [] },
    ],
    directory: false,
    files: [],
    filters: [
      { extensions: ["txt", "md"], name: "Text" },
      { extensions: [], name: "All files" },
    ],
    home: "/home/me",
    mode: "open",
    multiple: true,
    title: "Open Notes",
  },
  id: 3,
  kind: "file_chooser",
};

/** A small home for the file chooser to list. */
const home = () =>
  dialogDesktop(
    fakeDesktop({
      "/home/me/Documents/letter.txt": "",
      "/home/me/Documents/report.pdf": "",
      "/home/me/notes.txt": "",
      "/home/me/Pictures/cat.png": "",
      "/home/me/todo.md": "",
    }),
  );

const remoteDesktop = {
  app_id: "org.example.Remote",
  body: {
    clipboard: true,
    devices: { keyboard: true, pointer: true, touchscreen: false },
  },
  id: 4,
  kind: "remote_desktop",
};

const inputCapture = {
  app_id: "org.example.Barrier",
  body: { devices: { keyboard: true, pointer: true, touchscreen: false } },
  id: 5,
  kind: "input_capture",
};

const globalShortcuts = {
  app_id: "org.example.Chat",
  body: {
    shortcuts: [
      { description: "Push to talk", id: "talk", trigger: "CTRL+ALT+t" },
      { description: "Mute", id: "mute", trigger: "Meta+Return" },
      { description: "Deafen", id: "deafen" },
    ],
    taken: [{ app_id: "org.example.Recorder", chord: "Ctrl+Alt+t" }],
  },
  id: 8,
  kind: "global_shortcuts",
};

const screenCast = {
  app_id: "us.zoom.Zoom",
  body: {
    browser_windows: false,
    multiple: false,
    region: true,
    sources: [
      { app_id: "firefox", id: "app-3", title: "Notes", type: "window" },
      {
        app_id: "org.gnome.Evince",
        id: "app-4",
        title: "report.pdf",
        type: "window",
      },
      { app_id: "", id: "app-5", title: "", type: "window" },
      {
        description: "Dell Inc. DELL U3219Q",
        name: "drm-1",
        size: [1920, 1080],
        type: "monitor",
      },
      { description: "", name: "drm-2", size: [1280, 800], type: "monitor" },
    ],
  },
  id: 2,
  kind: "screen_cast",
};

/** A drawn desk of two monitors, 1600x500, standing in for a captured one. */
const deskFrame = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="500">
    <rect width="1000" height="500" fill="#2b6cb0"/>
    <rect x="1000" width="600" height="500" fill="#9f7aea"/>
    <rect x="80" y="60" width="520" height="340" fill="#f7fafc"/>
    <rect x="1080" y="120" width="420" height="260" fill="#1a202c"/>
    <circle cx="800" cy="380" r="60" fill="#f6ad55"/>
  </svg>`,
)}`;

const frozenDesk = {
  desk: { position: [0, 0], size: [1600, 500] },
  frame: deskFrame,
  height: 500,
  monitors: [
    {
      area: { height: 500, width: 1000, x: 0, y: 0 },
      description: "Dell Inc. DELL U3219Q",
      name: "DP-1",
    },
    {
      area: { height: 500, width: 600, x: 1000, y: 0 },
      description: "",
      name: "HDMI-A-1",
    },
  ],
  width: 1600,
  windows: [
    { app_id: "org.gnome.TextEditor", id: "app-1", title: "Notes" },
    { app_id: "kitty", id: "app-2", title: "~/src" },
  ],
};

const screenshot = {
  app_id: "org.example.Shooter",
  body: frozenDesk,
  id: 9,
  kind: "screenshot",
};

/** A screen cast picker over `frozenDesk`, browser windows offered. */
const screenCastOnDesk = {
  app_id: "com.google.Meet",
  body: {
    browser_windows: true,
    desk: frozenDesk,
    multiple: false,
    region: true,
    sources: [
      {
        app_id: "org.gnome.TextEditor",
        id: "app-1",
        title: "Notes",
        type: "window",
      },
      { app_id: "kitty", id: "app-2", title: "~/src", type: "window" },
      {
        description: "Dell Inc. DELL U3219Q",
        name: "DP-1",
        size: [1000, 500],
        type: "monitor",
      },
      { description: "", name: "HDMI-A-1", size: [600, 500], type: "monitor" },
    ],
  },
  id: 11,
  kind: "screen_cast",
};

/** A browser window the engine lists, by `id` and `title`. */
const browserWindow = (id: string, title: string): DomicileBrowserWindow => ({
  appId: "",
  height: 0,
  id,
  isApp: false,
  isCaptured: false,
  isHidden: false,
  isPrivate: false,
  menu: null,
  menuBarAutoHide: false,
  menuBarVisible: true,
  messageBox: null,
  parent: null,
  partition: "",
  popupMenu: null,
  popupWindow: null,
  profile: "default",
  title,
  toplevelId: null,
  url: "https://example.com",
  wantsFullscreen: false,
  wantsMaximized: false,
  wantsMinimized: false,
  width: 0,
  x: 0,
  y: 0,
});

const pickColor = {
  app_id: "org.example.Paint",
  body: frozenDesk,
  id: 10,
  kind: "pick_color",
};

const meta = {
  args: {
    domicile: pushing([access]),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
  argTypes: {
    domicile: {
      control: false,
      table: { category: "Behavior" },
    },
    screen: {
      control: "text",
      table: { category: "Appearance" },
    },
    screenOf: {
      control: false,
      table: { category: "Appearance" },
    },
    shellChords: {
      control: "object",
      table: { category: "Behavior" },
    },
    shownWindows: {
      control: false,
      table: { category: "Behavior" },
    },
  },
  component: PortalDialogs,
  parameters: {
    docs: {
      description: {
        component:
          "Draws the dialogs applications ask for through xdg-desktop-portal and answers them.",
      },
    },
  },
  tags: ["autodocs"],
  title: "Overlays/PortalDialogs",
} satisfies Meta<typeof PortalDialogs>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Access: Story = {
  args: {
    domicile: pushing([access]),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

export const AppChooser: Story = {
  args: {
    domicile: reading(pushing([appChooser]), installed),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

export const FileChooser: Story = {
  args: {
    domicile: reading(pushing([fileChooser]), home),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

/**
 * A source picker for an application that may record one window or screen,
 * or draw a region.
 */
export const ScreenCast: Story = {
  args: {
    domicile: reading(pushing([screenCast]), installed),
    screen: undefined,
    screenOf: undefined,
  },
};

/**
 * The source picker previewing each source on the desk: the text editor
 * and one browser window are on screen; the terminal and the other
 * browser window are hidden, so they show their icons.
 */
export const ScreenCastPreviews: Story = {
  args: {
    domicile: reading(
      pushing(
        [screenCastOnDesk],
        [],
        [browserWindow("1", "Pull requests"), browserWindow("2", "Docs")],
      ),
      installed,
    ),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: () => [
      ShownWindow.App("app-1", { height: 360, width: 520, x: 80, y: 40 }),
      ShownWindow.Browser("1", { height: 260, width: 420, x: 1080, y: 120 }),
    ],
  },
};

export const RemoteDesktop: Story = {
  args: {
    domicile: pushing([remoteDesktop]),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

export const InputCapture: Story = {
  args: {
    domicile: pushing([inputCapture]),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

export const Account: Story = {
  args: {
    domicile: pushing([account]),
    screen: undefined,
    screenOf: undefined,
  },
};

export const DynamicLauncher: Story = {
  args: {
    domicile: pushing([launcher]),
    screen: undefined,
    screenOf: undefined,
  },
};

export const Usb: Story = {
  args: {
    domicile: pushing([usb]),
    screen: undefined,
    screenOf: undefined,
  },
};

export const Print: Story = {
  args: {
    domicile: pushing([print([officePrinter])]),
    screen: undefined,
    screenOf: undefined,
  },
};

export const NoPrinters: Story = {
  args: {
    domicile: pushing([print([])]),
    screen: undefined,
    screenOf: undefined,
  },
};

export const Capturing: Story = {
  args: {
    domicile: pushing(
      [],
      [
        { ...remoteDesktop, id: 6 },
        { ...inputCapture, id: 7 },
        {
          app_id: "us.zoom.Zoom",
          body: {
            sources: [
              { id: "app-3", title: "Notes", type: "window" },
              { name: "drm-1", type: "monitor" },
            ],
          },
          id: 8,
          kind: "screen_cast",
        },
      ],
    ),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

/** The shell's own source picker, for a screen recording. */
export const RecordPicker: Story = {
  args: {
    domicile: reading(
      pushing([{ ...screenCast, app_id: "domicile:shell" }]),
      installed,
    ),
    screen: undefined,
    screenOf: undefined,
  },
};

/** The toolbar over the shell's own screen recording, a minute in. */
export const Recording: Story = {
  args: {
    domicile: pushing(
      [],
      [
        {
          app_id: "domicile:shell",
          body: {
            file: "/home/me/Videos/Screen recordings/a.webm",
            recorded_ms: 0,
            running_since_ms: Date.now() - 61_000,
            sources: [
              { description: "Dell U3219Q", name: "drm-1", type: "monitor" },
            ],
          },
          id: 9,
          kind: "recording",
        },
      ],
    ),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

/** A paused recording's toolbar. */
export const RecordingPaused: Story = {
  args: {
    domicile: pushing(
      [],
      [
        {
          app_id: "domicile:shell",
          body: {
            file: "/home/me/Videos/Screen recordings/a.webm",
            recorded_ms: 754_000,
            sources: [
              { description: "Dell U3219Q", name: "drm-1", type: "monitor" },
            ],
          },
          id: 9,
          kind: "recording",
        },
      ],
    ),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};

export const GlobalShortcuts: Story = {
  args: {
    domicile: pushing([globalShortcuts]),
    screen: undefined,
    screenOf: undefined,
    shellChords: ["Meta+Return"],
    shownWindows: undefined,
  },
};

export const Wallpaper: Story = {
  args: {
    domicile: reading(pushing([wallpaper]), withPicture),
    screen: undefined,
    screenOf: undefined,
  },
};

export const Screenshot: Story = {
  args: {
    domicile: pushing([screenshot]),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    // The text editor on screen; the terminal is a hidden tab.
    shownWindows: () => [
      ShownWindow.App("app-1", { height: 360, width: 520, x: 80, y: 40 }),
    ],
  },
};

export const PickColor: Story = {
  args: {
    domicile: pushing([pickColor]),
    screen: undefined,
    screenOf: undefined,
    shellChords: undefined,
    shownWindows: undefined,
  },
};
