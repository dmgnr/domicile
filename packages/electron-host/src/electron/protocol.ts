// The stand-in for Electron's `protocol`: each session's handlers for the
// requests its pages make, answered over the engine. See "Requests" in
// docs/architecture/ELECTRON-APPS.md.

import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What the host asks the engine about a session's protocols. */
export type ProtocolRequest =
  | {
      readonly type: "handle_protocol" | "unhandle_protocol";
      readonly session: string;
      readonly scheme: string;
    }
  | {
      readonly type: "protocol_response";
      readonly request: number;
      readonly status: number;
      readonly headers: [string, string][];
      readonly body: string;
    }
  | {
      readonly type: "protocol_response";
      readonly request: number;
      readonly status: number;
      readonly headers: [string, string][];
      readonly file: string;
    }
  | {
      readonly type: "protocol_response";
      readonly request: number;
      readonly status: number;
      readonly headers: [string, string][];
      readonly stream: true;
    }
  | {
      readonly type: "protocol_response";
      readonly request: number;
      readonly error: string;
    }
  | {
      readonly type: "protocol_data";
      readonly request: number;
      readonly data: string;
    }
  | {
      readonly type: "protocol_end";
      readonly request: number;
      readonly error?: string;
    };

/** A page's request in a scheme its session handles, as the engine sends it. */
export type IncomingRequest = {
  readonly request: number;
  readonly session: string;
  readonly url: string;
  readonly method: string;
  readonly headers: [string, string][];
  /** Base64, when the request has a body. */
  readonly body?: string | undefined;
};

export type ProtocolHandler = (
  request: Request,
) => Response | Promise<Response>;

/** Electron's `Protocol`, one per session. */
export type Protocol = {
  readonly handle: (scheme: string, handler: ProtocolHandler) => void;
  readonly unhandle: (scheme: string) => void;
  readonly isProtocolHandled: (scheme: string) => boolean;
  /** Asks `handler` for the scheme ahead of its own: false when one is. */
  readonly intercept: (scheme: string, handler: ProtocolHandler) => boolean;
  readonly unintercept: (scheme: string) => boolean;
  readonly isIntercepted: (scheme: string) => boolean;
  /** Serves the scheme from directories on disk, as its one handler. */
  readonly registerSource: (scheme: string, source: ProtocolSource) => void;
  readonly getSource: (scheme: string) => ProtocolSource | null;
};

/** Electron's `ProtocolSource`: which directory serves which URLs. */
export type ProtocolSource = {
  readonly routes: readonly {
    readonly match?: { readonly host?: string; readonly path?: string };
    readonly source: {
      readonly type: string;
      readonly root: string;
      readonly index?: string;
      readonly headers?: Readonly<Record<string, string>>;
    };
  }[];
};

/**
 * The protocols of an app's sessions, named by Electron partition ("" the
 * app's own). Every session serves `file:` from the file system, as Electron
 * does, until the app handles `file:` itself. `send` asks the engine.
 */
