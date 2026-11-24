// The stand-in for Electron's `net`: requests from the main process, with
// Bun's `fetch`, which goes out as Electron's `net` does.

import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { isOnline } from "./online";

type RequestOptions = {
  readonly method?: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly hostname?: string;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly headers?: Record<string, string | string[]>;
  readonly redirect?: "follow" | "error" | "manual";
};

/** Electron's `IncomingMessage`: a readable body with the status and headers. */
const incomingMessage = (response: Response) => {
  const headers: Record<string, string | string[]> = {};
  const rawHeaders: string[] = [];
  response.headers.forEach((value, name) => {
    rawHeaders.push(name, value);
    headers[name] =
      name === "set-cookie" ? response.headers.getSetCookie() : value;
  });
  const body =
    response.body === null
      ? Readable.from([])
      : Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        );
  return Object.assign(body, {
    headers,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    rawHeaders,
    statusCode: response.status,
    statusMessage: response.statusText,
  });
};

const urlOf = (options: string | RequestOptions) => {
  if (typeof options === "string") {
    return options;
  } else if (options.url === undefined) {
    return `${options.protocol ?? "http:"}//${hostOf(options)}${options.path ?? "/"}`;
  } else {
    return options.url;
  }
};

/**
 * Electron's: `host`, which carries its own port, over `hostname` and
 * `port`. Electron skips a port of 0 or NaN, as it does any falsy one.
 */
const hostOf = (options: RequestOptions) => {
  if (options.host === undefined) {
    const port =
      Number.isFinite(options.port) && options.port !== 0
        ? `:${options.port}`
        : "";
    return `${options.hostname ?? "localhost"}${port}`;
  } else {
    return options.host;
  }
};

/** Electron's `ClientRequest`: write the body, `end`, then hear `response`. */
export const clientRequest = (options: string | RequestOptions) => {
  const request = new EventEmitter();
  const url = urlOf(options);
  const opts = typeof options === "string" ? {} : options;
  const headers = new Headers();
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    for (const each of [value].flat()) {
      headers.append(name, each);
    }
  }
  const chunks: Uint8Array[] = [];
  const abort = new AbortController();
  let redirect = opts.redirect ?? "follow";
  let ended = false;
  /** The response, once it starts. */
  let message: ReturnType<typeof incomingMessage> | undefined;

  const send = async () => {
    try {
      const method = opts.method ?? "GET";
      const go = () =>
        fetch(url, {
          body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
          headers,
          method,
          redirect: redirect === "manual" ? "manual" : redirect,
          signal: abort.signal,
        });
      const first = await go();
      const signIn = await askToSignIn(request, url, first);
      if (signIn !== undefined) {
        headers.set("authorization", signIn);
      }
      const response = signIn === undefined ? first : await go();
      if (
        redirect === "manual" &&
        response.status >= 300 &&
        response.status < 400
      ) {
        request.emit(
          "redirect",
          response.status,
          method,
          response.headers.get("location") ?? "",
          {},
        );
      }
      message = incomingMessage(response);
      request.emit("response", message);
      message.on("end", () => request.emit("close"));
    } catch (error) {
      if (abort.signal.aborted) {
        request.emit("abort");
        request.emit("close");
      } else {
        request.emit("error", error);
      }
    }
  };

  return Object.assign(request, {
    /**
     * Stops the request. One aborted before its response fails its fetch,
     * which says so; one aborted mid-body says so here, as Node's does.
     */
    abort: () => {
      abort.abort();
      if (
        message !== undefined &&
        !message.readableEnded &&
        !message.destroyed
      ) {
        message.emit("aborted");
        message.destroy();
        process.nextTick(() => {
          request.emit("abort");
          request.emit("close");
        });
      }
    },
    chunkedEncoding: false,
    end: (
      chunk?: string | Uint8Array,
      _encoding?: string,
      callback?: () => void,
    ) => {
      if (chunk !== undefined) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      if (!ended) {
        ended = true;
        request.emit("finish");
        void send();
      }
      callback?.();
      return request;
    },
    followRedirect: () => {
      redirect = "follow";
    },
    getHeader: (name: string) => headers.get(name) ?? undefined,
    getUploadProgress: () => ({
      active: ended,
      current: 0,
      started: ended,
      total: 0,
    }),
    removeHeader: (name: string) => {
      headers.delete(name);
    },
    setHeader: (name: string, value: string) => {
      headers.set(name, value);
    },
    write: (
      chunk: string | Uint8Array,
      _encoding?: string,
      callback?: () => void,
    ) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      callback?.();
      return true;
    },
  });
};

/**
 * The `Authorization` a `login` listener's callback signs in with, for a
 * response that asks for one; nothing when it doesn't ask, nothing listens
 * or the callback gives no user name, and the response stands, as in
 * Electron.
 */
const askToSignIn = async (
  request: EventEmitter,
  url: string,
  response: Response,
): Promise<string | undefined> => {
  const challenge = response.headers.get("www-authenticate");
  if (
    response.status !== 401 ||
    challenge === null ||
    request.listenerCount("login") === 0
  ) {
    return undefined;
  }
  const scheme = (challenge.split(/\s/, 1)[0] ?? "").toLowerCase();
  const { hostname, port, protocol } = new URL(url);
  const credentials = await new Promise<[string, string] | undefined>(
    (resolve) => {
      request.emit(
        "login",
        {
          host: hostname,
          isProxy: false,
          port: port === "" ? defaultPort(protocol) : Number(port),
          realm: /realm="([^"]*)"/i.exec(challenge)?.[1] ?? "",
          scheme,
        },
        (username?: string, password?: string) => {
          resolve(
            username === undefined ? undefined : [username, password ?? ""],
          );
        },
      );
    },
  );
  if (credentials === undefined) {
    return undefined;
  } else if (scheme === "basic") {
    return `Basic ${Buffer.from(credentials.join(":")).toString("base64")}`;
  } else {
    throw new Error(
      `net.request signs in with Basic only on Domicile, and ${url} asks for ${scheme}`,
    );
  }
};

const defaultPort = (protocol: string) => (protocol === "https:" ? 443 : 80);

/** Electron's `net`, whose `WebSocket` is the host's (see web-socket.ts). */
export const createNet = <W>(WebSocket: W) => ({
  fetch: (input: string | Request, init?: RequestInit) => fetch(input, init),
  isOnline: () => isOnline(),
  get online() {
    return isOnline();
  },
  request: clientRequest,
  resolveHost: async (host: string, _options?: unknown) => {
    const addresses = await lookup(host, { all: true });
    return {
      endpoints: addresses.map(({ address, family }) => ({
        address,
        family: family === 6 ? ("ipv6" as const) : ("ipv4" as const),
      })),
    };
  },
  WebSocket,
});
