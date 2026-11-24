import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import type { CastBackend, CastTarget } from "@domicile-desktop/sdk/cast";
import { CastMode, casting } from "@domicile-desktop/sdk/cast";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { SHELL_APP_ID } from "@domicile-desktop/sdk/portal";
import type { PreviewedWindow } from "@domicile-desktop/sdk/previewed-window";
import type {
  Listened,
  SystemError,
  VirtualMonitor,
  Watch,
} from "@domicile-desktop/sdk/system";
import { SystemErrorKind } from "@domicile-desktop/sdk/system";
import type {
  FakeDesktop,
  Node,
} from "@domicile-desktop/system-apps/fake-desktop";
import { fakeDesktop } from "@domicile-desktop/system-apps/fake-desktop";
import { loadEmittedStylesheet } from "@domicile-desktop/test-support/emitted-stylesheet";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { token } from "../../styled-system/tokens";
import { Button } from "../Button/Button";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { DisplayProvider } from "../Screen/DisplayProvider";
import type { DisplaySource } from "../Screen/display-source";
import type { DialogDesktop, PortalDialogsDesktop } from "./PortalDialogs";
import { PortalDialogs } from "./PortalDialogs";
import { ShownWindow } from "./shown-windows";

const directoryWatches: Promise<Result<"stopped", SystemError>>[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(directoryWatches.splice(0));
});

/** `fake` with captures that never draw, for dialogs that preview nothing. */
const dialogDesktop = (fake: FakeDesktop): DialogDesktop => ({
  ...fake,
  capture: {
    preview: () =>
      new Promise(() => {
        /* never drawn */
      }),
  },
  files: { ...fake.files, watch: directoryWatch },
});

/**
 * A desktop that pushes `portal_requests` lines and records answers. Its
 * calls go to the `fakeDesktop` each test passes to `with`.
 */
class FakeHost {
  readonly fake = new FakeDomicileHost();
  readonly domicile = this.fake.domicile;

  /** The desktop, its files and previews from `dialogs`. */
  with(dialogs: () => DialogDesktop): PortalDialogsDesktop {
    return { ...this.domicile, ...dialogs() };
  }

  get answers(): [id: unknown, answer: unknown][] {
    return this.fake.calls
      .filter(([name]) => name === "answerPortalRequest")
      .map(([, id, answer]) => [id, JSON.parse(String(answer))]);
  }

  push(
    items: readonly object[],
    capturing?: readonly object[],
    shortcuts?: readonly object[],
  ): void {
    const data = JSON.stringify({
      capturing,
      items,
      shortcuts,
      type: "portal_requests",
    });
    act(() => {
      this.fake.dispatch("portalrequests", { data });
    });
  }
}

const access = (id: number, body: object = {}) => ({
  app_id: "org.example.App",
  body: {
    body: "It will see you.",
    destructive: false,
    subtitle: "Example wants the camera",
    title: "Use the camera?",
    ...body,
  },
  id,
  kind: "access",
});

/** An application's desktop entry. */
const entry = (name: string, icon: string): string =>
  `[Desktop Entry]\nType=Application\nName=${name}\nExec=${icon}\nIcon=${icon}\n`;

/**
 * A desktop with a document viewer and a browser installed, the browser the
 * default for PDFs, and `tree` besides.
 */
const desktop =
  (tree: Readonly<Record<string, Node>> = {}) =>
  () =>
    dialogDesktop(
      fakeDesktop(
        {
          "/config/mimeapps.list":
            "[Default Applications]\napplication/pdf=firefox.desktop\n",
          "/share/applications/firefox.desktop": entry("Firefox", "firefox"),
          "/share/applications/org.gnome.Evince.desktop": entry(
            "Document Viewer",
            "evince",
          ),
          "/share/icons/hicolor/48x48/apps/firefox.svg": "<svg/>",
          ...tree,
        },
        () => ({
          code: 0,
          stderr: "",
          stdout:
            "XDG_CONFIG_HOME=/config\0XDG_DATA_HOME=/data\0XDG_DATA_DIRS=/share\0",
        }),
      ),
    );

/**
 * A desktop that previews window `app-3` and browser window `2`, each as a
 * `data:` URL naming it, and no other window.
 */
const previewing = () => () => ({
  ...desktop()(),
  capture: {
    preview: (window: PreviewedWindow): Promise<Result<string, SystemError>> =>
      Promise.resolve(
        window.id === "app-3" || window.id === "2"
          ? Ok(`data:image/png;base64,${window.id}`)
          : Err({ kind: SystemErrorKind.NotFound, message: window.id }),
      ),
  },
});

const chooser = (id: number, body: object = {}) => ({
  app_id: "org.example.App",
  body: {
    choices: ["org.gnome.Evince", "firefox"],
    content_type: "application/pdf",
    filename: "report.pdf",
    ...body,
  },
  id,
  kind: "app_chooser",
});

/** A desktop with a small home for the file chooser to list. */
const home = () =>
  desktop({
    "/home/me/Documents/report.pdf": "",
    "/home/me/notes.txt": "",
    "/home/me/photo.png": "",
  });

const fileChooser = (id: number, body: object = {}) => ({
  app_id: "org.example.Editor",
  body: {
    choices: [],
    directory: false,
    files: [],
    filters: [],
    home: "/home/me",
    mode: "open",
    multiple: false,
    title: "Open Notes",
    ...body,
  },
  id,
  kind: "file_chooser",
});

/** Lets the picker's listings resolve. */
const listed = () => act(() => Promise.resolve());

