// The stand-in for Electron's `app`: the app's identity, paths, lifecycle and
// command-line switches.

import { EventEmitter } from "node:events";
import { cwd, env as processEnv } from "node:process";

import type { AppPackage } from "../app-package";
import { Priority, say } from "../journal";
import type { PathName } from "../paths";
import { nativeImage } from "./native-image";
import type { SecondInstance } from "./single-instance";
import { createSingleInstanceLock } from "./single-instance";

export type AppOptions = {
  /** The app directory: the mirror's extracted `app.asar`. */
  readonly appPath: string;
  readonly exit?: (code: number) => void;
  readonly pkg: AppPackage;
  readonly paths: Readonly<Record<PathName, string>>;
  /** The environment the app's locale comes from. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Runs a command to its end: its exit code and what it printed. */
  readonly runSync?: (command: readonly string[]) => {
    readonly code: number;
    readonly output: string;
  };
  /** Starts the app again once this instance exits, with `args`. */
  readonly relaunch?: (args: readonly string[]) => void;
};

/** Hooks the rest of the host gives `app` once they exist. */
export type AppHooks = {
  /** Shows the app's windows, as `app.focus()` does. */
  focus?: () => void;
  /** `app.applicationMenu`, which `Menu` owns. */
  applicationMenu?: { get: () => unknown; set: (menu: unknown) => void };
  /** `app.userAgentFallback`, which needs the engine's user agent. */
  userAgentFallback?: {
    get: () => string;
    renamed: () => void;
    set: (agent: string) => void;
  };
};

/** What Electron's `child-process-gone` says of a process that went. */
export type ChildProcessGoneDetails = {
  readonly type: "Utility";
  readonly reason: "abnormal-exit" | "crashed" | "killed";
  readonly exitCode: number;
  readonly serviceName: string;
  readonly name: string;
};

/**
 * The `app` an Electron app sees, and what the host calls on it: `markReady`
 * once the engine can open windows, `sessionCreated` with each session it
 * makes, `childProcessGone` when one of the app's processes went, and
 * `gpuInfoUpdated` when the engine learned more of its GPU.
 */
export const createApp = ({
  appPath,
  env = processEnv,
  exit = (code) => process.exit(code),
  pkg,
  paths,
  relaunch = () => {
    throw new Error("app.relaunch has nothing to start the app again with");
  },
  runSync = () => ({ code: 127, output: "no command runner" }),
}: AppOptions) => {
  const hooks: AppHooks = {};
  const app = new ElectronApp(
    appPath,
    exit,
    pkg,
    paths,
    env,
    runSync,
    relaunch,
    hooks,
  );
  /** Sessions made before ready, which Electron can only make from then. */
  const early: unknown[] = [];
  return {
    app,
    childProcessGone: (details: ChildProcessGoneDetails) => {
      app.emit("child-process-gone", eventObject(), details);
    },
    gpuInfoUpdated: () => {
      // With nothing, as Electron's.
      app.emit("gpu-info-update");
    },
    hooks,
    markReady: () => {
      app.emit("will-finish-launching", eventObject());
      for (const session of early.splice(0)) {
        app.emit("session-created", session);
      }
      app.markReady();
    },
    sessionCreated: (session: unknown) => {
      if (app.isReady()) {
        app.emit("session-created", session);
      } else {
        early.push(session);
      }
    },
  };
};

/**
 * Electron's `app`. A class because the app listens on it as an
 * `EventEmitter` and reads and sets `name` as a property.
 */
export class ElectronApp extends EventEmitter {
  readonly commandLine = commandLine();
  readonly isPackaged = true;
  #name: string;
  #paths: Map<string, string>;
  #ready = Promise.withResolvers<void>();
  #isReady = false;
  #badgeCount = 0;
  #relaunchWith: readonly string[] | undefined;
  #aboutPanel: Record<string, unknown> = {};
  #desktopName: string | undefined;
  #lock;

