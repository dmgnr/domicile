// The wire side of portal dialogs: the compositor's `portal_requests` pushes,
// parsed, and the answers, serialized. Not exported from the SDK; a shell
// reaches these through `domicile.portals`. See docs/PORTALS.md.

import { z } from "zod";

import type { DomicileHost } from "../domicile-host";
import type {
  AccessBody,
  AccountBody,
  AgentBody,
  AgentReach,
  AgentSessionBody,
  AgentWindow,
  AppChooserBody,
  BoundShortcut,
  CapturingBase,
  FileChooserBody,
  InhibitBody,
  LauncherBody,
  PortalRequestBase,
  PortalWallpaper,
  PrintBody,
  Printer,
  PrintOptions,
  RecordingBody,
  ScreenCastBody,
  ShortcutsBody,
  ShotRect,
  UsbBody,
  WallpaperBody,
} from "../portal";
import {
  Captured,
  Capturing,
  CastSource,
  CastSourceKind,
  ColorMode,
  FileChooserMode,
  Inhibited,
  LauncherType,
  Orientation,
  PortalAnswer,
  PortalAnswerKind,
  PortalRequest,
  PrintQuality,
  Sides,
  WallpaperTarget,
} from "../portal";

/** What the portal functions need of the desktop `Shell` is handed. */
export type PortalHost = Pick<DomicileHost, "answerPortalRequest"> & {
  addEventListener: (
    type: "portalrequests",
    listener: (event: MessageEvent<string>) => void,
  ) => void;
  removeEventListener: (
    type: "portalrequests",
    listener: (event: MessageEvent<string>) => void,
  ) => void;
};

/**
 * Call `listener` with every unanswered request, oldest first, on each change.
 * Returns a function that stops listening. Throws on a request of a known kind
 * whose body does not parse: the compositor and this SDK disagree.
 */
export const watchPortalRequests = (
  host: PortalHost,
  listener: (requests: readonly PortalRequest[]) => void,
): (() => void) =>
  watch(host, (message) => {
    listener(message.items.map((item) => parseRequest(item)));
  });

/**
 * Call `listener` with every chord applications hold through the
 * GlobalShortcuts portal, on each push. Returns a function that stops
 * listening.
 */
export const watchBoundShortcuts = (
  host: PortalHost,
  listener: (shortcuts: readonly BoundShortcut[]) => void,
): (() => void) =>
  watch(host, (message) => {
    listener(
      (message.shortcuts ?? []).map((bound) => ({
        appId: bound.app_id,
        chord: bound.chord,
        id: bound.id,
      })),
    );
  });

/**
 * Call `listener` with every session that controls or captures input, on each
 * change. Returns a function that stops listening.
 */
export const watchCapturing = (
  host: PortalHost,
  listener: (sessions: readonly Capturing[]) => void,
): (() => void) => {
  const heard = (event: MessageEvent<string>) => {
    listener(
      requestsSchema
        .parse(JSON.parse(event.data))
        .capturing.map((item) => parseCapturing(item)),
    );
  };
  host.addEventListener("portalrequests", heard);
  return () => {
    host.removeEventListener("portalrequests", heard);
  };
};

/**
 * Call `listener` with the pictures applications set through the Wallpaper
 * portal, on each push. Returns a function that stops listening.
 */
export const watchPortalWallpaper = (
  host: PortalHost,
  listener: (wallpaper: PortalWallpaper) => void,
): (() => void) => {
  const heard = (event: MessageEvent<string>) => {
    listener(requestsSchema.parse(JSON.parse(event.data)).wallpaper);
  };
  host.addEventListener("portalrequests", heard);
  return () => {
    host.removeEventListener("portalrequests", heard);
  };
};

/** Answer request `id`. The first answer to reach the compositor wins. */
export const answerPortalRequest = (
  host: PortalHost,
  id: number,
  answer: PortalAnswer,
): void => {
  host.answerPortalRequest(id, JSON.stringify(wireAnswer(answer)));
};

/** End capturing session `id`. */
export const stopCapturing = (host: PortalHost, id: number): void => {
  answerPortalRequest(host, id, PortalAnswer.Stop());
};

/** Ask the user again what agent session `id` reaches. */
export const changeAgent = (host: PortalHost, id: number): void => {
  answerPortalRequest(host, id, PortalAnswer.Change());
};