export const createProtocols = (send: (request: ProtocolRequest) => void) => {
  const sessions = new Map<string, SessionHandlers>();

  const forSession = (session: string) => {
    const { handlers, interceptors, sources } =
      sessions.get(session) ??
      (() => {
        const made = {
          handlers: new Map(),
          interceptors: new Map(),
          sources: new Map(),
        };
        sessions.set(session, made);
        send({ scheme: "file", session, type: "handle_protocol" });
        return made;
      })();
    /** Whether the engine sends the app `scheme`'s requests. file: always. */
    const reaches = (scheme: string) =>
      handled(scheme) || interceptors.has(scheme);
    /** Whether the scheme has a handler or a source. file: always. */
    const handled = (scheme: string) =>
      scheme === "file" || handlers.has(scheme) || sources.has(scheme);
    /** Adds `handler` to `table`, telling the engine if it now reaches. */
    const add = <T>(table: Map<string, T>, scheme: string, handler: T) => {
      const reached = reaches(scheme);
      table.set(scheme, handler);
      if (!reached) {
        send({ scheme, session, type: "handle_protocol" });
      }
    };
    /** Removes `scheme` from `table`, telling the engine if it no longer reaches. */
    const remove = <T>(table: Map<string, T>, scheme: string) => {
      const had = table.delete(scheme);
      if (had && !reaches(scheme)) {
        send({ scheme, session, type: "unhandle_protocol" });
      }
      return had;
    };
    const protocol: Protocol = {
      getSource: (scheme) => sources.get(scheme) ?? null,
      handle: (scheme, handler) => {
        if (handlers.has(scheme) || sources.has(scheme)) {
          throw new Error(`Failed to register protocol: ${scheme}`);
        }
        add(handlers, scheme, handler);
      },
      intercept: (scheme, handler) => {
        const free = !interceptors.has(scheme);
        if (free) {
          add(interceptors, scheme, handler);
        }
        return free;
      },
      isIntercepted: (scheme) => interceptors.has(scheme),
      isProtocolHandled: handled,
      registerSource: (scheme, source) => {
        if (handlers.has(scheme) || sources.has(scheme)) {
          throw new Error(`Failed to register protocol: ${scheme}`);
        }
        for (const { source: route } of source.routes) {
          if (route.type !== "directory") {
            throw new TypeError(
              `a source's type must be "directory", not ${JSON.stringify(route.type)}`,
            );
          } else if (!isAbsolute(route.root)) {
            throw new TypeError(
              `a source's root must be an absolute path: ${route.root}`,
            );
          }
        }
        add(sources, scheme, source);
      },
      unhandle: (scheme) => {
        remove(handlers, scheme);
        remove(sources, scheme);
      },
      unintercept: (scheme) => remove(interceptors, scheme),
    };
    return withLegacyProtocols(protocol);
  };

  /** Answers `incoming` with its session's handler, or why there is none. */
  const answer = async (incoming: IncomingRequest) => {
    const { request } = incoming;
    const scheme = new URL(incoming.url).protocol.slice(0, -1);
    const handlers = sessions.get(incoming.session);
    const handler =
      handlers?.interceptors.get(scheme) ?? handlers?.handlers.get(scheme);
    const source = handlers?.sources.get(scheme);
    if (handler !== undefined) {
      await respond(send, request, scheme, () => handler(asRequest(incoming)));
    } else if (source !== undefined) {
      send(fromSource(source, incoming));
    } else if (scheme === "file") {
      send(fromFileSystem(incoming));
    } else {
      // The app unhandled the scheme as the page asked.
      send({
        error: `nothing handles ${scheme}: in this session`,
        request,
        type: "protocol_response",
      });
    }
  };

  return { answer, forSession };
};

/** The answer `source` gives `incoming`: a file the engine reads, or none. */
const fromSource = (
  source: ProtocolSource,
  incoming: IncomingRequest,
): ProtocolRequest => {
  const file =
    incoming.method === "GET" || incoming.method === "HEAD"
      ? sourceFile(source, new URL(incoming.url))
      : undefined;
  return file === undefined
    ? {
        error: FILE_NOT_FOUND,
        request: incoming.request,
        type: "protocol_response",
      }
    : {
        file: file.path,
        headers: file.headers,
        request: incoming.request,
        status: 200,
        type: "protocol_response",
      };
};

/**
 * A `file:` URL's file, for the engine to read, ranges and all. One naming
 * another host has no path here.
 */
const fromFileSystem = (incoming: IncomingRequest): ProtocolRequest => {
  const { request } = incoming;
  try {
    return {
      file: fileURLToPath(incoming.url),
      headers: [],
      request,
      status: 200,
      type: "protocol_response",
    };
  } catch (error) {
    return { error: whyFailed(error), request, type: "protocol_response" };
  }
};

/** A session's handlers and sources, and its interceptors that come before them. */
type SessionHandlers = {
  readonly handlers: Map<string, ProtocolHandler>;
  readonly interceptors: Map<string, ProtocolHandler>;
  readonly sources: Map<string, ProtocolSource>;
};

/** What a source answers for what it doesn't serve, as Chromium names it. */
const FILE_NOT_FOUND = "net::ERR_FILE_NOT_FOUND";

/**
 * The file `source` serves for `url`, and the headers it adds, or none. A
 * route with a host wins over one without, then the longest path; the rest
 * of the URL's path is a path inside its root, which it can't leave.
 */
