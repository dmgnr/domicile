// The stand-in for Electron's `session.webRequest`: each session's listeners
// for its pages' requests, which the engine asks over the Electron socket.
// See "Requests" in docs/architecture/ELECTRON-APPS.md.

/** The webRequest events, by their names on the wire. */
const events = {
  before_redirect: "onBeforeRedirect",
  before_request: "onBeforeRequest",
  before_send_headers: "onBeforeSendHeaders",
  completed: "onCompleted",
  error_occurred: "onErrorOccurred",
  headers_received: "onHeadersReceived",
  response_started: "onResponseStarted",
  send_headers: "onSendHeaders",
} as const;

type EventName = keyof typeof events;

/** What the host tells the engine of a session's webRequest listeners. */
export type WebRequestMessage =
  | {
      readonly type: "web_request_listen";
      readonly session: string;
      readonly events: EventName[];
    }
  | {
      readonly type: "web_request_answer";
      readonly ask: number;
      readonly cancel?: boolean;
      readonly redirect_url?: string;
      readonly request_headers?: [string, string][];
      readonly response_headers?: [string, string][];
      readonly status_line?: string;
    };

/** An event of a page's request, as the engine sends it. */
export type IncomingWebRequest = {
  readonly event: EventName;
  /** Set when the request waits for the answer. */
  readonly ask?: number | undefined;
  readonly id: number;
  readonly session: string;
  readonly window?: number | undefined;
  readonly url: string;
  readonly method: string;
  readonly resource_type: string;
  readonly referrer: string;
  readonly request_headers?: [string, string][] | undefined;
  readonly response_headers?: [string, string][] | undefined;
  readonly status_code?: number | undefined;
  readonly status_line?: string | undefined;
  readonly redirect_url?: string | undefined;
  readonly error?: string | undefined;
  readonly from_cache?: boolean | undefined;
  readonly ip?: string | undefined;
};

/** Electron's `WebRequestFilter`. */
export type WebRequestFilter = {
  readonly urls?: readonly string[];
  readonly excludeUrls?: readonly string[];
  readonly types?: readonly string[];
};

/** What Electron hands a webRequest listener. */
export type WebRequestDetails = {
  id: number;
  url: string;
  method: string;
  webContentsId?: number;
  webContents?: unknown;
  resourceType: string;
  referrer: string;
  timestamp: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string[]>;
  statusCode?: number;
  statusLine?: string;
  redirectURL?: string;
  error?: string;
  fromCache?: boolean;
  ip?: string;
};

/** What a waiting event's listener may answer with. */
export type WebRequestResponse = {
  cancel?: boolean;
  redirectURL?: string;
  requestHeaders?: Record<string, string | string[]>;
  responseHeaders?: Record<string, string | string[]>;
  statusLine?: string;
};

type Waiting = (
  details: WebRequestDetails,
  callback: (response?: WebRequestResponse) => void,
) => void;
type Told = (details: WebRequestDetails) => void;

type On<L> = {
  (listener: L | null): void;
  (filter: WebRequestFilter, listener: L | null): void;
};

/** Electron's `WebRequest`, one per session. */
export type WebRequest = {
  readonly onBeforeRequest: On<Waiting>;
  readonly onBeforeSendHeaders: On<Waiting>;
  readonly onSendHeaders: On<Told>;
  readonly onHeadersReceived: On<Waiting>;
  readonly onResponseStarted: On<Told>;
  readonly onBeforeRedirect: On<Told>;
  readonly onCompleted: On<Told>;
  readonly onErrorOccurred: On<Told>;
};

type Listening = {
  readonly filter: WebRequestFilter;
  readonly listener: Waiting | Told;
};

/**
 * The webRequest listeners of an app's sessions, named by Electron
 * partition. `send` tells the engine; `webContentsOf` finds the page of a
 * window by its number.
 */
export const createWebRequests = (
  send: (message: WebRequestMessage) => void,
  webContentsOf: (window: number) => { readonly id: number } | undefined,
) => {
  const sessions = new Map<string, Map<EventName, Listening>>();

  const forSession = (session: string): WebRequest => {
    const listeners =
      sessions.get(session) ??
      (() => {
        const made = new Map<EventName, Listening>();
        sessions.set(session, made);
        return made;
      })();
    const on =
      (event: EventName) =>
      (
        first: WebRequestFilter | Waiting | Told | null,
        second?: Waiting | Told | null,
      ) => {
        const filter =
          typeof first === "function" || first === null ? {} : first;
        const listener =
          typeof first === "function" || first === null ? first : second;
        if (listener === null || listener === undefined) {
          listeners.delete(event);
        } else {
          listeners.set(event, { filter, listener });
        }
        send({
          events: (Object.keys(events) as EventName[]).filter((name) =>
            listeners.has(name),
          ),
          session,
          type: "web_request_listen",
        });
      };
    return Object.fromEntries(
      (Object.entries(events) as [EventName, string][]).map(
        ([event, method]) => [method, on(event)],
      ),
    ) as WebRequest;
  };

  /** Hands `incoming` to its listener, and answers when it waits. */
  const hear = (incoming: IncomingWebRequest) => {
    const { ask } = incoming;
    const listening = sessions.get(incoming.session)?.get(incoming.event);
    if (
      listening === undefined ||
      !matchesFilter(listening.filter, incoming.url, incoming.resource_type)
    ) {
      if (ask !== undefined) {
        send({ ask, type: "web_request_answer" });
      }
      return;
    }
    const details = detailsOf(incoming, webContentsOf);
    if (ask === undefined) {
      (listening.listener as Told)(details);
      return;
    }
    let answered = false;
    const callback = (response: WebRequestResponse = {}) => {
      if (!answered) {
        answered = true;
        send(answerOf(ask, incoming.event, response));
      }
    };
    try {
      (listening.listener as Waiting)(details, callback);
    } catch (error) {
      // As in Electron, the throw is the app's to see; the request goes no
      // further than its listener did.
      callback({ cancel: true });
      throw error;
    }
  };

  return { forSession, hear };
};