/** Pause recording `id`. Its file leaves the pause out. */
export const pauseRecording = (host: PortalHost, id: number): void => {
  answerPortalRequest(host, id, PortalAnswer.Pause());
};

/** Resume paused recording `id`. */
export const resumeRecording = (host: PortalHost, id: number): void => {
  answerPortalRequest(host, id, PortalAnswer.Resume());
};

/** Stop recording `id` and delete its file. */
export const discardRecording = (host: PortalHost, id: number): void => {
  answerPortalRequest(host, id, PortalAnswer.Discard());
};

/** Each `portal_requests` push, parsed. */
const watch = (
  host: PortalHost,
  listener: (message: z.infer<typeof requestsSchema>) => void,
): (() => void) => {
  const heard = (event: MessageEvent<string>) => {
    listener(requestsSchema.parse(JSON.parse(event.data)));
  };
  host.addEventListener("portalrequests", heard);
  return () => {
    host.removeEventListener("portalrequests", heard);
  };
};

const accessSchema = z
  .object({
    body: z.string(),
    deny_label: z.string().optional(),
    destructive: z.boolean(),
    grant_label: z.string().optional(),
    subtitle: z.string(),
    title: z.string(),
  })
  .transform(
    (body): AccessBody => ({
      body: body.body,
      denyLabel: body.deny_label,
      destructive: body.destructive,
      grantLabel: body.grant_label,
      subtitle: body.subtitle,
      title: body.title,
    }),
  );

const appChooserSchema = z
  .object({
    choices: z.array(z.string()),
    content_type: z.string().optional(),
    filename: z.string().optional(),
    last_choice: z.string().optional(),
    uri: z.string().optional(),
  })
  .transform(
    (body): AppChooserBody => ({
      choices: body.choices,
      contentType: body.content_type,
      filename: body.filename,
      lastChoice: body.last_choice,
      uri: body.uri,
    }),
  );

const fileChooserSchema = z
  .object({
    accept_label: z.string().optional(),
    choices: z.array(
      z.object({
        id: z.string(),
        initial: z.string(),
        label: z.string(),
        options: z.array(z.object({ id: z.string(), label: z.string() })),
      }),
    ),
    current_filter: z.number().optional(),
    current_folder: z.string().optional(),
    current_name: z.string().optional(),
    directory: z.boolean(),
    files: z.array(z.string()),
    filters: z.array(
      z.object({ extensions: z.array(z.string()), name: z.string() }),
    ),
    home: z.string(),
    mode: z.enum(["open", "save", "save_files"]),
    multiple: z.boolean(),
    title: z.string(),
  })
  .transform(
    (body): FileChooserBody => ({
      acceptLabel:
        body.accept_label === undefined
          ? undefined
          : withoutAccessKeys(body.accept_label),
      choices: body.choices.map((choice) => ({
        ...choice,
        label: withoutAccessKeys(choice.label),
        options: choice.options.map((option) => ({
          ...option,
          label: withoutAccessKeys(option.label),
        })),
      })),
      currentFilter: body.current_filter,
      currentFolder: body.current_folder,
      currentName: body.current_name,
      directory: body.directory,
      files: body.files,
      filters: body.filters,
      home: body.home,
      mode: chooserMode(body.mode),
      multiple: body.multiple,
      title: body.title,
    }),
  );

const INHIBITED = {
  logout: Inhibited.Logout,
  suspend: Inhibited.Suspend,
  user_switch: Inhibited.UserSwitch,
} as const;

const inhibitSchema = z
  .object({
    reason: z.string().optional(),
    what: z.array(z.enum(["logout", "user_switch", "suspend"])),
  })
  .transform(
    (body): InhibitBody => ({
      reason: body.reason,
      what: body.what.map((inhibited) => INHIBITED[inhibited]),
    }),
  );

const devicesSchema = z.object({
  keyboard: z.boolean(),
  pointer: z.boolean(),
  touchscreen: z.boolean(),
});

const remoteDesktopSchema = z.object({
  clipboard: z.boolean(),
  devices: devicesSchema,
});

const inputCaptureSchema = z.object({ devices: devicesSchema });

const accountSchema = z
  .object({
    image: z.string().optional(),
    name: z.string(),
    reason: z.string().optional(),
  })
  .transform(
    (body): AccountBody => ({
      image: body.image,
      name: body.name,
      reason: body.reason,
    }),
  );
const pairSchema = z.tuple([z.number(), z.number()]);

