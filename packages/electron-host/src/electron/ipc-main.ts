// The stand-in for Electron's `ipcMain`: what the pages of the app's windows
// send through their preloads' `ipcRenderer`.

import { EventEmitter } from "node:events";
import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";

import type { MessagePortMain } from "./message-port-main";

/** The page a message came from: its window's `webContents`. */
export type IpcSender = {
  readonly id: number;
  readonly send: (channel: string, ...args: unknown[]) => void;
  /**
   * The page's own `webContents.ipc`, which hears only this page, ahead of
   * `ipcMain`.
   */
  readonly ipc?: IpcMain;
  /**
   * The page's main frame, the one frame that sends: an event's
   * `senderFrame`, which apps check before they answer (Slack drops a message
   * without one).
   */
  readonly mainFrame?: {
    readonly processId: number;
    readonly routingId: number;
  };
  /**
   * The page's `webContents` as an emitter: it says `ipc-message` and
   * `ipc-message-sync` ahead of every other listener, as in Electron.
   */
  readonly emit?: (event: string, ...args: unknown[]) => boolean;
  readonly listenerCount?: (event: string) => number;
};

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** What an `ipcMain.handle` handler gets first. */
export type IpcMainInvokeEvent = ReturnType<typeof invokeEvent>;

/** What an `ipcMain.on` listener gets first. */
export type IpcMainEvent = ReturnType<typeof messageEvent>;

/**
 * The `ipcMain` an Electron app sees, and what the host calls with each
 * page's `send` and `invoke`.
 */
export const createIpcMain = () => {
  const ipcMain = new IpcMain();
  return {
    invoke: (sender: IpcSender, channel: string, args: unknown[]) =>
      (sender.ipc?.handles(channel) ? sender.ipc : ipcMain).invoked(
        sender,
        channel,
        args,
      ),
    ipcMain,
    /** A page's `ipcRenderer.postMessage`, with the ports that came with it. */
    post: (
      sender: IpcSender,
      channel: string,
      message: unknown,
      ports: readonly MessagePortMain[],
    ) => {
      sender.ipc?.emit(channel, { ...messageEvent(sender), ports }, message);
      ipcMain.emit(channel, { ...messageEvent(sender), ports }, message);
    },
    receive: (sender: IpcSender, channel: string, args: unknown[]) => {
      const event = messageEvent(sender);
      sender.emit?.("ipc-message", event, channel, ...args);
      sender.ipc?.emit(channel, event, ...args);
      ipcMain.emit(channel, event, ...args);
    },
    /**
     * A page's `sendSync`, answered with the first `returnValue` a listener
     * sets, whenever it sets it: the page waits until then, as in Electron.
     * One nobody listens for fails, as nothing could answer it.
     */
    sendSync: (
      sender: IpcSender,
      channel: string,
      args: unknown[],
    ): Promise<Result<{ readonly result: unknown }, string>> =>
      (sender.listenerCount?.("ipc-message-sync") ?? 0) +
        (sender.ipc?.listenerCount(channel) ?? 0) +
        ipcMain.listenerCount(channel) ===
      0
        ? Promise.resolve(
            Err(`Nothing listens for '${channel}' to set its returnValue`),
          )
        : new Promise((resolve) => {
            const event = syncEvent(sender, resolve);
            sender.emit?.("ipc-message-sync", event, channel, ...args);
            sender.ipc?.emit(channel, event, ...args);
            ipcMain.emit(channel, event, ...args);
          }),
  };
};

/**
 * Electron's `ipcMain`. A class because the app listens on it as an
 * `EventEmitter`.
 */
export class IpcMain extends EventEmitter {
  #handlers = new Map<string, Handler>();

  /** Answers each `ipcRenderer.invoke` on `channel`. One per channel. */
  readonly handle = (channel: string, handler: Handler) => {
    if (this.#handlers.has(channel)) {
      throw new Error(
        `Attempted to register a second handler for '${channel}'`,
      );
    }
    this.#handlers.set(channel, handler);
  };

  /** Answers the next `ipcRenderer.invoke` on `channel`, then stops. */
  readonly handleOnce = (channel: string, handler: Handler) => {
    this.handle(channel, (event, ...args) => {
      this.removeHandler(channel);
      return handler(event, ...args);
    });
  };

  /** Whether something answers invokes on `channel`. */
  readonly handles = (channel: string) => this.#handlers.has(channel);

  readonly removeHandler = (channel: string) => {
    this.#handlers.delete(channel);
  };

  /**
   * The handler's answer to an invoke, or why there is none. A handler that
   * throws fails the page's promise with what it threw, as in Electron: the
   * app's bug is the page's to see.
   */
  readonly invoked = async (
    sender: IpcSender,
    channel: string,
    args: unknown[],
  ): Promise<Result<{ readonly result: unknown }, string>> => {
    const handler = this.#handlers.get(channel);
    if (handler === undefined) {
      return Err(`No handler registered for '${channel}'`);
    } else {
      try {
        return Ok({ result: await handler(invokeEvent(sender), ...args) });
      } catch (error) {
        return Err(String(error));
      }
    }
  };
}

const invokeEvent = (sender: IpcSender) => ({
  frameId: sender.mainFrame?.routingId ?? 0,
  processId: sender.mainFrame?.processId ?? 0,
  sender,
  senderFrame: sender.mainFrame ?? null,
});

const messageEvent = (sender: IpcSender) => ({
  ...invokeEvent(sender),
  /** Answers on the page's `ipcRenderer`. */
  reply: (channel: string, ...args: unknown[]) => {
    sender.send(channel, ...args);
  },
});

/** A `sendSync`'s event: setting its `returnValue` answers the page. */
const syncEvent = (
  sender: IpcSender,
  answer: (result: Result<{ readonly result: unknown }, string>) => void,
) => {
  const set: { value?: unknown } = {};
  return {
    ...messageEvent(sender),
    get returnValue(): unknown {
      return set.value;
    },
    set returnValue(result: unknown) {
      set.value = result;
      answer(Ok({ result }));
    },
  };
};
