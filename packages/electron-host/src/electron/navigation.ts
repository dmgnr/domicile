// A page's navigations, frames and loads, as Electron's webContents events
// tell them, from what the engine says of them. See "Windows" in
// docs/architecture/ELECTRON-APPS.md.

import type { EngineRequest, NavigationEvent, WireFrame } from "../engine";

/** The events whose listeners a page's navigation waits for. */
export const ASKS_BEFORE_NAVIGATING = [
  "will-navigate",
  "will-frame-navigate",
  "will-redirect",
] as const;

export const asksBeforeNavigating = (name: string | symbol) =>
  (ASKS_BEFORE_NAVIGATING as readonly (string | symbol)[]).includes(name);

/** ERR_ABORTED: a navigation canceled or replaced, which Electron doesn't call a failed load. */
const ABORTED = -3;

/** What the navigation events need of their page. */
export type NavigatingPage<Frame> = {
  /** Emits on the page's webContents. */
  readonly emit: (name: string, ...args: unknown[]) => void;
  /** The frame the engine names, or null when it names none. */
  readonly frame: (frame: WireFrame | undefined, main: boolean) => Frame | null;
  /** `frame` committed `url`, in a new document unless `sameDocument`. */
  readonly committed: (
    frame: Frame | null,
    main: boolean,
    url: string,
    sameDocument: boolean,
  ) => void;
  /** The main frame failed to load `url`, as did-fail-load says. */
  readonly failed: (error: LoadError) => void;
  readonly toEngine: (request: EngineRequest) => void;
};

/** Why a load failed, as Electron's loadURL rejects with it. */
export type LoadError = Error & {
  readonly errno: number;
  readonly code: string;
  readonly url: string;
};

/** Emits what `event` says happened, and answers what it asks. */
export const takeNavigation = <Frame>(
  page: NavigatingPage<Frame>,
  event: NavigationEvent,
) => {
  switch (event.type) {
    case "navigation_started": {
      page.emit("did-start-navigation", ...navigationArguments(page, event));
      break;
    }
    case "navigation_redirected": {
      page.emit("did-redirect-navigation", ...navigationArguments(page, event));
      break;
    }
    case "will_navigate": {
      answering(page, event.ask, () => willNavigate(page, event));
      break;
    }
    case "navigation_committed": {
      committed(page, event);
      break;
    }
    case "load_failed": {
      loadFailed(page, event);
      break;
    }
    case "frame_loaded": {
      page.frame(event.frame, false);
      page.emit(
        "did-frame-finish-load",
        eventObject(),
        false,
        event.frame.process,
        event.frame.routing,
      );
      break;
    }
    case "frame_created": {
      page.emit("frame-created", eventObject(), {
        frame: page.frame(event.frame, event.main_frame),
      });
      break;
    }
    case "will_prevent_unload": {
      const prevented = eventObject();
      // A listener that throws keeps the page, as no listener does.
      try {
        page.emit("will-prevent-unload", prevented);
      } finally {
        page.toEngine({
          ask: event.ask,
          type: "unload_answer",
          unload: prevented.defaultPrevented,
        });
      }
      break;
    }
  }
};

/** Electron's error for a failed load of `url`, as loadURL rejects. */
export const loadError = (
  errno: number,
  code: string,
  url: string,
): LoadError =>
  Object.assign(
    new Error(`${code} (${errno}) loading '${url.slice(0, 2048)}'`),
    {
      code,
      errno,
      url,
    },
  );

