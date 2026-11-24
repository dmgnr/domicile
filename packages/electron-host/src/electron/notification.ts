// The stand-in for Electron's `Notification`: a notification on the desktop's
// `org.freedesktop.Notifications` server, as Electron sends on Linux. See
// docs/architecture/NOTIFICATIONS.md for what Domicile's server does with
// each field.

import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";

/** A hint's D-Bus signature and value. */
export type Hint =
  | readonly ["s", string]
  | readonly ["b", boolean]
  | readonly ["y", number];

/** One `Notify` call, as the spec orders its arguments. */
export type NotifyCall = {
  readonly appName: string;
  /** The notification this one replaces, or 0. */
  readonly replaces: number;
  readonly icon: string;
  readonly summary: string;
  readonly body: string;
  /** Alternating action keys and labels. */
  readonly actions: readonly string[];
  readonly hints: Readonly<Record<string, Hint>>;
  /** Milliseconds, 0 for never, -1 for the server's choice. */
  readonly timeout: number;
};

/** What this needs of the notification server. */
export type NotificationsBus = {
  readonly notify: (call: NotifyCall) => Promise<number>;
  readonly close: (id: number) => Promise<void>;
  readonly on: {
    (
      event: "ActionInvoked",
      listener: (id: number, key: string) => void,
    ): unknown;
    (
      event: "NotificationReplied",
      listener: (id: number, text: string) => void,
    ): unknown;
    (
      event: "NotificationClosed",
      listener: (id: number, reason: number) => void,
    ): unknown;
  };
};

export type NotificationAction = {
  readonly type: "button";
  readonly text: string;
};

export type NotificationOptions = {
  title?: string | undefined;
  subtitle?: string | undefined;
  body?: string | undefined;
  silent?: boolean | undefined;
  /** A file path. */
  icon?: string | undefined;
  hasReply?: boolean | undefined;
  replyPlaceholder?: string | undefined;
  urgency?: "low" | "normal" | "critical" | undefined;
  timeoutType?: "default" | "never" | undefined;
  actions?: readonly NotificationAction[] | undefined;
  /** A sound theme's name, or a sound file's path. */
  sound?: string | undefined;
  closeButtonText?: string | undefined;
};

/** What the server says the user did with a notification. */
type Heard =
  | { readonly kind: "action"; readonly key: string }
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "closed" };

const URGENCY = { critical: 2, low: 0, normal: 1 } as const;

/** The click on the notification itself, as Electron's Linux build names it. */
const DEFAULT_ACTION = "default";
const REPLY_ACTION = "inline-reply";
/** A reply's label when the app sets no placeholder: the button macOS shows. */
const REPLY_LABEL = "Reply";

/**
 * Makes the `Notification` class for the app `appId` (its desktop entry's
 * name) called `name`, on `bus`.
 */
export const createNotification = (
  bus: NotificationsBus,
  app: { readonly appId: string; readonly name: string },
) => {
  /** Each shown notification, by the server's number, until it closes. */
  const shown = new Map<number, Notification>();

  /** The event object Electron passes first to a listener. */
  const eventObject = () => ({ preventDefault: () => undefined });

  class Notification extends EventEmitter {
    static readonly isSupported = () => true;

    title: string;
    subtitle: string;
    body: string;
    silent: boolean;
    hasReply: boolean;
    replyPlaceholder: string;
    urgency: "low" | "normal" | "critical";
    timeoutType: "default" | "never";
    actions: readonly NotificationAction[];
    sound: string;
    /** Kept for the app: the desktop's notifications have no close button text. */
    closeButtonText: string;
    readonly #icon: string;
    #id = 0;

    constructor(options: NotificationOptions = {}) {
      super();
      if (options.icon !== undefined && typeof options.icon !== "string") {
        throw new TypeError(
          "a notification's icon must be a file path on Domicile: nativeImage icons aren't carried yet",
        );
      }
      this.title = options.title ?? "";
      this.subtitle = options.subtitle ?? "";
      this.body = options.body ?? "";
      this.silent = options.silent ?? false;
      this.hasReply = options.hasReply ?? false;
      this.replyPlaceholder = options.replyPlaceholder ?? "";
      this.urgency = options.urgency ?? "normal";
      this.timeoutType = options.timeoutType ?? "default";
      this.actions = options.actions ?? [];
      this.sound = options.sound ?? "";
      this.closeButtonText = options.closeButtonText ?? "";
      this.#icon = options.icon ?? "";
    }

    /** Shows it, or updates it in place if it is up. */
    readonly show = () => {
      bus.notify(this.#call()).then(
        (id) => {
          this.#id = id;
          shown.set(id, this);
          this.emit("show", eventObject());
        },
        (error: unknown) => {
          this.emit(
            "failed",
            eventObject(),
            error instanceof Error ? error.message : String(error),
          );
        },
      );
    };

    readonly close = () => {
      if (this.#id !== 0) {
        bus.close(this.#id).catch((error: unknown) => {
          this.emit(
            "failed",
            eventObject(),
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    };

    // What the server says the user did reaches the notification it names.
    static {
      bus.on("ActionInvoked", (id, key) => {
        Notification.#deliver(id, { key, kind: "action" });
      });
      bus.on("NotificationReplied", (id, text) => {
        Notification.#deliver(id, { kind: "reply", text });
      });
      bus.on("NotificationClosed", (id) => {
        Notification.#deliver(id, { kind: "closed" });
      });
    }

    static #deliver(id: number, what: Heard) {
      const notification = shown.get(id);
      if (notification !== undefined) {
        notification.#hear(what);
      }
    }

    /** Takes what the server said the user did with it. */
    readonly #hear = (what: Heard) => {
      if (what.kind === "closed") {
        shown.delete(this.#id);
        this.#id = 0;
        this.emit("close", eventObject());
      } else if (what.kind === "reply") {
        this.emit("reply", eventObject(), what.text);
      } else if (what.key === DEFAULT_ACTION) {
        this.emit("click", eventObject());
      } else {
        this.emit("action", eventObject(), Number(what.key));
      }
    };

    readonly #call = (): NotifyCall => ({
      actions: [
        DEFAULT_ACTION,
        "",
        ...this.actions.flatMap((action, index) => [`${index}`, action.text]),
        ...(this.hasReply
          ? [
              REPLY_ACTION,
              this.replyPlaceholder === ""
                ? REPLY_LABEL
                : this.replyPlaceholder,
            ]
          : []),
      ],
      appName: app.name,
      body: this.subtitle === "" ? this.body : `${this.subtitle}\n${this.body}`,
      hints: {
        "desktop-entry": ["s", app.appId],
        ...(this.#icon === "" ? {} : { "image-path": ["s", this.#icon] }),
        ...(this.silent ? { "suppress-sound": ["b", true] } : {}),
        ...soundHint(this.sound),
        urgency: ["y", URGENCY[this.urgency]],
      },
      icon: this.#icon,
      replaces: this.#id,
      summary: this.title,
      timeout: this.timeoutType === "never" ? 0 : -1,
    });
  }

  return Notification;
};

/** The hint naming `sound`: a file by its path, else a sound theme's name. */
const soundHint = (sound: string): Readonly<Record<string, Hint>> => {
  if (sound === "") {
    return {};
  } else {
    return isAbsolute(sound)
      ? { "sound-file": ["s", sound] }
      : { "sound-name": ["s", sound] };
  }
};