/** Lets the applications' desktop entries be read. */
const named = () =>
  act(
    () =>
      new Promise((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

const remoteDesktop = (id: number, clipboard: boolean) => ({
  app_id: "org.example.Remote",
  body: {
    clipboard,
    devices: { keyboard: true, pointer: true, touchscreen: false },
  },
  id,
  kind: "remote_desktop",
});

const inputCapture = (id: number) => ({
  app_id: "org.example.Barrier",
  body: { devices: { keyboard: true, pointer: true, touchscreen: false } },
  id,
  kind: "input_capture",
});

const account = (
  id: number,
  body: object = { name: "Ada Lovelace", reason: "To sign you in" },
) => ({
  app_id: "org.example.Mail",
  body,
  id,
  kind: "account",
});

const shortcuts = (id: number) => ({
  app_id: "org.example.App",
  body: {
    shortcuts: [
      { description: "Push to talk", id: "talk", trigger: "CTRL+ALT+t" },
      { description: "Mute", id: "mute" },
      { description: "Deafen", id: "deafen", trigger: "Alt+Meta+d" },
    ],
    taken: [{ app_id: "org.example.Other", chord: "Ctrl+Alt+t" }],
  },
  id,
  kind: "global_shortcuts",
});

const wallpaper = (id: number) => ({
  app_id: "org.example.Photos",
  body: { path: "/home/u/sky.jpg", set_on: "both" },
  id,
  kind: "wallpaper",
});

/** A desktop holding the picture `wallpaper` names. */
const withPicture = desktop({ "/home/u/sky.jpg": "sky" });
const printer = (name: string, initial: object = {}) => ({
  color_modes: ["color", "monochrome"],
  copies_max: 9,
  description: `${name} printer`,
  initial: { copies: 1, media: "iso_a4_210x297mm", pages: [], ...initial },
  media: [
    { label: "A4 (210 × 297 mm)", name: "iso_a4_210x297mm" },
    { label: "Letter (8.5 × 11 in)", name: "na_letter_8.5x11in" },
  ],
  name,
  orientations: ["portrait", "landscape"],
  page_ranges: true,
  qualities: [],
  sides: ["one_sided", "two_sided_long_edge"],
});

const pdf = {
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

const print = (id: number, printers: readonly object[], start = "office") => ({
  app_id: "org.example.Editor",
  body: {
    accept_label: "Print it",
    home: "/home/me",
    pdf,
    printer: start,
    printers,
    title: "Report",
  },
  id,
  kind: "print",
});

const launcher = (id: number, body: object = {}) => ({
  app_id: "org.example.Browser",
  body: {
    editable_name: true,
    icon: "data:image/png;base64,iVBORw==",
    launcher_type: "webapp",
    name: "Mail",
    target: "https://mail.example.com",
    ...body,
  },
  id,
  kind: "dynamic_launcher",
});

const usb = (id: number) => ({
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
  id,
  kind: "usb",
});

const WINDOWS = [
  { app_id: "firefox", id: "app-3", title: "Notes", type: "window" },
  { app_id: "", id: "app-4", title: "", type: "window" },
];

const MONITORS = [
  {
    description: "Dell Inc. DELL U3219Q",
    name: "drm-1",
    size: [1920, 1080],
    type: "monitor",
  },
  { description: "", name: "drm-2", size: [1280, 800], type: "monitor" },
];

const screenCast = (
  multiple = false,
  sources: readonly object[] = WINDOWS,
  region = false,
  more: { browser_windows?: boolean; desk?: object } = {},
) => ({
  app_id: "us.zoom.Zoom",
  body: { browser_windows: false, multiple, region, sources, ...more },
  id: 5,
  kind: "screen_cast",
});

/**
 * A 300x100 frozen desk with two monitors and one window: the desktop from
 * (-10, 0) to (140, 50), at two frame pixels a CSS pixel.
 */
const frozen = (id: number, kind: "screenshot" | "pick_color") => ({
  app_id: "org.example.Shooter",
  body: {
    desk: { position: [-10, 0], size: [150, 50] },
    frame: "data:image/png;base64,AA==",
    height: 100,
    monitors: [
      {
        area: { height: 100, width: 200, x: 0, y: 0 },
        description: "BOE NE135A1M-NY1",
        name: "drm-2785430483108608",
      },
      {
        area: { height: 100, width: 100, x: 200, y: 0 },
        description: "",
        name: "HDMI-A-1",
      },
    ],
    width: 300,
    windows: [{ app_id: "kitty", id: "app-3", title: "~/src" }],
  },
  id,
  kind,
});

/**
 * An element of `tag` named by `attribute`, drawn at `box` in the page, as
 * an `<app>` or a `<webview>` is.
 */
const drawn = (
  tag: "app" | "webview",
  attribute: [string, string] | undefined,
  box: DOMRectInit,
): HTMLElement => {
  const element = document.createElement(tag);
  if (attribute !== undefined) {
    element.setAttribute(...attribute);
  }
  element.getBoundingClientRect = () => DOMRect.fromRect(box);
  document.body.append(element);
  return element;
};

/** Browser window `id`'s `<webview>`, showing a page whose icon is `favicon`. */
const iconed = (id: string, favicon: string): HTMLElement => {
  const element = drawn("webview", ["window", id], {
    height: 0,
    width: 0,
    x: 0,
    y: 0,
  });
  Object.defineProperty(element, "favicon", { value: favicon });
  return element;
};

/** Browser window `id`, titled `title`, as the engine lists it. */
const browserWindow = (id: string, title: string) => ({
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

/** Draws `element` 150x50 at (10, 20), as layout would. */
/** The radios in the group named `group`, which `names` name in order. */
const radiosNamed = (group: string, names: readonly string[]) => {
  const within_ = within(screen.getByRole("group", { name: group }));
  return {
    actual: within_.getAllByRole("radio"),
    expected: names.map((name) => within_.getByRole("radio", { name })),
  };
};

const drawnAtHalfSize = (element: HTMLElement): HTMLElement => {
  element.getBoundingClientRect = () =>
    DOMRect.fromRect({ height: 50, width: 150, x: 10, y: 20 });
  return element;
};

/** Drags from `from` to `to` over the whole page, selecting on screen. */
const dragOnScreen = (
  from: readonly [number, number],
  to: readonly [number, number],
): void => {
  const page = screen.getByRole("application", {
    name: "Drag to select an area",
  });
  fireEvent.pointerDown(page, { clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(page, { clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(page, { clientX: to[0], clientY: to[1] });
};

/**
 * A browser window's `<webview>`, focused as when its page has the keyboard.
 * Keys sent to a focused page never reach the document.
 */
/** Ends `element`'s transition of `propertyName`. */
const transitionEnd = (element: Element, propertyName: string): void => {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  fireEvent(element, event);
};

const focusedPage = (): HTMLElement => {
  const page = document.createElement("webview");
  page.tabIndex = -1;
  document.body.append(page);
  page.focus();
  return page;
};

/** The selected area's handle at `corner`, which has no role to find it by. */
const cornerOf = (corner: string): HTMLElement => {
  const handle = document.querySelector<HTMLElement>(
    `[data-corner='${corner}']`,
  );
  if (handle === null) {
    throw new Error(`no ${corner} corner`);
  } else {
    return handle;
  }
};

/** Loads `preview` as a 200x100 frame, as the browser would decode it. */
const loaded200x100 = (preview: HTMLElement): void => {
  Object.defineProperty(preview, "naturalWidth", { value: 200 });
  Object.defineProperty(preview, "naturalHeight", { value: 100 });
  fireEvent.load(preview);
};

describe("PortalDialogs", () => {
  describe("rendering", () => {
    it("draws nothing while no application asks", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([]);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("asks an access question naming the application", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);

      expect(screen.getByRole("dialog")).toHaveTextContent("Use the camera?");
      expect(screen.getByText("App asks")).toBeInTheDocument();
      expect(screen.getByText("It will see you.")).toBeInTheDocument();
      // The subtitle mostly restates the title; it shows only without a body.
      expect(
        screen.queryByText("Example wants the camera"),
      ).not.toBeInTheDocument();
    });

    it("explains with the subtitle when there is no body", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1, { body: "" })]);

      expect(screen.getByText("Example wants the camera")).toBeInTheDocument();
    });

    it("draws the yes in the accent", () => {
      const accent = render(<Button variant="accent">Allow</Button>);
      const accented = within(accent.container).getByRole("button").className;
      accent.unmount();
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);

      expect(screen.getByRole("button", { name: "Allow" }).className).toBe(
        accented,
      );
    });

    it("uses the labels the application offers", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1, { deny_label: "Never", grant_label: "Sure" })]);

      expect(screen.getByRole("button", { name: "Sure" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Never" })).toBeInTheDocument();
    });

    it("marks a destructive question's yes as dangerous", () => {
      const danger = render(<Button variant="danger">Shut down</Button>);
      const dangerous = within(danger.container).getByRole("button").className;
      danger.unmount();
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1, { destructive: true, grant_label: "Shut down" })]);

      expect(screen.getByRole("button", { name: "Shut down" }).className).toBe(
        dangerous,
      );
    });

    it("asks the shell's own question without naming an asker", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([{ ...access(1), app_id: SHELL_APP_ID }]);

      expect(screen.queryByText(/asks$/)).not.toBeInTheDocument();
    });

    it("asks to share the user's name and picture, naming the application and its reason", async () => {
      const host = new FakeHost();
      render(
        <PortalDialogs
          domicile={host.with(desktop({ "/home/ada/me.png": "png" }))}
        />,
      );
      host.push([
        account(1, {
          image: "/home/ada/me.png",
          name: "Ada Lovelace",
          reason: "To sign you in",
        }),
      ]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Share your name and picture?",
      );
      expect(screen.getByText("Mail asks")).toBeInTheDocument();
      expect(screen.getByText("To sign you in")).toBeInTheDocument();
      expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
      expect(
        (await screen.findByRole("img", { name: "Ada Lovelace" })).getAttribute(
          "src",
        ),
      ).toStartWith("blob:");
    });

    it("asks to share the user's name without a reason or picture", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([account(1, { name: "Ada Lovelace" })]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Share your name and picture?",
      );
      expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("names an application it cannot identify", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([{ ...access(1), app_id: "" }]);

      expect(screen.getByText("An application asks")).toBeInTheDocument();
    });

    it("names the application by its desktop entry", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([{ ...access(1), app_id: "firefox" }]);

      expect(await screen.findByText("Firefox asks")).toBeInTheDocument();
    });

    it("puts the dialog over the screen it is given", () => {
      const host = new FakeHost();
      render(
        <DisplayProvider source={TWO_SCREENS}>
          <PortalDialogs domicile={host.domicile} screen="right" />
        </DisplayProvider>,
      );
      host.push([access(1)]);

      expect(screen.getByRole("dialog").parentElement?.style.left).toBe(
        "1920px",
      );
    });

    it("offers each choice by name and icon, the default picked", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);

      expect(
        screen.getByRole("dialog", {
          name: "Choose an app to open report.pdf",
        }),
      ).toHaveTextContent("App asks");
      const firefox = await screen.findByRole("option", { name: "Firefox" });
      expect(firefox).toHaveAttribute("aria-selected", "true");
      expect(
        screen.getByRole("option", { name: "Document Viewer" }),
      ).toHaveAttribute("aria-selected", "false");
      expect(firefox.querySelector("img")?.getAttribute("src")).toStartWith(
        "data:image/svg+xml",
      );
    });

    it("picks the last choice over the default", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1, { last_choice: "org.gnome.Evince" })]);

      expect(
        await screen.findByRole("option", { name: "Document Viewer" }),
      ).toHaveAttribute("aria-selected", "true");
    });

    it("names a choice with no desktop entry by its id, and a URI", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([
        chooser(1, {
          choices: ["org.example.Gone"],
          content_type: undefined,
          filename: undefined,
          uri: "https://example.com/",
        }),
      ]);

      const dialog = await screen.findByRole("dialog", { name: "Open Gone?" });
      expect(dialog).toHaveTextContent("Opens this link in Gone.");
      expect(dialog).toHaveTextContent("https://example.com/");
    });

    it("shows the one application's icon by its name", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1, { choices: ["firefox"] })]);

      const dialog = await screen.findByRole("dialog", {
        name: "Open Firefox?",
      });
      expect(dialog.querySelector("img")?.getAttribute("src")).toStartWith(
        "data:image/svg+xml",
      );
    });

    it("shows choices the application adds while it is up", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1, { choices: ["org.gnome.Evince"] })]);
      await screen.findByRole("dialog", { name: "Open Document Viewer?" });
      host.push([chooser(1)]);

      expect(
        await screen.findByRole("option", { name: "Firefox" }),
      ).toBeInTheDocument();
    });

    it("reviews each shortcut an application asks for", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([shortcuts(5)]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "App wants shortcuts that work in any window",
      );
      expect(screen.getByRole("textbox", { name: "Push to talk" })).toHaveValue(
        "CTRL+ALT+t",
      );
      expect(screen.getByRole("textbox", { name: "Mute" })).toHaveValue("");
    });

    it("flags a chord the shell or another application holds", () => {
      const host = new FakeHost();
      render(
        <PortalDialogs domicile={host.domicile} shellChords={["Meta+Alt+d"]} />,
      );
      host.push([shortcuts(5)]);

      expect(screen.getByText("Other uses this chord")).toBeInTheDocument();
      expect(
        screen.getByText("The desktop uses this chord"),
      ).toBeInTheDocument();
    });

    it("will not bind a trigger that is not a chord", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([shortcuts(5)]);
      await userEvent.type(
        screen.getByRole("textbox", { name: "Mute" }),
        "Hyper+m",
      );

      expect(screen.getByRole("button", { name: "Bind" })).toBeDisabled();
    });

    it("previews a wallpaper, naming the application and where it goes", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(withPicture)} />);
      host.push([wallpaper(1)]);
      await act(() => Promise.resolve());

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Photos wants to change the wallpaper",
      );
      expect(screen.getByText("Desktop and lock screen")).toBeInTheDocument();
      expect(
        screen
          .getByRole("img", { name: "The new wallpaper" })
          .getAttribute("src"),
      ).toStartWith("blob:");
    });

    it("shows a launcher's icon, name and address", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([launcher(1)]);
      await named();

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Browser wants to add an app",
      );
      expect(screen.getByLabelText("Name")).toHaveValue("Mail");
      expect(screen.getByText("https://mail.example.com")).toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "App icon" }).getAttribute("src"),
      ).toBe("data:image/png;base64,iVBORw==");
    });

    it("keeps a launcher's name when it may not be changed", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([launcher(1, { editable_name: false })]);
      await named();

      expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
    });

    it("lists the USB devices an application asks for", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([usb(1)]);
      await named();

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Keys wants to use USB devices",
      );
      expect(screen.getByText("Yubico.com YubiKey 5")).toBeInTheDocument();
      expect(screen.getByText("Unknown device")).toBeInTheDocument();
      expect(screen.getByText("Read and write")).toBeInTheDocument();
      expect(screen.getByText("Read only")).toBeInTheDocument();
    });

    it("stacks a screenshot over the dialog before it, to shoot that dialog", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);
      await named();
      host.push([chooser(1), frozen(2, "screenshot")]);
      await named();

      expect(
        screen
          .getAllByRole("dialog", { hidden: true })
          .map((dialog) => dialog.textContent),
      ).toEqual([
        expect.stringContaining("report.pdf"),
        expect.stringContaining("Take a screenshot"),
      ]);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(host.answers).toEqual([
        [
          2,
          {
            area: { height: 100, width: 300, x: 0, y: 0 },
            copy: false,
            kind: "screenshot",
          },
        ],
      ]);
      host.push([chooser(1)]);
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toHaveTextContent("report.pdf");
      });
    });

    it.each([
      ["color pick", frozen(2, "pick_color")],
      ["screen cast", { ...screenCast(), id: 2 }],
    ])("stacks a %s over the dialog before it", async (_, capture) => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);
      await named();
      host.push([chooser(1), capture]);
      await named();

      expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
      expect(screen.getByRole("dialog")).not.toHaveTextContent("report.pdf");
    });

    it("holds a dialog asked for after a screenshot until it is answered", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot"), access(2)]);

      expect(
        screen.getAllByRole("dialog").map((dialog) => dialog.textContent),
      ).toEqual([expect.stringContaining("Take a screenshot")]);
    });

    it("goes away when the request does", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);
      host.push([]);

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("animates out as the request goes", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);
      host.push([]);

      expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute(
        "data-closed",
      );
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { hidden: true }),
        ).not.toBeInTheDocument();
      });
    });

    it("holds the keyboard while one is up, and lets it go after", async () => {
      // The window that asked would otherwise be sent every key typed.
      const holds: string[] = [];
      const holdKeyboard = () => {
        holds.push("held");
        return () => {
          holds.push("released");
        };
      };
      const host = new FakeHost();
      render(
        <PortalDialogs domicile={host.domicile} holdKeyboard={holdKeyboard} />,
      );
      expect(holds).toEqual([]);

      host.push([access(1)]);
      await screen.findByRole("dialog");
      expect(holds).toEqual(["held"]);

      host.push([]);
      await waitFor(() => {
        expect(holds).toEqual(["held", "released"]);
      });
    });
  });

  describe("file chooser", () => {
    it("asks for files under the application's title, in its folder", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([
        fileChooser(1, {
          accept_label: "Attach",
          current_folder: "/home/me/Documents",
        }),
      ]);
      await listed();

      expect(
        screen.getByRole("dialog", { name: "Open Notes" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "report.pdf" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Attach" }),
      ).toBeInTheDocument();
    });

    it("gives the keyboard to the name when saving", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([fileChooser(1, { current_name: "notes.txt", mode: "save" })]);
      await listed();

      expect(screen.getByRole("combobox", { name: "Name" })).toHaveFocus();
    });

    it("answers with the file chosen, the filter and each choice", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([
        fileChooser(1, {
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
            {
              id: "readonly",
              initial: "false",
              label: "Read only",
              options: [],
            },
          ],
          current_filter: 1,
          filters: [
            { extensions: ["png"], name: "Images" },
            { extensions: ["txt"], name: "Text" },
          ],
        }),
      ]);
      await listed();
      await userEvent.click(
        screen.getByRole("combobox", { name: "Read only" }),
      );
      await userEvent.click(screen.getByRole("option", { name: "Yes" }));
      await userEvent.click(screen.getByRole("combobox", { name: "Encoding" }));
      await userEvent.click(screen.getByRole("option", { name: "Latin-1" }));
      await userEvent.dblClick(
        screen.getByRole("option", { name: "notes.txt" }),
      );

      expect(host.answers).toEqual([
        [
          1,
          {
            choices: { encoding: "latin1", readonly: "true" },
            current_filter: 1,
            kind: "file_chooser",
            paths: ["/home/me/notes.txt"],
          },
        ],
      ]);
    });

    it("opens several files", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([fileChooser(1, { multiple: true })]);
      await listed();

      expect(
        screen.getByRole("listbox", { name: "Contents of ~" }),
      ).toHaveAttribute("aria-multiselectable", "true");
    });

    it("chooses a folder", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([fileChooser(1, { directory: true })]);
      await listed();
      await userEvent.click(screen.getByRole("button", { name: "Choose" }));

      expect(host.answers).toEqual([
        [1, { choices: {}, kind: "file_chooser", paths: ["/home/me"] }],
      ]);
    });

    it("saves under the name suggested", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([fileChooser(1, { current_name: "draft.txt", mode: "save" })]);
      await listed();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [
          1,
          { choices: {}, kind: "file_chooser", paths: ["/home/me/draft.txt"] },
        ],
      ]);
    });

    it("saves several files into the folder chosen", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([
        fileChooser(1, { files: ["a.txt", "b.txt"], mode: "save_files" }),
      ]);
      await listed();

      expect(screen.getByText("Saves a.txt, b.txt")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(host.answers).toEqual([
        [1, { choices: {}, kind: "file_chooser", paths: ["/home/me"] }],
      ]);
    });

    it("cancels", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([fileChooser(1)]);
      await listed();
      await userEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Cancel",
        }),
      );

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });

    it("goes over the screen of the window that asked", async () => {
      const host = new FakeHost();
      render(
        <DisplayProvider source={TWO_SCREENS}>
          <PortalDialogs
            domicile={host.with(home())}
            screen="left"
            screenOf={(appId) => (appId === "app-3" ? "right" : undefined)}
          />
        </DisplayProvider>,
      );
      host.push([{ ...fileChooser(1), parent_app_id: "app-3" }]);
      await listed();

      expect(screen.getByRole("dialog").parentElement?.style.left).toBe(
        "1920px",
      );
    });
  });

  // Like every other portal dialog: over every window, which stack above
  // `z-index: auto`, and alone in the accessibility tree.
  describe("file pickers are modal", () => {
    loadEmittedStylesheet(
      document,
      new URL("../../styled-system/styles.css", import.meta.url),
    );

    /** The `z-index` of the box around the file picker. */
    const pickerDepth = () =>
      globalThis.getComputedStyle(
        screen.getByRole("dialog").parentElement as HTMLElement,
      ).zIndex;

    it("draws a file chooser over the windows, alone", async () => {
      const host = new FakeHost();
      render(
        <>
          <Button>Behind</Button>
          <PortalDialogs domicile={host.with(home())} />
        </>,
      );
      host.push([fileChooser(1)]);
      await listed();

      expect(pickerDepth()).toBe(token("zIndex.modal"));
      expect(screen.queryByRole("button", { name: "Behind" })).toBeNull();
    });

    it("draws a print's save picker over the windows, alone", async () => {
      const user = userEvent.setup();
      const host = new FakeHost();
      render(
        <>
          <Button>Behind</Button>
          <PortalDialogs domicile={host.with(home())} />
        </>,
      );
      host.push([print(1, [])]);
      await user.click(screen.getByRole("button", { name: "Save…" }));
      await listed();

      expect(pickerDepth()).toBe(token("zIndex.modal"));
      expect(screen.queryByRole("button", { name: "Behind" })).toBeNull();
    });
  });

  describe("answers", () => {
    it("allows", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Allow" }));

      expect(host.answers).toEqual([[1, { kind: "access" }]]);
    });

    it("denies", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Deny" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });

    it("starts on Deny, and the arrow keys move focus without answering", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);
      const deny = await screen.findByRole("button", { name: "Deny" });
      await waitFor(() => {
        expect(deny).toHaveFocus();
      });
      await userEvent.keyboard("{ArrowRight}");

      expect(screen.getByRole("button", { name: "Allow" })).toHaveFocus();
      expect(host.answers).toEqual([]);
    });

    it("shares the user's name", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([account(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(host.answers).toEqual([[1, { kind: "access" }]]);
    });

    it("keeps the user's name", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([account(1)]);
      await userEvent.click(
        screen.getByRole("button", { name: "Don't share" }),
      );

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });

    it("cancels on Escape", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([access(1)]);
      await userEvent.keyboard("{Escape}");

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });

    it("opens the picked application", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);
      await screen.findByRole("option", { name: "Firefox" });
      await userEvent.click(screen.getByRole("button", { name: "Open" }));

      expect(host.answers).toEqual([
        [1, { choice: "firefox", kind: "app_chooser" }],
      ]);
    });

    it("moves the pick a page with Page Up", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);
      await screen.findByRole("option", { name: "Firefox" });
      await userEvent.keyboard("{PageUp}{Enter}");

      expect(host.answers).toEqual([
        [1, { choice: "org.gnome.Evince", kind: "app_chooser" }],
      ]);
    });

    it("moves the pick with the arrows and opens it with Enter", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);
      await screen.findByRole("option", { name: "Firefox" });
      await userEvent.keyboard("{ArrowUp}{Enter}");

      expect(host.answers).toEqual([
        [1, { choice: "org.gnome.Evince", kind: "app_chooser" }],
      ]);
    });

    it("opens an application double-clicked", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);
      await userEvent.dblClick(
        await screen.findByRole("option", { name: "Document Viewer" }),
      );

      expect(host.answers).toEqual([
        [1, { choice: "org.gnome.Evince", kind: "app_chooser" }],
      ]);
    });

    it("cancels a choice", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([chooser(1)]);
      await screen.findByRole("option", { name: "Firefox" });
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });

    it("leaves an inhibitor alone and asks what comes after it", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([
        {
          app_id: "org.example.Editor",
          body: { what: ["logout"] },
          id: 5,
          kind: "inhibit",
        },
        access(6),
      ]);
      await named();

      expect(host.answers).toEqual([]);
      expect(screen.getByRole("dialog")).toHaveTextContent("Use the camera?");
    });

    it("binds the chords the user accepts, changes and clears", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([shortcuts(5)]);
      await userEvent.clear(screen.getByRole("textbox", { name: "Mute" }));
      await userEvent.type(
        screen.getByRole("textbox", { name: "Mute" }),
        "shift+ctrl+m",
      );
      await userEvent.clear(screen.getByRole("textbox", { name: "Deafen" }));
      await userEvent.click(screen.getByRole("button", { name: "Bind" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "global_shortcuts",
            triggers: [
              { id: "talk", trigger: "Ctrl+Alt+t" },
              { id: "mute", trigger: "Ctrl+Shift+m" },
              { id: "deafen" },
            ],
          },
        ],
      ]);
    });

    it("clears every chord when declined, so the choice is kept", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([shortcuts(5)]);
      await userEvent.click(screen.getByRole("button", { name: "Decline" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "global_shortcuts",
            triggers: [{ id: "talk" }, { id: "mute" }, { id: "deafen" }],
          },
        ],
      ]);
    });

    it("binds nothing when dismissed", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([shortcuts(5)]);
      await userEvent.keyboard("{Escape}");

      expect(host.answers).toEqual([[5, { kind: "canceled" }]]);
    });

    it("reports a press of a chord an application holds", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([], undefined, [
        { app_id: "org.example.App", chord: "Ctrl+Alt+t", id: 3 },
      ]);
      act(() => {
        host.fake.dispatch("shortcut", { chord: "Ctrl+Alt+t" });
      });

      expect(host.answers).toEqual([[3, { kind: "pressed" }]]);
    });

    it("sets a wallpaper", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(withPicture)} />);
      host.push([wallpaper(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Set" }));

      expect(host.answers).toEqual([[1, { kind: "access" }]]);
    });

    it("keeps the wallpaper", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(withPicture)} />);
      host.push([wallpaper(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });

    it("installs a launcher under the name typed", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([launcher(1)]);
      await userEvent.clear(screen.getByLabelText("Name"));
      await userEvent.type(screen.getByLabelText("Name"), "Work mail");
      await userEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(host.answers).toEqual([
        [1, { kind: "dynamic_launcher", name: "Work mail" }],
      ]);
    });

    it("cannot install a launcher with no name", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([launcher(1)]);
      await userEvent.clear(screen.getByLabelText("Name"));

      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    });

    it("allows the USB devices", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([usb(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Allow" }));

      expect(host.answers).toEqual([[1, { kind: "access" }]]);
    });

    it("refuses a kind it has no dialog for", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([{ app_id: "", body: {}, id: 4, kind: "wobble" }]);

      expect(host.answers).toEqual([[4, { kind: "refused" }]]);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
  describe("remote desktop", () => {
    it("offers each device asked for, all on, and the clipboard", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([remoteDesktop(1, true)]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Remote wants to control your computer",
      );
      expect(
        screen.queryByRole("switch", { name: "Touchscreen" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("switch", { name: "Keyboard" })).toBeChecked();
      expect(screen.getByRole("switch", { name: "Pointer" })).toBeChecked();
      expect(
        screen.getByRole("switch", { name: "Share clipboard" }),
      ).toBeChecked();
    });

    it("offers no clipboard when none was asked for", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([remoteDesktop(1, false)]);

      expect(
        screen.queryByRole("switch", { name: "Share clipboard" }),
      ).not.toBeInTheDocument();
    });

    it("grants what is left on", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([remoteDesktop(1, true)]);
      await userEvent.click(screen.getByRole("switch", { name: "Keyboard" }));
      await userEvent.click(
        screen.getByRole("switch", { name: "Share clipboard" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Allow" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            clipboard: false,
            devices: { keyboard: false, pointer: true, touchscreen: false },
            kind: "remote_desktop",
          },
        ],
      ]);
    });

    it("denies", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([remoteDesktop(1, true)]);
      await userEvent.click(screen.getByRole("button", { name: "Deny" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });
  });

  describe("agent", () => {
    const agent = (id: number) => ({
      app_id: "",
      body: {
        agent: "Claude Code",
        windows: [
          { id: "n1", kind: "native", title: "Notes" },
          { id: "w1", kind: "browser", title: "Pull requests" },
          { id: "n2", kind: "native", title: "" },
        ],
      },
      id,
      kind: "agent",
    });

    it("asks in the agent's own name, offering the entire desktop first", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([agent(1)]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Let Claude Code use your desktop?",
      );
      expect(
        screen.getByRole("radio", { name: /Entire desktop/u }),
      ).toBeChecked();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    });

    it("lets the entire desktop in", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([agent(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Allow" }));

      expect(host.answers).toEqual([
        [1, { kind: "agent", reach: { type: "desk" } }],
      ]);
    });

    it("lists the windows, none checked, under only these windows", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([agent(1)]);
      await userEvent.click(
        screen.getByRole("radio", { name: /Only these windows/u }),
      );

      const windows = screen.getAllByRole("checkbox");
      expect(windows.map((window) => window.textContent)).toEqual([
        "NotesWindow",
        "Pull requestsBrowser",
        "Untitled windowWindow",
      ]);
      for (const window of windows) {
        expect(window).not.toBeChecked();
      }
      expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Private windows are never shared.",
      );
    });

    it("lets only the checked windows in", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([agent(1)]);
      await userEvent.click(
        screen.getByRole("radio", { name: /Only these windows/u }),
      );
      await userEvent.click(
        screen.getByRole("checkbox", { name: /Pull requests/u }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Allow" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            kind: "agent",
            reach: {
              type: "windows",
              windows: [{ id: "w1", kind: "browser", title: "Pull requests" }],
            },
          },
        ],
      ]);
    });

    it("cancels", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([agent(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });

    it("remembers an agent let into the entire desktop, when asked to", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([agent(1)]);
      const remember = screen.getByRole("switch", {
        name: "Remember for Claude Code",
      });
      expect(remember).not.toBeChecked();
      await userEvent.click(remember);
      await userEvent.click(screen.getByRole("button", { name: "Allow" }));

      expect(host.answers).toEqual([
        [1, { kind: "agent", reach: { type: "desk" }, remember: true }],
      ]);
    });

    it("offers no remembering for only some windows", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([agent(1)]);
      await userEvent.click(
        screen.getByRole("radio", { name: /Only these windows/u }),
      );

      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    });

    it("changes an agent from what it reaches now, and saves", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      const asked = agent(1);
      host.push([
        {
          ...asked,
          body: {
            ...asked.body,
            current: {
              type: "windows",
              windows: [{ id: "n1", kind: "native", title: "Notes" }],
            },
          },
        },
      ]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Change what Claude Code can use",
      );
      expect(
        screen.getByRole("radio", { name: /Only these windows/u }),
      ).toBeChecked();
      expect(screen.getByRole("checkbox", { name: /Notes/u })).toBeChecked();
      await userEvent.click(screen.getByRole("radio", { name: /Entire/u }));
      expect(
        screen.getByRole("switch", { name: "Remember for Claude Code" }),
      ).not.toBeChecked();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [1, { kind: "agent", reach: { type: "desk" } }],
      ]);
    });

    it("starts a remembered agent's change with Remember on", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      const asked = agent(1);
      host.push([
        {
          ...asked,
          body: { ...asked.body, current: { type: "desk" }, remembered: true },
        },
      ]);

      expect(
        screen.getByRole("switch", { name: "Remember for Claude Code" }),
      ).toBeChecked();
    });

    it("is listed while in control, unless the shell shows agents itself", async () => {
      const session = {
        app_id: "",
        body: { actions: [], agent: "Claude Code", reach: { type: "desk" } },
        id: 9,
        kind: "agent",
      };
      const host = new FakeHost();
      const { rerender } = render(<PortalDialogs domicile={host.domicile} />);
      host.push([], [session]);
      expect(screen.getByRole("listitem")).toHaveTextContent(
        "In control: Claude Code — your desktop",
      );
      await userEvent.click(screen.getByRole("button", { name: "Change" }));
      expect(host.answers).toEqual([[9, { kind: "change" }]]);

      rerender(<PortalDialogs domicile={host.domicile} omitAgents />);
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    });
  });

  describe("input capture", () => {
    it("names the application and the devices it would take", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([inputCapture(1)]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Barrier wants to capture your keyboard and pointer when the pointer leaves the screen.",
      );
    });

    it("allows", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([inputCapture(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Allow" }));

      expect(host.answers).toEqual([[1, { kind: "input_capture" }]]);
    });

    it("denies", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([inputCapture(1)]);
      await userEvent.click(screen.getByRole("button", { name: "Deny" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });
  });

  describe("print", () => {
    const twoPrinters = [
      printer("office", { color_mode: "monochrome", sides: "one_sided" }),
      printer("lab", { media: "na_letter_8.5x11in" }),
    ];

    it("prints the starting printer's options as they stand", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([print(1, twoPrinters)]);

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Editor prints “Report”",
      );
      expect(
        screen.getByRole("combobox", { name: "Destination" }).textContent,
      ).toContain("office printer");
      expect(
        screen.getByRole("combobox", { name: "Two-sided" }).textContent,
      ).toContain("Off");
      expect(screen.queryByRole("combobox", { name: "Quality" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Print it" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            kind: "print",
            options: {
              color_mode: "monochrome",
              copies: 1,
              media: "iso_a4_210x297mm",
              pages: [],
              sides: "one_sided",
            },
            printer: "office",
          },
        ],
      ]);
    });

    it("takes another printer's options, copies, pages and paper", async () => {
      const user = userEvent.setup();
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([print(1, twoPrinters)]);

      await user.click(screen.getByRole("combobox", { name: "Destination" }));
      await user.click(screen.getByRole("option", { name: "lab printer" }));
      await user.click(screen.getByRole("combobox", { name: "Layout" }));
      await user.click(screen.getByRole("option", { name: "Landscape" }));
      await user.clear(screen.getByRole("spinbutton", { name: "Copies" }));
      await user.type(screen.getByRole("spinbutton", { name: "Copies" }), "3");
      expect(screen.queryByRole("textbox", { name: "Page range" })).toBeNull();
      await user.click(screen.getByRole("combobox", { name: "Pages" }));
      await user.click(screen.getByRole("option", { name: "Custom" }));
      await user.type(
        screen.getByRole("textbox", { name: "Page range" }),
        "1-2, 5",
      );
      await user.click(screen.getByRole("button", { name: "Print it" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            kind: "print",
            options: {
              copies: 3,
              media: "na_letter_8.5x11in",
              orientation: "landscape",
              pages: [
                { first: 1, last: 2 },
                { first: 5, last: 5 },
              ],
            },
            printer: "lab",
          },
        ],
      ]);
    });

    it("will not print pages it cannot read or more copies than allowed", async () => {
      const user = userEvent.setup();
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([print(1, twoPrinters)]);

      await user.clear(screen.getByRole("spinbutton", { name: "Copies" }));
      await user.type(screen.getByRole("spinbutton", { name: "Copies" }), "10");
      expect(screen.getByRole("button", { name: "Print it" })).toBeDisabled();
      await user.clear(screen.getByRole("spinbutton", { name: "Copies" }));
      await user.type(screen.getByRole("spinbutton", { name: "Copies" }), "1");
      await user.click(screen.getByRole("combobox", { name: "Pages" }));
      await user.click(screen.getByRole("option", { name: "Custom" }));
      expect(screen.getByRole("button", { name: "Print it" })).toBeDisabled();
      await user.type(
        screen.getByRole("textbox", { name: "Page range" }),
        "3-1",
      );
      expect(
        screen.getByRole("textbox", { name: "Page range" }),
      ).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("button", { name: "Print it" })).toBeDisabled();
    });

    it("saves a PDF where the user picks, with its paper and pages", async () => {
      const user = userEvent.setup();
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([print(1, twoPrinters)]);

      await user.click(screen.getByRole("combobox", { name: "Destination" }));
      await user.click(screen.getByRole("option", { name: "Save to PDF" }));
      expect(screen.queryByRole("spinbutton", { name: "Copies" })).toBeNull();
      await user.click(screen.getByRole("combobox", { name: "Pages" }));
      await user.click(screen.getByRole("option", { name: "Custom" }));
      await user.type(screen.getByRole("textbox", { name: "Page range" }), "2");
      await user.click(screen.getByRole("button", { name: "Save…" }));
      await listed();

      expect(screen.getByRole("combobox", { name: "Name" })).toHaveValue(
        "Report.pdf",
      );
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            kind: "save_to_pdf",
            options: {
              copies: 1,
              media: "na_letter_8.5x11in",
              orientation: "portrait",
              pages: [{ first: 2, last: 2 }],
            },
            path: "/home/me/Report.pdf",
          },
        ],
      ]);
    });

    it("goes back to its options when the PDF's picker is canceled", async () => {
      const user = userEvent.setup();
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(home())} />);
      host.push([print(1, twoPrinters)]);

      await user.click(screen.getByRole("combobox", { name: "Destination" }));
      await user.click(screen.getByRole("option", { name: "Save to PDF" }));
      await user.click(screen.getByRole("button", { name: "Save…" }));
      await listed();
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(
        screen.getByRole("combobox", { name: "Destination" }).textContent,
      ).toContain("Save to PDF");
      expect(host.answers).toEqual([]);
    });

    it("offers a PDF when no printers are set up", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([print(1, [], "")]);

      expect(
        screen.getByRole("combobox", { name: "Destination" }).textContent,
      ).toContain("Save to PDF");
      expect(screen.getByText("No printers are set up.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save…" })).toBeEnabled();
    });

    it("cancels", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([print(1, twoPrinters)]);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });
  });

  describe("screenshot", () => {
    it("lists the whole desk, each screen and each window beside the frozen desk", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);

      expect(screen.getByRole("img", { name: "The desk" })).toHaveAttribute(
        "src",
        "data:image/png;base64,AA==",
      );
      expect(screen.getByRole("dialog")).toHaveTextContent("Shooter asks");
      expect(screen.getByRole("radio", { name: "Everything" })).toBeChecked();
      // A screen by its make and model, else its output's name.
      const screens = radiosNamed("Screens", ["BOE NE135A1M-NY1", "HDMI-A-1"]);
      expect(screens.actual).toEqual(screens.expected);
      const windows = radiosNamed("Windows", ["Kitty: ~/src"]);
      expect(windows.actual).toEqual(windows.expected);
    });

    it("outlines the pick on the desk, with its size", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      expect(screen.getByRole("dialog")).toHaveTextContent("300 × 100");
      await userEvent.click(screen.getByRole("radio", { name: "HDMI-A-1" }));

      expect(screen.getByRole("dialog")).toHaveTextContent("100 × 100");
    });

    it("moves the pick with the arrow keys", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      screen.getByRole("radio", { name: "Everything" }).focus();
      await userEvent.keyboard("{ArrowDown}{ArrowDown}");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            area: { height: 100, width: 100, x: 200, y: 0 },
            copy: false,
            kind: "screenshot",
          },
        ],
      ]);
    });

    it("names each window by its application, with its icon", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      const shot = frozen(1, "screenshot");
      host.push([
        {
          ...shot,
          body: {
            ...shot.body,
            windows: [
              { app_id: "firefox", id: "app-1", title: "Notes" },
              { app_id: "", id: "app-2", title: "" },
            ],
          },
        },
      ]);

      const notes = await screen.findByRole("radio", {
        name: "Firefox: Notes",
      });
      expect(
        within(notes).getByRole("presentation").getAttribute("src"),
      ).toStartWith("data:image/svg+xml");
      expect(
        screen.getByRole("radio", { name: "Untitled window" }),
      ).toBeInTheDocument();
    });

    it("shows each browser window's page icon", () => {
      const host = new FakeHost();
      host.fake.set({
        browserWindows: [
          browserWindow("1", "Settings"),
          browserWindow("2", "Blank"),
        ],
      });
      const elements = [
        iconed("1", "data:image/svg+xml,settings"),
        iconed("2", ""),
      ];
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      const settings = screen.getByRole("radio", { name: "Browser: Settings" });
      const blank = screen.getByRole("radio", { name: "Browser: Blank" });
      for (const element of elements) {
        element.remove();
      }

      expect(
        within(settings).getByRole("presentation").getAttribute("src"),
      ).toBe("data:image/svg+xml,settings");
      expect(within(blank).queryByRole("presentation")).not.toBeInTheDocument();
    });

    it("names an app window by its app, with the app's icon over its page's", async () => {
      const host = new FakeHost();
      host.fake.set({
        browserWindows: [
          { ...browserWindow("1", "Notes"), appId: "firefox", isApp: true },
        ],
      });
      const element = iconed("1", "data:image/png;base64,page");
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([frozen(1, "screenshot")]);

      const notes = await screen.findByRole("radio", {
        name: "Firefox: Notes",
      });
      // The radio can carry the app's name before the app's icon has loaded,
      // while it still shows the page's (seen in CI).
      await waitFor(() => {
        expect(
          within(notes).getByRole("presentation").getAttribute("src"),
        ).toStartWith("data:image/svg+xml");
      });
      element.remove();
    });

    it("saves a window the shell shows from its own frame, without what is over it", async () => {
      const host = new FakeHost();
      render(
        <PortalDialogs
          domicile={host.domicile}
          shownWindows={() => [
            ShownWindow.App("app-3", { height: 10, width: 20, x: 0, y: 5 }),
          ]}
        />,
      );
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Kitty: ~/src" }),
      );
      expect(screen.getByRole("dialog")).not.toHaveTextContent("Not on screen");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [1, { copy: false, id: "app-3", kind: "screenshot_window" }],
      ]);
    });

    it("saves a window the shell does not show from its own last frame", async () => {
      // A tab behind another, or a window on another workspace.
      const host = new FakeHost();
      render(
        <PortalDialogs domicile={host.domicile} shownWindows={() => []} />,
      );
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Kitty: ~/src" }),
      );

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "Not on screen: saved as it last drew itself.",
      );
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(host.answers).toEqual([
        [1, { copy: false, id: "app-3", kind: "screenshot_window" }],
      ]);
    });

    it("saves a part dragged over a window that is not on screen", async () => {
      const host = new FakeHost();
      render(
        <PortalDialogs
          domicile={host.with(previewing())}
          shownWindows={() => []}
        />,
      );
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Kitty: ~/src" }),
      );
      loaded200x100(await screen.findByRole("img", { name: "Kitty: ~/src" }));
      const preview = drawnAtHalfSize(
        screen.getByRole("group", {
          name: "Drag to pick a part of the window",
        }),
      );
      fireEvent.pointerDown(preview, { clientX: 60, clientY: 30 });
      fireEvent.pointerMove(preview, { clientX: 20, clientY: 45 });
      fireEvent.pointerUp(preview, { clientX: 20, clientY: 45 });

      expect(screen.getByRole("figure")).toHaveTextContent("54 × 31");
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "A part of the window",
      );
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(host.answers).toEqual([
        [
          1,
          {
            area: { height: 31, width: 54, x: 13, y: 20 },
            copy: false,
            id: "app-3",
            kind: "screenshot_window",
          },
        ],
      ]);
    });

    it("previews a window that is not on screen as it last drew itself", async () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("2", "Hidden")] });
      render(
        <PortalDialogs
          domicile={host.with(previewing())}
          shownWindows={() => []}
        />,
      );
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Kitty: ~/src" }),
      );

      expect(
        await screen.findByRole("img", { name: "Kitty: ~/src" }),
      ).toHaveAttribute("src", "data:image/png;base64,app-3");
      await userEvent.click(
        screen.getByRole("radio", { name: "Browser: Hidden" }),
      );
      expect(
        await screen.findByRole("img", { name: "Browser: Hidden" }),
      ).toHaveAttribute("src", "data:image/png;base64,2");
      await userEvent.click(screen.getByRole("radio", { name: "Everything" }));
      expect(screen.getByRole("img", { name: "The desk" })).toBeInTheDocument();
    });

    // A preview of another shape would resize the dialog on every pick.
    it("draws a preview in the desk's box, so the dialog keeps its size", async () => {
      const host = new FakeHost();
      render(
        <PortalDialogs
          domicile={host.with(previewing())}
          shownWindows={() => []}
        />,
      );
      host.push([frozen(1, "screenshot")]);
      const box = (element: HTMLElement) => element.parentElement?.style;
      const desk = box(screen.getByRole("img", { name: "The desk" }));

      await userEvent.click(
        screen.getByRole("radio", { name: "Kitty: ~/src" }),
      );
      const preview = box(
        await screen.findByRole("img", { name: "Kitty: ~/src" }),
      );

      expect(preview?.aspectRatio).toBe(desk?.aspectRatio);
      expect(preview?.inlineSize).toBe(desk?.inlineSize);
    });

    it("says when a window's preview cannot be drawn", async () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("9", "Gone")] });
      render(
        <PortalDialogs
          domicile={host.with(previewing())}
          shownWindows={() => []}
        />,
      );
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Browser: Gone" }),
      );

      expect(await screen.findByText("No preview")).toBeInTheDocument();
    });

    it("saves each browser window from its page alone, shown or not", async () => {
      // "Hidden" is a tab behind another in a stack.
      const host = new FakeHost();
      host.fake.set({
        browserWindows: [
          browserWindow("1", "Pull requests"),
          browserWindow("2", "Hidden"),
        ],
      });
      render(
        <PortalDialogs
          domicile={host.domicile}
          shownWindows={() => [
            // Past the desk's right edge, at 140.
            ShownWindow.Browser("1", { height: 40, width: 100, x: 50, y: 10 }),
          ]}
        />,
      );
      host.push([frozen(1, "screenshot")]);
      const listed = radiosNamed("Windows", [
        "Kitty: ~/src",
        "Browser: Pull requests",
        "Browser: Hidden",
      ]);
      expect(listed.actual).toEqual(listed.expected);
      await userEvent.click(
        screen.getByRole("radio", { name: "Browser: Hidden" }),
      );
      expect(screen.getByRole("dialog")).toHaveTextContent("Not on screen");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [1, { copy: false, id: "2", kind: "screenshot_browser_window" }],
      ]);
    });

    it("finds the windows the page draws when the shell does not say", async () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("1", "Pull requests")] });
      const elements = [
        drawn("app", ["app-id", "app-3"], {
          height: 10,
          width: 20,
          x: 0,
          y: 5,
        }),
        drawn("webview", ["window", "1"], { height: 5, width: 5, x: 0, y: 0 }),
        // The shell's own page, such as a preview.
        drawn("webview", undefined, { height: 40, width: 100, x: 0, y: 0 }),
      ];
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      const windows = within(screen.getByRole("group", { name: "Windows" }));
      const listed = radiosNamed("Windows", [
        "Kitty: ~/src",
        "Browser: Pull requests",
      ]);
      expect(listed.actual).toEqual(listed.expected);
      await userEvent.click(
        windows.getByRole("radio", { name: "Kitty: ~/src" }),
      );
      expect(screen.getByRole("dialog")).not.toHaveTextContent("Not on screen");
      await userEvent.click(
        windows.getByRole("radio", { name: "Browser: Pull requests" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      for (const element of elements) {
        element.remove();
      }

      expect(host.answers).toEqual([
        [1, { copy: false, id: "1", kind: "screenshot_browser_window" }],
      ]);
    });

    it("names no asker when the shell asked for it", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([{ ...frozen(1, "screenshot"), app_id: SHELL_APP_ID }]);

      expect(screen.getByRole("dialog")).toHaveTextContent("Take a screenshot");
      expect(screen.getByRole("dialog")).not.toHaveTextContent("asks");
    });

    it("saves the whole desk, picked again", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(screen.getByRole("radio", { name: "Everything" }));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            area: { height: 100, width: 300, x: 0, y: 0 },
            copy: false,
            kind: "screenshot",
          },
        ],
      ]);
    });

    it("saves an area dragged on the desk", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      const desk = drawnAtHalfSize(
        screen.getByRole("group", { name: "Drag to pick an area" }),
      );
      fireEvent.pointerDown(desk, { clientX: 60, clientY: 30 });
      fireEvent.pointerMove(desk, { clientX: 20, clientY: 45 });
      fireEvent.pointerUp(desk, { clientX: 20, clientY: 45 });
      await userEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(host.answers).toEqual([
        [
          1,
          {
            area: { height: 31, width: 81, x: 20, y: 20 },
            copy: false,
            kind: "screenshot",
          },
        ],
      ]);
    });

    it("copies the window picked with Ctrl+C instead of saving it", async () => {
      const host = new FakeHost();
      render(
        <PortalDialogs domicile={host.domicile} shownWindows={() => []} />,
      );
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Kitty: ~/src" }),
      );
      await userEvent.keyboard("{Control>}c{/Control}");

      expect(host.answers).toEqual([
        [1, { copy: true, id: "app-3", kind: "screenshot_window" }],
      ]);
    });

    it("copies nothing more with Ctrl+C as it animates out", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      await userEvent.keyboard("{Control>}c{/Control}");
      host.push([]);
      fireEvent.keyDown(document, { ctrlKey: true, key: "c" });

      expect(host.answers).toHaveLength(1);
    });

    it("copies an area dragged on the desk with Ctrl+C", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      const desk = drawnAtHalfSize(
        screen.getByRole("group", { name: "Drag to pick an area" }),
      );
      fireEvent.pointerDown(desk, { clientX: 60, clientY: 30 });
      fireEvent.pointerMove(desk, { clientX: 20, clientY: 45 });
      fireEvent.pointerUp(desk, { clientX: 20, clientY: 45 });
      await userEvent.keyboard("{Control>}c{/Control}");

      expect(host.answers).toEqual([
        [
          1,
          {
            area: { height: 31, width: 81, x: 20, y: 20 },
            copy: true,
            kind: "screenshot",
          },
        ],
      ]);
    });

    it("copies the pick with the Copy button", async () => {
      const host = new FakeHost();
      render(
        <PortalDialogs domicile={host.domicile} shownWindows={() => []} />,
      );
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Kitty: ~/src" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Copy" }));

      expect(host.answers).toEqual([
        [1, { copy: true, id: "app-3", kind: "screenshot_window" }],
      ]);
    });

    describe("selected on screen", () => {
      it("draws the frozen desk under the selection", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );

        expect(screen.getByRole("img", { name: "The desk" })).toHaveStyle({
          height: "50px",
          left: "-10px",
          top: "0px",
          width: "150px",
        });
      });

      it("saves the area in the frame's pixels", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([0, 10], [40, 30]);
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(host.answers).toEqual([
          [
            1,
            {
              area: { height: 40, width: 80, x: 20, y: 20 },
              copy: false,
              kind: "screenshot",
            },
          ],
        ]);
      });

      it("copies the area", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([0, 10], [40, 30]);
        await userEvent.click(screen.getByRole("button", { name: "Copy" }));

        expect(host.answers).toEqual([
          [
            1,
            {
              area: { height: 40, width: 80, x: 20, y: 20 },
              copy: true,
              kind: "screenshot",
            },
          ],
        ]);
      });

      it("copies the area with Ctrl+C, once one is selected", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        await userEvent.keyboard("{Control>}c{/Control}");
        expect(host.answers).toEqual([]);
        dragOnScreen([0, 10], [40, 30]);
        await userEvent.keyboard("{Control>}c{/Control}");

        expect(host.answers).toEqual([
          [
            1,
            {
              area: { height: 40, width: 80, x: 20, y: 20 },
              copy: true,
              kind: "screenshot",
            },
          ],
        ]);
      });

      it("takes the keyboard from the window focused before", async () => {
        const host = new FakeHost();
        const page = focusedPage();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );

        expect(
          screen.getByRole("application", { name: "Drag to select an area" }),
        ).toHaveFocus();
        page.remove();
      });

      it("takes the keyboard back from a window's page", async () => {
        const host = new FakeHost();
        const page = focusedPage();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        page.focus();

        expect(
          screen.getByRole("application", { name: "Drag to select an area" }),
        ).toHaveFocus();
        page.remove();
      });

      it("fades the dialog out as the picker comes up", () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        fireEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );

        expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute(
          "data-closed",
        );
        expect(
          screen.getByRole("application", { name: "Drag to select an area" }),
        ).toBeInTheDocument();
      });

      it("draws over a dialog already up, such as the launcher", async () => {
        const host = new FakeHost();
        render(
          <>
            <ModalDialog open title="Launcher">
              <input aria-label="Search" />
            </ModalDialog>
            <PortalDialogs domicile={host.domicile} />
          </>,
        );
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          await screen.findByRole("button", { name: "Select on screen" }),
        );
        const picker = screen.getByRole("application", {
          name: "Drag to select an area",
        });
        const launcher = screen.getByRole("dialog", {
          hidden: true,
          name: "Launcher",
        });

        // Last on the body, so it stacks above the launcher's layer.
        expect(picker.parentElement).toBe(document.body);
        expect(
          launcher.compareDocumentPosition(picker) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      });

      it("fades out on Escape, then shows the dialog", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        // Taken while up: the dialog back over it hides it from the tree.
        const picker = screen.getByRole("application", {
          name: "Drag to select an area",
        });
        await userEvent.keyboard("{Escape}");

        expect(picker).toHaveAttribute("data-leaving");
        transitionEnd(picker, "opacity");
        expect(picker).not.toBeInTheDocument();
        expect(
          await screen.findByRole("button", { name: "Select on screen" }),
        ).toBeInTheDocument();
      });

      it("fades out once answered", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        host.push([]);
        const picker = screen.getByRole("application", {
          hidden: true,
          name: "Drag to select an area",
        });

        expect(picker).toHaveAttribute("data-leaving");
        transitionEnd(picker, "opacity");
        expect(picker).not.toBeInTheDocument();
        expect(
          screen.queryByRole("dialog", { hidden: true }),
        ).not.toBeInTheDocument();
      });

      it("copies nothing more with Ctrl+C as it fades out", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([0, 10], [40, 30]);
        await userEvent.keyboard("{Control>}c{/Control}");
        host.push([]);
        fireEvent.keyDown(document, { ctrlKey: true, key: "c" });

        expect(host.answers).toHaveLength(1);
      });

      it("lets a window's page have the keyboard back as it fades out", async () => {
        const host = new FakeHost();
        const page = focusedPage();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        host.push([]);
        page.focus();

        expect(page).toHaveFocus();
        page.remove();
      });

      it("leaves focus that moves to the shell", async () => {
        const host = new FakeHost();
        render(
          <>
            <input aria-label="Passphrase" />
            <PortalDialogs domicile={host.domicile} />
          </>,
        );
        host.push([frozen(1, "screenshot")]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        screen.getByRole("textbox", { name: "Passphrase" }).focus();

        expect(
          screen.getByRole("textbox", { name: "Passphrase" }),
        ).toHaveFocus();
      });
    });

    it("cancels", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "screenshot")]);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });
  });

  describe("pick color", () => {
    it("starts at the middle of the frozen desk", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "pick_color")]);

      expect(
        screen.getByRole("button", { name: "Pick the pixel at 150, 50" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("img", { name: "The desk" })).toBeInTheDocument();
    });

    it("picks the pixel the arrow keys move to", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "pick_color")]);
      screen.getByRole("button", { name: /^Pick the pixel/ }).focus();
      await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowUp}{Enter}");

      expect(host.answers).toEqual([
        [1, { kind: "pick_color", x: 152, y: 49 }],
      ]);
    });

    it("picks the pixel clicked", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "pick_color")]);
      const desk = drawnAtHalfSize(
        screen.getByRole("button", { name: /^Pick the pixel/ }),
      );
      fireEvent.pointerMove(desk, { clientX: 15, clientY: 69 });

      expect(desk).toHaveAccessibleName("Pick the pixel at 10, 98");
      fireEvent.click(desk, { clientX: 15, clientY: 69 });
      expect(host.answers).toEqual([[1, { kind: "pick_color", x: 10, y: 98 }]]);
    });

    it("cancels", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([frozen(1, "pick_color")]);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(host.answers).toEqual([[1, { kind: "canceled" }]]);
    });
  });

  describe("capturing", () => {
    it("shows nothing while no session runs", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([]);

      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });

    it("names each session's application and what it holds", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push(
        [],
        [
          remoteDesktop(5, true),
          inputCapture(6),
          {
            app_id: "us.zoom.Zoom",
            body: {
              sources: [
                { app_id: "", id: "app-3", title: "Notes", type: "window" },
                { app_id: "", id: "app-4", title: "", type: "window" },
                { description: "", name: "drm-1", type: "monitor" },
                {
                  description: "Dell Inc. DELL U2720Q",
                  name: "DP-1",
                  type: "monitor",
                },
                { type: "desk" },
                {
                  monitor: { description: "", name: "drm-1" },
                  position: [0, 0],
                  size: [10, 10],
                  type: "region",
                },
                { position: [-50, 0], size: [10, 10], type: "region" },
              ],
            },
            id: 7,
            kind: "screen_cast",
          },
          { app_id: "", body: {}, id: 8, kind: "screenshot" },
        ],
      );

      expect(
        screen
          .getAllByRole("listitem")
          .map((item) => item.firstChild?.textContent),
      ).toEqual([
        "Remote control: Remote — keyboard, pointer, clipboard",
        "Input capture: Barrier — keyboard, pointer",
        "Sharing: Zoom — Notes, Untitled window, Screen drm-1, Dell Inc. DELL U2720Q, All screens, Part of Screen drm-1, Part of the desktop",
        "screenshot: An application",
      ]);
    });

    it("names a session's application by its desktop entry, with its icon", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.with(desktop())} />);
      host.push([], [{ ...inputCapture(6), app_id: "firefox" }]);

      expect(
        await screen.findByText("Input capture: Firefox — keyboard, pointer"),
      ).toBeInTheDocument();
      expect(screen.getByRole("presentation")).toHaveAttribute(
        "src",
        "data:image/svg+xml;base64,PHN2Zy8+",
      );
    });

    it("leaves screen casts out when the shell shows them", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} omitScreenCasts />);
      host.push(
        [],
        [
          inputCapture(6),
          {
            app_id: "us.zoom.Zoom",
            body: { sources: [] },
            id: 7,
            kind: "screen_cast",
          },
        ],
      );

      expect(
        screen.getAllByRole("listitem").map((item) => item.textContent),
      ).toEqual(["Input capture: Barrier — keyboard, pointerStop"]);
    });

    it("stops a session", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([], [remoteDesktop(5, false), inputCapture(6)]);
      const [, capture] = screen.getAllByRole("listitem");
      if (capture === undefined) {
        throw new Error("no second session");
      }
      await userEvent.click(
        within(capture).getByRole("button", { name: "Stop" }),
      );

      expect(host.answers).toEqual([[6, { kind: "stop" }]]);
    });
  });
});

