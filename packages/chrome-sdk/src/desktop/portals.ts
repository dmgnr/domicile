// Portal dialogs and the sessions they started: Domicile is the only
// xdg-desktop-portal backend, and the shell draws its dialogs. See
// docs/PORTALS.md.

import type { Result } from "@cprussin/option-result";
import type { DomicileHost } from "../domicile-host";
import type {
  BoundShortcut,
  Capturing,
  KnownAgents,
  PortalAnswer,
  PortalRequest,
  PortalWallpaper,
} from "../portal";
import type { SystemError } from "../system";
import {
  answerPortalRequest,
  changeAgent,
  discardRecording,
  pauseRecording,
  resumeRecording,
  stopCapturing,
  watchBoundShortcuts,
  watchCapturing,
  watchPortalRequests,
  watchPortalWallpaper,
} from "./portal-wire";
import type { On } from "./subscribe";
import { hostEvent, on } from "./subscribe";
import type { System } from "./system-calls";

export type PortalsListeners = {
  /** The compositor pushed: read each part again. */
  change: () => void;
};

/** Each part is `undefined` until the compositor's first push. */
export type Portals = {
  /** Every unanswered request, oldest first. */
  readonly requests: readonly PortalRequest[] | undefined;
  /** Every session that controls or captures input. */
  readonly capturing: readonly Capturing[] | undefined;
  /** Every chord applications hold through the GlobalShortcuts portal. */
  readonly boundShortcuts: readonly BoundShortcut[] | undefined;
  /** The pictures applications set through the Wallpaper portal. */
  readonly wallpaper: PortalWallpaper | undefined;
  /** Answer request `id`. The first answer to reach the compositor wins. */
  answer: (id: number, answer: PortalAnswer) => void;
  /** End capturing session `id`. */
  stopCapturing: (id: number) => void;
  /**
   * Ask the user again what agent session `id` reaches, in a
   * {@link PortalKind.Agent} dialog with its reach as `current`.
   */
  changeAgent: (id: number) => void;
  /**
   * The agents let in now, and those let in without asking. An agent in now
   * is also a {@link CapturingKind.Agent} in {@link Portals.capturing}, which
   * {@link Portals.stopCapturing} ends.
   */
  agents: () => Promise<Result<KnownAgents, SystemError>>;
  /**
   * Make remembered agent `agent` ask again next time. Succeeds whether or
   * not it was remembered.
   */
  forgetAgent: (agent: string) => Promise<Result<"set", SystemError>>;
  /** Pause the shell's screen recording `id`. */
  pauseRecording: (id: number) => void;
  /** Resume the shell's paused screen recording `id`. */
  resumeRecording: (id: number) => void;
  /** End the shell's screen recording `id` and delete its file. */
  discardRecording: (id: number) => void;
  /**
   * Tell the application holding bound shortcut `id` its chord went down or
   * up. See {@link Portals.boundShortcuts}.
   */
  fireShortcut: (id: number, kind: "pressed" | "released") => void;
  on: On<PortalsListeners>;
};

export type PortalsHost = Pick<
  DomicileHost,
  "addEventListener" | "answerPortalRequest" | "removeEventListener"
>;

/** Listens from the start: the engine sends the latest push to a new listener. */
export const portals = (
  host: PortalsHost,
  calls: Pick<System, "agents" | "forgetAgent">,
): Portals => {
  const latest: {
    requests?: readonly PortalRequest[];
    capturing?: readonly Capturing[];
    boundShortcuts?: readonly BoundShortcut[];
    wallpaper?: PortalWallpaper;
  } = {};
  watchPortalRequests(host, (requests) => {
    latest.requests = requests;
  });
  watchCapturing(host, (capturing) => {
    latest.capturing = capturing;
  });
  watchBoundShortcuts(host, (boundShortcuts) => {
    latest.boundShortcuts = boundShortcuts;
  });
  watchPortalWallpaper(host, (wallpaper) => {
    latest.wallpaper = wallpaper;
  });
  return {
    agents: () => calls.agents(),
    answer: (id, answer) => {
      answerPortalRequest(host, id, answer);
    },
    get boundShortcuts() {
      return latest.boundShortcuts;
    },
    get capturing() {
      return latest.capturing;
    },
    changeAgent: (id) => {
      changeAgent(host, id);
    },
    discardRecording: (id) => {
      discardRecording(host, id);
    },
    fireShortcut: (id, kind) => {
      host.answerPortalRequest(id, JSON.stringify({ kind }));
    },
    forgetAgent: (agent) => calls.forgetAgent(agent),
    on: on<PortalsListeners>({
      change: (listener) => hostEvent(host, "portalrequests", () => listener()),
    }),
    pauseRecording: (id) => {
      pauseRecording(host, id);
    },
    get requests() {
      return latest.requests;
    },
    resumeRecording: (id) => {
      resumeRecording(host, id);
    },
    stopCapturing: (id) => {
      stopCapturing(host, id);
    },
    get wallpaper() {
      return latest.wallpaper;
    },
  };
};
