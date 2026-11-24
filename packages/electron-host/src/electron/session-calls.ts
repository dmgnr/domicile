// The parts of Electron's `Session` the engine keeps: its cookies, its
// storage and cache, and its user agent. Each is a `session_call` the engine
// answers with a `session_result`. See "Requests" in
// docs/architecture/ELECTRON-APPS.md.

import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { z } from "zod";

/** The calls the host makes on a session, by their names on the wire. */
export type SessionCallMessage = {
  readonly type: "session_call";
  readonly call: number;
  readonly session: string;
  readonly method:
    | "cookies_get"
    | "cookies_set"
    | "cookies_remove"
    | "cookies_flush"
    | "cookies_watch"
    | "clear_storage_data"
    | "clear_cache"
    | "set_user_agent"
    | "clear_data"
    | "clear_auth_cache"
    | "clear_code_caches"
    | "resolve_host"
    | "preconnect_sockets"
    | "storage_path"
    | "set_code_cache_path"
    | "clear_shared_dictionary_cache"
    | "clear_shared_dictionary_cache_for_isolation_key"
    | "get_shared_dictionary_info"
    | "get_shared_dictionary_usage_info"
    | "service_workers_watch";
  readonly [argument: string]: unknown;
};

/** The engine's answer to a session call. */
export type SessionResult =
  | {
      readonly type: "session_result";
      readonly call: number;
      readonly result: unknown;
    }
  | {
      readonly type: "session_result";
      readonly call: number;
      readonly error: string;
    };

/** A change to a watched session's cookies, as the engine says it. */
export type CookieChanged = {
  readonly type: "cookie_changed";
  readonly session: string;
  readonly cookie: Cookie;
  readonly cause: string;
  readonly removed: boolean;
};

/** Electron's `CookiesGetFilter`. */
export type CookiesGetFilter = {
  readonly url?: string;
  readonly name?: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly session?: boolean;
};

/** Electron's `CookiesSetDetails`. */
export type CookiesSetDetails = {
  readonly url: string;
  readonly name?: string;
  readonly value?: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly expirationDate?: number;
  readonly sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
};

/** Electron's `Cookie`, as the engine gives it. */
export type Cookie = {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly hostOnly?: boolean;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly session?: boolean;
  readonly expirationDate?: number;
  readonly sameSite?: string;
};

/** Electron's `Cookies`. */
export type Cookies = {
  readonly get: (filter: CookiesGetFilter) => Promise<Cookie[]>;
  readonly set: (details: CookiesSetDetails) => Promise<void>;
  readonly remove: (url: string, name: string) => Promise<void>;
  readonly flushStore: () => Promise<void>;
};

/** Electron's `ClearStorageDataOptions`; `quotas` has no meaning here. */
export type ClearStorageDataOptions = {
  readonly origin?: string;
  readonly storages?: readonly string[];
  readonly quotas?: readonly string[];
};

/** Electron's `ClearDataOptions`. */
export type ClearDataOptions = {
  readonly dataTypes?: readonly string[];
  readonly origins?: readonly string[];
  readonly excludeOrigins?: readonly string[];
  readonly avoidClosingConnections?: boolean;
  readonly originMatchingMode?:
    | "third-parties-included"
    | "origin-in-all-contexts";
};

/** Electron's `ResolveHostOptions`. */
export type ResolveHostOptions = {
  readonly queryType?: "A" | "AAAA";
  readonly source?: "any" | "system" | "dns" | "mdns" | "localOnly";
  readonly cacheUsage?: "allowed" | "staleAllowed" | "disallowed";
  readonly secureDnsPolicy?: "allow" | "disable";
};

/** Electron's `ResolvedHost`. */
export type ResolvedHost = {
  readonly endpoints: readonly {
    readonly address: string;
    readonly family: "ipv4" | "ipv6" | "unspec";
  }[];
};

/** The key a shared dictionary is kept under, Electron's names. */
export type SharedDictionaryIsolationKey = {
  readonly frameOrigin: string;
  readonly topFrameSite: string;
};

/** Electron's `SharedDictionaryInfo`. */
export type SharedDictionaryInfo = {
  readonly match: string;
  readonly matchDestinations: readonly string[];
  readonly id: string;
  readonly dictionaryUrl: string;
  readonly lastFetchTime: Date;
  readonly responseTime: Date;
  /** Milliseconds. */
  readonly expirationDuration: number;
  readonly lastUsedTime: Date;
  readonly size: number;
  readonly hash: string;
};

/** Electron's `SharedDictionaryUsageInfo`. */
export type SharedDictionaryUsageInfo = SharedDictionaryIsolationKey & {
  readonly totalSizeBytes: number;
};

/** A running service worker, as the engine says it. */
export type RunningServiceWorker = {
  readonly version_id: number;
  readonly scope: string;
  readonly script_url: string;
  readonly render_process_id: number;
};