const castSourceSchema = z
  .discriminatedUnion("type", [
    z.object({
      app_id: z.string(),
      id: z.string(),
      title: z.string(),
      type: z.literal("window"),
    }),
    z.object({
      description: z.string(),
      name: z.string(),
      size: pairSchema,
      type: z.literal("monitor"),
    }),
  ])
  .transform((source) => {
    switch (source.type) {
      case "window":
        return CastSource.Window({
          appId: source.app_id,
          id: source.id,
          title: source.title,
        });
      case "monitor":
        return CastSource.Monitor({
          description: source.description,
          name: source.name,
          size: source.size,
        });
    }
  });

const capturedMonitorSchema = z.object({
  description: z.string(),
  name: z.string(),
});

const capturedSchema = z
  .discriminatedUnion("type", [
    z.object({
      app_id: z.string(),
      id: z.string(),
      title: z.string(),
      type: z.literal("window"),
    }),
    z.object({
      id: z.string(),
      title: z.string(),
      type: z.literal("browser_window"),
    }),
    capturedMonitorSchema.extend({ type: z.literal("monitor") }),
    z.object({ type: z.literal("desk") }),
    z.object({
      monitor: capturedMonitorSchema.optional(),
      position: pairSchema,
      size: pairSchema,
      type: z.literal("region"),
    }),
  ])
  .transform((source) => {
    switch (source.type) {
      case "window":
        return Captured.Window({
          appId: source.app_id,
          id: source.id,
          title: source.title,
        });
      case "browser_window":
        return Captured.BrowserWindow({ id: source.id, title: source.title });
      case "monitor":
        return Captured.Monitor({
          description: source.description,
          name: source.name,
        });
      case "desk":
        return Captured.Desk();
      case "region":
        return Captured.Region({
          monitor: source.monitor,
          position: source.position,
          size: source.size,
        });
    }
  });

const screenCastingSchema = z.object({ sources: z.array(capturedSchema) });

const recordingSchema = z
  .object({
    file: z.string(),
    recorded_ms: z.number(),
    running_since_ms: z.number().optional(),
    sources: z.array(capturedSchema),
  })
  .transform(
    (recording): RecordingBody => ({
      file: recording.file,
      recordedMs: recording.recorded_ms,
      runningSinceMs: recording.running_since_ms,
      sources: recording.sources,
    }),
  );

const agentWindowSchema = z
  .object({
    app: z.string().optional(),
    id: z.string(),
    kind: z.enum(["native", "browser"]),
    title: z.string(),
  })
  .transform(
    (window): AgentWindow => ({
      app: window.app,
      browser: window.kind === "browser",
      id: window.id,
      title: window.title,
    }),
  );

const agentReachSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("desk") }),
    z.object({
      type: z.literal("windows"),
      windows: z.array(agentWindowSchema),
    }),
  ])
  .transform(
    (reach): AgentReach =>
      reach.type === "desk"
        ? { kind: "desk" }
        : { kind: "windows", windows: reach.windows },
  );

/** An agent's reach, as the compositor sends it. */
export const readAgentReach = (reach: unknown): AgentReach =>
  agentReachSchema.parse(reach);

const agentSchema = z
  .object({
    agent: z.string(),
    current: agentReachSchema.optional(),
    remembered: z.boolean().default(false),
    windows: z.array(agentWindowSchema),
  })
  .transform(
    (body): AgentBody => ({
      agent: body.agent,
      current: body.current,
      remembered: body.remembered,
      windows: body.windows,
    }),
  );

const agentSessionSchema = z
  .object({
    actions: z.array(z.object({ at_ms: z.number(), said: z.string() })),
    agent: z.string(),
    reach: agentReachSchema,
  })
  .transform(
    (session): AgentSessionBody => ({
      actions: session.actions.map(({ at_ms, said }) => ({
        atMs: at_ms,
        said,
      })),
      agent: session.agent,
      reach: session.reach,
    }),
  );

const shortcutsSchema = z
  .object({
    shortcuts: z.array(
      z.object({
        description: z.string(),
        id: z.string(),
        trigger: z.string().optional(),
      }),
    ),
    taken: z.array(z.object({ app_id: z.string(), chord: z.string() })),
  })
  .transform(
    (body): ShortcutsBody => ({
      shortcuts: body.shortcuts.map((shortcut) => ({
        description: shortcut.description,
        id: shortcut.id,
        trigger: shortcut.trigger,
      })),
      taken: body.taken.map((taken) => ({
        appId: taken.app_id,
        chord: taken.chord,
      })),
    }),
  );