  constructor(
    private readonly appPath: string,
    private readonly exitWith: (code: number) => void,
    private readonly pkg: AppPackage,
    paths: Readonly<Record<PathName, string>>,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly runSync: NonNullable<AppOptions["runSync"]>,
    private readonly relaunchWith: NonNullable<AppOptions["relaunch"]>,
    private readonly hooks: AppHooks,
  ) {
    super();
    this.#name = pkg.productName;
    this.#paths = new Map(Object.entries(paths));
    this.#lock = createSingleInstanceLock(
      () => this.getPath("userData"),
      ({ argv, workingDirectory, additionalData }: SecondInstance) => {
        this.emit(
          "second-instance",
          eventObject(),
          [...argv],
          workingDirectory,
          additionalData,
        );
      },
    );
  }

  get userAgentFallback() {
    return userAgentFallbackOf(this.hooks).get();
  }

  set userAgentFallback(agent: string) {
    userAgentFallbackOf(this.hooks).set(agent);
  }

  get applicationMenu() {
    return this.hooks.applicationMenu?.get() ?? null;
  }

  set applicationMenu(menu: unknown) {
    this.hooks.applicationMenu?.set(menu);
  }

  get badgeCount() {
    return this.#badgeCount;
  }

  set badgeCount(count: number) {
    this.setBadgeCount(count);
  }

  get name() {
    return this.#name;
  }

  set name(name: string) {
    this.#name = name;
  }

  readonly exit = (code = 0) => {
    this.#leave();
    this.exitWith(code);
  };

  /** What every way out does first: free the lock, start again if asked. */
  readonly #leave = () => {
    this.#lock.release();
    if (this.#relaunchWith !== undefined) {
      this.relaunchWith(this.#relaunchWith);
    }
  };

  // Settings the engine decides, or Chromium's that an app's own Electron
  // would apply and the engine's sandboxed pages already have.
  readonly configureHostResolver = (_options?: unknown) => undefined;
  readonly disableDomainBlockingFor3DAPIs = () => undefined;
  readonly disableHardwareAcceleration = () => undefined;
  readonly enableSandbox = () => undefined;
  readonly isHardwareAccelerationEnabled = () => true;
  readonly isEmojiPanelSupported = () => false;
  readonly setClientCertRequestPasswordHandler = (_handler: unknown) =>
    undefined;

  /** Shows the app's windows. */
  readonly focus = (_options?: unknown) => {
    this.hooks.focus?.();
  };

  /** This process, as Electron lists the app's processes. */
  readonly getAppMetrics = () => {
    const { rss } = process.memoryUsage();
    const kilobytes = Math.round(rss / 1024);
    return [
      {
        cpu: { idleWakeupsPerSecond: 0, percentCPUUsage: 0 },
        creationTime: Date.now() - Math.round(process.uptime() * 1000),
        memory: { peakWorkingSetSize: kilobytes, workingSetSize: kilobytes },
        pid: process.pid,
        sandboxed: false,
        type: "Browser",
      },
    ];
  };

  /** The app the desktop opens `url`'s scheme with, by its desktop file's name. */
  readonly getApplicationNameForProtocol = (url: string) => {
    const scheme = url.split(":")[0] ?? "";
    const { code, output } = this.runSync([
      "xdg-mime",
      "query",
      "default",
      `x-scheme-handler/${scheme}`,
    ]);
    return code === 0 ? output.trim().replace(/\.desktop$/, "") : "";
  };

  readonly getApplicationInfoForProtocol = (url: string) =>
    Promise.resolve().then(() => {
      const name = this.getApplicationNameForProtocol(url);
      if (name === "") {
        throw new Error(`no app opens ${url.split(":")[0]} links`);
      }
      return { icon: nativeImage.createEmpty(), name, path: name };
    });

  /** No file icons on Domicile yet: an empty image, as for a file with none. */
  readonly getFileIcon = async (_path: string, _options?: unknown) =>
    nativeImage.createEmpty();

  /** The engine renders on the GPU; its features as Chromium names them. */
  readonly getGPUFeatureStatus = () => ({
    "2d_canvas": "enabled",
    canvas_oop_rasterization: "enabled_on",
    gpu_compositing: "enabled",
    multiple_raster_threads: "enabled_on",
    opengl: "enabled_on",
    rasterization: "enabled",
    raw_draw: "disabled_off",
    skia_graphite: "disabled_off",
    video_decode: "enabled",
    video_encode: "enabled",
    vulkan: "disabled_off",
    webgl: "enabled",
    webgl2: "enabled",
    webgpu: "enabled",
  });

  readonly getGPUInfo = async (_infoType: string) => ({
    auxAttributes: {},
    gpuDevice: [],
    machineModelName: "",
    machineModelVersion: "",
  });

  /** `en-US` from `LANG=en_US.UTF-8`, as Chromium reads it on Linux. */
  readonly getLocale = () => localeOf(this.env);

  readonly getLocaleCountryCode = () => localeOf(this.env).split("-")[1] ?? "";

  readonly getSystemLocale = () => localeOf(this.env);

  readonly getPreferredSystemLanguages = () => {
    const languages = (this.env.LANGUAGE ?? "")
      .split(":")
      .filter((language) => language !== "")
      .map(asBcp47);
    return languages.length > 0 ? languages : [localeOf(this.env)];
  };

  readonly hasSingleInstanceLock = () => this.#lock.has();

  readonly requestSingleInstanceLock = (additionalData: unknown = {}) =>
    this.#lock.request({
      additionalData,
      argv: process.argv,
      workingDirectory: cwd(),
    });

  readonly releaseSingleInstanceLock = () => {
    this.#lock.release();
  };

  /** No client certificates on Domicile yet: Chromium's "failed" result. */
  readonly importCertificate = (
    _options: unknown,
    callback: (result: number) => void,
  ) => {
    callback(-2);
  };

  /** Whether the desktop opens `protocol` links with this app, as `xdg-settings` says. */
  readonly isDefaultProtocolClient = (protocol: string) => {
    const desktop = this.#desktopFile();
    const { code, output } = this.runSync([
      "xdg-settings",
      "check",
      "default-url-scheme-handler",
      protocol,
      desktop,
    ]);
    return code === 0 && output.trim() === "yes";
  };

  /** Makes this app the one `protocol` links open, with `xdg-settings`, as Electron does. */
  readonly setAsDefaultProtocolClient = (protocol: string) => {
    const desktop = this.#desktopFile();
    return (
      this.runSync([
        "xdg-settings",
        "set",
        "default-url-scheme-handler",
        protocol,
        desktop,
      ]).code === 0
    );
  };

  /** The app's desktop file, as `xdg-settings` names it. */
  readonly #desktopFile = () =>
    this.#desktopName ?? `${this.pkg.appId}.desktop`;

  readonly relaunch = (options: { args?: readonly string[] } = {}) => {
    this.#relaunchWith = options.args ?? process.argv.slice(1);
  };

  /** Every connection goes direct: the engine doesn't take a proxy from the app. */
  readonly resolveProxy = async (_url: string) => "DIRECT";

  readonly setProxy = async (_config: unknown) => undefined;

  readonly setAboutPanelOptions = (options: Record<string, unknown>) => {
    this.#aboutPanel = { ...options };
  };

  readonly showAboutPanel = () => {
    // Electron's about panel is a GTK dialog, which Domicile has no stand-in for.
    say(
      Priority.Warning,
      `electron-host: ${this.#name} asked for its about panel, which Domicile doesn't show: ${JSON.stringify(this.#aboutPanel)}`,
    );
  };

  readonly setAppLogsPath = (path?: string) => {
    this.#paths.set("logs", path ?? `${this.getPath("userData")}/logs`);
  };

  /** The count Electron keeps on Linux, where only Unity's launcher shows it. */
  readonly setBadgeCount = (count = 0) => {
    this.#badgeCount = count;
    return true;
  };

  readonly getBadgeCount = () => this.#badgeCount;

  // macOS and Windows APIs whose answers apps read on Linux too: what
  // Electron gives there.
  readonly getAccessibilitySupportFeatures = () => [] as string[];
  readonly getJumpListSettings = () => ({ minItems: 0, removedItems: [] });
  readonly getLoginItemSettings = (_options?: unknown) => ({
    executableWillLaunchAtLogin: false,
    launchItems: [],
    openAsHidden: false,
    openAtLogin: false,
    restoreState: false,
    status: "not-registered",
    wasOpenedAsHidden: false,
    wasOpenedAtLogin: false,
  });
  readonly getRecentDocuments = () => [] as string[];
  readonly isAccessibilitySupportEnabled = () => false;
  readonly isActive = () => true;
  readonly isHidden = () => false;
  readonly isInApplicationsFolder = () => false;
  readonly isSecureKeyboardEntryEnabled = () => false;
  readonly setUserTasks = (_tasks: unknown) => false;

  /** Shows the app's windows, as on macOS. */
  readonly show = () => {
    this.hooks.focus?.();
  };

  /** Whether Unity's launcher shows the badge: no Domicile shell is Unity. */
  readonly isUnityRunning = () => false;

  readonly setDesktopName = (name: string) => {
    this.#desktopName = name;
  };

  readonly getAppPath = () => this.appPath;

  readonly getName = () => this.#name;

  readonly getPath = (name: string) => {
    const path = this.#paths.get(name);
    if (path === undefined) {
      throw new Error(`Failed to get '${name}' path`);
    } else {
      return path;
    }
  };

  readonly getVersion = () => this.pkg.version;

  readonly isReady = () => this.#isReady;

  readonly markReady = () => {
    this.#isReady = true;
    this.#ready.resolve();
    this.emit("ready", eventObject(), {});
  };

  readonly quit = () => {
    const beforeQuit = eventObject();
    this.emit("before-quit", beforeQuit);
    if (!beforeQuit.defaultPrevented) {
      this.emit("will-quit", eventObject());
      this.emit("quit", eventObject(), 0);
      this.#leave();
      this.exitWith(0);
    }
  };

  readonly setName = (name: string) => {
    this.#name = name;
    // Before the engine, it reads the name when it reaches it.
    this.hooks.userAgentFallback?.renamed();
  };

  readonly setPath = (name: string, path: string) => {
    this.#paths.set(name, path);
  };

  readonly whenReady = () => this.#ready.promise;
}

