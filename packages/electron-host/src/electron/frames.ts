// The frames of a page the engine names in its navigation events: the main
// frame, and an object for each other frame. The engine runs the app's
// scripts and IPC only in a page's main frame, so the others say who they are
// and where they are, and nothing more.

import type { WireFrame } from "../engine";

/** What a page's main frame needs to stand for the engine's main frame. */
export type IdentifiedFrame = {
  readonly identify: (frame: WireFrame) => void;
  readonly processId: number;
  readonly routingId: number;
};

/** A frame of a page but its main frame, as Electron's events give one. */
export class SubFrame<Top> {
  url = "";
  /** Its document went with the main frame's, and it with it. */
  #gone = false;

  constructor(
    readonly processId: number,
    readonly routingId: number,
    readonly top: Top,
  ) {}

  get origin() {
    return URL.canParse(this.url) ? new URL(this.url).origin : "";
  }
  get detached() {
    return this.#gone;
  }
  readonly isDestroyed = () => this.#gone;
  /** The main frame's new document took this frame's away. */
  readonly destroy = () => {
    this.#gone = true;
  };
  readonly executeJavaScript = (_code: string) =>
    Promise.reject(new Error(MAIN_FRAME_ONLY));
  readonly send = (_channel: string) => {
    throw new Error(MAIN_FRAME_ONLY);
  };
  readonly postMessage = (_channel: string) => {
    throw new Error(MAIN_FRAME_ONLY);
  };
}

const MAIN_FRAME_ONLY =
  "Domicile's engine runs the app's scripts and IPC only in a page's main frame";

/**
 * The frames of a page whose main frame is `main`: each `frame` the engine
 * names, the main frame when it is that (`isMain`, or its ids), or null for
 * none.
 */
export const createFrames = <Main extends IdentifiedFrame>(main: Main) => {
  const others = new Map<string, SubFrame<Main>>();
  const frame = (
    wire: WireFrame | undefined,
    isMain: boolean,
  ): Main | SubFrame<Main> | null => {
    if (wire === undefined) {
      return null;
    } else if (isMain) {
      main.identify(wire);
      return main;
    } else if (
      wire.process === main.processId &&
      wire.routing === main.routingId
    ) {
      return main;
    } else {
      const key = `${wire.process}:${wire.routing}`;
      const known = others.get(key);
      const found = known ?? new SubFrame(wire.process, wire.routing, main);
      others.set(key, found);
      return found;
    }
  };
  return {
    /** A new document in the main frame: the old one's frames are gone. */
    clear: () => {
      for (const other of others.values()) {
        other.destroy();
      }
      others.clear();
    },
    frame,
  };
};