const detailsOf = (
  incoming: IncomingWebRequest,
  webContentsOf: (window: number) => { readonly id: number } | undefined,
): WebRequestDetails => {
  const webContents =
    incoming.window === undefined ? undefined : webContentsOf(incoming.window);
  return {
    id: incoming.id,
    method: incoming.method,
    referrer: incoming.referrer,
    resourceType: incoming.resource_type,
    timestamp: Date.now(),
    url: incoming.url,
    ...(webContents === undefined
      ? {}
      : { webContents, webContentsId: webContents.id }),
    ...(incoming.request_headers === undefined
      ? {}
      : { requestHeaders: requestHeadersOf(incoming.request_headers) }),
    ...(incoming.response_headers === undefined
      ? {}
      : { responseHeaders: responseHeadersOf(incoming.response_headers) }),
    ...(incoming.status_code === undefined
      ? {}
      : { statusCode: incoming.status_code }),
    ...(incoming.status_line === undefined
      ? {}
      : { statusLine: incoming.status_line }),
    ...(incoming.redirect_url === undefined
      ? {}
      : { redirectURL: incoming.redirect_url }),
    ...(incoming.error === undefined ? {} : { error: incoming.error }),
    ...(incoming.from_cache === undefined
      ? {}
      : { fromCache: incoming.from_cache }),
    ...(incoming.ip === undefined ? {} : { ip: incoming.ip }),
  };
};

/** Electron's requestHeaders: one value a name, repeats joined. */
const requestHeadersOf = (pairs: [string, string][]) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of pairs) {
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return headers;
};

/** Electron's responseHeaders: every value of each name. */
const responseHeadersOf = (pairs: [string, string][]) => {
  const headers: Record<string, string[]> = {};
  for (const [name, value] of pairs) {
    headers[name] = [...(headers[name] ?? []), value];
  }
  return headers;
};

const pairsOf = (headers: Record<string, string | string[]>) =>
  Object.entries(headers).flatMap(([name, values]) =>
    (Array.isArray(values) ? values : [values]).map(
      (value): [string, string] => [name, String(value)],
    ),
  );

/** The answer to `ask` for `event`: only what that event may change. */
const answerOf = (
  ask: number,
  event: EventName,
  response: WebRequestResponse,
): WebRequestMessage => ({
  ask,
  type: "web_request_answer",
  ...(response.cancel === undefined ? {} : { cancel: response.cancel }),
  ...(event === "before_request" && response.redirectURL !== undefined
    ? { redirect_url: response.redirectURL }
    : {}),
  ...(event === "before_send_headers" && response.requestHeaders !== undefined
    ? { request_headers: pairsOf(response.requestHeaders) }
    : {}),
  ...(event === "headers_received" && response.responseHeaders !== undefined
    ? { response_headers: pairsOf(response.responseHeaders) }
    : {}),
  ...(event === "headers_received" && response.statusLine !== undefined
    ? { status_line: response.statusLine }
    : {}),
});

const matchesFilter = (
  filter: WebRequestFilter,
  url: string,
  resourceType: string,
) =>
  (filter.urls === undefined ||
    filter.urls.length === 0 ||
    filter.urls.some((pattern) => matchesUrlPattern(pattern, url))) &&
  !(filter.excludeUrls ?? []).some((pattern) =>
    matchesUrlPattern(pattern, url),
  ) &&
  (filter.types === undefined ||
    filter.types.length === 0 ||
    filter.types.includes(resourceType));

const escapeRegExp = (text: string) =>
  text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `url` matches `pattern`, one of Chromium's URL patterns:
 * `<all_urls>`, or scheme://host/path, where the scheme `*` is http or
 * https (or ws or wss), the host `*` is any and `*.` any subdomain, a port
 * is optional, and `*` in the path is anything.
 */
export const matchesUrlPattern = (pattern: string, url: string) => {
  if (pattern === "<all_urls>") {
    return true;
  }
  const parts = /^([^:]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parts === null) {
    return false;
  }
  const [, scheme = "", hostAndPort = "", path = ""] = parts;
  const urlScheme = parsed.protocol.slice(0, -1);
  const schemeMatches =
    scheme === "*"
      ? ["http", "https", "ws", "wss"].includes(urlScheme)
      : scheme === urlScheme;
  const [host = "", port] = hostAndPort.split(":");
  const hostMatches =
    host === "*" ||
    (host.startsWith("*.")
      ? parsed.hostname === host.slice(2) ||
        parsed.hostname.endsWith(host.slice(1))
      : parsed.hostname === host);
  const portMatches =
    port === undefined || port === "*" || parsed.port === port;
  const pathMatches = new RegExp(
    `^${path.split("*").map(escapeRegExp).join(".*")}$`,
  ).test(parsed.pathname + parsed.search);
  return schemeMatches && hostMatches && portMatches && pathMatches;
};
