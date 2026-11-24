import { describe, expect, it } from "bun:test";
import type { PortalHost } from "./desktop/portal-wire";
import {
  answerPortalRequest,
  discardRecording,
  pauseRecording,
  resumeRecording,
  stopCapturing,
  watchBoundShortcuts,
  watchCapturing,
  watchPortalRequests,
  watchPortalWallpaper,
} from "./desktop/portal-wire";
import type {
  BoundShortcut,
  Capturing,
  FrozenDesk,
  PortalRequest,
  PortalWallpaper,
} from "./portal";
import {
  Captured,
  CapturingKind,
  CastSource,
  ColorMode,
  FileChooserMode,
  hideFromCaptures,
  Inhibited,
  LauncherType,
  Orientation,
  PortalAnswer,
  PortalKind,
  PrintQuality,
  SHELL_APP_ID,
  Sides,
  WallpaperTarget,
} from "./portal";

/** A desktop that pushes `portal_requests` lines and records answers. */
class FakeHost implements PortalHost {
  readonly answers: [id: number, answer: unknown][] = [];
  readonly #listeners = new Set<(event: MessageEvent<string>) => void>();

  answerPortalRequest(id: number, answer: string): void {
    this.answers.push([id, JSON.parse(answer)]);
  }

  addEventListener(
    type: "portalrequests",
    listener: (event: MessageEvent<string>) => void,
  ): void {
    expect(type).toBe("portalrequests");
    this.#listeners.add(listener);
  }

  removeEventListener(
    type: "portalrequests",
    listener: (event: MessageEvent<string>) => void,
  ): void {
    expect(type).toBe("portalrequests");
    this.#listeners.delete(listener);
  }

  push(
    items: readonly object[],
    capturing?: readonly object[],
    shortcuts?: readonly object[],
    wallpaper?: object,
  ): void {
    const data = JSON.stringify({
      capturing,
      items,
      shortcuts,
      type: "portal_requests",
      wallpaper,
    });
    for (const listener of this.#listeners) {
      listener(new MessageEvent("portalrequests", { data }));
    }
  }
}

const watched = (host: FakeHost): Promise<readonly PortalRequest[]> =>
  new Promise((resolve) => {
    watchPortalRequests(host, resolve);
  });

