// The stand-in for Electron's main-process `WebSocket` (also `net.WebSocket`):
// Bun's WebSocket, with Electron's options. With `useSessionCookies` the
// handshake carries the session's cookies, read before it starts, so the
// socket connects a moment later. Cookies the handshake's answer sets are not
// kept: Bun doesn't show the answer's headers.

type Cookie = { readonly name: string; readonly value: string };

/** The sessions a socket can belong to: Electron's `session` module's. */
type Sessions<S extends SocketSession> = {
  readonly defaultSession: S;
  readonly fromPartition: (partition: string) => S;
};

type SocketSession = {
  readonly cookies: {
    readonly get: (filter: { url: string }) => Promise<readonly Cookie[]>;
  };
};

/** Electron's `WebSocketOptions`. */
type WebSocketOptions<S> = {
  readonly headers?: Record<string, string>;
  readonly origin?: string;
  readonly partition?: string;
  readonly protocols?: string | string[];
  readonly session?: S;
  readonly useSessionCookies?: boolean;
};

type BinaryType = "nodebuffer" | "arraybuffer" | "blob";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const FORWARDED = ["open", "message", "error", "close"] as const;
type Forwarded = (typeof FORWARDED)[number];

/** Electron's `WebSocket` class, its sessions found in `sessions`. */
export const createWebSocket = <S extends SocketSession>(
  sessions: Sessions<S>,
) =>
  class WebSocket extends EventTarget {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;

    readonly url: string;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    #socket: globalThis.WebSocket | undefined;
    #binaryType: BinaryType = "nodebuffer";
    // Set when the app closes the socket before it has connected.
    #closedEarly = false;

    constructor(
      url: string,
      protocolsOrOptions?: string | string[] | WebSocketOptions<S>,
    ) {
      super();
      this.url = new URL(url).href;
      const options =
        typeof protocolsOrOptions === "string" ||
        Array.isArray(protocolsOrOptions)
          ? { protocols: protocolsOrOptions }
          : (protocolsOrOptions ?? {});
      const headers = {
        origin: options.origin ?? httpOrigin(this.url),
        ...options.headers,
      };
      if (options.useSessionCookies === true) {
        const session =
          options.session ?? sessions.fromPartition(options.partition ?? "");
        session.cookies
          .get({ url: httpUrl(this.url) })
          .then((cookies) => {
            if (!this.#closedEarly) {
              this.#connect(options.protocols, {
                ...headers,
                ...(cookies.length > 0 && { cookie: cookieHeader(cookies) }),
              });
            }
          })
          .catch((error: unknown) => {
            this.#fail(error);
          });
      } else {
        this.#connect(options.protocols, headers);
      }
    }

    get readyState(): number {
      return (
        this.#socket?.readyState ?? (this.#closedEarly ? CLOSED : CONNECTING)
      );
    }

    get protocol() {
      return this.#socket?.protocol ?? "";
    }

    get extensions() {
      return this.#socket?.extensions ?? "";
    }

    get bufferedAmount() {
      return this.#socket?.bufferedAmount ?? 0;
    }

    get binaryType(): BinaryType {
      return this.#binaryType;
    }

    set binaryType(type: BinaryType) {
      this.#binaryType = type;
      if (this.#socket !== undefined) {
        this.#socket.binaryType = type;
      }
    }

    send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
      if (
        this.#socket === undefined ||
        this.#socket.readyState === CONNECTING
      ) {
        throw new DOMException(
          "Still in CONNECTING state.",
          "InvalidStateError",
        );
      } else {
        this.#socket.send(data as Parameters<globalThis.WebSocket["send"]>[0]);
      }
    }

    close(code?: number, reason?: string) {
      if (this.#socket === undefined) {
        if (!this.#closedEarly) {
          this.#closedEarly = true;
          this.#emit(
            "close",
            new CloseEvent("close", {
              code: code ?? 1005,
              reason: reason ?? "",
              wasClean: false,
            }),
          );
        }
      } else {
        this.#socket.close(code, reason);
      }
    }

    #connect(
      protocols: string | string[] | undefined,
      headers: Record<string, string>,
    ) {
      // Bun's constructor takes the handshake's headers, as browsers' can't.
      const socket = new globalThis.WebSocket(this.url, {
        headers,
        protocols,
      } as unknown as string[]);
      socket.binaryType = this.#binaryType;
      for (const type of FORWARDED) {
        socket.addEventListener(type, (event) => {
          this.#emit(type, copyOf(event));
        });
      }
      this.#socket = socket;
    }

    #fail(error: unknown) {
      this.#closedEarly = true;
      this.#emit("error", new ErrorEvent("error", { error }));
      this.#emit(
        "close",
        new CloseEvent("close", { code: 1006, reason: "", wasClean: false }),
      );
    }

    #emit(type: Forwarded, event: Event) {
      this.dispatchEvent(event);
      const handler = {
        close: this.onclose,
        error: this.onerror,
        message: this.onmessage,
        open: this.onopen,
      }[type] as ((event: Event) => void) | null;
      handler?.call(this, event);
    }
  };

/** `ws:` and `wss:` as the `http:` and `https:` they upgrade from. */
const httpUrl = (url: string) => url.replace(/^ws(s?):/, "http$1:");

const httpOrigin = (url: string) => new URL(httpUrl(url)).origin;

const cookieHeader = (cookies: readonly Cookie[]) =>
  cookies.map(({ name, value }) => `${name}=${value}`).join("; ");

/** An event of the inner socket, as one this socket can dispatch. */
const copyOf = (event: Event): Event => {
  if (event instanceof MessageEvent) {
    return new MessageEvent("message", { data: event.data });
  } else if (event instanceof CloseEvent) {
    return new CloseEvent("close", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  } else if (event instanceof ErrorEvent) {
    return new ErrorEvent("error", {
      error: event.error,
      message: event.message,
    });
  } else {
    return new Event(event.type);
  }
};
