// The preload guard-electron-node.sh gives windows 1 to 3, as an Electron
// app's preload with Node.js would be written: Node's require, the app's own
// modules, and `electron` beside them.
// biome-ignore-all lint/style/noCommonJs: a preload is CommonJS, as Electron runs it.
const { contextBridge, ipcRenderer } = require("electron");
const fs = require("node:fs");
const timers = require("node:timers");
const { answer } = require("./helper.js");

// What Node in this page is, for the app to check.
ipcRenderer.send("preload", {
  chrome: typeof process.versions.chrome,
  electron: process.versions.electron,
  // biome-ignore lint/style/noProcessEnv: the app's environment, which the guard gave the page
  env: process.env.DOMICILE_GUARD_NODE,
  helper: answer,
  isolated: process.contextIsolated,
  node: typeof process.versions.node,
  type: process.type,
});

// What Node's loop throws, the app hears, since the page's console is out of
// the guard's sight.
process.on("uncaughtException", (error) => {
  ipcRenderer.send("error", String(error?.stack ?? error));
});

// Node's own loop turns: a timer and a file read each call back. The others
// say which of Node's queues ran when the timer didn't.
timers.setTimeout(() => ipcRenderer.send("ticked", true), 20);
timers.setTimeout(() => ipcRenderer.send("timer-0", true), 0);
timers.setImmediate(() => ipcRenderer.send("immediate", true));
process.nextTick(() => ipcRenderer.send("next-tick", true));
fs.readFile(__filename, "utf8", (error, text) => {
  ipcRenderer.send("read", error === null && text.includes("ticked"));
});

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("guard", {
    send: (channel, value) => ipcRenderer.send(channel, value),
  });
} else {
  // The page's own world: what the preload leaves on window, the page sees.
  window.guardSend = (channel, value) => ipcRenderer.send(channel, value);
}
