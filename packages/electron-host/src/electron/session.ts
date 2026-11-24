// The stand-in for Electron's `session`: one per partition, each with its own
// protocol handlers, webRequest listeners, cookies, storage and permission
// handlers. Each is a partition inside the app's own in the engine,
// so no session reaches another app's storage. See "Requests" in
// docs/architecture/ELECTRON-APPS.md.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";

import type { IncomingPreconnect } from "../engine";
import type { DisplayMediaRequestHandler } from "./desktop-capturer";
import { setDisplayMediaRequestHandler } from "./desktop-capturer";
import type { NetworkEmulationOptions } from "./network-emulation";
import { createNetworkEmulation } from "./network-emulation";
import type { PageMethod } from "./page-control";
import type {
  createPermissions,
  PermissionCheckHandler,
  PermissionRequestHandler,
  Permissions,
} from "./permissions";
import type { createProtocols, Protocol } from "./protocol";
import type { ServiceWorkerEvent } from "./service-workers";
import { createServiceWorkers } from "./service-workers";
import type {
  ClearDataOptions,
  ClearStorageDataOptions,
  Cookies,
  createSessionCalls,
  ResolveHostOptions,
  SessionCalls,
  SharedDictionaryIsolationKey,
} from "./session-calls";
import type { createWebRequests, WebRequest } from "./web-request";

const partitions = new WeakMap<Session, string>();
/** What each session's calls are, for learnStoragePath. */
const sessionCalls = new WeakMap<Session, SessionCalls>();
/** Where each persistent session keeps its data, once the engine says. */
const storagePaths = new WeakMap<Session, string>();
/** Each session's service workers, from the app's first use. */
const watchedWorkers = new WeakMap<
  Session,
  ReturnType<typeof createServiceWorkers>
>();

/** Each session's network emulation, which its pages follow. */
const emulations = new WeakMap<
  Session,
  ReturnType<typeof createNetworkEmulation>
>();

/** Electron's `PreloadScript`. */
type PreloadScript = {
  readonly type: "frame" | "service-worker";
  readonly id: string;
  readonly filePath: string;
};

/** Electron's `PreloadScriptRegistration`, the keys the host takes. */
type PreloadScriptRegistration = {
  readonly type: "frame" | "service-worker";
  readonly id?: string;
  readonly filePath: string;
  readonly matches?: readonly string[];
  readonly excludeMatches?: readonly string[];
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
};

/** Electron's `Session`, as far as the host has it. */
export class Session extends EventEmitter {
  readonly cookies: Cookies;
  readonly #calls: SessionCalls;
  readonly #permissions: Permissions;