const wallpaperTargetSchema = z
  .enum(["background", "lockscreen", "both"])
  .transform((target): WallpaperTarget => {
    switch (target) {
      case "background":
        return WallpaperTarget.Background;
      case "lockscreen":
        return WallpaperTarget.Lockscreen;
      case "both":
        return WallpaperTarget.Both;
    }
  });

const wallpaperSchema = z
  .object({ path: z.string(), set_on: wallpaperTargetSchema })
  .transform(
    (body): WallpaperBody => ({ path: body.path, setOn: body.set_on }),
  );

const launcherSchema = z
  .object({
    editable_name: z.boolean(),
    icon: z.string().optional(),
    launcher_type: z.enum(["application", "webapp"]),
    name: z.string(),
    target: z.string().optional(),
  })
  .transform(
    (body): LauncherBody => ({
      editableName: body.editable_name,
      icon: body.icon,
      launcherType:
        body.launcher_type === "webapp"
          ? LauncherType.Webapp
          : LauncherType.Application,
      name: body.name,
      target: body.target,
    }),
  );

const usbSchema = z
  .object({
    devices: z.array(
      z.object({
        id: z.string(),
        product: z.string().optional(),
        vendor: z.string().optional(),
        writable: z.boolean(),
      }),
    ),
  })
  .transform(
    (body): UsbBody => ({
      devices: body.devices.map((device) => ({
        id: device.id,
        product: device.product,
        vendor: device.vendor,
        writable: device.writable,
      })),
    }),
  );
const shotRectSchema = z.object({
  height: z.number(),
  width: z.number(),
  x: z.number(),
  y: z.number(),
});

const shotAreaSchema = z.object({
  area: shotRectSchema,
  description: z.string(),
  name: z.string(),
});

const shotWindowSchema = z
  .object({ app_id: z.string(), id: z.string(), title: z.string() })
  .transform(({ app_id, id, title }) => ({ appId: app_id, id, title }));

const frozenDeskSchema = z.object({
  desk: z.object({ position: pairSchema, size: pairSchema }),
  frame: z.string(),
  height: z.number(),
  monitors: z.array(shotAreaSchema),
  width: z.number(),
  windows: z.array(shotWindowSchema),
});

const screenCastSchema = z
  .object({
    browser_windows: z.boolean(),
    desk: frozenDeskSchema.optional(),
    multiple: z.boolean(),
    region: z.boolean(),
    sources: z.array(castSourceSchema),
  })
  .transform(
    (body): ScreenCastBody => ({
      browserWindows: body.browser_windows,
      desk: body.desk,
      multiple: body.multiple,
      region: body.region,
      sources: body.sources,
    }),
  );

/** Each wire name and the value it stands for. */
type Pairs<W extends string, V> = readonly (readonly [W, V])[];

const SIDES: Pairs<z.infer<typeof sidesSchema>, Sides> = [
  ["one_sided", Sides.OneSided],
  ["two_sided_long_edge", Sides.TwoSidedLongEdge],
  ["two_sided_short_edge", Sides.TwoSidedShortEdge],
];

const COLOR_MODES: Pairs<z.infer<typeof colorModeSchema>, ColorMode> = [
  ["color", ColorMode.Color],
  ["monochrome", ColorMode.Monochrome],
];

const ORIENTATIONS: Pairs<z.infer<typeof orientationSchema>, Orientation> = [
  ["portrait", Orientation.Portrait],
  ["landscape", Orientation.Landscape],
  ["reverse_landscape", Orientation.ReverseLandscape],
  ["reverse_portrait", Orientation.ReversePortrait],
];

const QUALITIES: Pairs<z.infer<typeof qualitySchema>, PrintQuality> = [
  ["draft", PrintQuality.Draft],
  ["normal", PrintQuality.Normal],
  ["high", PrintQuality.High],
];

const sidesSchema = z.enum([
  "one_sided",
  "two_sided_long_edge",
  "two_sided_short_edge",
]);
const colorModeSchema = z.enum(["color", "monochrome"]);
const orientationSchema = z.enum([
  "portrait",
  "landscape",
  "reverse_landscape",
  "reverse_portrait",
]);
const qualitySchema = z.enum(["draft", "normal", "high"]);

