/**
 * What an app's webContents hears of its page beyond its state and IPC: its
 * console, preload, sound, fullscreen, icons, cursor and input, with the
 * page's own user agent, mute and menu shortcuts. See electron_page_reports.h
 * in the engine.
 *
 * @module
 */

import type { EventEmitter } from "node:events";
import { z } from "zod";
import { nativeImage } from "./native-image";

const modifiers = z.array(z.string());

/** A mouse event as the engine says it, before-mouse-event's and input-event's. */
const mouseFields = {
  button: z.enum(["left", "middle", "right"]).optional(),
  click_count: z.number(),
  global_x: z.number(),
  global_y: z.number(),
  movement_x: z.number(),
  movement_y: z.number(),
  x: z.number(),
  y: z.number(),
};

const inputEvent = z.object({
  button: mouseFields.button,
  click_count: z.number().optional(),
  delta_x: z.number().optional(),
  delta_y: z.number().optional(),
  global_x: z.number().optional(),
  global_y: z.number().optional(),
  has_precise_scrolling_deltas: z.boolean().optional(),
  key_code: z.string().optional(),
  modifiers,
  movement_x: z.number().optional(),
  movement_y: z.number().optional(),
  type: z.string(),
  wheel_ticks_x: z.number().optional(),
  wheel_ticks_y: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

/** What the engine says of a page here, for engine.ts's events. */
export const pageEventSchemas = [
  z.object({
    level: z.enum(["debug", "info", "warning", "error"]),
    line: z.number(),
    message: z.string(),
    source: z.string(),
    type: z.literal("console_message"),
    window: z.number(),
  }),
  z.object({
    message: z.string(),
    name: z.string(),
    stack: z.string(),
    type: z.literal("preload_error"),
    window: z.number(),
  }),
  z.object({
    responsive: z.boolean(),
    type: z.literal("responsive"),
    window: z.number(),
  }),
  z.object({
    fullscreen: z.boolean(),
    type: z.literal("html_fullscreen"),
    window: z.number(),
  }),
  z.object({
    playing: z.boolean(),
    type: z.literal("media_playing"),
    window: z.number(),
  }),
  z.object({
    audible: z.boolean(),
    type: z.literal("audible"),
    window: z.number(),
  }),
  z.object({
    type: z.literal("favicons"),
    urls: z.array(z.string()),
    window: z.number(),
  }),
  z.object({
    type: z.literal("target_url"),
    url: z.string(),
    window: z.number(),
  }),
  z.object({
    type: z.literal("zoom_asked"),
    window: z.number(),
    zoom_in: z.boolean(),
  }),
  z.object({
    color: z.string().optional(),
    type: z.literal("theme_color"),
    window: z.number(),
  }),
  z.object({
    cursor: z.string(),
    height: z.number().optional(),
    hotspot_x: z.number().optional(),
    hotspot_y: z.number().optional(),
    image: z.string().optional(),
    scale: z.number().optional(),
    type: z.literal("cursor_changed"),
    width: z.number().optional(),
    window: z.number(),
  }),
  z.object({
    height: z.number(),
    type: z.literal("preferred_size"),
    width: z.number(),
    window: z.number(),
  }),
  z.object({
    height: z.number(),
    type: z.literal("content_bounds"),
    width: z.number(),
    window: z.number(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    ask: z.number(),
    input: z.object({
      alt: z.boolean(),
      code: z.string(),
      control: z.boolean(),
      is_auto_repeat: z.boolean(),
      is_composing: z.boolean(),
      key: z.string(),
      location: z.number(),
      meta: z.boolean(),
      modifiers,
      shift: z.boolean(),
      type: z.enum(["keyDown", "keyUp"]),
    }),
    type: z.literal("before_input"),
    window: z.number(),
  }),
  z.object({
    ask: z.number(),
    mouse: z.object({ ...mouseFields, modifiers, type: z.string() }),
    type: z.literal("before_mouse"),
    window: z.number(),
  }),
  z.object({
    event: inputEvent,
    type: z.literal("input_event"),
    window: z.number(),
  }),
] as const;

/** What the engine says of a page here. */
export type PageEvent = z.infer<(typeof pageEventSchemas)[number]>;

const PAGE_EVENTS: ReadonlySet<string> = new Set(
  pageEventSchemas.map((schema) => schema.shape.type.value),
);

/** Whether `event` is one PageEvents takes. */
export const isPageEvent = <Event extends { readonly type: string }>(
  event: Event,
): event is Extract<Event, PageEvent> => PAGE_EVENTS.has(event.type);

/** sendInputEvent's event, as the engine takes it; JSON leaves out what is undefined. */
export type SyntheticInput = {
  readonly type: string;
  readonly modifiers?: readonly string[] | undefined;
  readonly key_code?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly global_x?: number | undefined;
  readonly global_y?: number | undefined;
  readonly movement_x?: number | undefined;
  readonly movement_y?: number | undefined;
  readonly button?: "left" | "middle" | "right" | undefined;
  readonly click_count?: number | undefined;
  readonly delta_x?: number | undefined;
  readonly delta_y?: number | undefined;
  readonly wheel_ticks_x?: number | undefined;
  readonly wheel_ticks_y?: number | undefined;
  readonly has_precise_scrolling_deltas?: boolean | undefined;
  readonly can_scroll?: boolean | undefined;
};

/** What the app asks of its page here, which its window's number completes. */
export type PageEventAction =
  | {
      /** Which of before-input-event, before-mouse-event and input-event it hears. */
      readonly type: "listen_input";
      readonly keys: boolean;
      readonly mouse: boolean;
      readonly events: boolean;
    }
  | {
      /** A before-input-event's or before-mouse-event's listeners ran. */
      readonly type: "input_answer";
      readonly ask: number;
      readonly prevent: boolean;
    }
  | { readonly type: "send_input_event"; readonly event: SyntheticInput }
  | { readonly type: "set_audio_muted"; readonly muted: boolean }
  | { readonly type: "set_ignore_menu_shortcuts"; readonly ignore: boolean }
  | { readonly type: "enable_preferred_size_mode" }
  | { readonly type: "set_page_user_agent"; readonly user_agent: string };

/** A request of window `window`'s page here, for engine.ts's requests. */
export type PageEventRequest = PageEventAction extends infer Action
  ? Action extends unknown
    ? Action & { readonly window: number }
    : never
  : never;

/** console-message's numbers for the levels, Electron's deprecated argument. */
const LEVELS = { debug: 0, error: 3, info: 1, warning: 2 } as const;

const KEY_TYPES: ReadonlySet<string> = new Set(["keyDown", "keyUp", "char"]);
const INPUT_TYPES = [
  "keyDown",
  "keyUp",
  "char",
  "mouseDown",
  "mouseUp",
  "mouseMove",
  "mouseEnter",
  "mouseLeave",
  "contextMenu",
  "mouseWheel",
] as const;

/** sendInputEvent's event, as Electron takes it. */
const ElectronInput = z.object({
  button: z.enum(["left", "middle", "right"]).optional(),
  canScroll: z.boolean().optional(),
  clickCount: z.number().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  globalX: z.number().optional(),
  globalY: z.number().optional(),
  hasPreciseScrollingDeltas: z.boolean().optional(),
  keyCode: z.string().optional(),
  modifiers: z.array(z.string()).optional(),
  movementX: z.number().optional(),
  movementY: z.number().optional(),
  type: z.enum(INPUT_TYPES),
  wheelTicksX: z.number().optional(),
  wheelTicksY: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

/** sendInputEvent's `event` as the engine takes it; throws for one it isn't. */
export const syntheticInput = (event: unknown): SyntheticInput => {
  const given = ElectronInput.parse(event);
  if (KEY_TYPES.has(given.type) && given.keyCode === undefined) {
    throw new TypeError("sendInputEvent's key needs its keyCode");
  }
  return {
    button: given.button,
    can_scroll: given.canScroll,
    click_count: given.clickCount,
    delta_x: given.deltaX,
    delta_y: given.deltaY,
    global_x: given.globalX,
    global_y: given.globalY,
    has_precise_scrolling_deltas: given.hasPreciseScrollingDeltas,
    key_code: given.keyCode,
    modifiers: given.modifiers,
    movement_x: given.movementX,
    movement_y: given.movementY,
    type: given.type,
    wheel_ticks_x: given.wheelTicksX,
    wheel_ticks_y: given.wheelTicksY,
    x: given.x,
    y: given.y,
  };
};

/** An input event the engine says, by Electron's names. */
const electronInput = (event: z.infer<typeof inputEvent>) => ({
  button: event.button,
  clickCount: event.click_count,
  deltaX: event.delta_x,
  deltaY: event.delta_y,
  globalX: event.global_x,
  globalY: event.global_y,
  hasPreciseScrollingDeltas: event.has_precise_scrolling_deltas,
  keyCode: event.key_code,
  modifiers: [...event.modifiers],
  movementX: event.movement_x,
  movementY: event.movement_y,
  type: event.type,
  wheelTicksX: event.wheel_ticks_x,
  wheelTicksY: event.wheel_ticks_y,
  x: event.x,
  y: event.y,
});

/** What PageEvents needs of its webContents and the page it is. */
export type PageEventsOwner = {
  /** The webContents, which hears each event. */
  readonly contents: EventEmitter;
  /** Its BrowserWindow, which hears some too; none for a view. */
  readonly window: () => EventEmitter | undefined;
  /** Sends `action` for the page; only once it is open. */
  readonly send: (action: PageEventAction) => void;
  readonly isOpen: () => boolean;
  /** Its session's user agent, its own when it has none. */
  readonly sessionUserAgent: () => string;
  /** webPreferences.preload, which preload-error names. */
  readonly preloadPath: () => string | undefined;
  /** The event object Electron passes first to a listener. */
  readonly eventObject: () => {
    defaultPrevented: boolean;
    preventDefault: () => void;
  };
};

/** Each listen_input flag, and the event whose listeners it says of. */
const LISTENED = [
  ["events", "input-event"],
  ["keys", "before-input-event"],
  ["mouse", "before-mouse-event"],
] as const;

/** One page's events and settings of these kinds. */
export class PageEvents {
  readonly #owner: PageEventsOwner;
  #userAgent = "";
  #muted = false;
  #audible = false;
  #ignoreMenuShortcuts = false;
  #preferredSizeMode = false;
  /** Whether it has each of LISTENED's listeners, as the engine was told. */
  #listening = { events: false, keys: false, mouse: false };

  constructor(owner: PageEventsOwner) {
    this.#owner = owner;
    this.watch();
  }

  // EventEmitter says newListener before adding it, removeListener after.
  readonly #added = (name: string) => {
    this.#listen(name, 1);
  };
  readonly #removed = (name: string) => {
    this.#listen(name, 0);
  };

  /**
   * Hears the app add and remove listeners, again after its
   * removeAllListeners took these too.
   */
  readonly watch = () => {
    const { contents } = this.#owner;
    if (!contents.listeners("newListener").includes(this.#added)) {
      contents.on("newListener", this.#added);
    }
    if (!contents.listeners("removeListener").includes(this.#removed)) {
      contents.on("removeListener", this.#removed);
    }
    // Bun's removeAllListeners says nothing of what it removed.
    for (const [, event] of LISTENED) {
      this.#listen(event, 0);
    }
  };

  /** What open_window tells the engine of the page. */
  readonly openKeys = (): { user_agent?: string } =>
    this.#userAgent === "" ? {} : { user_agent: this.#userAgent };

  /** The engine opened the page: it hears what the app set before. */
  readonly opened = () => {
    const { events, keys, mouse } = this.#listening;
    if (events || keys || mouse) {
      this.#owner.send({ events, keys, mouse, type: "listen_input" });
    }
    if (this.#muted) {
      this.#owner.send({ muted: true, type: "set_audio_muted" });
    }
    if (this.#ignoreMenuShortcuts) {
      this.#owner.send({ ignore: true, type: "set_ignore_menu_shortcuts" });
    }
    if (this.#preferredSizeMode) {
      this.#owner.send({ type: "enable_preferred_size_mode" });
    }
  };

  readonly #toPage = (action: PageEventAction) => {
    if (this.#owner.isOpen()) {
      this.#owner.send(action);
    }
  };

  readonly #listen = (name: string, adding: number) => {
    const kind = LISTENED.find(([, event]) => event === name)?.[0];
    if (kind === undefined) {
      return;
    }
    const listening = this.#owner.contents.listenerCount(name) + adding > 0;
    if (listening !== this.#listening[kind]) {
      this.#listening = { ...this.#listening, [kind]: listening };
      this.#toPage({ ...this.#listening, type: "listen_input" });
    }
  };

  readonly getUserAgent = () =>
    this.#userAgent === "" ? this.#owner.sessionUserAgent() : this.#userAgent;
  readonly setUserAgent = (userAgent: string) => {
    this.#userAgent = userAgent;
    this.#toPage({ type: "set_page_user_agent", user_agent: userAgent });
  };
  readonly isAudioMuted = () => this.#muted;
  readonly setAudioMuted = (muted: boolean) => {
    this.#muted = muted;
    this.#toPage({ muted, type: "set_audio_muted" });
  };
  readonly isCurrentlyAudible = () => this.#audible;
  readonly setIgnoreMenuShortcuts = (ignore: boolean) => {
    this.#ignoreMenuShortcuts = ignore;
    this.#toPage({ ignore, type: "set_ignore_menu_shortcuts" });
  };
  /** webPreferences.enablePreferredSizeMode: preferred-size-changed's. */
  readonly enablePreferredSizeMode = () => {
    this.#preferredSizeMode = true;
    this.#toPage({ type: "enable_preferred_size_mode" });
  };
  readonly sendInputEvent = (event: unknown) => {
    const input = syntheticInput(event);
    this.#toPage({ event: input, type: "send_input_event" });
  };

  /** Emits `name` on the webContents and, when it has one, its window. */
  readonly #both = (name: string) => {
    const { contents, eventObject, window } = this.#owner;
    contents.emit(name, eventObject());
    window()?.emit(name, eventObject());
  };

  /** Asks the listeners of `name` about held input `ask`, and answers. */
  readonly #ask = (ask: number, name: string, input: unknown) => {
    const event = this.#owner.eventObject();
    try {
      this.#owner.contents.emit(name, event, input);
    } finally {
      // The page's input waits on the answer, even when a listener threw.
      this.#owner.send({
        ask,
        prevent: event.defaultPrevented,
        type: "input_answer",
      });
    }
  };

  /** Takes what the engine said of the page. */
  readonly take = (event: PageEvent) => {
    const { contents, eventObject } = this.#owner;
    switch (event.type) {
      case "console_message": {
        const { level, line, message, source } = event;
        contents.emit(
          "console-message",
          {
            ...eventObject(),
            level,
            lineNumber: line,
            message,
            sourceId: source,
          },
          LEVELS[level],
          message,
          line,
          source,
        );
        break;
      }
      case "preload_error": {
        const error = new Error(event.message);
        error.name = event.name;
        // The page's, not the host's; a thrown value with none, its name.
        error.stack =
          event.stack === "" ? `${event.name}: ${event.message}` : event.stack;
        contents.emit(
          "preload-error",
          eventObject(),
          this.#owner.preloadPath() ?? "",
          error,
        );
        break;
      }
      case "responsive": {
        this.#both(event.responsive ? "responsive" : "unresponsive");
        break;
      }
      case "html_fullscreen": {
        this.#both(
          event.fullscreen
            ? "enter-html-full-screen"
            : "leave-html-full-screen",
        );
        break;
      }
      case "media_playing": {
        contents.emit(
          event.playing ? "media-started-playing" : "media-paused",
          eventObject(),
        );
        break;
      }
      case "audible": {
        this.#audible = event.audible;
        contents.emit("audio-state-changed", {
          ...eventObject(),
          audible: event.audible,
        });
        break;
      }
      case "favicons": {
        contents.emit("page-favicon-updated", eventObject(), [...event.urls]);
        break;
      }
      case "target_url": {
        contents.emit("update-target-url", eventObject(), event.url);
        break;
      }
      case "zoom_asked": {
        contents.emit(
          "zoom-changed",
          eventObject(),
          event.zoom_in ? "in" : "out",
        );
        break;
      }
      case "theme_color": {
        contents.emit(
          "did-change-theme-color",
          eventObject(),
          event.color ?? null,
        );
        break;
      }
      case "cursor_changed": {
        const { height, hotspot_x, hotspot_y, image, scale, width } = event;
        if (image === undefined) {
          contents.emit("cursor-changed", eventObject(), event.cursor);
        } else {
          contents.emit(
            "cursor-changed",
            eventObject(),
            event.cursor,
            nativeImage.createFromDataURL(image),
            scale,
            { height, width },
            { x: hotspot_x, y: hotspot_y },
          );
        }
        break;
      }
      case "preferred_size": {
        contents.emit("preferred-size-changed", eventObject(), {
          height: event.height,
          width: event.width,
        });
        break;
      }
      case "content_bounds": {
        // The desktop places windows, so nothing follows the listeners.
        contents.emit("content-bounds-updated", eventObject(), {
          height: event.height,
          width: event.width,
          x: event.x,
          y: event.y,
        });
        break;
      }
      case "before_input": {
        const { input } = event;
        this.#ask(event.ask, "before-input-event", {
          alt: input.alt,
          code: input.code,
          control: input.control,
          isAutoRepeat: input.is_auto_repeat,
          isComposing: input.is_composing,
          key: input.key,
          location: input.location,
          meta: input.meta,
          modifiers: [...input.modifiers],
          shift: input.shift,
          type: input.type,
        });
        break;
      }
      case "before_mouse": {
        this.#ask(event.ask, "before-mouse-event", electronInput(event.mouse));
        break;
      }
      case "input_event": {
        contents.emit("input-event", eventObject(), electronInput(event.event));
        break;
      }
    }
  };
}