describe("watchPortalRequests", () => {
  it("parses an access request's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.App",
        body: {
          body: "",
          destructive: true,
          grant_label: "Allow",
          subtitle: "Example wants to see you",
          title: "Use the camera?",
        },
        id: 1,
        kind: "access",
        parent_app_id: "app-3",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.App",
        body: {
          body: "",
          denyLabel: undefined,
          destructive: true,
          grantLabel: "Allow",
          subtitle: "Example wants to see you",
          title: "Use the camera?",
        },
        id: 1,
        kind: PortalKind.Access,
        parentAppId: "app-3",
      },
    ]);
  });

  it("parses an app chooser's body, absent fields as undefined", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.App",
        body: {
          choices: ["org.gnome.Evince", "firefox"],
          content_type: "application/pdf",
          filename: "report.pdf",
        },
        id: 4,
        kind: "app_chooser",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.App",
        body: {
          choices: ["org.gnome.Evince", "firefox"],
          contentType: "application/pdf",
          filename: "report.pdf",
          lastChoice: undefined,
          uri: undefined,
        },
        id: 4,
        kind: PortalKind.AppChooser,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a file chooser's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Editor",
        body: {
          choices: [
            {
              id: "encoding",
              initial: "utf8",
              label: "Encoding",
              options: [{ id: "utf8", label: "UTF-8" }],
            },
          ],
          current_filter: 0,
          current_folder: "/home/me",
          current_name: "notes.txt",
          directory: false,
          files: [],
          filters: [{ extensions: ["txt"], name: "Text" }],
          home: "/home/me",
          mode: "save",
          multiple: false,
          title: "Save As",
        },
        id: 4,
        kind: "file_chooser",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Editor",
        body: {
          acceptLabel: undefined,
          choices: [
            {
              id: "encoding",
              initial: "utf8",
              label: "Encoding",
              options: [{ id: "utf8", label: "UTF-8" }],
            },
          ],
          currentFilter: 0,
          currentFolder: "/home/me",
          currentName: "notes.txt",
          directory: false,
          files: [],
          filters: [{ extensions: ["txt"], name: "Text" }],
          home: "/home/me",
          mode: FileChooserMode.Save,
          multiple: false,
          title: "Save As",
        },
        id: 4,
        kind: PortalKind.FileChooser,
        parentAppId: undefined,
      },
    ]);
  });

  // GTK marks a label's access key with `_`, and writes a literal one as `__`.
  it("drops the access key marks from a file chooser's labels", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.gnome.SimpleScan",
        body: {
          accept_label: "_Save",
          choices: [
            {
              id: "mode",
              initial: "a",
              label: "_Scan__mode",
              options: [{ id: "a", label: "_All pages" }],
            },
          ],
          directory: false,
          files: [],
          filters: [],
          home: "/home/me",
          mode: "save",
          multiple: false,
          title: "Save As",
        },
        id: 5,
        kind: "file_chooser",
      },
    ]);

    expect(await requests).toMatchObject([
      {
        body: {
          acceptLabel: "Save",
          choices: [
            {
              label: "Scan_mode",
              options: [{ id: "a", label: "All pages" }],
            },
          ],
        },
      },
    ]);
  });

  it("parses an inhibitor's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Editor",
        body: { reason: "Unsaved changes", what: ["logout", "suspend"] },
        id: 5,
        kind: "inhibit",
      },
      {
        app_id: "org.example.Burner",
        body: { what: ["user_switch"] },
        id: 6,
        kind: "inhibit",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Editor",
        body: {
          reason: "Unsaved changes",
          what: [Inhibited.Logout, Inhibited.Suspend],
        },
        id: 5,
        kind: PortalKind.Inhibit,
        parentAppId: undefined,
      },
      {
        appId: "org.example.Burner",
        body: { reason: undefined, what: [Inhibited.UserSwitch] },
        id: 6,
        kind: PortalKind.Inhibit,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a remote desktop request's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Remote",
        body: { clipboard: true, devices: KEYBOARD_AND_POINTER },
        id: 3,
        kind: "remote_desktop",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Remote",
        body: {
          clipboard: true,
          devices: { keyboard: true, pointer: true, touchscreen: false },
        },
        id: 3,
        kind: PortalKind.RemoteDesktop,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses an agent's ask and the windows it offers", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "",
        body: {
          agent: "Claude Code",
          windows: [
            {
              app: "org.gnome.TextEditor",
              id: "t1",
              kind: "native",
              title: "Notes",
            },
            { id: "t2", kind: "browser", title: "Pull requests" },
          ],
        },
        id: 3,
        kind: "agent",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "",
        body: {
          agent: "Claude Code",
          current: undefined,
          remembered: false,
          windows: [
            {
              app: "org.gnome.TextEditor",
              browser: false,
              id: "t1",
              title: "Notes",
            },
            { app: undefined, browser: true, id: "t2", title: "Pull requests" },
          ],
        },
        id: 3,
        kind: PortalKind.Agent,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a change to an agent with what it reaches now", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "",
        body: {
          agent: "Claude Code",
          current: { type: "desk" },
          remembered: true,
          windows: [],
        },
        id: 3,
        kind: "agent",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "",
        body: {
          agent: "Claude Code",
          current: { kind: "desk" },
          remembered: true,
          windows: [],
        },
        id: 3,
        kind: PortalKind.Agent,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses an input capture request's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Barrier",
        body: { devices: KEYBOARD_AND_POINTER },
        id: 4,
        kind: "input_capture",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Barrier",
        body: {
          devices: { keyboard: true, pointer: true, touchscreen: false },
        },
        id: 4,
        kind: PortalKind.InputCapture,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses an account request, with or without a reason or picture", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Mail",
        body: {
          image: "/var/lib/AccountsService/icons/ada",
          name: "Ada Lovelace",
          reason: "To sign you in",
        },
        id: 1,
        kind: "account",
      },
      { app_id: "", body: { name: "ada" }, id: 2, kind: "account" },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Mail",
        body: {
          image: "/var/lib/AccountsService/icons/ada",
          name: "Ada Lovelace",
          reason: "To sign you in",
        },
        id: 1,
        kind: PortalKind.Account,
        parentAppId: undefined,
      },
      {
        appId: "",
        body: { image: undefined, name: "ada", reason: undefined },
        id: 2,
        kind: PortalKind.Account,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a global shortcuts review's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.App",
        body: {
          shortcuts: [
            { description: "Push to talk", id: "talk", trigger: "CTRL+t" },
            { description: "Mute", id: "mute" },
          ],
          taken: [{ app_id: "org.example.Other", chord: "Ctrl+Alt+m" }],
        },
        id: 4,
        kind: "global_shortcuts",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.App",
        body: {
          shortcuts: [
            { description: "Push to talk", id: "talk", trigger: "CTRL+t" },
            { description: "Mute", id: "mute", trigger: undefined },
          ],
          taken: [{ appId: "org.example.Other", chord: "Ctrl+Alt+m" }],
        },
        id: 4,
        kind: PortalKind.GlobalShortcuts,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a wallpaper preview's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Photos",
        body: { path: "/home/u/sky.jpg", set_on: "lockscreen" },
        id: 4,
        kind: "wallpaper",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Photos",
        body: { path: "/home/u/sky.jpg", setOn: WallpaperTarget.Lockscreen },
        id: 4,
        kind: PortalKind.Wallpaper,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a launcher install's body", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Browser",
        body: {
          editable_name: true,
          icon: "data:image/png;base64,iVBORw==",
          launcher_type: "webapp",
          name: "Mail",
          target: "https://mail.example.com",
        },
        id: 7,
        kind: "dynamic_launcher",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Browser",
        body: {
          editableName: true,
          icon: "data:image/png;base64,iVBORw==",
          launcherType: LauncherType.Webapp,
          name: "Mail",
          target: "https://mail.example.com",
        },
        id: 7,
        kind: PortalKind.DynamicLauncher,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a screen cast request's sources", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "us.zoom.Zoom",
        body: {
          browser_windows: true,
          desk: {
            desk: { position: [0, 0], size: [1920, 1080] },
            frame: "data:image/png;base64,AA==",
            height: 1080,
            monitors: [
              {
                area: { height: 1080, width: 1920, x: 0, y: 0 },
                description: "",
                name: "drm-1",
              },
            ],
            width: 1920,
            windows: [],
          },
          multiple: true,
          region: true,
          sources: [
            {
              app_id: "org.gnome.TextEditor",
              id: "app-3",
              title: "Notes",
              type: "window",
            },
            { app_id: "", id: "app-4", title: "", type: "window" },
            {
              description: "Dell Inc. DELL U3219Q",
              name: "drm-1",
              size: [1920, 1080],
              type: "monitor",
            },
          ],
        },
        id: 4,
        kind: "screen_cast",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "us.zoom.Zoom",
        body: {
          browserWindows: true,
          desk: {
            desk: { position: [0, 0], size: [1920, 1080] },
            frame: "data:image/png;base64,AA==",
            height: 1080,
            monitors: [
              {
                area: { height: 1080, width: 1920, x: 0, y: 0 },
                description: "",
                name: "drm-1",
              },
            ],
            width: 1920,
            windows: [],
          },
          multiple: true,
          region: true,
          sources: [
            CastSource.Window({
              appId: "org.gnome.TextEditor",
              id: "app-3",
              title: "Notes",
            }),
            CastSource.Window({ appId: "", id: "app-4", title: "" }),
            CastSource.Monitor({
              description: "Dell Inc. DELL U3219Q",
              name: "drm-1",
              size: [1920, 1080],
            }),
          ],
        },
        id: 4,
        kind: PortalKind.ScreenCast,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a USB grant's devices", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Keys",
        body: {
          devices: [
            { id: "dev-1", vendor: "Yubico.com", writable: true },
            { id: "dev-2", writable: false },
          ],
        },
        id: 8,
        kind: "usb",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Keys",
        body: {
          devices: [
            {
              id: "dev-1",
              product: undefined,
              vendor: "Yubico.com",
              writable: true,
            },
            {
              id: "dev-2",
              product: undefined,
              vendor: undefined,
              writable: false,
            },
          ],
        },
        id: 8,
        kind: PortalKind.Usb,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a print dialog's printers, their options and Save to PDF", async () => {
    const pdf = {
      color_modes: [],
      copies_max: 1,
      description: "Save to PDF",
      initial: { copies: 1, media: "na_letter_8.5x11in", pages: [] },
      media: [{ label: "Letter (8.5 × 11 in)", name: "na_letter_8.5x11in" }],
      name: "pdf",
      orientations: ["portrait", "landscape"],
      page_ranges: true,
      qualities: [],
      sides: [],
    };
    const parsedPdf = {
      colorModes: [],
      copiesMax: 1,
      description: "Save to PDF",
      initial: {
        colorMode: undefined,
        copies: 1,
        media: "na_letter_8.5x11in",
        orientation: undefined,
        pages: [],
        quality: undefined,
        sides: undefined,
      },
      media: [{ label: "Letter (8.5 × 11 in)", name: "na_letter_8.5x11in" }],
      name: "pdf",
      orientations: [Orientation.Portrait, Orientation.Landscape],
      pageRanges: true,
      qualities: [],
      sides: [],
    };
    const host = new FakeHost();
    const requests = watched(host);
    host.push([
      {
        app_id: "org.example.Editor",
        body: {
          home: "/home/u",
          pdf,
          printer: "office",
          printers: [
            {
              color_modes: ["color", "monochrome"],
              copies_max: 99,
              description: "Office laser",
              initial: {
                color_mode: "monochrome",
                copies: 1,
                media: "iso_a4_210x297mm",
                orientation: "reverse_landscape",
                pages: [{ first: 1, last: 3 }],
                quality: "high",
                sides: "two_sided_short_edge",
              },
              media: [{ label: "A4 (210 × 297 mm)", name: "iso_a4_210x297mm" }],
              name: "office",
              orientations: ["portrait", "landscape"],
              page_ranges: true,
              qualities: ["draft", "normal"],
              sides: ["one_sided", "two_sided_long_edge"],
            },
          ],
          title: "Report",
        },
        id: 1,
        kind: "print",
      },
      {
        app_id: "",
        body: { home: "/home/u", pdf, printers: [], title: "Report" },
        id: 2,
        kind: "print",
      },
    ]);

    expect(await requests).toEqual([
      {
        appId: "org.example.Editor",
        body: {
          acceptLabel: undefined,
          home: "/home/u",
          pdf: parsedPdf,
          printer: "office",
          printers: [
            {
              colorModes: [ColorMode.Color, ColorMode.Monochrome],
              copiesMax: 99,
              description: "Office laser",
              initial: {
                colorMode: ColorMode.Monochrome,
                copies: 1,
                media: "iso_a4_210x297mm",
                orientation: Orientation.ReverseLandscape,
                pages: [{ first: 1, last: 3 }],
                quality: PrintQuality.High,
                sides: Sides.TwoSidedShortEdge,
              },
              media: [{ label: "A4 (210 × 297 mm)", name: "iso_a4_210x297mm" }],
              name: "office",
              orientations: [Orientation.Portrait, Orientation.Landscape],
              pageRanges: true,
              qualities: [PrintQuality.Draft, PrintQuality.Normal],
              sides: [Sides.OneSided, Sides.TwoSidedLongEdge],
            },
          ],
          title: "Report",
        },
        id: 1,
        kind: PortalKind.Print,
        parentAppId: undefined,
      },
      {
        appId: "",
        body: {
          acceptLabel: undefined,
          home: "/home/u",
          pdf: parsedPdf,
          printer: undefined,
          printers: [],
          title: "Report",
        },
        id: 2,
        kind: PortalKind.Print,
        parentAppId: undefined,
      },
    ]);
  });

  it("parses a screenshot picker and a color picker over a frozen desk", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    const desk = {
      desk: { position: [-10, 0], size: [150, 50] },
      frame: "data:image/png;base64,AA==",
      height: 100,
      monitors: [
        {
          area: { height: 100, width: 300, x: 0, y: 0 },
          description: "BOE NE135A1M-NY1",
          name: "DP-1",
        },
      ],
      width: 300,
      windows: [{ app_id: "kitty", id: "app-3", title: "~/src" }],
    };
    host.push([
      { app_id: "org.example.Shot", body: desk, id: 5, kind: "screenshot" },
      { app_id: "org.example.Shot", body: desk, id: 6, kind: "pick_color" },
    ]);

    const frozen: FrozenDesk = {
      desk: { position: [-10, 0], size: [150, 50] },
      frame: "data:image/png;base64,AA==",
      height: 100,
      monitors: [
        {
          area: { height: 100, width: 300, x: 0, y: 0 },
          description: "BOE NE135A1M-NY1",
          name: "DP-1",
        },
      ],
      width: 300,
      windows: [{ appId: "kitty", id: "app-3", title: "~/src" }],
    };
    expect(await requests).toEqual([
      {
        appId: "org.example.Shot",
        body: frozen,
        id: 5,
        kind: PortalKind.Screenshot,
        parentAppId: undefined,
      },
      {
        appId: "org.example.Shot",
        body: frozen,
        id: 6,
        kind: PortalKind.PickColor,
        parentAppId: undefined,
      },
    ]);
  });

  it("keeps a kind it does not know, to be refused", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([{ app_id: "", body: { x: 1 }, id: 2, kind: "wobble" }]);

    expect(await requests).toEqual([
      {
        appId: "",
        id: 2,
        kind: PortalKind.Unknown,
        parentAppId: undefined,
        wireKind: "wobble",
      },
    ]);
  });

  it("knows no kind by an object's own property names", async () => {
    const host = new FakeHost();
    const requests = watched(host);
    host.push([{ app_id: "", body: {}, id: 2, kind: "constructor" }]);

    expect((await requests)[0]?.kind).toBe(PortalKind.Unknown);
  });

  it("throws on a known kind whose body does not parse", () => {
    const host = new FakeHost();
    watchPortalRequests(host, () => {
      /* no-op */
    });

    expect(() => {
      host.push([{ app_id: "", body: { title: 7 }, id: 3, kind: "access" }]);
    }).toThrow();
  });

  it("stops listening when the returned function is called", () => {
    const host = new FakeHost();
    const heard: (readonly PortalRequest[])[] = [];
    const stop = watchPortalRequests(host, (requests) => {
      heard.push(requests);
    });
    stop();
    host.push([]);

    expect(heard).toEqual([]);
  });
});

