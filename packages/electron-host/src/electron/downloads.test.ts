import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import type {
  DownloadItem,
  DownloadMessage,
  IncomingDownloadUpdate,
  IncomingWillDownload,
} from "./downloads";
import { createDownloads } from "./downloads";

const setUp = () => {
  const sent: DownloadMessage[] = [];
  const sessions = new Map<string, EventEmitter>();
  const downloads = createDownloads(
    (message) => sent.push(message),
    (partition) => {
      const session = sessions.get(partition) ?? new EventEmitter();
      sessions.set(partition, session);
      return session;
    },
    (window) => (window === 1 ? { id: 1 } : undefined),
  );
  const session = (partition: string) => {
    const found = sessions.get(partition) ?? new EventEmitter();
    sessions.set(partition, found);
    return found;
  };
  return { downloads, sent, session };
};

const willDownload = (
  more: Partial<IncomingWillDownload> = {},
): IncomingWillDownload => ({
  content_disposition: 'attachment; filename="a.csv"',
  download: 2,
  etag: '"e"',
  filename: "a.csv",
  has_user_gesture: false,
  initiator_origin: "https://app.slack.com",
  last_modified: "Mon, 23 Nov 2026 23:00:00 GMT",
  mime_type: "text/csv",
  session: "",
  start_time: 1.5,
  total_bytes: 200,
  type: "will_download",
  url: "https://files.slack.com/a.csv",
  url_chain: ["https://slack.com/f", "https://files.slack.com/a.csv"],
  window: 1,
  ...more,
});

const update = (
  more: Partial<IncomingDownloadUpdate> = {},
): IncomingDownloadUpdate => ({
  bytes_per_second: 50,
  can_resume: false,
  done: false,
  download: 2,
  filename: "a.csv",
  mime_type: "text/csv",
  paused: false,
  received_bytes: 50,
  save_path: "/home/me/a.csv",
  state: "progressing",
  total_bytes: 200,
  type: "download_updated",
  ...more,
});

/** Hears will-download on `session`, keeping each item. */
const listen = (session: EventEmitter) => {
  const items: DownloadItem[] = [];
  session.on("will-download", (_event, item: DownloadItem) => {
    items.push(item);
  });
  return items;
};

