// The webContents members the engine carries out on a page with a
// `page_call`: style sheets, isolated worlds, captures, PDFs, emulation and
// the page's settings. Captures, PDFs, emulation and frame subscription go
// through the page's own DevTools client in the engine (method `devtools`).
// See "Page calls" in docs/architecture/ELECTRON-APPS.md.

import type { EventEmitter } from "node:events";
import { z } from "zod";
import { Priority, say } from "../journal";
import type { NativeImage } from "./native-image";
import { nativeImage } from "./native-image";

/** What a `page_call` asks of a page, by the engine's names. */
export type PageMethod =
  | { readonly method: "reload_ignoring_cache" }
  | {
      readonly method: "insert_css";
      readonly css: string;
      readonly user: boolean;
    }
  | {
      readonly method: "remove_inserted_css";
      readonly key: string;
      readonly user: boolean;
    }
  | {
      readonly method: "execute_in_isolated_world";
      readonly world: number;
      readonly scripts: readonly { code: string; url?: string }[];
      readonly user_gesture: boolean;
    }
  | { readonly method: "copy_image_at"; readonly x: number; readonly y: number }
  | {
      readonly method: "copy_video_frame_at";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly method: "adjust_selection";
      readonly start: number;
      readonly end: number;
    }
  | { readonly method: "set_caret_browsing"; readonly enabled: boolean }
  | { readonly method: "set_webrtc_ip_policy"; readonly policy: string }
  | { readonly method: "set_ignore_input"; readonly ignore: boolean }
  | {
      readonly method: "devtools";
      readonly devtools_method: string;
      readonly params: Readonly<Record<string, unknown>>;
    };

/** The page's DevTools events, by DevTools method. */
export type DevToolsEvents = EventEmitter<
  Record<string, [params: Readonly<Record<string, unknown>>]>
>;

/** How the page's members reach the engine. */
export type PageCaller = {
  /** Carries `method` out on the page: rejects when the page can't. */
  readonly call: (method: PageMethod) => Promise<unknown>;
  /** As `call`, after a load under way, as executeJavaScript waits for one. */
  readonly callAfterLoad: (method: PageMethod) => Promise<unknown>;
  /** A setting: sent now, or as the page opens, its failure logged. */
  readonly set: (method: PageMethod) => void;
  readonly devtools: DevToolsEvents;
  /** Whether the page shows on the desk, and so draws what a capture takes. */
  readonly isShowing: () => boolean;
};

/** Electron's `Rectangle`. */
type Rectangle = { x: number; y: number; width: number; height: number };

/** Electron's `PrintToPDFOptions`. */
export type PrintToPdfOptions = {
  readonly landscape?: boolean;
  readonly displayHeaderFooter?: boolean;
  readonly printBackground?: boolean;
  readonly scale?: number;
  readonly pageSize?:
    | string
    | { readonly width: number; readonly height: number };
  readonly margins?: {
    readonly top?: number;
    readonly bottom?: number;
    readonly left?: number;
    readonly right?: number;
  };
  readonly pageRanges?: string;
  readonly headerTemplate?: string;
  readonly footerTemplate?: string;
  readonly preferCSSPageSize?: boolean;
  readonly generateTaggedPDF?: boolean;
  readonly generateDocumentOutline?: boolean;
};

/** Electron's device emulation `Parameters`. */
export type DeviceEmulation = {
  readonly screenPosition?: "desktop" | "mobile";
  readonly screenSize?: { readonly width: number; readonly height: number };
  readonly viewPosition?: { readonly x: number; readonly y: number };
  readonly deviceScaleFactor?: number;
  readonly viewSize?: { readonly width: number; readonly height: number };
  readonly scale?: number;
};

type FrameSubscriber = (image: NativeImage, dirtyRect: Rectangle) => void;

/** Electron's paper sizes, in inches, by its names lowercased. */
const PAPER_SIZES: Readonly<Record<string, { width: number; height: number }>> =
  {
    a0: { height: 46.8, width: 33.1 },
    a1: { height: 33.1, width: 23.4 },
    a2: { height: 23.4, width: 16.54 },
    a3: { height: 16.54, width: 11.7 },
    a4: { height: 11.7, width: 8.27 },
    a5: { height: 8.27, width: 5.83 },
    a6: { height: 5.83, width: 4.13 },
    ledger: { height: 11, width: 17 },
    legal: { height: 14, width: 8.5 },
    letter: { height: 11, width: 8.5 },
    tabloid: { height: 17, width: 11 },
  };

/** Electron's default margin, 1cm, in inches. */
const DEFAULT_MARGIN = 0.4;

/** The policies setWebRTCIPHandlingPolicy takes, by Electron's names. */
const WEBRTC_IP_POLICIES = new Set([
  "default",
  "default_public_interface_only",
  "default_public_and_private_interfaces",
  "disable_non_proxied_udp",
]);