const printOptionsSchema = z
  .object({
    color_mode: colorModeSchema.optional(),
    copies: z.number(),
    media: z.string().optional(),
    orientation: orientationSchema.optional(),
    pages: z.array(z.object({ first: z.number(), last: z.number() })),
    quality: qualitySchema.optional(),
    sides: sidesSchema.optional(),
  })
  .transform(
    (options): PrintOptions => ({
      colorMode: optionalOf(COLOR_MODES, options.color_mode),
      copies: options.copies,
      media: options.media,
      orientation: optionalOf(ORIENTATIONS, options.orientation),
      pages: options.pages,
      quality: optionalOf(QUALITIES, options.quality),
      sides: optionalOf(SIDES, options.sides),
    }),
  );

const printerSchema = z
  .object({
    color_modes: z.array(colorModeSchema),
    copies_max: z.number(),
    description: z.string().optional(),
    initial: printOptionsSchema,
    media: z.array(z.object({ label: z.string(), name: z.string() })),
    name: z.string(),
    orientations: z.array(orientationSchema),
    page_ranges: z.boolean(),
    qualities: z.array(qualitySchema),
    sides: z.array(sidesSchema),
  })
  .transform(
    (printer): Printer => ({
      colorModes: printer.color_modes.map((mode) =>
        valueFor(COLOR_MODES, mode),
      ),
      copiesMax: printer.copies_max,
      description: printer.description,
      initial: printer.initial,
      media: printer.media,
      name: printer.name,
      orientations: printer.orientations.map((name) =>
        valueFor(ORIENTATIONS, name),
      ),
      pageRanges: printer.page_ranges,
      qualities: printer.qualities.map((name) => valueFor(QUALITIES, name)),
      sides: printer.sides.map((name) => valueFor(SIDES, name)),
    }),
  );

/**
 * A GTK label as shown: `_` marks the next letter as the access key, and
 * `__` is a literal `_`.
 */
const withoutAccessKeys = (label: string): string =>
  label.replaceAll(/_(.)/gsu, "$1");

const printSchema = z
  .object({
    accept_label: z.string().optional(),
    home: z.string(),
    pdf: printerSchema,
    printer: z.string().optional(),
    printers: z.array(printerSchema),
    title: z.string(),
  })
  .transform(
    (body): PrintBody => ({
      acceptLabel: body.accept_label,
      home: body.home,
      pdf: body.pdf,
      printer: body.printer,
      printers: body.printers,
      title: body.title,
    }),
  );

/** Reads one kind's body into a request. */
type ReadKind = (base: PortalRequestBase, body: unknown) => PortalRequest;

/** Each kind's wire name, and how to read its body into a request. */
const KINDS: ReadonlyMap<string, ReadKind> = new Map<string, ReadKind>([
  [
    "access",
    (base, body) => PortalRequest.Access(base, accessSchema.parse(body)),
  ],
  [
    "app_chooser",
    (base, body) =>
      PortalRequest.AppChooser(base, appChooserSchema.parse(body)),
  ],
  [
    "file_chooser",
    (base, body) =>
      PortalRequest.FileChooser(base, fileChooserSchema.parse(body)),
  ],
  [
    "inhibit",
    (base: PortalRequestBase, body: unknown) =>
      PortalRequest.Inhibit(base, inhibitSchema.parse(body)),
  ],
  [
    "remote_desktop",
    (base, body) =>
      PortalRequest.RemoteDesktop(base, remoteDesktopSchema.parse(body)),
  ],
  [
    "input_capture",
    (base, body) =>
      PortalRequest.InputCapture(base, inputCaptureSchema.parse(body)),
  ],
  [
    "account",
    (base, body) => PortalRequest.Account(base, accountSchema.parse(body)),
  ],
  [
    "global_shortcuts",
    (base, body) =>
      PortalRequest.GlobalShortcuts(base, shortcutsSchema.parse(body)),
  ],
  [
    "wallpaper",
    (base, body) => PortalRequest.Wallpaper(base, wallpaperSchema.parse(body)),
  ],
  [
    "dynamic_launcher",
    (base, body) =>
      PortalRequest.DynamicLauncher(base, launcherSchema.parse(body)),
  ],
  ["usb", (base, body) => PortalRequest.Usb(base, usbSchema.parse(body))],
  [
    "screen_cast",
    (base, body) =>
      PortalRequest.ScreenCast(base, screenCastSchema.parse(body)),
  ],
  ["print", (base, body) => PortalRequest.Print(base, printSchema.parse(body))],
  [
    "screenshot",
    (base, body) =>
      PortalRequest.Screenshot(base, frozenDeskSchema.parse(body)),
  ],
  [
    "pick_color",
    (base, body) => PortalRequest.PickColor(base, frozenDeskSchema.parse(body)),
  ],
  ["agent", (base, body) => PortalRequest.Agent(base, agentSchema.parse(body))],
]);