describe("watchCapturing", () => {
  const capturing = (host: FakeHost): Promise<readonly Capturing[]> =>
    new Promise((resolve) => {
      watchCapturing(host, resolve);
    });

  it("parses an agent's session and what it did", async () => {
    const host = new FakeHost();
    const sessions = capturing(host);
    host.push(
      [],
      [
        {
          app_id: "",
          body: {
            actions: [{ at_ms: 7, said: "Read Notes" }],
            agent: "Claude Code",
            reach: {
              type: "windows",
              windows: [{ id: "t1", kind: "native", title: "Notes" }],
            },
          },
          id: 5,
          kind: "agent",
        },
      ],
    );

    expect(await sessions).toEqual([
      {
        actions: [{ atMs: 7, said: "Read Notes" }],
        agent: "Claude Code",
        appId: "",
        id: 5,
        kind: CapturingKind.Agent,
        reach: {
          kind: "windows",
          windows: [
            { app: undefined, browser: false, id: "t1", title: "Notes" },
          ],
        },
      },
    ]);
  });

  it("parses each session", async () => {
    const host = new FakeHost();
    const sessions = capturing(host);
    host.push(
      [],
      [
        {
          app_id: "org.example.Remote",
          body: { clipboard: false, devices: KEYBOARD_AND_POINTER },
          id: 5,
          kind: "remote_desktop",
        },
        {
          app_id: "org.example.Barrier",
          body: { devices: KEYBOARD_AND_POINTER },
          id: 6,
          kind: "input_capture",
        },
        { app_id: "", body: {}, id: 7, kind: "screenshot" },
      ],
    );

    expect(await sessions).toEqual([
      {
        appId: "org.example.Remote",
        clipboard: false,
        devices: { keyboard: true, pointer: true, touchscreen: false },
        id: 5,
        kind: CapturingKind.RemoteDesktop,
      },
      {
        appId: "org.example.Barrier",
        devices: { keyboard: true, pointer: true, touchscreen: false },
        id: 6,
        kind: CapturingKind.InputCapture,
      },
      {
        appId: "",
        id: 7,
        kind: CapturingKind.Unknown,
        wireKind: "screenshot",
      },
    ]);
  });

  it("parses what a screen cast records", async () => {
    const host = new FakeHost();
    const sessions = new Promise<readonly Capturing[]>((resolve) => {
      watchCapturing(host, resolve);
    });
    host.push(
      [],
      [
        {
          app_id: "us.zoom.Zoom",
          body: {
            sources: [
              {
                app_id: "org.gnome.TextEditor",
                id: "app-3",
                title: "Notes",
                type: "window",
              },
              { id: "7", title: "Meet", type: "browser_window" },
              {
                description: "BOE NE135A1M-NY1",
                name: "drm-1",
                type: "monitor",
              },
              { type: "desk" },
              {
                monitor: { description: "", name: "drm-2" },
                position: [10, -20],
                size: [300, 200],
                type: "region",
              },
              { position: [-500, 0], size: [300, 200], type: "region" },
            ],
          },
          id: 5,
          kind: "screen_cast",
        },
      ],
    );

    expect(await sessions).toEqual([
      {
        appId: "us.zoom.Zoom",
        id: 5,
        kind: CapturingKind.ScreenCast,
        sources: [
          Captured.Window({
            appId: "org.gnome.TextEditor",
            id: "app-3",
            title: "Notes",
          }),
          Captured.BrowserWindow({ id: "7", title: "Meet" }),
          Captured.Monitor({ description: "BOE NE135A1M-NY1", name: "drm-1" }),
          Captured.Desk(),
          Captured.Region({
            monitor: { description: "", name: "drm-2" },
            position: [10, -20],
            size: [300, 200],
          }),
          Captured.Region({
            monitor: undefined,
            position: [-500, 0],
            size: [300, 200],
          }),
        ],
      },
    ]);
  });

  it("parses a screen recording, paused and running", async () => {
    const host = new FakeHost();
    const sessions = new Promise<readonly Capturing[]>((resolve) => {
      watchCapturing(host, resolve);
    });
    const recording = {
      file: "/home/me/Videos/Screen recordings/a.webm",
      recorded_ms: 2500,
      sources: [{ description: "Dell U3219Q", name: "drm-1", type: "monitor" }],
    };
    host.push(
      [],
      [
        {
          app_id: SHELL_APP_ID,
          body: { ...recording, running_since_ms: 9000 },
          id: 5,
          kind: "recording",
        },
        { app_id: SHELL_APP_ID, body: recording, id: 6, kind: "recording" },
      ],
    );

    expect(await sessions).toEqual([
      {
        appId: SHELL_APP_ID,
        file: "/home/me/Videos/Screen recordings/a.webm",
        id: 5,
        kind: CapturingKind.Recording,
        recordedMs: 2500,
        runningSinceMs: 9000,
        sources: [
          Captured.Monitor({ description: "Dell U3219Q", name: "drm-1" }),
        ],
      },
      {
        appId: SHELL_APP_ID,
        file: "/home/me/Videos/Screen recordings/a.webm",
        id: 6,
        kind: CapturingKind.Recording,
        recordedMs: 2500,
        runningSinceMs: undefined,
        sources: [
          Captured.Monitor({ description: "Dell U3219Q", name: "drm-1" }),
        ],
      },
    ]);
  });

  it("reads a push without sessions as none", async () => {
    const host = new FakeHost();
    const sessions = capturing(host);
    host.push([]);

    expect(await sessions).toEqual([]);
  });

  it("stops listening when the returned function is called", () => {
    const host = new FakeHost();
    const heard: (readonly Capturing[])[] = [];
    const stop = watchCapturing(host, (sessions) => {
      heard.push(sessions);
    });
    stop();
    host.push([]);

    expect(heard).toEqual([]);
  });
});