/** A page's members that a page call carries out. */
export const createPageControl = (page: PageCaller) => {
  /** Whether each inserted style sheet's key is the user's, by key. */
  const userSheets = new Map<string, boolean>();
  let caretBrowsing = false;
  let webRtcIpPolicy = "default";
  let frameSubscriber: FrameSubscriber | undefined;

  const devtools = (method: string, params: Record<string, unknown> = {}) =>
    page.call({ devtools_method: method, method: "devtools", params });
  const setDevtools = (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    page.set({ devtools_method: method, method: "devtools", params });
  };

  /** The page as it shows, or the part of it in `rect`. */
  const captureShown = async (rect: Rectangle | undefined) => {
    const whole = rect === undefined || rect.width === 0 || rect.height === 0;
    const clip = whole ? {} : { clip: await shownClip(rect) };
    const result = await devtools("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      ...clip,
    });
    return nativeImage.createFromBuffer(
      Buffer.from(withData.parse(result).data, "base64"),
    );
  };

  /** DevTools' clip, from the document's top left, for a rect of what shows. */
  const shownClip = async (rect: Rectangle) => {
    const { cssVisualViewport } = layoutMetrics.parse(
      await devtools("Page.getLayoutMetrics"),
    );
    return {
      ...rect,
      scale: 1,
      x: rect.x + cssVisualViewport.pageX,
      y: rect.y + cssVisualViewport.pageY,
    };
  };

  page.devtools.on("Page.screencastFrame", (params) => {
    if (frameSubscriber !== undefined) {
      const frame = screencastFrame.parse(params);
      fireAndLog(
        devtools("Page.screencastFrameAck", { sessionId: frame.sessionId }),
        "acknowledge a frame",
      );
      const image = nativeImage.createFromBuffer(
        Buffer.from(frame.data, "base64"),
      );
      frameSubscriber(image, { ...image.getSize(), x: 0, y: 0 });
    }
  });

  return {
    adjustSelection: ({
      end = 0,
      start = 0,
    }: {
      start?: number;
      end?: number;
    }) => {
      fireAndLog(
        page.call({ end, method: "adjust_selection", start }),
        "adjust the selection",
      );
    },

    /** Calls `callback` with each frame the page draws, until it ends. */
    beginFrameSubscription: (
      onlyDirtyOrCallback: boolean | FrameSubscriber,
      callback?: FrameSubscriber,
    ) => {
      const subscriber =
        typeof onlyDirtyOrCallback === "function"
          ? onlyDirtyOrCallback
          : callback;
      if (subscriber === undefined) {
        throw new TypeError("beginFrameSubscription takes a callback");
      } else {
        if (frameSubscriber === undefined) {
          setDevtools("Page.startScreencast", { format: "png" });
        }
        frameSubscriber = subscriber;
      }
    },

    /**
     * The page as the shell last drew it, or the part of it in `rect`, which
     * is from the top left of what shows, as the page is scrolled.
     */
    capturePage: async (rect?: Rectangle, _options?: unknown) =>
      // A page that doesn't show draws no frame to capture.
      page.isShowing() ? await captureShown(rect) : nativeImage.createEmpty(),

    copyImageAt: (x: number, y: number) => {
      fireAndLog(
        page.call({ method: "copy_image_at", ...wholePoint(x, y) }),
        "copy an image",
      );
    },
    copyVideoFrameAt: (x: number, y: number) => {
      fireAndLog(
        page.call({ method: "copy_video_frame_at", ...wholePoint(x, y) }),
        "copy a video frame",
      );
    },
    disableDeviceEmulation: () => {
      setDevtools("Emulation.clearDeviceMetricsOverride");
    },

    enableDeviceEmulation: (parameters: DeviceEmulation) => {
      setDevtools(
        "Emulation.setDeviceMetricsOverride",
        deviceMetrics(parameters),
      );
    },
    endFrameSubscription: () => {
      if (frameSubscriber !== undefined) {
        frameSubscriber = undefined;
        setDevtools("Page.stopScreencast");
      }
    },

    executeJavaScriptInIsolatedWorld: (
      worldId: number,
      scripts: readonly { code: string; url?: string }[],
      userGesture = false,
    ) =>
      page.callAfterLoad({
        method: "execute_in_isolated_world",
        scripts: scripts.map(({ code, url }) =>
          url === undefined ? { code } : { code, url },
        ),
        user_gesture: userGesture,
        world: worldId,
      }),
    getWebRTCIPHandlingPolicy: () => webRtcIpPolicy,

    /** Resolves with the sheet's key, for removeInsertedCSS. */
    insertCSS: async (
      css: string,
      { cssOrigin = "author" }: { cssOrigin?: "user" | "author" } = {},
    ) => {
      const user = cssOrigin === "user";
      const key = z
        .string()
        .parse(await page.callAfterLoad({ css, method: "insert_css", user }));
      userSheets.set(key, user);
      return key;
    },
    isCaretBrowsingEnabled: () => caretBrowsing,

    printToPDF: async (options: PrintToPdfOptions) => {
      const result = await devtools(
        "Page.printToPDF",
        printToPdfParams(options),
      );
      return Buffer.from(withData.parse(result).data, "base64");
    },
    reloadIgnoringCache: () => {
      fireAndLog(
        page.call({ method: "reload_ignoring_cache" }),
        "reload ignoring the cache",
      );
    },
    removeInsertedCSS: async (key: string) => {
      // A key the app never had removes nothing, as in Electron.
      const user = userSheets.get(key) ?? false;
      userSheets.delete(key);
      await page.call({ key, method: "remove_inserted_css", user });
    },

    setCaretBrowsingEnabled: (enabled: boolean) => {
      caretBrowsing = enabled;
      page.set({ enabled, method: "set_caret_browsing" });
    },

    setWebRTCIPHandlingPolicy: (policy: string) => {
      if (WEBRTC_IP_POLICIES.has(policy)) {
        webRtcIpPolicy = policy;
        page.set({ method: "set_webrtc_ip_policy", policy });
      } else {
        throw new TypeError(`Invalid WebRTC IP handling policy: ${policy}`);
      }
    },
  };
};