/** What one session has of these calls. */
export type SessionCalls = {
  /** An EventEmitter as well, for `changed`. */
  readonly cookies: Cookies & EventEmitter;
  readonly clearStorageData: (
    options?: ClearStorageDataOptions,
  ) => Promise<void>;
  readonly clearCache: () => Promise<void>;
  readonly setUserAgent: (userAgent: string, acceptLanguages?: string) => void;
  /** The user agent the app set; "" until it sets one. */
  readonly getUserAgent: () => string;
  readonly clearData: (options?: ClearDataOptions) => Promise<void>;
  readonly clearAuthCache: () => Promise<void>;
  readonly clearCodeCaches: (options: {
    readonly urls?: readonly string[];
  }) => Promise<void>;
  readonly resolveHost: (
    host: string,
    options?: ResolveHostOptions,
  ) => Promise<ResolvedHost>;
  readonly preconnect: (options: {
    readonly url: string;
    readonly numSockets?: number;
  }) => void;
  /** Where the engine keeps the session's data on disk. */
  readonly storagePath: () => Promise<string>;
  /** Where the session keeps the code V8 compiles for its scripts. */
  readonly setCodeCachePath: (path: string) => void;
  readonly clearSharedDictionaryCache: () => Promise<void>;
  readonly clearSharedDictionaryCacheForIsolationKey: (
    key: SharedDictionaryIsolationKey,
  ) => Promise<void>;
  readonly getSharedDictionaryInfo: (
    key: SharedDictionaryIsolationKey,
  ) => Promise<SharedDictionaryInfo[]>;
  readonly getSharedDictionaryUsageInfo: () => Promise<
    SharedDictionaryUsageInfo[]
  >;
  /**
   * Has the engine say each change to the session's service workers, as
   * `service_worker` events; gives the ones running now.
   */
  readonly watchServiceWorkers: () => Promise<RunningServiceWorker[]>;
};

/** A shared dictionary as the engine gives it: its times in milliseconds. */
const wireDictionaries = z.array(
  z.object({
    dictionaryUrl: z.string(),
    expirationDuration: z.number(),
    hash: z.string(),
    id: z.string(),
    lastFetchTime: z.number().transform((time) => new Date(time)),
    lastUsedTime: z.number().transform((time) => new Date(time)),
    match: z.string(),
    matchDestinations: z.array(z.string()),
    responseTime: z.number().transform((time) => new Date(time)),
    size: z.number(),
  }),
);

const wireUsage = z.array(
  z.object({
    frameOrigin: z.string(),
    topFrameSite: z.string(),
    totalSizeBytes: z.number(),
  }),
);

const wireResolvedHost = z.object({
  endpoints: z.array(
    z.object({
      address: z.string(),
      family: z.enum(["ipv4", "ipv6", "unspec"]),
    }),
  ),
});

const wireRunningWorkers = z.array(
  z.object({
    render_process_id: z.number(),
    scope: z.string(),
    script_url: z.string(),
    version_id: z.number(),
  }),
);

const isolationKey = (key: SharedDictionaryIsolationKey) => ({
  frame_origin: key.frameOrigin,
  top_frame_site: key.topFrameSite,
});

