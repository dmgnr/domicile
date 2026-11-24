// The stand-in for Electron's downloads: a session's `will-download` and the
// DownloadItem it hands the app. The engine asks the app where each of its
// pages' downloads goes, then says how it goes. See "Downloads" under
// "Requests" in docs/architecture/ELECTRON-APPS.md.

import { EventEmitter } from "node:events";

/** What the host tells the engine of a download. */
export type DownloadMessage =
  | {
      readonly type: "download_answer";
      readonly download: number;
      readonly path?: string;
      readonly cancel?: true;
    }
  | {
      readonly type: "download_control";
      readonly download: number;
      readonly action: "pause" | "resume" | "cancel";
    };

/** A download a page started, as the engine asks about it. */
export type IncomingWillDownload = {
  readonly type: "will_download";
  readonly download: number;
  readonly session: string;
  readonly window?: number | undefined;
  readonly url: string;
  readonly url_chain: string[];
  readonly filename: string;
  readonly mime_type: string;
  readonly total_bytes: number;
  readonly content_disposition: string;
  readonly has_user_gesture: boolean;
  readonly start_time: number;
  readonly etag: string;
  readonly last_modified: string;
  readonly initiator_origin: string;
};

/** How a download goes, as the engine says. */
export type IncomingDownloadUpdate = {
  readonly type: "download_updated";
  readonly download: number;
  readonly state: EngineDownloadState;
  readonly done: boolean;
  readonly paused: boolean;
  readonly can_resume: boolean;
  readonly received_bytes: number;
  readonly total_bytes: number;
  readonly bytes_per_second: number;
  readonly save_path: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly end_time?: number | undefined;
};

export type EngineDownloadState =
  | "progressing"
  | "completed"
  | "canceled"
  | "interrupted";

/** Electron's name for a canceled download, spelled the British way. */
const electronCanceled = "cancelled";

type ElectronDownloadState =
  | Exclude<EngineDownloadState, "canceled">
  | typeof electronCanceled;

const electronState = (state: EngineDownloadState): ElectronDownloadState => {
  switch (state) {
    case "canceled":
      return electronCanceled;
    case "completed":
    case "interrupted":
    case "progressing":
      return state;
  }
};

type Action = "pause" | "resume" | "cancel";

/** What this module keeps of an item, out of the app's reach. */
type Link = {
  readonly details: IncomingWillDownload;
  readonly control: (action: Action) => void;
  progress: IncomingDownloadUpdate | undefined;
  /** The engine heard where it goes; until then a cancel is the answer. */
  answered: boolean;
  canceledEarly: boolean;
};

/** Electron's DownloadItem: what the app reads of a download, and does to it. */
export class DownloadItem extends EventEmitter {
  /** Where it is saved: the app's to set in will-download. */
  savePath = "";
  readonly #link: Link;
  #saveDialogOptions: Record<string, unknown> = {};

  constructor(link: Link) {
    super();
    this.#link = link;
  }

  pause() {
    this.#link.control("pause");
  }

  resume() {
    this.#link.control("resume");
  }

  cancel() {
    if (this.#link.answered) {
      this.#link.control("cancel");
    } else {
      this.#link.canceledEarly = true;
    }
  }

  isPaused() {
    return this.#link.progress?.paused ?? false;
  }

  canResume() {
    return this.#link.progress?.can_resume ?? false;
  }

  getState(): ElectronDownloadState {
    return electronState(this.#link.progress?.state ?? "progressing");
  }

  getSavePath() {
    return this.savePath;
  }

  setSavePath(path: string) {
    this.savePath = path;
  }

  getSaveDialogOptions() {
    return this.#saveDialogOptions;
  }

  /** Kept for the app to read back: the shell draws the picker. */
  setSaveDialogOptions(options: Record<string, unknown>) {
    this.#saveDialogOptions = options;
  }

  getURL() {
    return this.#link.details.url;
  }

  getURLChain() {
    return [...this.#link.details.url_chain];
  }

  getMimeType() {
    return this.#link.progress?.mime_type ?? this.#link.details.mime_type;
  }

  getFilename() {
    return this.#link.progress?.filename ?? this.#link.details.filename;
  }

  hasUserGesture() {
    return this.#link.details.has_user_gesture;
  }

  getContentDisposition() {
    return this.#link.details.content_disposition;
  }

  getInitiatorOrigin() {
    return this.#link.details.initiator_origin;
  }

  getETag() {
    return this.#link.details.etag;
  }

  getLastModifiedTime() {
    return this.#link.details.last_modified;
  }

  getStartTime() {
    return this.#link.details.start_time;
  }

  getEndTime() {
    return this.#link.progress?.end_time ?? 0;
  }

  getReceivedBytes() {
    return this.#link.progress?.received_bytes ?? 0;
  }

  getTotalBytes() {
    return this.#link.progress?.total_bytes ?? this.#link.details.total_bytes;
  }

  getCurrentBytesPerSecond() {
    return this.#link.progress?.bytes_per_second ?? 0;
  }

  /** A whole percent; 0 while the size is unknown. */
  getPercentComplete() {
    const total = this.getTotalBytes();
    return total === 0
      ? 0
      : Math.round((this.getReceivedBytes() * 100) / total);
  }
}

/**
 * An app's downloads. `send` tells the engine; `sessionOf` finds a session by
 * its Electron partition, which hears `will-download`; `webContentsOf` finds a
 * window's page by its number.
 */
export const createDownloads = (
  send: (message: DownloadMessage) => void,
  sessionOf: (partition: string) => EventEmitter,
  webContentsOf: (window: number) => { readonly id: number } | undefined,
) => {
  const made = new Map<number, { item: DownloadItem; link: Link }>();

  /** Asks `incoming`'s session's will-download, and answers the engine. */
  const hearWillDownload = (incoming: IncomingWillDownload) => {
    const { download } = incoming;
    const link: Link = {
      answered: false,
      canceledEarly: false,
      control: (action) => {
        send({ action, download, type: "download_control" });
      },
      details: incoming,
      progress: undefined,
    };
    const item = new DownloadItem(link);
    made.set(download, { item, link });
    const event = {
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
    };
    try {
      sessionOf(incoming.session).emit(
        "will-download",
        event,
        item,
        incoming.window === undefined
          ? undefined
          : webContentsOf(incoming.window),
      );
    } finally {
      // Answered even when a listener throws, as Electron goes on with what
      // the listeners set; the throw is the app's to see.
      send(
        answerFor(download, item, event.defaultPrevented || link.canceledEarly),
      );
      link.answered = true;
    }
  };

  /** Keeps what the engine says, and the item says `updated` or `done`. */
  const hearUpdate = (incoming: IncomingDownloadUpdate) => {
    const found = made.get(incoming.download);
    if (found === undefined) {
      throw new Error(
        `the engine updated download ${String(incoming.download)}, which it never started`,
      );
    } else {
      found.link.progress = incoming;
      if (incoming.save_path !== "") {
        found.item.savePath = incoming.save_path;
      }
      found.item.emit(
        incoming.done ? "done" : "updated",
        {},
        found.item.getState(),
      );
    }
  };

  return { hearUpdate, hearWillDownload };
};

const answerFor = (
  download: number,
  item: DownloadItem,
  canceled: boolean,
): DownloadMessage => {
  if (canceled) {
    return { cancel: true, download, type: "download_answer" };
  } else if (item.savePath === "") {
    // Nobody said where: the user is asked, as Electron's save dialog asks.
    return { download, type: "download_answer" };
  } else {
    return { download, path: item.savePath, type: "download_answer" };
  }
};