describe("screen recording", () => {
  const recording = (id: number, more: object = {}) => ({
    app_id: SHELL_APP_ID,
    body: {
      file: "/home/me/Videos/Screen recordings/a.webm",
      recorded_ms: 65_000,
      sources: [{ description: "Dell U3219Q", name: "drm-1", type: "monitor" }],
      ...more,
    },
    id,
    kind: "recording",
  });

  afterEach(() => {
    setSystemTime();
    delete (globalThis as { RestrictionTarget?: unknown }).RestrictionTarget;
  });

  it("asks the shell what to record in the screen cast picker", async () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([{ ...screenCast(false, MONITORS, true), app_id: SHELL_APP_ID }]);

    expect(screen.getByRole("dialog")).toHaveTextContent("Record your screen");
    expect(screen.queryByText(/wants to record/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "drm-2" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));

    expect(host.answers).toEqual([
      [
        5,
        { kind: "screen_cast", sources: [{ name: "drm-2", type: "monitor" }] },
      ],
    ]);
  });

  it("shows a toolbar timing the recording, not an indicator row", () => {
    setSystemTime(new Date(100_000));
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([], [recording(7, { running_since_ms: 95_000 })]);

    const toolbar = screen.getByRole("toolbar", { name: "Screen recording" });
    expect(within(toolbar).getByRole("timer")).toHaveTextContent("1:10");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("says whether it is recording or paused", () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([], [recording(7, { running_since_ms: 95_000 })]);
    const toolbar = screen.getByRole("toolbar", { name: "Screen recording" });
    expect(toolbar).toHaveTextContent(/^Recording/);

    host.push([], [recording(7)]);
    expect(toolbar).toHaveTextContent(/^Paused/);
  });

  it("leaves its toolbar out of captures of the desk", async () => {
    const hidden: Element[] = [];
    (globalThis as { RestrictionTarget?: unknown }).RestrictionTarget = {
      fromElement: (element: Element) => {
        hidden.push(element);
        return Promise.resolve({});
      },
    };
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([], [recording(7, { running_since_ms: 95_000 })]);

    await waitFor(() => {
      expect(hidden).toEqual([screen.getByRole("toolbar")]);
    });
  });

  it("pauses, stops and discards the recording", async () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([], [recording(7, { running_since_ms: 95_000 })]);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(host.answers).toEqual([
      [7, { kind: "pause" }],
      [7, { kind: "stop" }],
      [7, { kind: "discard" }],
    ]);
  });

  it("resumes a paused recording, whose time stands still", async () => {
    setSystemTime(new Date(100_000));
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([], [recording(7)]);

    expect(screen.getByRole("timer")).toHaveTextContent("1:05");
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(host.answers).toEqual([[7, { kind: "resume" }]]);
  });
});