describe(createDownloads, () => {
  describe("will-download", () => {
    it("hands the session's listener the item and the page that started it", () => {
      const { downloads, session } = setUp();
      const heard = new Promise<unknown[]>((resolve) => {
        session("persist:a").on("will-download", (...args: unknown[]) => {
          resolve(args);
        });
      });

      downloads.hearWillDownload(willDownload({ session: "persist:a" }));

      return heard.then(([event, item, webContents]) => {
        expect(event).toMatchObject({ defaultPrevented: false });
        expect(webContents).toEqual({ id: 1 });
        const download = item as DownloadItem;
        expect({
          contentDisposition: download.getContentDisposition(),
          etag: download.getETag(),
          filename: download.getFilename(),
          hasUserGesture: download.hasUserGesture(),
          initiatorOrigin: download.getInitiatorOrigin(),
          lastModified: download.getLastModifiedTime(),
          mimeType: download.getMimeType(),
          percent: download.getPercentComplete(),
          received: download.getReceivedBytes(),
          savePath: download.getSavePath(),
          startTime: download.getStartTime(),
          state: download.getState(),
          total: download.getTotalBytes(),
          url: download.getURL(),
          urlChain: download.getURLChain(),
        }).toEqual({
          contentDisposition: 'attachment; filename="a.csv"',
          etag: '"e"',
          filename: "a.csv",
          hasUserGesture: false,
          initiatorOrigin: "https://app.slack.com",
          lastModified: "Mon, 23 Nov 2026 23:00:00 GMT",
          mimeType: "text/csv",
          percent: 0,
          received: 0,
          savePath: "",
          startTime: 1.5,
          state: "progressing",
          total: 200,
          url: "https://files.slack.com/a.csv",
          urlChain: ["https://slack.com/f", "https://files.slack.com/a.csv"],
        });
      });
    });

    it("saves where the listener set the save path, by either name", () => {
      const { downloads, sent, session } = setUp();
      session("").on("will-download", (_event, item: DownloadItem) => {
        if (item.getURL().endsWith("a.csv")) {
          // Slack sets the property.
          item.savePath = "/home/me/a.csv";
        } else {
          item.setSavePath("/home/me/b.csv");
        }
      });

      downloads.hearWillDownload(willDownload());
      downloads.hearWillDownload(
        willDownload({ download: 3, url: "https://files.slack.com/b.csv" }),
      );

      expect(sent).toEqual([
        { download: 2, path: "/home/me/a.csv", type: "download_answer" },
        { download: 3, path: "/home/me/b.csv", type: "download_answer" },
      ]);
    });

    it("cancels a download the listener prevents or cancels", () => {
      const { downloads, sent, session } = setUp();
      session("").on(
        "will-download",
        (event: { preventDefault: () => void }, item: DownloadItem) => {
          if (item.getURL().endsWith("a.csv")) {
            event.preventDefault();
          } else {
            item.cancel();
          }
        },
      );

      downloads.hearWillDownload(willDownload());
      downloads.hearWillDownload(
        willDownload({ download: 3, url: "https://files.slack.com/b.csv" }),
      );

      expect(sent).toEqual([
        { cancel: true, download: 2, type: "download_answer" },
        { cancel: true, download: 3, type: "download_answer" },
      ]);
    });

    it("asks the user when nobody says where it goes", () => {
      const { downloads, sent } = setUp();

      downloads.hearWillDownload(willDownload({ window: undefined }));

      expect(sent).toEqual([{ download: 2, type: "download_answer" }]);
    });

    it("still answers when the listener throws, and the throw is the app's", () => {
      const { downloads, sent, session } = setUp();
      session("").on("will-download", (_event, item: DownloadItem) => {
        item.savePath = "/home/me/a.csv";
        throw new Error("the app's bug");
      });

      expect(() => {
        downloads.hearWillDownload(willDownload());
      }).toThrow("the app's bug");
      expect(sent).toEqual([
        { download: 2, path: "/home/me/a.csv", type: "download_answer" },
      ]);
    });
  });

  describe("the item", () => {
    it("says updated as the download goes, and done once it ends", () => {
      const { downloads, session } = setUp();
      const items = listen(session(""));
      downloads.hearWillDownload(willDownload());
      const [item] = items;
      if (item === undefined) {
        throw new Error("no item");
      }
      const heard: unknown[] = [];
      item.on("updated", (_event, state: string) => {
        heard.push(["updated", state, item.getReceivedBytes()]);
      });
      item.on("done", (_event, state: string) => {
        heard.push(["done", state, item.getSavePath()]);
      });

      downloads.hearUpdate(update());
      downloads.hearUpdate(update({ paused: true, state: "interrupted" }));
      downloads.hearUpdate(
        update({ done: true, received_bytes: 200, state: "completed" }),
      );

      expect(heard).toEqual([
        ["updated", "progressing", 50],
        ["updated", "interrupted", 50],
        ["done", "completed", "/home/me/a.csv"],
      ]);
      expect({
        end: item.getEndTime(),
        percent: item.getPercentComplete(),
        speed: item.getCurrentBytesPerSecond(),
      }).toEqual({ end: 0, percent: 100, speed: 50 });
    });

    it("names a canceled download as Electron does", () => {
      const { downloads, session } = setUp();
      const items = listen(session(""));
      downloads.hearWillDownload(willDownload());

      downloads.hearUpdate(
        update({ done: true, end_time: 9, state: "canceled" }),
      );

      expect(items[0]?.getState()).toBe("cancelled");
      expect(items[0]?.getEndTime()).toBe(9);
    });

    it("pauses, resumes and cancels through the engine", () => {
      const { downloads, sent, session } = setUp();
      const items = listen(session(""));
      downloads.hearWillDownload(willDownload());
      downloads.hearUpdate(update({ can_resume: true, paused: true }));
      sent.length = 0;
      const [item] = items;

      item?.pause();
      item?.resume();
      item?.cancel();

      expect([item?.isPaused(), item?.canResume()]).toEqual([true, true]);
      expect(sent).toEqual([
        { action: "pause", download: 2, type: "download_control" },
        { action: "resume", download: 2, type: "download_control" },
        { action: "cancel", download: 2, type: "download_control" },
      ]);
    });

    it("keeps the save dialog options it is given", () => {
      const { downloads, session } = setUp();
      const items = listen(session(""));
      downloads.hearWillDownload(willDownload());

      items[0]?.setSaveDialogOptions({ title: "Save" });

      expect(items[0]?.getSaveDialogOptions()).toEqual({ title: "Save" });
    });
  });

  it("refuses an update for a download it never heard of", () => {
    const { downloads } = setUp();

    expect(() => {
      downloads.hearUpdate(update({ download: 9 }));
    }).toThrow("the engine updated download 9, which it never started");
  });
});