/** DevTools' Page.printToPDF parameters for Electron's options. */
const printToPdfParams = (options: PrintToPdfOptions) => {
  const scale = options.scale ?? 1;
  if (scale < 0.1 || scale > 2) {
    throw new RangeError("scale must be between 0.1 and 2");
  } else {
    return pdfParams(options, scale, paperSize(options.pageSize ?? "Letter"));
  }
};

const pdfParams = (
  options: PrintToPdfOptions,
  scale: number,
  paper: { width: number; height: number },
) => {
  const margins = options.margins ?? {};
  return {
    displayHeaderFooter: options.displayHeaderFooter ?? false,
    footerTemplate: options.footerTemplate ?? "",
    generateDocumentOutline: options.generateDocumentOutline ?? false,
    generateTaggedPDF: options.generateTaggedPDF ?? false,
    headerTemplate: options.headerTemplate ?? "",
    landscape: options.landscape ?? false,
    marginBottom: margins.bottom ?? DEFAULT_MARGIN,
    marginLeft: margins.left ?? DEFAULT_MARGIN,
    marginRight: margins.right ?? DEFAULT_MARGIN,
    marginTop: margins.top ?? DEFAULT_MARGIN,
    pageRanges: options.pageRanges ?? "",
    paperHeight: paper.height,
    paperWidth: paper.width,
    preferCSSPageSize: options.preferCSSPageSize ?? false,
    printBackground: options.printBackground ?? false,
    scale,
    transferMode: "ReturnAsBase64",
  };
};

const paperSize = (
  pageSize: NonNullable<PrintToPdfOptions["pageSize"]>,
): { width: number; height: number } => {
  if (typeof pageSize === "string") {
    const named = PAPER_SIZES[pageSize.toLowerCase()];
    if (named === undefined) {
      throw new Error(`Invalid pageSize ${pageSize}`);
    } else {
      return named;
    }
  } else {
    return { height: pageSize.height, width: pageSize.width };
  }
};

/** DevTools' Emulation.setDeviceMetricsOverride for Electron's parameters. */
const deviceMetrics = ({
  deviceScaleFactor = 0,
  scale = 1,
  screenPosition = "desktop",
  screenSize = { height: 0, width: 0 },
  viewPosition = { x: 0, y: 0 },
  viewSize = { height: 0, width: 0 },
}: DeviceEmulation) => ({
  deviceScaleFactor,
  height: viewSize.height,
  mobile: screenPosition === "mobile",
  positionX: viewPosition.x,
  positionY: viewPosition.y,
  scale,
  screenHeight: screenSize.height,
  screenWidth: screenSize.width,
  width: viewSize.width,
});

/** A DevTools answer or event that carries base64 `data`: a PNG or a PDF. */
const withData = z.object({ data: z.string() });

/** What a Page.getLayoutMetrics answer says of where the page is scrolled. */
const layoutMetrics = z.object({
  cssVisualViewport: z.object({ pageX: z.number(), pageY: z.number() }),
});

/** A Page.screencastFrame event's parameters that a subscriber needs. */
const screencastFrame = z.object({ data: z.string(), sessionId: z.number() });

const wholePoint = (x: number, y: number) => ({
  x: Math.round(x),
  y: Math.round(y),
});

/** Logs the failure of a call whose Electron member answers nothing. */
const fireAndLog = (call: Promise<unknown>, what: string) => {
  call.catch((error: unknown) => {
    say(
      Priority.Error,
      `electron-host: couldn't ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
};
