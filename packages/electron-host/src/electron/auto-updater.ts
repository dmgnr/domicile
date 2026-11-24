// The stand-in for Electron's `autoUpdater`, which Electron has no Linux
// implementation of: as there, a check emits `error`. On Domicile the
// app's package updates it.

import { EventEmitter } from "node:events";

export const createAutoUpdater = () => {
  const updater = new EventEmitter();
  let feed = "";
  return Object.assign(updater, {
    checkForUpdates: () => {
      queueMicrotask(() => {
        updater.emit(
          "error",
          new Error(
            "autoUpdater is not supported on Linux: the app's package updates it",
          ),
        );
      });
    },
    getFeedURL: () => feed,
    quitAndInstall: () => undefined,
    setFeedURL: (options: string | { url: string }) => {
      feed = typeof options === "string" ? options : options.url;
    },
  });
};