describe("watchBoundShortcuts", () => {
  it("parses the chords applications hold, none when absent", async () => {
    const host = new FakeHost();
    const heard: (readonly BoundShortcut[])[] = [];
    const both = new Promise<void>((resolve) => {
      watchBoundShortcuts(host, (shortcuts) => {
        heard.push(shortcuts);
        if (heard.length === 2) {
          resolve();
        }
      });
    });
    host.push([], undefined, [
      { app_id: "org.example.App", chord: "Ctrl+Alt+t", id: 3 },
    ]);
    host.push([]);
    await both;

    expect(heard).toEqual([
      [{ appId: "org.example.App", chord: "Ctrl+Alt+t", id: 3 }],
      [],
    ]);
  });
});

describe("watchPortalWallpaper", () => {
  const wallpaper = (host: FakeHost): Promise<PortalWallpaper> =>
    new Promise((resolve) => {
      watchPortalWallpaper(host, resolve);
    });

  it("reads the pictures applications set", async () => {
    const host = new FakeHost();
    const heard = wallpaper(host);
    host.push([], undefined, undefined, {
      background: "/state/background-1.jpg",
    });

    expect(await heard).toEqual({
      background: "/state/background-1.jpg",
      lockscreen: undefined,
    });
  });

  it("reads none set when the line has no wallpaper", async () => {
    const host = new FakeHost();
    const heard = wallpaper(host);
    host.push([]);

    expect(await heard).toEqual({
      background: undefined,
      lockscreen: undefined,
    });
  });
});

