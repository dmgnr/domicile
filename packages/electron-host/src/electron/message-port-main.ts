// The stand-ins for Electron's `MessageChannelMain` and `MessagePortMain`, and
// the ports the app shares with its windows' pages over the engine. See
// "Message ports" in docs/architecture/ELECTRON-APPS.md.

import { EventEmitter } from "node:events";

/** What the host asks the engine for a port shared with a page. */
export type PortRequest =
  | {
      readonly type: "port_post";
      readonly window: number;
      readonly port: string;
      readonly data: unknown;
    }
  | {
      readonly type: "port_close";
      readonly window: number;
      readonly port: string;
    };

/** Where a port's messages go: the other end, here or in a page. */
type Peer = {
  readonly post: (data: unknown) => void;
  readonly close: () => void;
};

/** What this module, and only it, does to a port. */
type Control = {
  /** A message from the other end. */
  readonly deliver: (data: unknown) => void;
  /** The other end closed. */
  readonly end: () => void;
  readonly link: (peer: Peer) => void;
  /** The other end, while it's a port here. */
  partner: MessagePortMain | undefined;
};

const controls = new WeakMap<MessagePortMain, Control>();

/**
 * Electron's `MessagePortMain`. Messages wait until `start()`, and the port
 * says `close` when its other end closes.
 */
export class MessagePortMain extends EventEmitter<{
  close: [];
  message: [event: { data: unknown; ports: MessagePortMain[] }];
}> {
  #peer: Peer | undefined = undefined;
  #started = false;
  #waiting: unknown[] = [];

  constructor() {
    super();
    controls.set(this, {
      deliver: (data) => {
        if (this.#started) {
          this.emit("message", { data, ports: [] });
        } else {
          this.#waiting.push(data);
        }
      },
      end: () => {
        if (this.#peer !== undefined) {
          this.#peer = undefined;
          this.emit("close");
        }
      },
      link: (peer) => {
        this.#peer = peer;
      },
      partner: undefined,
    });
  }

  /** Sends `message` to the other end. On a closed port it goes nowhere, as on the web. */
  readonly postMessage = (message: unknown) => {
    this.#peer?.post(message);
  };

  readonly start = () => {
    this.#started = true;
    for (const data of this.#waiting.splice(0)) {
      this.emit("message", { data, ports: [] });
    }
  };

  /** Closes the port. Closing one twice does nothing, as on the web. */
  readonly close = () => {
    const peer = this.#peer;
    this.#peer = undefined;
    peer?.close();
  };
}

/** Electron's `MessageChannelMain`: two ports, each the other's other end. */
export class MessageChannelMain {
  readonly port1 = new MessagePortMain();
  readonly port2 = new MessagePortMain();

  constructor() {
    entangle(this.port1, this.port2);
    entangle(this.port2, this.port1);
  }
}

/** What linked ports ask the other side for, by port name. */
export type LinkedPortRequest =
  | { readonly type: "post"; readonly port: string; readonly data: unknown }
  | { readonly type: "close"; readonly port: string };

/**
 * Ports whose other ends are on another side (a page, a utility process),
 * each named. `send` carries a port's messages and close there, its data as
 * it is; `name` names a port given there.
 */
export const createLinkedPorts = (
  send: (request: LinkedPortRequest) => void,
  name: () => string,
) => {
  const linked = new Map<string, MessagePortMain>();

  const attach = (port: string, local: MessagePortMain) => {
    linked.set(port, local);
    control(local).link({
      close: () => {
        linked.delete(port);
        send({ port, type: "close" });
      },
      post: (data) => {
        send({ data, port, type: "post" });
      },
    });
  };

  return {
    /** The other side closed its end of port `port`. */
    closed: (port: string) => {
      const local = linked.get(port);
      if (local !== undefined) {
        linked.delete(port);
        control(local).end();
      }
    },
    /**
     * Sends `given`, ends of MessageChannelMains, to the other side, and links
     * each one's partner there instead. Returns their names.
     */
    give: (given: readonly MessagePortMain[]) =>
      given
        .map((port) => transfer(port))
        .map((partner) => {
          const port = name();
          attach(port, partner);
          return port;
        }),
    /** The other side went, and every port it had. */
    gone: () => {
      const ended = [...linked.values()];
      linked.clear();
      for (const local of ended) {
        control(local).end();
      }
    },
    /** A message from the other side on port `port`. */
    message: (port: string, data: unknown) => {
      // The other side may send on a port closed here before it heard: the
      // message has nowhere to go, as on the web.
      const local = linked.get(port);
      if (local !== undefined) {
        control(local).deliver(data);
      }
    },
    /** The ports the other side sent with a message, each linked to its end. */
    take: (names: readonly string[]) =>
      names.map((port) => {
        const local = new MessagePortMain();
        attach(port, local);
        return local;
      }),
  };
};

/**
 * The ports an app shares with its windows' pages: each is one end of a pipe
 * whose other end is a MessagePort in the page, named by who made it ("m1"
 * by the app, "r1" by the page). `send` asks the engine.
 */
export const createPagePorts = (send: (request: PortRequest) => void) => {
  const windows = new Map<number, ReturnType<typeof createLinkedPorts>>();
  let next = 1;

  const of = (window: number) => {
    const found = windows.get(window);
    if (found === undefined) {
      const made = createLinkedPorts(
        (request) => {
          send(
            request.type === "post"
              ? {
                  data: asJson(request.data),
                  port: request.port,
                  type: "port_post",
                  window,
                }
              : { port: request.port, type: "port_close", window },
          );
        },
        () => `m${next++}`,
      );
      windows.set(window, made);
      return made;
    } else {
      return found;
    }
  };

  return {
    /** A page closed its end of port `port`. */
    closed: (window: number, port: string) => {
      windows.get(window)?.closed(port);
    },
    /**
     * Sends `given`, ends of MessageChannelMains, to window `window`'s page,
     * and links each one's partner to the page instead. Returns their names.
     */
    give: (window: number, given: readonly MessagePortMain[]) =>
      of(window).give(given),
    /** Window `window`'s page went, and every port it had with it. */
    gone: (window: number) => {
      windows.get(window)?.gone();
      windows.delete(window);
    },
    /** A message from the page on port `port`. */
    message: (window: number, port: string, data: unknown) => {
      windows.get(window)?.message(port, data);
    },
    /** The ports a page sent with a message, each linked to its end there. */
    take: (window: number, names: readonly string[]) => of(window).take(names),
  };
};

const entangle = (from: MessagePortMain, to: MessagePortMain) => {
  const link = control(from);
  link.partner = to;
  link.link({
    close: () => {
      link.partner = undefined;
      control(to).partner = undefined;
      control(to).end();
    },
    post: (data) => {
      control(to).deliver(structuredClone(data));
    },
  });
};

/**
 * Takes `port` out of its channel, for a page or a utility process, and
 * returns its partner.
 */
const transfer = (port: MessagePortMain) => {
  const partner = control(port).partner;
  if (partner === undefined) {
    throw new Error(
      "a MessagePortMain goes elsewhere once, from its MessageChannelMain",
    );
  } else {
    control(port).partner = undefined;
    control(port).link({ close: () => undefined, post: () => undefined });
    control(partner).partner = undefined;
    return partner;
  }
};

const control = (port: MessagePortMain) => {
  const found = controls.get(port);
  if (found === undefined) {
    throw new Error("every MessagePortMain has its control");
  } else {
    return found;
  }
};

/** `data` as it arrives after a trip through JSON. */
const asJson = (data: unknown): unknown =>
  JSON.parse(JSON.stringify([data]))[0];