type ReadCapturing = (base: CapturingBase, body: unknown) => Capturing;

/** Each capturing kind's wire name, and how to read its body into a session. */
const CAPTURING_KINDS: ReadonlyMap<string, ReadCapturing> = new Map<
  string,
  ReadCapturing
>([
  [
    "remote_desktop",
    (base, body) =>
      Capturing.RemoteDesktop(base, remoteDesktopSchema.parse(body)),
  ],
  [
    "input_capture",
    (base, body) =>
      Capturing.InputCapture(base, inputCaptureSchema.parse(body)),
  ],
  [
    "screen_cast",
    (base, body) => Capturing.ScreenCast(base, screenCastingSchema.parse(body)),
  ],
  [
    "recording",
    (base, body) => Capturing.Recording(base, recordingSchema.parse(body)),
  ],
  [
    "agent",
    (base, body) => Capturing.Agent(base, agentSessionSchema.parse(body)),
  ],
]);

const itemSchema = z.object({
  app_id: z.string(),
  body: z.unknown(),
  id: z.number(),
  kind: z.string(),
  parent_app_id: z.string().optional(),
});

const capturingSchema = z.object({
  app_id: z.string(),
  body: z.unknown(),
  id: z.number(),
  kind: z.string(),
});

const portalWallpaperSchema = z
  .object({
    background: z.string().optional(),
    lockscreen: z.string().optional(),
  })
  .optional()
  .transform(
    (wallpaper): PortalWallpaper => ({
      background: wallpaper?.background,
      lockscreen: wallpaper?.lockscreen,
    }),
  );

const requestsSchema = z.object({
  // Optional on the wire, so a line without it parses.
  capturing: z.array(capturingSchema).default([]),
  items: z.array(itemSchema),
  shortcuts: z
    .array(z.object({ app_id: z.string(), chord: z.string(), id: z.number() }))
    .optional(),
  type: z.literal("portal_requests"),
  wallpaper: portalWallpaperSchema,
});

const parseRequest = (item: z.infer<typeof itemSchema>): PortalRequest => {
  const base = {
    appId: item.app_id,
    id: item.id,
    parentAppId: item.parent_app_id,
  };
  const parse = KINDS.get(item.kind);
  return parse === undefined
    ? PortalRequest.Unknown(base, item.kind)
    : parse(base, item.body);
};

const chooserMode = (mode: "open" | "save" | "save_files"): FileChooserMode => {
  switch (mode) {
    case "open":
      return FileChooserMode.Open;
    case "save":
      return FileChooserMode.Save;
    case "save_files":
      return FileChooserMode.SaveFiles;
  }
};

const parseCapturing = (item: z.infer<typeof capturingSchema>): Capturing => {
  const base = { appId: item.app_id, id: item.id };
  const parse = CAPTURING_KINDS.get(item.kind);
  return parse === undefined
    ? Capturing.Unknown(base, item.kind)
    : parse(base, item.body);
};