describe("answerPortalRequest", () => {
  it("writes each answer as the compositor reads it", () => {
    const host = new FakeHost();
    answerPortalRequest(host, 1, PortalAnswer.Access());
    answerPortalRequest(host, 2, PortalAnswer.Canceled());
    answerPortalRequest(host, 3, PortalAnswer.Refused());
    answerPortalRequest(host, 4, PortalAnswer.AppChooser("firefox"));
    answerPortalRequest(host, 7, PortalAnswer.DynamicLauncher("Work mail"));
    answerPortalRequest(
      host,
      5,
      PortalAnswer.FileChooser({
        choices: new Map([["encoding", "utf8"]]),
        currentFilter: 1,
        paths: ["/home/me/a.txt"],
      }),
    );
    answerPortalRequest(
      host,
      6,
      PortalAnswer.FileChooser({
        choices: new Map(),
        currentFilter: undefined,
        paths: ["/home/me"],
      }),
    );

    answerPortalRequest(
      host,
      7,
      PortalAnswer.RemoteDesktop(
        { keyboard: true, pointer: false, touchscreen: false },
        true,
      ),
    );
    answerPortalRequest(host, 8, PortalAnswer.InputCapture());
    answerPortalRequest(
      host,
      9,
      PortalAnswer.GlobalShortcuts([
        { id: "talk", trigger: "Ctrl+Alt+t" },
        { id: "mute", trigger: undefined },
      ]),
    );
    answerPortalRequest(
      host,
      10,
      PortalAnswer.Screenshot({ height: 4, width: 3, x: 1, y: 2 }, false),
    );
    answerPortalRequest(host, 11, PortalAnswer.PickColor({ x: 5, y: 6 }));
    answerPortalRequest(host, 12, PortalAnswer.ScreenshotWindow("app-3", true));
    answerPortalRequest(
      host,
      13,
      PortalAnswer.ScreenshotBrowserWindow("1", false),
    );
    answerPortalRequest(host, 15, PortalAnswer.Agent({ kind: "desk" }, true));
    answerPortalRequest(host, 17, PortalAnswer.Change());
    answerPortalRequest(
      host,
      16,
      PortalAnswer.Agent({
        kind: "windows",
        windows: [
          { app: undefined, browser: true, id: "t2", title: "Pull requests" },
        ],
      }),
    );
    answerPortalRequest(
      host,
      14,
      PortalAnswer.ScreenshotWindow("app-3", false, {
        height: 4,
        width: 3,
        x: 1,
        y: 2,
      }),
    );

    expect(host.answers).toEqual([
      [1, { kind: "access" }],
      [2, { kind: "canceled" }],
      [3, { kind: "refused" }],
      [4, { choice: "firefox", kind: "app_chooser" }],
      [7, { kind: "dynamic_launcher", name: "Work mail" }],
      [
        5,
        {
          choices: { encoding: "utf8" },
          current_filter: 1,
          kind: "file_chooser",
          paths: ["/home/me/a.txt"],
        },
      ],
      [6, { choices: {}, kind: "file_chooser", paths: ["/home/me"] }],
      [
        7,
        {
          clipboard: true,
          devices: { keyboard: true, pointer: false, touchscreen: false },
          kind: "remote_desktop",
        },
      ],
      [8, { kind: "input_capture" }],
      [
        9,
        {
          kind: "global_shortcuts",
          triggers: [{ id: "talk", trigger: "Ctrl+Alt+t" }, { id: "mute" }],
        },
      ],
      [
        10,
        {
          area: { height: 4, width: 3, x: 1, y: 2 },
          copy: false,
          kind: "screenshot",
        },
      ],
      [11, { kind: "pick_color", x: 5, y: 6 }],
      [12, { copy: true, id: "app-3", kind: "screenshot_window" }],
      [13, { copy: false, id: "1", kind: "screenshot_browser_window" }],
      [15, { kind: "agent", reach: { type: "desk" }, remember: true }],
      [17, { kind: "change" }],
      [
        16,
        {
          kind: "agent",
          reach: {
            type: "windows",
            windows: [{ id: "t2", kind: "browser", title: "Pull requests" }],
          },
        },
      ],
      [
        14,
        {
          area: { height: 4, width: 3, x: 1, y: 2 },
          copy: false,
          id: "app-3",
          kind: "screenshot_window",
        },
      ],
    ]);
  });

  it("writes the sources picked for a screen cast", () => {
    const host = new FakeHost();
    answerPortalRequest(
      host,
      4,
      PortalAnswer.ScreenCast([
        CastSource.Window({ appId: "", id: "app-3", title: "Notes" }),
        CastSource.BrowserWindow({ id: "7", title: "Meet" }),
        CastSource.BrowserWindow({
          area: { height: 4, width: 3, x: 1, y: 2 },
          id: "8",
          title: "Docs",
        }),
        CastSource.Monitor({
          description: "",
          name: "drm-1",
          size: [1920, 1080],
        }),
        CastSource.Region({ position: [10, -20], size: [300, 200] }),
      ]),
    );

    expect(host.answers).toEqual([
      [
        4,
        {
          kind: "screen_cast",
          sources: [
            { id: "app-3", type: "window" },
            { id: "7", title: "Meet", type: "browser_window" },
            {
              area: { height: 4, width: 3, x: 1, y: 2 },
              id: "8",
              title: "Docs",
              type: "browser_window",
            },
            { name: "drm-1", type: "monitor" },
            { position: [10, -20], size: [300, 200], type: "region" },
          ],
        },
      ],
    ]);
  });
});