describe("screen cast", () => {
  it("lists the windows beside the desk, by title over application", async () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.with(desktop())} />);
    host.push([
      screenCast(false, WINDOWS, false, {
        desk: frozen(1, "screenshot").body,
      }),
    ]);

    expect(screen.getByRole("dialog")).toHaveTextContent("Share a window");
    expect(screen.getByText("Zoom wants to record")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "The desk" })).toHaveAttribute(
      "src",
      "data:image/png;base64,AA==",
    );
    const notes = await screen.findByRole("radio", { name: "Firefox: Notes" });
    expect(
      within(notes).getByRole("presentation").getAttribute("src"),
    ).toStartWith("data:image/svg+xml");
    const windows = radiosNamed("Windows", [
      "Firefox: Notes",
      "Untitled window",
    ]);
    expect(windows.actual).toEqual(windows.expected);
  });

  it("shares nothing until a window is picked", () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([screenCast()]);

    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
  });

  it("shares the window picked", async () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([screenCast()]);
    await userEvent.click(
      screen.getByRole("radio", { name: "Firefox: Notes" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(host.answers).toEqual([
      [5, { kind: "screen_cast", sources: [{ id: "app-3", type: "window" }] }],
    ]);
  });

  it("shares several windows when the application asks for more", async () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([screenCast(true)]);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Firefox: Notes" }),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Untitled window" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(host.answers).toEqual([
      [
        5,
        {
          kind: "screen_cast",
          sources: [
            { id: "app-3", type: "window" },
            { id: "app-4", type: "window" },
          ],
        },
      ],
    ]);
  });

  it("cancels", async () => {
    const host = new FakeHost();
    render(<PortalDialogs domicile={host.domicile} />);
    host.push([screenCast()]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(host.answers).toEqual([[5, { kind: "canceled" }]]);
  });

  describe("browser windows", () => {
    it("offers each browser window's page alone, shown or not, with its icon, and shares it", async () => {
      const host = new FakeHost();
      host.fake.set({
        browserWindows: [
          browserWindow("7", "Meet"),
          browserWindow("8", "Docs"),
        ],
      });
      const meet = iconed("7", "https://meet.example/icon.png");
      render(
        <PortalDialogs domicile={host.domicile} shownWindows={() => []} />,
      );
      host.push([screenCast(false, WINDOWS, false, { browser_windows: true })]);
      expect(
        within(screen.getByRole("radio", { name: "Browser: Meet" }))
          .getByRole("presentation")
          .getAttribute("src"),
      ).toBe("https://meet.example/icon.png");
      meet.remove();
      const windows = radiosNamed("Windows", [
        "Firefox: Notes",
        "Untitled window",
        "Browser: Meet",
        "Browser: Docs",
      ]);
      expect(windows.actual).toEqual(windows.expected);
      await userEvent.click(
        screen.getByRole("radio", { name: "Browser: Docs" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [{ id: "8", title: "Docs", type: "browser_window" }],
          },
        ],
      ]);
    });

    it("leave out the windows the shell shows as closed", () => {
      // "Messages" is an inbox's, kept running for its notifications.
      const host = new FakeHost();
      host.fake.set({
        browserWindows: [
          browserWindow("7", "Meet"),
          browserWindow("8", "Messages"),
        ],
      });
      render(
        <PortalDialogs
          closedBrowsers={["8"]}
          domicile={host.domicile}
          shownWindows={() => []}
        />,
      );
      host.push([screenCast(false, WINDOWS, false, { browser_windows: true })]);

      const windows = radiosNamed("Windows", [
        "Firefox: Notes",
        "Untitled window",
        "Browser: Meet",
      ]);
      expect(windows.actual).toEqual(windows.expected);
    });

    it("are not offered to an application that cannot take windows", () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("7", "Meet")] });
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([screenCast(false, MONITORS)]);

      expect(
        screen.queryByRole("radio", { name: "Browser: Meet" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("preview", () => {
    const shown = () => [
      ShownWindow.App("app-3", { height: 10, width: 20, x: 0, y: 5 }),
      ShownWindow.Browser("7", { height: 10, width: 30, x: 20, y: 5 }),
    ];
    const withDesk = () =>
      screenCast(
        true,
        [
          ...WINDOWS,
          {
            description: "",
            name: "HDMI-A-1",
            size: [100, 50],
            type: "monitor",
          },
        ],
        false,
        { browser_windows: true, desk: frozen(1, "screenshot").body },
      );

    it("outlines each source picked on the desk, with its size", async () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("7", "Meet")] });
      render(<PortalDialogs domicile={host.domicile} shownWindows={shown} />);
      host.push([withDesk()]);
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Firefox: Notes" }),
      );
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Browser: Meet" }),
      );
      await userEvent.click(screen.getByRole("checkbox", { name: "HDMI-A-1" }));

      const stage = screen.getByRole("figure");
      expect(stage).toHaveTextContent("40 × 20");
      expect(stage).toHaveTextContent("60 × 20");
      expect(stage).toHaveTextContent("100 × 100");
    });

    it("previews the source picked last when it is not on screen", async () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("2", "Docs")] });
      render(
        <PortalDialogs
          domicile={host.with(previewing())}
          shownWindows={shown}
        />,
      );
      host.push([withDesk()]);
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Browser: Docs" }),
      );

      expect(
        await screen.findByRole("img", { name: "Browser: Docs" }),
      ).toHaveAttribute("src", "data:image/png;base64,2");
      await userEvent.click(screen.getByRole("checkbox", { name: "HDMI-A-1" }));
      expect(screen.getByRole("img", { name: "The desk" })).toBeInTheDocument();
    });

    it("shares a part dragged over a window that is not on screen", async () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("2", "Docs")] });
      render(
        <PortalDialogs
          domicile={host.with(previewing())}
          shownWindows={shown}
        />,
      );
      host.push([withDesk()]);
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Browser: Docs" }),
      );
      loaded200x100(await screen.findByRole("img", { name: "Browser: Docs" }));
      const preview = drawnAtHalfSize(
        screen.getByRole("group", {
          name: "Drag to pick a part of the window",
        }),
      );
      fireEvent.pointerDown(preview, { clientX: 60, clientY: 30 });
      fireEvent.pointerMove(preview, { clientX: 20, clientY: 45 });
      fireEvent.pointerUp(preview, { clientX: 20, clientY: 45 });
      await userEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [
              {
                area: { height: 31, width: 54, x: 13, y: 20 },
                id: "2",
                title: "Docs",
                type: "browser_window",
              },
            ],
          },
        ],
      ]);
    });

    it("says when the source picked is not on screen", async () => {
      const host = new FakeHost();
      host.fake.set({ browserWindows: [browserWindow("7", "Meet")] });
      render(<PortalDialogs domicile={host.domicile} shownWindows={shown} />);
      host.push([withDesk()]);
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Untitled window" }),
      );

      expect(screen.getByRole("figure")).toHaveTextContent("Not on screen");
    });
  });

  describe("screens", () => {
    it("lists each screen by its panel over its name", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([screenCast(false, MONITORS)]);

      expect(screen.getByRole("dialog")).toHaveTextContent("Share a screen");
      const screens = radiosNamed("Screens", [
        "Dell Inc. DELL U3219Q",
        "drm-2",
      ]);
      expect(screens.actual).toEqual(screens.expected);
      expect(
        screen.queryByRole("group", { name: "Windows" }),
      ).not.toBeInTheDocument();
    });

    it("offers windows and screens together and shares from both", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([screenCast(true, [...WINDOWS, ...MONITORS])]);
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Firefox: Notes" }),
      );
      await userEvent.click(screen.getByRole("checkbox", { name: "drm-2" }));
      await userEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [
              { name: "drm-2", type: "monitor" },
              { id: "app-3", type: "window" },
            ],
          },
        ],
      ]);
    });

    it("picks one source across the groups unless the application asks for more", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([screenCast(false, [...WINDOWS, ...MONITORS])]);
      await userEvent.click(
        screen.getByRole("radio", { name: "Firefox: Notes" }),
      );
      await userEvent.click(screen.getByRole("radio", { name: "drm-2" }));
      await userEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [{ name: "drm-2", type: "monitor" }],
          },
        ],
      ]);
    });
  });

  describe("region", () => {
    it("is offered only when the application asks for one", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([screenCast()]);

      expect(
        screen.queryByRole("button", { name: "Select on screen" }),
      ).not.toBeInTheDocument();
    });

    it("shares an area dragged on the desk shot", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([
        screenCast(false, MONITORS, true, {
          desk: frozen(1, "screenshot").body,
        }),
      ]);
      const desk = drawnAtHalfSize(
        screen.getByRole("group", { name: "Drag to pick an area" }),
      );
      fireEvent.pointerDown(desk, { clientX: 60, clientY: 30 });
      fireEvent.pointerMove(desk, { clientX: 20, clientY: 45 });
      fireEvent.pointerUp(desk, { clientX: 20, clientY: 45 });
      await userEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [{ position: [0, 10], size: [41, 16], type: "region" }],
          },
        ],
      ]);
    });

    it("picks the whole desk at first and shares it", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([
        screenCast(false, MONITORS, true, {
          desk: frozen(1, "screenshot").body,
        }),
      ]);

      expect(screen.getByRole("radio", { name: "Everything" })).toBeChecked();
      await userEvent.click(screen.getByRole("button", { name: "Share" }));
      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [{ position: [-10, 0], size: [150, 50], type: "region" }],
          },
        ],
      ]);
    });

    it("offers no whole desk when the application asks for no region", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([
        screenCast(false, MONITORS, false, {
          desk: frozen(1, "screenshot").body,
        }),
      ]);

      expect(
        screen.queryByRole("radio", { name: "Everything" }),
      ).not.toBeInTheDocument();
    });

    it("shares a source picked after an area was dragged", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([
        screenCast(false, MONITORS, true, {
          desk: frozen(1, "screenshot").body,
        }),
      ]);
      const desk = drawnAtHalfSize(
        screen.getByRole("group", { name: "Drag to pick an area" }),
      );
      fireEvent.pointerDown(desk, { clientX: 60, clientY: 30 });
      fireEvent.pointerUp(desk, { clientX: 20, clientY: 45 });
      await userEvent.click(screen.getByRole("radio", { name: "drm-2" }));
      await userEvent.click(screen.getByRole("button", { name: "Share" }));

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [{ name: "drm-2", type: "monitor" }],
          },
        ],
      ]);
    });

    it("cannot be dragged when the application asks for no region", () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      host.push([
        screenCast(false, MONITORS, false, {
          desk: frozen(1, "screenshot").body,
        }),
      ]);

      expect(
        screen.queryByRole("group", { name: "Drag to pick an area" }),
      ).not.toBeInTheDocument();
    });

    describe("selected on screen", () => {
      it("is offered beside the desk shot", () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([
          screenCast(false, MONITORS, true, {
            desk: frozen(1, "screenshot").body,
          }),
        ]);

        expect(
          screen.getByRole("button", { name: "Select on screen" }),
        ).toBeInTheDocument();
      });

      it("shares the area selected", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([300, 200], [100, 50]);
        await userEvent.click(screen.getByRole("button", { name: "Share" }));

        expect(host.answers).toEqual([
          [
            5,
            {
              kind: "screen_cast",
              sources: [
                { position: [100, 50], size: [200, 150], type: "region" },
              ],
            },
          ],
        ]);
      });

      it("resizes the area by a corner", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([100, 50], [300, 200]);
        const corner = cornerOf("top-left");
        fireEvent.pointerDown(corner, { clientX: 100, clientY: 50 });
        fireEvent.pointerMove(corner, { clientX: 120, clientY: 40 });
        fireEvent.pointerUp(corner, { clientX: 120, clientY: 40 });
        await userEvent.click(screen.getByRole("button", { name: "Share" }));

        expect(host.answers).toEqual([
          [
            5,
            {
              kind: "screen_cast",
              sources: [
                { position: [120, 40], size: [180, 160], type: "region" },
              ],
            },
          ],
        ]);
      });

      it("moves the area dragged from inside it", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([100, 50], [300, 200]);
        const area = screen.getByRole("group", { name: "Selected area" });
        fireEvent.pointerDown(area, { clientX: 150, clientY: 100 });
        fireEvent.pointerMove(area, { clientX: 160, clientY: 130 });
        fireEvent.pointerUp(area, { clientX: 160, clientY: 130 });
        await userEvent.click(screen.getByRole("button", { name: "Share" }));

        expect(host.answers).toEqual([
          [
            5,
            {
              kind: "screen_cast",
              sources: [
                { position: [110, 80], size: [200, 150], type: "region" },
              ],
            },
          ],
        ]);
      });

      it("puts its buttons inside the area when there is no room below", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([100, 50], [300, window.innerHeight - 10]);

        expect(
          screen.getByRole("toolbar", { name: "Selected area" }),
        ).toHaveAttribute("data-inside");
      });

      it("goes back to the picker", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([300, 200], [100, 50]);
        await userEvent.click(screen.getByRole("button", { name: "Back" }));

        expect(
          await screen.findByRole("button", { name: "Select on screen" }),
        ).toBeInTheDocument();
        expect(host.answers).toEqual([]);
      });

      it("goes back to the picker on Escape", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        await userEvent.keyboard("{Escape}");

        expect(
          await screen.findByRole("button", { name: "Select on screen" }),
        ).toBeInTheDocument();
        expect(host.answers).toEqual([]);
      });

      it("cancels", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([300, 200], [100, 50]);
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(host.answers).toEqual([[5, { kind: "canceled" }]]);
      });

      it("selects nothing with a click", async () => {
        const host = new FakeHost();
        render(<PortalDialogs domicile={host.domicile} />);
        host.push([screenCast(false, MONITORS, true)]);
        await userEvent.click(
          screen.getByRole("button", { name: "Select on screen" }),
        );
        dragOnScreen([300, 200], [300, 200]);

        expect(
          screen.queryByRole("button", { name: "Share" }),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("cast to a TV", () => {
    const TV: CastTarget = {
      id: "tv",
      mode: { height: 1080, refreshMhz: 60_000, width: 1920 },
      name: "Living Room TV",
      unreachable: undefined,
    };

    /** A backend whose casts wait on the portal; the TV never answers. */
    const backend: CastBackend = {
      appId: "",
      send: () => new Promise(() => undefined),
      watchTargets: () => () => undefined,
    };

    const castRequest = (sources: readonly object[]) => ({
      ...screenCast(false, sources),
      app_id: "",
    });

    it("titles the picker for the TV a cast picks for", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      void casting(host.domicile).start(backend, TV, CastMode.Pick);
      await Promise.resolve();
      host.push([castRequest(MONITORS)]);

      expect(
        screen.getByRole("dialog", { name: "Cast to Living Room TV" }),
      ).not.toHaveTextContent("wants to record");
      expect(screen.getByRole("button", { name: "Cast" })).toBeInTheDocument();
    });

    it("answers an extended desk's request with its monitor, showing nothing", async () => {
      const host = new FakeHost();
      host.fake.set({
        displays: [
          {
            adaptiveSync: "unsupported",
            hdr: "unsupported",
            height: 1080,
            modeHeight: 1080,
            modeWidth: 1920,
            name: "drm-2",
            peakLuminance: 0,
            refreshMhz: 60_000,
            scale: 1,
            sdrWhite: 0,
            transform: "normal",
            width: 1920,
            x: 0,
            y: 0,
          },
        ],
      });
      const monitor = {
        addVirtual: () =>
          Promise.resolve(
            Ok<VirtualMonitor, SystemError>({
              ended: new Promise<never>(() => undefined),
              output: "drm-2",
              remove: () => undefined,
              resize: () => undefined,
            }),
          ),
      };
      const sent = Promise.withResolvers<void>();
      render(<PortalDialogs domicile={host.domicile} />);
      void casting(host.domicile, monitor).start(
        {
          ...backend,
          send: () => {
            sent.resolve();
            return new Promise(() => undefined);
          },
        },
        TV,
        CastMode.Extend,
      );
      await sent.promise;
      host.push([castRequest(MONITORS)]);

      expect(host.answers).toEqual([
        [
          5,
          {
            kind: "screen_cast",
            sources: [{ name: "drm-2", type: "monitor" }],
          },
        ],
      ]);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("leaves an application's request to its own picker", async () => {
      const host = new FakeHost();
      render(<PortalDialogs domicile={host.domicile} />);
      void casting(host.domicile).start(backend, TV, CastMode.Pick);
      await Promise.resolve();
      host.push([screenCast(false, MONITORS)]);

      expect(screen.getByRole("dialog")).toHaveTextContent("Share a screen");
    });
  });
});

const TWO_SCREENS = {
  displays: [
    { name: "left", position: [0, 0], scale: 1, size: [1920, 1080] },
    { name: "right", position: [1920, 0], scale: 1, size: [1920, 1080] },
  ],
  onDisplays: () => () => undefined,
} satisfies DisplaySource;

/** A directory watch stays open until the dialog releases it. */
const directoryWatch = (): Promise<Result<Watch, SystemError>> => {
  const stopped = Promise.withResolvers<Result<"stopped", SystemError>>();
  let controller: ReadableStreamDefaultController<Listened<string>>;
  const items = new ReadableStream<Listened<string>>({
    start: (opened) => {
      controller = opened;
    },
  });
  directoryWatches.push(stopped.promise);
  return Promise.resolve(
    Ok({
      ended: stopped.promise,
      items,
      stop: () => {
        controller.close();
        stopped.resolve(Ok("stopped"));
      },
    }),
  );
};
