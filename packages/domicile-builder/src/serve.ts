// Serves a shell entry from a Vite dev server on a unix socket, with hot
// module replacement. The engine reads the shell's files from the socket and
// serves them to the page over `domicile://shell/`, so no TCP port is open.
// See docs/WRITING-A-SHELL.md#hot-module-replacement.

import { chmodSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";

import type {
  HotChannel,
  HotChannelClient,
  HotPayload,
  Plugin,
  ViteDevServer,
} from "vite";
import { createServer, DevEnvironment } from "vite";
import { z } from "zod";

import { fromDomicile, manganeseIn } from "./bundle";

/**
 * The module the engine's shell document imports. Only unreserved characters:
 * the engine escapes the rest in the document, and Vite would not undo it.
 */
export const DEV_MODULE = "domicile-dev-shell.js";

/** Where the page's HMR transport reads updates from and sends messages to. */
export const HMR_PATH = "/@domicile/hmr";

/** The response header that names a page's HMR connection. */
const CLIENT_HEADER = "x-domicile-hmr-client";

/** Vite's client module, which the transform below gives a socket it can use. */
const VITE_CLIENT = /\/vite\/dist\/client\/client\.mjs$/;

type Listener = (data: unknown, client: HotChannelClient) => void;

/** A message from the page: Vite's client sends only custom events. */
const pageMessage = z.object({
  data: z.unknown(),
  event: z.string(),
  type: z.literal("custom"),
});

/** One page connected for updates: a response that never ends. */
type Connection = {
  readonly client: HotChannelClient;
  readonly response: ServerResponse;
};

/**
 * Vite's HMR channel over plain requests, in place of its WebSocket server.
 *
 * A page reads updates from a GET of {@link HMR_PATH}, one JSON payload per
 * line, and sends its messages (`import.meta.hot.send`, invalidations) as
 * POSTs naming its connection. The shell page cannot open a WebSocket to its
 * own origin: `domicile://` is not a network scheme.
 */
const requestChannel = () => {
  const connections = new Map<string, Connection>();
  const listeners = new Map<string, Set<Listener>>();
  let opened = 0;
  // Vite buffers an error or reload sent while no page is connected, so a
  // page that connects late still hears it. This does the same.
  let buffered: HotPayload | undefined;

  const write = (response: ServerResponse, payload: HotPayload): void => {
    response.write(`${JSON.stringify(payload)}\n`);
  };

  const emit = (event: string, data: unknown, client: HotChannelClient) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(data, client);
    }
  };

  const connect = (response: ServerResponse): void => {
    opened += 1;
    const id = String(opened);
    const client: HotChannelClient = {
      send: (payload: HotPayload) => {
        write(response, payload);
      },
    };
    connections.set(id, { client, response });
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson",
      [CLIENT_HEADER]: id,
    });
    // Flushes the head, so the page's fetch resolves and it counts as open.
    write(response, { type: "connected" });
    response.on("close", () => {
      connections.delete(id);
      emit("vite:client:disconnect", undefined, client);
    });
    emit("vite:client:connect", undefined, client);
    if (buffered !== undefined) {
      write(response, buffered);
      buffered = undefined;
    }
  };

  const receive = (id: string, body: string): boolean => {
    const connection = connections.get(id);
    if (connection === undefined) {
      return false;
    }
    const message = pageMessage.parse(JSON.parse(body));
    emit(message.event, message.data, connection.client);
    return true;
  };

  const channel = {
    close: () => {
      for (const { response } of connections.values()) {
        response.end();
      }
      connections.clear();
    },
    off: (event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    },
    on: (event: string, listener: Listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    send: (payload: HotPayload) => {
      if (
        connections.size === 0 &&
        (payload.type === "error" || payload.type === "full-reload")
      ) {
        buffered = payload;
        return;
      }
      for (const { response } of connections.values()) {
        write(response, payload);
      }
    },
  } satisfies HotChannel;

  return { channel, connect, receive };
};

/**
 * A stand-in for the WebSocket Vite's client opens, over {@link HMR_PATH}.
 * Implements what Vite's transport uses: `open`, `message`, `close` and
 * `error` listeners, `readyState`, `send` and `close`.
 */