/** Drops the keys whose value is undefined, so the line leaves them out. */
const defined = (fields: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

/**
 * The session calls of an app whose requests to the engine go through
 * `send`; `hear` takes the engine's answers. A session without its own user
 * agent has `userAgentFallback`'s, app.userAgentFallback.
 */
export const createSessionCalls = (
  send: (message: SessionCallMessage) => void,
  userAgentFallback: () => string,
) => {
  const waiting = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  let next = 1;

  const call = (
    session: string,
    method: SessionCallMessage["method"],
    args: Record<string, unknown> = {},
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const number = next++;
      waiting.set(number, { reject, resolve });
      send({ ...args, call: number, method, session, type: "session_call" });
    });

  const nothing = (promise: Promise<unknown>) => promise.then(() => undefined);

  // Each session's `cookies`, which hear its changes.
  const cookieEmitters = new Map<string, EventEmitter>();

  /**
   * An EventEmitter, as Electron's is. The engine watches the session's
   * cookies from the first `changed` listener on, so `changed` fires as in
   * Electron.
   */
  const cookiesEmitter = (session: string) => {
    if (cookieEmitters.has(session)) {
      throw new Error(`session ${JSON.stringify(session)} was made twice`);
    }
    const emitter = new EventEmitter();
    cookieEmitters.set(session, emitter);
    let watching = false;
    emitter.on("newListener", (event: string) => {
      if (event === "changed" && !watching) {
        watching = true;
        // A refusal is the engine's bug, and its rejection goes unhandled,
        // loudly.
        void call(session, "cookies_watch");
      }
    });
    return emitter;
  };

  const forSession = (session: string): SessionCalls => {
    let userAgent: string | undefined;
    return {
      clearAuthCache: () => nothing(call(session, "clear_auth_cache")),
      clearCache: () => nothing(call(session, "clear_cache")),
      clearCodeCaches: (options) =>
        nothing(
          call(session, "clear_code_caches", defined({ urls: options.urls })),
        ),
      clearData: (options = {}) =>
        nothing(
          call(
            session,
            "clear_data",
            defined({
              avoid_closing_connections: options.avoidClosingConnections,
              data_types: options.dataTypes,
              exclude_origins: options.excludeOrigins,
              origin_matching_mode: options.originMatchingMode,
              origins: options.origins,
            }),
          ),
        ),
      clearSharedDictionaryCache: () =>
        nothing(call(session, "clear_shared_dictionary_cache")),
      clearSharedDictionaryCacheForIsolationKey: (key) =>
        nothing(
          call(
            session,
            "clear_shared_dictionary_cache_for_isolation_key",
            isolationKey(key),
          ),
        ),
      clearStorageData: (options = {}) =>
        nothing(
          call(
            session,
            "clear_storage_data",
            defined({ origin: options.origin, storages: options.storages }),
          ),
        ),
      cookies: Object.assign<EventEmitter, Cookies>(cookiesEmitter(session), {
        flushStore: () => nothing(call(session, "cookies_flush")),
        get: async (filter) =>
          (await call(session, "cookies_get", {
            filter: defined({
              domain: filter.domain,
              http_only: filter.httpOnly,
              name: filter.name,
              path: filter.path,
              secure: filter.secure,
              session: filter.session,
              url: filter.url,
            }),
          })) as Cookie[],
        remove: (url, name) =>
          nothing(call(session, "cookies_remove", { name, url })),
        set: (details) =>
          nothing(
            call(session, "cookies_set", {
              details: defined({
                domain: details.domain,
                expiration_date: details.expirationDate,
                http_only: details.httpOnly,
                name: details.name,
                path: details.path,
                same_site: details.sameSite,
                secure: details.secure,
                url: details.url,
                value: details.value,
              }),
            }),
          ),
      }),
      getSharedDictionaryInfo: async (key) =>
        wireDictionaries.parse(
          await call(session, "get_shared_dictionary_info", isolationKey(key)),
        ),
      getSharedDictionaryUsageInfo: async () =>
        wireUsage.parse(
          await call(session, "get_shared_dictionary_usage_info"),
        ),
      getUserAgent: () => userAgent ?? userAgentFallback(),
      preconnect: ({ numSockets = 1, url }) => {
        if (!Number.isInteger(numSockets) || numSockets < 1 || numSockets > 6) {
          throw new Error(
            `preconnect's numSockets is 1 to 6, not ${numSockets}`,
          );
        }
        // Electron's is synchronous and says nothing back.
        call(session, "preconnect_sockets", { sockets: numSockets, url }).catch(
          (error: unknown) => {
            // biome-ignore lint/suspicious/noConsole: a refusal is the engine's bug
            console.error(`the engine refused to preconnect to ${url}`, error);
          },
        );
      },
      resolveHost: async (host, options = {}) =>
        wireResolvedHost.parse(
          await call(
            session,
            "resolve_host",
            defined({
              cache_usage: options.cacheUsage,
              host,
              query_type: options.queryType,
              secure_dns_policy: options.secureDnsPolicy,
              source: options.source,
            }),
          ),
        ),
      setCodeCachePath: (path) => {
        if (!isAbsolute(path)) {
          // Electron's own words.
          throw new Error(
            "Absolute path must be provided to store code cache.",
          );
        }
        // Electron's is synchronous and says nothing back.
        call(session, "set_code_cache_path", { path }).catch(
          (error: unknown) => {
            // biome-ignore lint/suspicious/noConsole: a refusal is the engine's bug
            console.error(
              `the engine refused to move the code cache to ${path}`,
              error,
            );
          },
        );
      },
      setUserAgent: (agent) => {
        userAgent = agent;
        // Electron's is synchronous; a refusal is the engine's bug, and its
        // rejection goes unhandled, loudly.
        void call(session, "set_user_agent", { user_agent: agent });
      },
      storagePath: async () =>
        z.string().parse(await call(session, "storage_path")),
      watchServiceWorkers: async () =>
        wireRunningWorkers.parse(await call(session, "service_workers_watch")),
    };
  };

  /** Settles the call `result` answers. */
  const hear = (result: SessionResult) => {
    const found = waiting.get(result.call);
    if (found === undefined) {
      throw new Error(
        `the engine answered session call ${result.call}, which nothing waits for`,
      );
    }
    waiting.delete(result.call);
    if ("error" in result) {
      found.reject(new Error(result.error));
    } else {
      found.resolve(result.result);
    }
  };

  /** Says `change` to its session's `cookies`, as Electron's `changed`. */
  const heardCookie = (change: CookieChanged) => {
    const emitter = cookieEmitters.get(change.session);
    if (emitter === undefined) {
      throw new Error(
        `the engine changed a cookie of session ${JSON.stringify(change.session)}, which this app never made`,
      );
    }
    emitter.emit("changed", {}, change.cookie, change.cause, change.removed);
  };

  return { forSession, hear, heardCookie };
};