describe("answerPortalRequest for a print dialog", () => {
  it("writes the printer and options, leaving out the printer's defaults", () => {
    const host = new FakeHost();
    answerPortalRequest(
      host,
      1,
      PortalAnswer.Print("office", {
        colorMode: ColorMode.Color,
        copies: 2,
        media: "na_letter_8.5x11in",
        orientation: Orientation.Portrait,
        pages: [{ first: 2, last: 2 }],
        quality: PrintQuality.Draft,
        sides: Sides.OneSided,
      }),
    );
    answerPortalRequest(
      host,
      2,
      PortalAnswer.Print("label", {
        colorMode: undefined,
        copies: 1,
        media: undefined,
        orientation: undefined,
        pages: [],
        quality: undefined,
        sides: undefined,
      }),
    );

    expect(host.answers).toEqual([
      [
        1,
        {
          kind: "print",
          options: {
            color_mode: "color",
            copies: 2,
            media: "na_letter_8.5x11in",
            orientation: "portrait",
            pages: [{ first: 2, last: 2 }],
            quality: "draft",
            sides: "one_sided",
          },
          printer: "office",
        },
      ],
      [
        2,
        { kind: "print", options: { copies: 1, pages: [] }, printer: "label" },
      ],
    ]);
  });

  it("writes a PDF's path and options", () => {
    const host = new FakeHost();
    answerPortalRequest(
      host,
      1,
      PortalAnswer.SaveToPdf("/home/u/Report.pdf", {
        colorMode: undefined,
        copies: 1,
        media: "iso_a4_210x297mm",
        orientation: Orientation.Landscape,
        pages: [],
        quality: undefined,
        sides: undefined,
      }),
    );

    expect(host.answers).toEqual([
      [
        1,
        {
          kind: "save_to_pdf",
          options: {
            copies: 1,
            media: "iso_a4_210x297mm",
            orientation: "landscape",
            pages: [],
          },
          path: "/home/u/Report.pdf",
        },
      ],
    ]);
  });
});

describe("stopCapturing", () => {
  it("answers the session with a stop", () => {
    const host = new FakeHost();
    stopCapturing(host, 5);

    expect(host.answers).toEqual([[5, { kind: "stop" }]]);
  });
});

describe("a recording's controls", () => {
  it("pause, resume and discard it", () => {
    const host = new FakeHost();
    pauseRecording(host, 5);
    resumeRecording(host, 5);
    discardRecording(host, 5);

    expect(host.answers).toEqual([
      [5, { kind: "pause" }],
      [5, { kind: "resume" }],
      [5, { kind: "discard" }],
    ]);
  });
});

describe("hideFromCaptures", () => {
  it("makes the element a restriction target", async () => {
    const marked: unknown[] = [];
    const element = { tagName: "DIV" } as unknown as Element;
    await hideFromCaptures(element, {
      fromElement: (target) => {
        marked.push(target);
        return Promise.resolve({});
      },
    });

    expect(marked).toEqual([element]);
  });

  it("does nothing where there is no Element Capture", async () => {
    await hideFromCaptures({} as Element, undefined);
  });
});

const KEYBOARD_AND_POINTER = {
  keyboard: true,
  pointer: true,
  touchscreen: false,
};