const HMR_SOCKET = `class DomicileHmrSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  #abort = new AbortController();
  #client;
  #sending = Promise.resolve();
  constructor(_url, protocol) {
    super();
    this.#run(protocol).catch((error) => {
      console.error("[domicile] the HMR connection failed", error);
    });
  }
  async #run(protocol) {
    let response;
    try {
      response = await fetch(${JSON.stringify(HMR_PATH)} + (protocol === "vite-ping" ? "?ping" : ""), { signal: this.#abort.signal });
    } catch (error) {
      // Closed as a WebSocket that cannot connect is: Vite's client then
      // pings until the server is back, and reloads.
      console.error("[domicile] cannot reach the dev server", error);
      response = undefined;
    }
    if (response === undefined || !response.ok) {
      this.readyState = 3;
      this.dispatchEvent(new Event("error"));
      this.dispatchEvent(new CloseEvent("close", { wasClean: false }));
      return;
    }
    this.#client = response.headers.get(${JSON.stringify(CLIENT_HEADER)});
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
    const lines = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    let wasClean = true;
    try {
      for (;;) {
        const { done, value } = await lines.read();
        if (done) {
          break;
        }
        pending += value;
        let end = pending.indexOf("\\n");
        while (end !== -1) {
          this.dispatchEvent(new MessageEvent("message", { data: pending.slice(0, end) }));
          pending = pending.slice(end + 1);
          end = pending.indexOf("\\n");
        }
      }
    } catch (error) {
      // close() aborts the read; anything else is the stream breaking.
      if (!this.#abort.signal.aborted) {
        console.error("[domicile] the dev server's updates stopped", error);
        wasClean = false;
      }
    }
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { wasClean }));
  }
  send(data) {
    const client = this.#client;
    // In order, as a WebSocket's; one that fails does not stop the rest.
    this.#sending = this.#sending
      .then(() => fetch(${JSON.stringify(HMR_PATH)} + "?client=" + client, { body: data, method: "POST" }))
      .then((sent) => {
        if (!sent.ok) {
          throw new Error("the dev server answered " + sent.status);
        }
      })
      .catch((error) => {
        console.error("[domicile] an HMR message did not reach the dev server", error);
      });
  }
  close() {
    this.readyState = 2;
    this.#abort.abort();
  }
}
`;

/**
 * Gives Vite's client {@link HMR_SOCKET} in place of `WebSocket`. Throws if
 * the client no longer opens one, rather than leaving a page with no updates.
 */
const hmrOverRequests = (): Plugin => ({
  enforce: "post",
  name: "domicile:hmr-over-requests",
  transform(code, id) {
    if (!VITE_CLIENT.test(id)) {
      return null;
    }
    const replaced = code.replaceAll(
      "new WebSocket(",
      "new DomicileHmrSocket(",
    );
    if (replaced === code) {
      throw new Error(
        "domicile-builder: Vite's client no longer opens a WebSocket, so the shell would get no updates. The builder's HMR transport needs updating for this Vite.",
      );
    }
    return { code: `${HMR_SOCKET}\n${replaced}`, map: null };
  },
});

/** A document for the plugins' `transformIndexHtml` to add their scripts to. */
const STUB_DOCUMENT = "<!doctype html><html><head></head><body></body></html>";

/** A `<script>` element: its attributes, then its text. */
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;

/** What the plugins added to `document`, beyond {@link STUB_DOCUMENT}. */
const ADDED_TAG = /<(?!\/?(?:html|head|body|script)\b|!doctype)[^>]+>/gi;

/**
 * The scripts Vite and its plugins add to a document, as module code: Vite's
 * client, and preambles like React Fast Refresh's. The engine writes the
 * shell's document, so they run from the module instead. Throws on a tag a
 * module cannot add, rather than serving a shell missing it.
 */
export const documentScripts = (document: string): string => {
  const added = document.replaceAll(SCRIPT, "").match(ADDED_TAG);
  if (added !== null) {
    throw new Error(
      `domicile-builder: a Vite plugin adds ${added.join(", ")} to the page, and Domicile writes the shell's document itself. Import what it needs from the shell instead.`,
    );
  }
  return [...document.matchAll(SCRIPT)]
    .map(([, attributes = "", text = ""]) => {
      const source = /\bsrc="([^"]+)"/.exec(attributes)?.[1];
      return source === undefined ? text : `import ${JSON.stringify(source)};`;
    })
    .join("\n");
};

/**
 * The module the shell document imports: the scripts a document would have
 * (see {@link documentScripts}), then the entry's exports. An edit the entry
 * does not accept reloads the page.
 */