/** Chromium's locale from the environment: `en_US.UTF-8` is `en-US`. */
const localeOf = (env: Readonly<Record<string, string | undefined>>) => {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "en_US";
  return raw === "C" || raw === "POSIX" ? "en-US" : asBcp47(raw);
};

const asBcp47 = (locale: string) =>
  (locale.split(".")[0] ?? locale).split("@")[0]?.replace("_", "-") ?? locale;

/**
 * The switches the app was started with (`--name` or `--name=value`, up to
 * a bare `--`), which Chromium's command line holds from the start: an app
 * reads `--password-store` or its own flags through `app.commandLine`.
 */
const startedWith = () => {
  const switches = new Map<string, string>();
  for (const arg of process.argv.slice(1)) {
    if (arg === "--") {
      break;
    }
    const matched = /^--([^=]+)(?:=(.*))?$/su.exec(arg);
    if (matched?.[1] !== undefined) {
      switches.set(matched[1], matched[2] ?? "");
    }
  }
  return switches;
};

/** `app.commandLine`: switches the app appends for Chromium, and its own. */
const commandLine = () => {
  const switches = new Map<string, string>();
  const args: string[] = [];
  return {
    appendArgument: (value: string) => {
      args.push(value);
    },
    appendSwitch: (name: string, value = "") => {
      switches.set(name, value);
    },
    getSwitchValue: (name: string) =>
      switches.get(name) ?? startedWith().get(name) ?? "",
    hasSwitch: (name: string) => switches.has(name) || startedWith().has(name),
    removeSwitch: (name: string) => {
      switches.delete(name);
    },
  };
};

/** The event object Electron passes first to an `app` listener. */
const eventObject = () => {
  const event = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
};

/** The host's `app.userAgentFallback`, which it sets once it reaches the engine. */
const userAgentFallbackOf = (hooks: AppHooks) => {
  if (hooks.userAgentFallback === undefined) {
    throw new Error(
      "app.userAgentFallback was used before the host reached the engine",
    );
  } else {
    return hooks.userAgentFallback;
  }
};
