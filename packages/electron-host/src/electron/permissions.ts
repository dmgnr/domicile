// The stand-in for Electron's `session.setPermissionRequestHandler`: while a
// session has a handler, the engine asks it about its pages' permission
// requests instead of the shell. See "Requests" in
// docs/architecture/ELECTRON-APPS.md.

/** What the host tells the engine of a session's permission handler. */
export type PermissionMessage =
  | {
      readonly type: "permission_handler";
      readonly session: string;
      readonly handle: boolean;
    }
  | {
      readonly type: "permission_answer";
      readonly ask: number;
      readonly granted: boolean;
    };

/** A page's permission request, as the engine sends it. */
export type IncomingPermissionRequest = {
  readonly ask: number;
  readonly session: string;
  readonly window?: number | undefined;
  /** Electron's name for it: "media", "geolocation", "notifications"... */
  readonly permission: string;
  readonly requesting_url: string;
  /** "media"'s kinds: "video", "audio". */
  readonly media_types?: string[] | undefined;
};

/** What Electron hands a permission request handler as its details. */
export type PermissionRequestDetails = {
  requestingUrl: string;
  mediaTypes?: string[];
};

/** Electron's handler: it calls `callback` once with whether to grant. */
export type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: PermissionRequestDetails,
) => void;

/** Electron's check handler, which the engine does not consult yet. */
export type PermissionCheckHandler = (...args: never[]) => boolean;

/** The permission methods of Electron's `Session`. */
export type Permissions = {
  // `null` clears a handler, as in Electron.
  readonly setPermissionRequestHandler: (
    handler: PermissionRequestHandler | null,
  ) => void;
  readonly setPermissionCheckHandler: (
    handler: PermissionCheckHandler | null,
  ) => void;
};

const checkHandlerWarning =
  "setPermissionCheckHandler is not supported on Domicile's engine yet: permission checks answer from what this app's request handler and the user granted before";

/**
 * The permission handlers of an app's sessions, named by Electron partition.
 * `send` tells the engine; `webContentsOf` finds the page of a window by its
 * number; `warn` tells the app's developer what the engine does not do.
 */
export const createPermissions = (
  send: (message: PermissionMessage) => void,
  webContentsOf: (window: number) => { readonly id: number } | undefined,
  warn: (warning: string) => void,
) => {
  const handlers = new Map<string, PermissionRequestHandler>();
  let warned = false;

  const forSession = (session: string): Permissions => ({
    setPermissionCheckHandler: (handler) => {
      if (handler !== null && !warned) {
        warned = true;
        warn(checkHandlerWarning);
      }
    },
    setPermissionRequestHandler: (handler) => {
      if (handler === null) {
        handlers.delete(session);
      } else {
        handlers.set(session, handler);
      }
      send({ handle: handler !== null, session, type: "permission_handler" });
    },
  });

  /** Asks `incoming`'s session's handler, and answers once it says. */
  const hear = (incoming: IncomingPermissionRequest) => {
    const { ask } = incoming;
    const handler = handlers.get(incoming.session);
    let answered = false;
    const callback = (granted: boolean) => {
      if (!answered) {
        answered = true;
        send({ ask, granted, type: "permission_answer" });
      }
    };
    if (handler === undefined) {
      // The app cleared its handler after the engine asked.
      callback(false);
      return;
    }
    const webContents =
      incoming.window === undefined
        ? undefined
        : webContentsOf(incoming.window);
    try {
      // Electron gives a request no page made a null webContents.
      handler(webContents ?? null, incoming.permission, callback, {
        requestingUrl: incoming.requesting_url,
        ...(incoming.media_types === undefined
          ? {}
          : { mediaTypes: incoming.media_types }),
      });
    } catch (error) {
      // As in Electron, the throw is the app's to see; nothing is granted.
      callback(false);
      throw error;
    }
  };

  return { forSession, hear };
};