const devModule = (entry: string): Plugin => {
  const id = `/${DEV_MODULE}`;
  const preamble = "/@domicile/preamble.js";
  let server: ViteDevServer | undefined;
  return {
    configureServer(configured) {
      server = configured;
    },
    enforce: "pre",
    async load(source) {
      if (source === id) {
        return [
          `import ${JSON.stringify(preamble)};`,
          `export * from ${JSON.stringify(`/@fs${entry}`)};`,
        ].join("\n");
      } else if (source === preamble) {
        if (server === undefined) {
          throw new Error(
            "domicile-builder: the shell's preamble was asked for outside the dev server.",
          );
        }
        return documentScripts(
          await server.transformIndexHtml("/", STUB_DOCUMENT),
        );
      } else {
        return null;
      }
    },
    name: "domicile:dev-module",
    resolveId(source) {
      return source === id || source === preamble ? source : null;
    },
  };
};

/** Answer the page's HMR requests; anything else goes to Vite. */
const hmrRoutes =
  (hmr: ReturnType<typeof requestChannel>) =>
  (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void => {
    const url = new URL(request.url ?? "/", "http://shell");
    if (url.pathname !== HMR_PATH) {
      next();
    } else if (request.method === "GET" && url.searchParams.has("ping")) {
      // Vite's client pings to learn when a restarted server is back.
      response.writeHead(204);
      response.end();
    } else if (request.method === "GET") {
      hmr.connect(response);
    } else if (request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const id = url.searchParams.get("client");
        response.writeHead(
          id !== null && hmr.receive(id, Buffer.concat(chunks).toString("utf8"))
            ? 204
            : 404,
        );
        response.end();
      });
    } else {
      response.writeHead(405);
      response.end();
    }
  };

/**
 * Aliases for React's packages to their directories in Domicile's install,
 * where manganese resolves them.
 */
const reactFrom = (domicile: string) =>
  ["react", "react-dom"].map((name) => ({
    find: new RegExp(`^${name}(?=/|$)`),
    replacement: path.dirname(
      Bun.resolveSync(`${name}/package.json`, manganeseIn(domicile)),
    ),
  }));

/** A running dev server. */
export type Serving = {
  readonly close: () => Promise<void>;
};

/** What {@link serve} serves, and where. */
export type Served = {
  /** The shell's entry module. */
  readonly entry: string;
  /** The entry's project: the dev server's root. */
  readonly project: string;
  /** The project's vite config, whose plugins and settings apply. */
  readonly config: string | undefined;
  /** Domicile's install, which `@domicile-desktop/*` and React come from. */
  readonly domicile: string;
  /** Vite's dependency cache. */
  readonly cache: string;
  /** The unix socket to serve on, made readable only by this user. */
  readonly socket: string;
};

/** Serve a shell entry for the engine, with hot module replacement. */
export const serve = async ({
  cache,
  config,
  domicile,
  entry,
  project,
  socket,
}: Served): Promise<Serving> => {
  const hmr = requestChannel();
  const vite = await createServer({
    appType: "custom",
    base: "/",
    cacheDir: cache,
    configFile: config ?? false,
    environments: {
      client: {
        dev: {
          createEnvironment: (name, resolved) =>
            new DevEnvironment(name, resolved, {
              hot: true,
              transport: hmr.channel,
            }),
        },
      },
    },
    // Scanned up front, so the first load does not stop to bundle a
    // dependency it finds late.
    optimizeDeps: { entries: [entry], holdUntilCrawlEnd: false },
    plugins: [devModule(entry), fromDomicile(domicile), hmrOverRequests()],
    // Plugins ask Vite to prebundle React by name, which it looks up from the
    // project, where it may not be installed. It is Domicile's, as in a build.
    resolve: { alias: reactFrom(domicile) },
    root: project,
    server: {
      // Vite's host check stops DNS rebinding over TCP. Only this user can
      // reach the socket, and the engine names the host `shell`.
      allowedHosts: true,
      fs: { allow: [project, path.dirname(entry), domicile] },
      middlewareMode: true,
      ws: false,
    },
  });
  const routes = hmrRoutes(hmr);
  const http = createHttpServer((request, response) => {
    routes(request, response, () => {
      vite.middlewares(request, response);
    });
  });
  rmSync(socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(socket, () => {
      resolve();
    });
  });
  // Only this user may ask the server for the shell's sources.
  chmodSync(socket, 0o600);
  return {
    close: async () => {
      hmr.channel.close();
      const closed = new Promise<void>((resolve) => {
        http.close(() => {
          resolve();
        });
      });
      // Idle keep-alive connections would hold the close open.
      http.closeAllConnections();
      await closed;
      await vite.close();
    },
  };
};