  constructor(
    partition: string,
    readonly protocol: Protocol,
    readonly webRequest: WebRequest,
    calls: SessionCalls,
    permissions: Permissions,
  ) {
    super();
    partitions.set(this, partition);
    sessionCalls.set(this, calls);
    this.cookies = calls.cookies;
    this.#calls = calls;
    this.#permissions = permissions;
    emulations.set(this, this.#emulation);
  }

  readonly #emulation = createNetworkEmulation();

  enableNetworkEmulation(options: NetworkEmulationOptions) {
    this.#emulation.enable(options);
  }

  disableNetworkEmulation() {
    this.#emulation.disable();
  }

  /** Watched from the app's first use, as an app reaches for it as it starts. */
  get serviceWorkers() {
    const found = watchedWorkers.get(this);
    if (found === undefined) {
      const made = createServiceWorkers(this.#calls.watchServiceWorkers);
      watchedWorkers.set(this, made);
      return made.serviceWorkers;
    } else {
      return found.serviceWorkers;
    }
  }

  /**
   * The engine keeps no net log for the app yet: logging never starts, and
   * asking it to says so.
   */
  readonly netLog = {
    currentlyLogging: false,
    startLogging: (_path: string, _options?: unknown) =>
      Promise.reject(
        new Error("Domicile's engine doesn't keep a net log for the app yet"),
      ),
    stopLogging: () => Promise.resolve(),
  };

  #spellCheck = {
    enabled: true,
    languages: ["en-US"],
    words: new Set<string>(),
  };
  #preloads: PreloadScript[] = [];
  /** The ids setPreloads registered, which its next call replaces. */
  #setPreloadIds = new Set<string>();

  /**
   * The engine checks spelling in its pages as the desktop's browser does,
   * so what the app sets here is kept for it to read back, not applied.
   */
  setSpellCheckerEnabled(enabled: boolean) {
    this.#spellCheck.enabled = enabled;
  }

  isSpellCheckerEnabled() {
    return this.#spellCheck.enabled;
  }

  get spellCheckerEnabled() {
    return this.#spellCheck.enabled;
  }

  set spellCheckerEnabled(enabled: boolean) {
    this.#spellCheck.enabled = enabled;
  }

  setSpellCheckerLanguages(languages: readonly string[]) {
    this.#spellCheck.languages = [...languages];
  }

  getSpellCheckerLanguages() {
    return [...this.#spellCheck.languages];
  }

  get availableSpellCheckerLanguages() {
    return [...this.#spellCheck.languages];
  }

  setSpellCheckerDictionaryDownloadURL(_url: string): void {
    // Nothing to do on Domicile: see above.
  }

  addWordToSpellCheckerDictionary(word: string) {
    this.#spellCheck.words.add(word);
    return true;
  }

  removeWordFromSpellCheckerDictionary(word: string) {
    return this.#spellCheck.words.delete(word);
  }

  listWordsInSpellCheckerDictionary() {
    return Promise.resolve([...this.#spellCheck.words]);
  }

  /**
   * A request from the main process with this session's cookies, as
   * Electron's goes out with them, keeping the cookies it sets.
   */
  async fetch(input: string | Request, init?: RequestInit) {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : new Request(input, init);
    if (!request.headers.has("cookie")) {
      const cookies = await this.cookies.get({ url: request.url });
      if (cookies.length > 0) {
        request.headers.set(
          "cookie",
          cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
        );
      }
    }
    const response = await fetch(request);
    for (const line of response.headers.getSetCookie()) {
      await this.cookies.set(cookieFrom(request.url, line));
    }
    return response;
  }

  // The engine connects directly, with no proxy from the app, and keeps its
  // own connection pools and caches.
  resolveProxy(_url: string) {
    return Promise.resolve("DIRECT");
  }

  setProxy(_config: unknown) {
    return Promise.resolve();
  }

  forceReloadProxyConfig() {
    return Promise.resolve();
  }

  closeAllConnections() {
    return Promise.resolve();
  }

  clearHostResolverCache() {
    return Promise.resolve();
  }

  /**
   * The engine signs in with NTLM or Kerberos only where its own policy
   * allows, as Chrome does, so the app's list changes nothing yet. Slack sets
   * one as it starts.
   */
  allowNTLMCredentialsForDomains(_domains: string): void {
    // Nothing to do on Domicile: see above.
  }

  /** The engine writes a page's storage out itself. */
  flushStorageData(): void {
    // Nothing to do on Domicile: see above.
  }

  getCacheSize() {
    return Promise.resolve(0);
  }

  /** Opens connections to `url` early, in the session's network. */
  preconnect(options: { url: string; numSockets?: number }) {
    this.#calls.preconnect(options);
  }

  isPersistent() {
    const partition = partitions.get(this) ?? "";
    return partition === "" || partition.startsWith("persist:");
  }

  /**
   * A frame preload runs in each page of the session the app opens from
   * then on, before the page's own, as each window's preload does.
   */
  registerPreloadScript(script: PreloadScriptRegistration) {
    const id = script.id ?? randomUUID();
    if (this.#preloads.some((each) => each.id === id)) {
      throw new Error(
        `a preload script ${JSON.stringify(id)} is already registered`,
      );
    } else if (!isAbsolute(script.filePath)) {
      throw new Error(
        `a preload script's filePath must be absolute, not ${script.filePath}`,
      );
    } else if (script.type === "service-worker") {
      throw new Error(
        "Domicile's engine runs no preload in service workers yet",
      );
    } else if (
      [
        script.matches,
        script.excludeMatches,
        script.includeGlobs,
        script.excludeGlobs,
      ].some((patterns) => patterns !== undefined)
    ) {
      throw new Error(
        "Domicile's engine runs a session's preloads in every page, so it can't match them yet",
      );
    }
    this.#preloads = [
      ...this.#preloads,
      { filePath: script.filePath, id, type: script.type },
    ];
    return id;
  }

  unregisterPreloadScript(id: string) {
    if (!this.#preloads.some((each) => each.id === id)) {
      throw new Error(`no preload script ${JSON.stringify(id)} is registered`);
    }
    this.#preloads = this.#preloads.filter((each) => each.id !== id);
    this.#setPreloadIds.delete(id);
  }

  getPreloadScripts() {
    return this.#preloads.map((script) => ({ ...script }));
  }

  /** Electron's older form: the frame preloads it last set. */
  setPreloads(preloads: readonly string[]) {
    for (const id of this.#setPreloadIds) {
      this.unregisterPreloadScript(id);
    }
    this.#setPreloadIds = new Set(
      preloads.map((filePath) =>
        this.registerPreloadScript({ filePath, type: "frame" }),
      ),
    );
  }

  getPreloads() {
    return framePreloadsOf(this);
  }

  /** Where the engine keeps the session's data; null for one in memory. */
  getStoragePath() {
    if (this.isPersistent()) {
      const path = storagePaths.get(this);
      if (path === undefined) {
        throw new Error(
          `the engine hasn't named session ${JSON.stringify(sessionPartition(this))}'s storage path yet`,
        );
      } else {
        return path;
      }
    } else {
      return null;
    }
  }

  get storagePath() {
    return this.getStoragePath();
  }

  setCodeCachePath(path: string) {
    this.#calls.setCodeCachePath(path);
  }

  clearCodeCaches(options: { urls?: readonly string[] }) {
    return this.#calls.clearCodeCaches(options);
  }

  clearData(options?: ClearDataOptions) {
    return this.#calls.clearData(options);
  }

  clearAuthCache() {
    return this.#calls.clearAuthCache();
  }

  resolveHost(host: string, options?: ResolveHostOptions) {
    return this.#calls.resolveHost(host, options);
  }

  clearSharedDictionaryCache() {
    return this.#calls.clearSharedDictionaryCache();
  }

  clearSharedDictionaryCacheForIsolationKey(key: SharedDictionaryIsolationKey) {
    return this.#calls.clearSharedDictionaryCacheForIsolationKey(key);
  }

  getSharedDictionaryInfo(key: SharedDictionaryIsolationKey) {
    return this.#calls.getSharedDictionaryInfo(key);
  }

  getSharedDictionaryUsageInfo() {
    return this.#calls.getSharedDictionaryUsageInfo();
  }

  /**
   * A blob's data, by the UUID a request's uploadData names. The engine's
   * webRequest names no blob, so there is none the app could ask for.
   */
  getBlobData(identifier: string): Promise<Buffer> {
    return Promise.reject(
      new Error(
        `no blob ${identifier}: Domicile's engine names no blob to the app`,
      ),
    );
  }

  // The engine's own checks stand: an app's handlers for certificates and
  // devices aren't asked, so nothing is let through that wouldn't be.
  setCertificateVerifyProc(_proc: unknown): void {
    // Nothing to do on Domicile: see above.
  }
  setDevicePermissionHandler(_handler: unknown): void {
    // Nothing to do on Domicile: see above.
  }
  setBluetoothPairingHandler(_handler: unknown): void {
    // Nothing to do on Domicile: see above.
  }
  setUSBProtectedClassesHandler(_handler: unknown): void {
    // Nothing to do on Domicile: see above.
  }

  setPermissionRequestHandler(handler: PermissionRequestHandler | null) {
    this.#permissions.setPermissionRequestHandler(handler);
  }

  setPermissionCheckHandler(handler: PermissionCheckHandler | null) {
    this.#permissions.setPermissionCheckHandler(handler);
  }

  /** The desktop's picker answers instead: see desktop-capturer.ts. */
  setDisplayMediaRequestHandler(
    handler: DisplayMediaRequestHandler | null,
    options?: { useSystemPicker?: boolean },
  ) {
    setDisplayMediaRequestHandler(handler, options);
  }

  clearStorageData(options?: ClearStorageDataOptions) {
    return this.#calls.clearStorageData(options);
  }

  clearCache() {
    return this.#calls.clearCache();
  }

  setUserAgent(userAgent: string, acceptLanguages?: string) {
    this.#calls.setUserAgent(userAgent, acceptLanguages);
  }

  getUserAgent() {
    return this.#calls.getUserAgent();
  }
}

/** The Electron partition `session` was made for, "" the app's own. */
export const sessionPartition = (session: Session) => {
  const partition = partitions.get(session);
  if (partition === undefined) {
    throw new Error("every Session is made by createSessions");
  } else {
    return partition;
  }
};

/**
 * Electron's `session` module for an app whose protocols are `protocols`,
 * whose webRequest listeners are `webRequests`, whose session calls go
 * through `calls` and whose permission handlers are `permissions`. `created`
 * hears each session as it is made, for `app`'s `session-created`.
 */
export const createSessions = (
  protocols: ReturnType<typeof createProtocols>,
  webRequests: ReturnType<typeof createWebRequests>,
  calls: ReturnType<typeof createSessionCalls>,
  permissions: ReturnType<typeof createPermissions>,
  created: (session: Session) => void,
) => {
  const made = new Map<string, Session>();
  /** The engine's dictionaries loaded so far, which every session checks with. */
  const dictionaries = new Set<string>();
  const fromPartition = (partition: string) => {
    const found = made.get(partition);
    if (found === undefined) {
      const session = new Session(
        partition,
        protocols.forSession(partition),
        webRequests.forSession(partition),
        calls.forSession(partition),
        permissions.forSession(partition),
      );
      made.set(partition, session);
      created(session);
      // After the app's listeners, as Electron loads a session's dictionaries
      // once it is made. Those loaded later each session hears as they load.
      const loaded = [...dictionaries];
      setImmediate(() => {
        for (const language of loaded) {
          session.emit(
            "spellcheck-dictionary-initialized",
            eventOf(),
            language,
          );
        }
      });
      return session;
    } else {
      return found;
    }
  };
  /**
   * The persistent session named by `path`. The engine keeps its storage in
   * the app's profile, as every session's, rather than at `path`.
   */
  const fromPath = (path: string, _options?: { cache?: boolean }) => {
    if (isAbsolute(path)) {
      return fromPartition(`persist:${path}`);
    } else {
      throw new Error("An absolute path is required");
    }
  };
  const madeNamed = (name: string) => {
    const session = made.get(name);
    if (session === undefined) {
      throw new Error(
        `the engine named session ${JSON.stringify(name)}, which the app never made`,
      );
    } else {
      return session;
    }
  };
  /** Fires `preconnect` on the session a page's resource hint was in. */
  const heardPreconnect = (preconnect: IncomingPreconnect) => {
    madeNamed(preconnect.session).emit(
      "preconnect",
      eventOf(),
      preconnect.url,
      preconnect.allow_credentials,
    );
  };
  /**
   * Fires `spellcheck-dictionary-initialized` on every session, as the app's
   * sessions share the engine's dictionaries.
   */
  const heardDictionary = ({ language }: { readonly language: string }) => {
    dictionaries.add(language);
    for (const session of made.values()) {
      session.emit("spellcheck-dictionary-initialized", eventOf(), language);
    }
  };
  /** Passes `event` to the service workers of the session it names. */
  const heardServiceWorker = (event: ServiceWorkerEvent) => {
    const session = made.get(event.session);
    const watching =
      session === undefined ? undefined : watchedWorkers.get(session);
    if (watching === undefined) {
      throw new Error(
        `the engine reported a service worker of session ${JSON.stringify(event.session)}, which watches none`,
      );
    }
    watching.heard(event);
  };
  return {
    defaultSession: fromPartition(""),
    fromPartition,
    fromPath,
    heardDictionary,
    heardPreconnect,
    heardServiceWorker,
  };
};

/**
 * Has `page`, one of `session`'s, emulate the session's network conditions
 * from now on, until the returned stop.
 */
export const followNetworkEmulation = (
  session: Session,
  page: { readonly set: (method: PageMethod) => void },
) => {
  const emulation = emulations.get(session);
  if (emulation === undefined) {
    throw new Error("every Session is made by createSessions");
  } else {
    return emulation.follow(page);
  }
};

/** Electron's `Event` for a session's events, which nothing prevents. */
const eventOf = () => ({ preventDefault: () => undefined });

/** The frame preloads `session` runs in each page, in order. */
export const framePreloadsOf = (session: Session) =>
  session
    .getPreloadScripts()
    .filter(({ type }) => type === "frame")
    .map(({ filePath }) => filePath);

/** Asks the engine where `session` keeps its data, for getStoragePath. */
export const learnStoragePath = async (session: Session) => {
  const calls = sessionCalls.get(session);
  if (calls === undefined) {
    throw new Error("every Session is made by createSessions");
  } else if (session.isPersistent()) {
    storagePaths.set(session, await calls.storagePath());
  }
};

/** The `cookies.set` details for a `Set-Cookie` line a response to `url` had. */
export const cookieFrom = (url: string, line: string) => {
  const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
  const split = pair.indexOf("=");
  const details: {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
    sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  } = {
    name: pair.slice(0, split),
    url,
    value: pair.slice(split + 1),
  };
  for (const attribute of attributes) {
    const [key = "", value = ""] = attribute.split("=");
    switch (key.toLowerCase()) {
      case "domain":
        details.domain = value;
        break;
      case "path":
        details.path = value;
        break;
      case "secure":
        details.secure = true;
        break;
      case "httponly":
        details.httpOnly = true;
        break;
      case "max-age":
        details.expirationDate = Date.now() / 1000 + Number(value);
        break;
      case "expires":
        details.expirationDate ??= Date.parse(value) / 1000;
        break;
      case "samesite":
        details.sameSite =
          value.toLowerCase() === "none"
            ? "no_restriction"
            : (value.toLowerCase() as "lax" | "strict");
        break;
    }
  }
  return details;
};