const sourceFile = (source: ProtocolSource, url: URL) => {
  const route = source.routes
    .map(({ match, source: served }) => ({
      host: match?.host,
      path: match?.path ?? "/",
      served,
    }))
    .filter(
      ({ host, path }) =>
        (host === undefined || host.toLowerCase() === url.host.toLowerCase()) &&
        url.pathname.startsWith(path),
    )
    .sort(
      (a, b) =>
        Number(b.host !== undefined) - Number(a.host !== undefined) ||
        b.path.length - a.path.length,
    )[0];
  if (route === undefined) {
    return undefined;
  } else {
    const rest = decodeURIComponent(url.pathname.slice(route.path.length));
    const index = route.served.index ?? "index.html";
    const wantsIndex = rest === "" || rest.endsWith("/");
    const path = join(route.served.root, rest, wantsIndex ? index : "");
    const inside = relative(route.served.root, path);
    const leaves =
      inside === "" || inside === ".." || inside.startsWith(`..${sep}`);
    return leaves || (wantsIndex && index === "")
      ? undefined
      : { headers: Object.entries(route.served.headers ?? {}), path };
  }
};

/** What `protocol.registerSchemesAsPrivileged` is given for each scheme. */
export type CustomScheme = {
  readonly scheme: string;
  readonly privileges?: Readonly<Record<string, boolean | undefined>>;
};

const asRequest = (incoming: IncomingRequest) =>
  new Request(incoming.url, {
    headers: incoming.headers,
    method: incoming.method,
    ...(incoming.body === undefined
      ? {}
      : { body: Buffer.from(incoming.body, "base64") }),
  });

const respond = async (
  send: (request: ProtocolRequest) => void,
  request: number,
  scheme: string,
  handle: () => Response | Promise<Response>,
) => {
  let response: Response;
  try {
    response = await handle();
  } catch (error) {
    send({ error: whyFailed(error), request, type: "protocol_response" });
    return;
  }
  if (response.type === "error") {
    send({
      error: `the ${scheme}: handler answered with a network error`,
      request,
      type: "protocol_response",
    });
  } else if (response.body === null) {
    send({
      body: "",
      headers: headerPairs(response.headers),
      request,
      status: response.status,
      type: "protocol_response",
    });
  } else {
    send({
      headers: headerPairs(response.headers),
      request,
      status: response.status,
      stream: true,
      type: "protocol_response",
    });
    try {
      for await (const piece of response.body) {
        send({
          data: Buffer.from(piece).toString("base64"),
          request,
          type: "protocol_data",
        });
      }
      send({ request, type: "protocol_end" });
    } catch (error) {
      send({ error: whyFailed(error), request, type: "protocol_end" });
    }
  }
};

/** A response's headers as pairs, each Set-Cookie its own. */
const headerPairs = (headers: Headers): [string, string][] => [
  ...[...headers.entries()].filter(([name]) => name !== "set-cookie"),
  ...headers
    .getSetCookie()
    .map((cookie): [string, string] => ["set-cookie", cookie]),
];

const whyFailed = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** What an Electron 24-style protocol handler hands its callback. */
type LegacyAnswer =
  | string
  | Uint8Array
  | NodeJS.ReadableStream
  | {
      readonly error?: number;
      readonly path?: string;
      readonly data?: string | Uint8Array | NodeJS.ReadableStream;
      readonly url?: string;
      readonly method?: string;
      readonly mimeType?: string;
      readonly charset?: string;
      readonly statusCode?: number;
      readonly headers?: Record<string, string | string[]>;
    };

type LegacyKind = "buffer" | "file" | "http" | "stream" | "string";

/** Electron's `ProtocolRequest`, from the request `handle` gives. */
const legacyRequest = async (request: Request) => ({
  headers: Object.fromEntries(request.headers),
  method: request.method,
  referrer: request.headers.get("referer") ?? "",
  uploadData:
    request.body === null
      ? []
      : [{ bytes: Buffer.from(await request.arrayBuffer()), type: "rawData" }],
  url: request.url,
});

const isStream = (value: unknown): value is NodeJS.ReadableStream =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { pipe?: unknown }).pipe === "function";