/** The event object Electron passes first, which a listener may prevent. */
const eventObject = <Details extends object>(details?: Details) => {
  const event = {
    ...details,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
};

type Navigation = Extract<
  NavigationEvent,
  {
    type: "navigation_started" | "navigation_redirected" | "will_navigate";
  }
>;

/**
 * What Electron passes each navigation event: an event with the
 * navigation's details, then its older arguments.
 */
const navigationArguments = <Frame>(
  page: NavigatingPage<Frame>,
  navigation: Navigation,
) =>
  [
    navigationEvent(page, navigation),
    navigation.url,
    navigation.same_document,
    navigation.main_frame,
    navigation.frame?.process ?? -1,
    navigation.frame?.routing ?? -1,
  ] as const;

const navigationEvent = <Frame>(
  page: NavigatingPage<Frame>,
  navigation: Navigation,
) =>
  eventObject({
    frame: page.frame(navigation.frame, navigation.main_frame),
    // The engine names an initiator by its ids alone, which may be the
    // main frame's.
    initiator:
      navigation.initiator === undefined
        ? null
        : page.frame(navigation.initiator, false),
    isMainFrame: navigation.main_frame,
    isSameDocument: navigation.same_document,
    url: navigation.url,
  });

/**
 * Answers ask `ask` with whether `decide` let the navigation go. A
 * listener that throws lets it go, as no listener does, and the app hears
 * why.
 */
const answering = <Frame>(
  page: NavigatingPage<Frame>,
  ask: number,
  decide: () => boolean,
) => {
  try {
    page.toEngine({ ask, proceed: decide(), type: "navigation_answer" });
  } catch (error) {
    page.toEngine({ ask, proceed: true, type: "navigation_answer" });
    throw error;
  }
};

/**
 * Electron's will-redirect for a redirect; otherwise will-frame-navigate,
 * then, for the main frame, will-navigate. Whether none prevented it.
 */
const willNavigate = <Frame>(
  page: NavigatingPage<Frame>,
  event: Extract<NavigationEvent, { type: "will_navigate" }>,
) => {
  if (event.redirect) {
    return !emitPrevented(page, "will-redirect", event);
  } else if (emitPrevented(page, "will-frame-navigate", event)) {
    return false;
  } else {
    return !(event.main_frame && emitPrevented(page, "will-navigate", event));
  }
};

const emitPrevented = <Frame>(
  page: NavigatingPage<Frame>,
  name: string,
  navigation: Navigation,
) => {
  const [event, ...rest] = navigationArguments(page, navigation);
  page.emit(name, event, ...rest);
  return event.defaultPrevented;
};

const committed = <Frame>(
  page: NavigatingPage<Frame>,
  event: Extract<NavigationEvent, { type: "navigation_committed" }>,
) => {
  const frame = page.frame(event.frame, event.main_frame);
  page.committed(frame, event.main_frame, event.url, event.same_document);
  const process = event.frame?.process ?? -1;
  const routing = event.frame?.routing ?? -1;
  if (event.same_document) {
    page.emit(
      "did-navigate-in-page",
      eventObject(),
      event.url,
      event.main_frame,
      process,
      routing,
    );
  } else {
    page.emit(
      "did-frame-navigate",
      eventObject(),
      event.url,
      event.http_response_code,
      event.http_status_text,
      event.main_frame,
      process,
      routing,
    );
    if (event.main_frame) {
      page.emit(
        "did-navigate",
        eventObject(),
        event.url,
        event.http_response_code,
        event.http_status_text,
      );
    }
  }
};

/**
 * did-fail-provisional-load for an error page, then did-fail-load unless
 * the navigation was aborted; did-fail-load alone for a committed
 * document's failure.
 */
const loadFailed = <Frame>(
  page: NavigatingPage<Frame>,
  event: Extract<NavigationEvent, { type: "load_failed" }>,
) => {
  page.frame(event.frame, event.main_frame);
  const failure = [
    event.error_code,
    event.error_description,
    event.url,
    event.main_frame,
    event.frame?.process ?? -1,
    event.frame?.routing ?? -1,
  ] as const;
  if (event.provisional) {
    page.emit("did-fail-provisional-load", eventObject(), ...failure);
  }
  if (!event.provisional || event.error_code !== ABORTED) {
    page.emit("did-fail-load", eventObject(), ...failure);
    if (event.main_frame) {
      page.failed(
        loadError(event.error_code, event.error_description, event.url),
      );
    }
  }
};