/** `answer` as the compositor reads it. A cleared trigger is absent. */
const wireAnswer = (answer: PortalAnswer): object => {
  switch (answer.kind) {
    case PortalAnswerKind.Access:
      return { kind: "access" };
    case PortalAnswerKind.AppChooser:
      return { choice: answer.choice, kind: "app_chooser" };
    case PortalAnswerKind.RemoteDesktop:
      return {
        clipboard: answer.clipboard,
        devices: answer.devices,
        kind: "remote_desktop",
      };
    case PortalAnswerKind.InputCapture:
      return { kind: "input_capture" };
    case PortalAnswerKind.ScreenCast:
      return {
        kind: "screen_cast",
        sources: answer.sources.map((source) => wireSource(source)),
      };
    case PortalAnswerKind.Stop:
      return { kind: "stop" };
    case PortalAnswerKind.Pause:
      return { kind: "pause" };
    case PortalAnswerKind.Resume:
      return { kind: "resume" };
    case PortalAnswerKind.Discard:
      return { kind: "discard" };
    case PortalAnswerKind.Canceled:
      return { kind: "canceled" };
    case PortalAnswerKind.DynamicLauncher:
      return { kind: "dynamic_launcher", name: answer.name };
    case PortalAnswerKind.FileChooser:
      return {
        choices: Object.fromEntries(answer.chosen.choices),
        current_filter: answer.chosen.currentFilter,
        kind: "file_chooser",
        paths: answer.chosen.paths,
      };
    case PortalAnswerKind.GlobalShortcuts:
      return {
        kind: "global_shortcuts",
        triggers: answer.triggers.map(({ id, trigger }) =>
          trigger === undefined ? { id } : { id, trigger },
        ),
      };
    case PortalAnswerKind.Print:
      return {
        kind: "print",
        options: wireOptions(answer.options),
        printer: answer.printer,
      };
    case PortalAnswerKind.SaveToPdf:
      return {
        kind: "save_to_pdf",
        options: wireOptions(answer.options),
        path: answer.path,
      };
    case PortalAnswerKind.Screenshot:
      return { area: answer.area, copy: answer.copy, kind: "screenshot" };
    case PortalAnswerKind.ScreenshotWindow:
      return {
        ...wireArea(answer.area),
        copy: answer.copy,
        id: answer.id,
        kind: "screenshot_window",
      };
    case PortalAnswerKind.ScreenshotBrowserWindow:
      return {
        ...wireArea(answer.area),
        copy: answer.copy,
        id: answer.id,
        kind: "screenshot_browser_window",
      };
    case PortalAnswerKind.PickColor:
      return { kind: "pick_color", x: answer.at.x, y: answer.at.y };
    case PortalAnswerKind.Agent:
      return {
        kind: "agent",
        reach: wireReach(answer.reach),
        ...(answer.remember ? { remember: true } : {}),
      };
    case PortalAnswerKind.Change:
      return { kind: "change" };
    case PortalAnswerKind.Refused:
      return { kind: "refused" };
  }
};

const wireReach = (reach: AgentReach): object =>
  reach.kind === "desk"
    ? { type: "desk" }
    : {
        type: "windows",
        windows: reach.windows.map((window) => ({
          ...(window.app === undefined ? {} : { app: window.app }),
          id: window.id,
          kind: window.browser ? "browser" : "native",
          title: window.title,
        })),
      };

const wireOptions = (options: PrintOptions): object => ({
  color_mode: wireOf(COLOR_MODES, options.colorMode),
  copies: options.copies,
  media: options.media,
  orientation: wireOf(ORIENTATIONS, options.orientation),
  pages: options.pages,
  quality: wireOf(QUALITIES, options.quality),
  sides: wireOf(SIDES, options.sides),
});

const wireSource = (source: CastSource): object => {
  switch (source.kind) {
    case CastSourceKind.Window:
      return { ...wireArea(source.area), id: source.id, type: "window" };
    case CastSourceKind.BrowserWindow:
      return {
        ...wireArea(source.area),
        id: source.id,
        title: source.title,
        type: "browser_window",
      };
    case CastSourceKind.Monitor:
      return { name: source.name, type: "monitor" };
    case CastSourceKind.Region:
      return { position: source.position, size: source.size, type: "region" };
  }
};

/** Part of a window, when only part is picked. */
const wireArea = (area: ShotRect | undefined): { area?: ShotRect } =>
  area === undefined ? {} : { area };

/** The value `pairs` gives `wire`. Every wire name the schema takes is listed. */
const valueFor = <W extends string, V>(pairs: Pairs<W, V>, wire: W): V => {
  const found = pairs.find(([listed]) => listed === wire);
  if (found === undefined) {
    throw new Error(`no value for ${wire}`);
  } else {
    return found[1];
  }
};

/** The value `pairs` gives `wire`, if `wire` is present. */
const optionalOf = <W extends string, V>(
  pairs: Pairs<W, V>,
  wire: W | undefined,
): V | undefined => (wire === undefined ? undefined : valueFor(pairs, wire));

/** The wire name `pairs` gives `value`, if `value` is present. */
const wireOf = <W extends string, V>(
  pairs: Pairs<W, V>,
  value: V | undefined,
): W | undefined => pairs.find(([, listed]) => listed === value)?.[0];