/** Chromium's net errors a handler answers with, as HTTP statuses. */
const statusOfError = (error: number) =>
  error === -6 || error === -10 ? 404 : 500;

/** The `Response` a legacy handler's answer of `kind` stands for. */
export const legacyResponse = async (
  kind: LegacyKind,
  answer: LegacyAnswer,
): Promise<Response> => {
  const options =
    typeof answer === "string" ||
    answer instanceof Uint8Array ||
    isStream(answer)
      ? {}
      : answer;
  if (options.error !== undefined) {
    return new Response(null, { status: statusOfError(options.error) });
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    for (const each of [value].flat()) {
      headers.append(name, each);
    }
  }
  if (options.mimeType !== undefined) {
    headers.set(
      "content-type",
      options.charset === undefined
        ? options.mimeType
        : `${options.mimeType}; charset=${options.charset}`,
    );
  }
  const status = options.statusCode ?? 200;
  const data =
    typeof answer === "string" ||
    answer instanceof Uint8Array ||
    isStream(answer)
      ? answer
      : answer.data;
  if (kind === "file") {
    const path = typeof answer === "string" ? answer : options.path;
    if (path === undefined) {
      return new Response(null, { status: 404 });
    }
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return new Response(null, { status: 404 });
    }
    if (!headers.has("content-type") && file.type !== "") {
      headers.set("content-type", file.type);
    }
    return new Response(file, { headers, status });
  } else if (kind === "http") {
    if (options.url === undefined) {
      return new Response(null, { status: 500 });
    }
    return fetch(options.url, { method: options.method ?? "GET" });
  } else if (isStream(data)) {
    const { Readable } = await import("node:stream");
    return new Response(
      Readable.toWeb(data as import("node:stream").Readable) as ReadableStream,
      { headers, status },
    );
  } else {
    return new Response(data ?? null, { headers, status });
  }
};

/**
 * Electron's `register*Protocol`, `intercept*Protocol` and their undoing and
 * asking, which apps written before `protocol.handle` call, on top of
 * `protocol`'s `handle` and `intercept`.
 */
export const withLegacyProtocols = <P extends Protocol>(protocol: P) => {
  const legacy = new Set<string>();
  const register =
    (kind: LegacyKind) => (scheme: string, handler: LegacyHandler) => {
      if (protocol.isProtocolHandled(scheme) && scheme !== "file") {
        return false;
      }
      protocol.handle(scheme, fromLegacy(kind, handler));
      legacy.add(scheme);
      return true;
    };
  const intercept =
    (kind: LegacyKind) => (scheme: string, handler: LegacyHandler) =>
      protocol.intercept(scheme, fromLegacy(kind, handler));
  return Object.assign(protocol, {
    interceptBufferProtocol: intercept("buffer"),
    interceptFileProtocol: intercept("file"),
    interceptHttpProtocol: intercept("http"),
    interceptStreamProtocol: intercept("stream"),
    interceptStringProtocol: intercept("string"),
    isProtocolIntercepted: protocol.isIntercepted,
    isProtocolRegistered: (scheme: string) => legacy.has(scheme),
    registerBufferProtocol: register("buffer"),
    registerFileProtocol: register("file"),
    registerHttpProtocol: register("http"),
    registerStreamProtocol: register("stream"),
    registerStringProtocol: register("string"),
    uninterceptProtocol: protocol.unintercept,
    unregisterProtocol: (scheme: string) => {
      const had = legacy.delete(scheme);
      if (had) {
        protocol.unhandle(scheme);
      }
      return had;
    },
  });
};

/** An Electron 24-style handler, which answers through its callback. */
type LegacyHandler = (
  request: unknown,
  callback: (answer: LegacyAnswer) => void,
) => void;

/** `protocol.handle`'s handler for a legacy handler answering `kind`. */
const fromLegacy =
  (kind: LegacyKind, handler: LegacyHandler): ProtocolHandler =>
  async (request) => {
    const asked = await legacyRequest(request);
    const answer = await new Promise<LegacyAnswer>((resolve) => {
      handler(asked, resolve);
    });
    return legacyResponse(kind, answer);
  };
