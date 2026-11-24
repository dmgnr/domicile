// The preload guard-electron-preload.sh gives window 1, as an Electron app's
// sandboxed preload would be written.
// biome-ignore lint/style/noCommonJs: a preload is CommonJS, as Electron runs it.
const electron = require("electron");

const { contextBridge, crashReporter, ipcRenderer, webFrame, webUtils } =
  electron;

// The preload's own world: the page must not see this.
window.secret = "the preload's";

// ipcRenderer is an EventEmitter: what the preload emits reaches its own
// listeners, with the arguments as given, as Element's preload relies on.
let emitted;
ipcRenderer.once("local", (value) => {
  emitted = value;
});
ipcRenderer.emit("local", 7);

// The rest of Electron's sandboxed electron module, as apps use it: Claude's
// preloads expose nothing unless process.isMainFrame and the frame is its own
// top, by frameToken, and read the window's additionalArguments from
// process.argv. Apps read their Electron and resources from process too.
crashReporter.addExtraParameter("guard", "kept");
// process is an EventEmitter that tells of the document's progress, as
// Slack's preload relies on to set up its window.
const heard = [];
process.once("loaded", () => heard.push("loaded"));
process.on("document-start", () => heard.push("document-start"));
process.on("document-end", () => heard.push("document-end"));
const styled = webFrame.insertCSS("p { color: rgb(1, 2, 3); }");
const shaped = {
  argv: process.argv.includes("--guard-argument=1"),
  crash: crashReporter.getParameters().guard,
  electron: process.versions.electron,
  mainFrame: process.isMainFrame,
  resources: process.resourcesPath,
  routingId: Number.isInteger(webFrame.routingId),
  token: typeof webFrame.frameToken === "string" && webFrame.frameToken !== "",
  top:
    "frameToken" in webFrame &&
    webFrame.top !== null &&
    webFrame.top.frameToken === webFrame.frameToken,
  webUtils: typeof webUtils.getPathForFile,
  zoom: webFrame.getZoomFactor(),
};

contextBridge.exposeInMainWorld("guard", {
  ask: (n) => ipcRenderer.invoke("double", n),
  askNow: (n) => ipcRenderer.sendSync("triple", n),
  emitted,
  heard: () => [...heard],
  onPing: (callback) =>
    ipcRenderer.on("ping", (_event, value) => callback(value)),
  send: (channel, value) => ipcRenderer.send(channel, value),
  shaped,
  unstyle: () => webFrame.removeInsertedCSS(styled),
});

// A port the app hands over: each number on it comes back one more.
ipcRenderer.on("port", (event) => {
  const [port] = event.ports;
  port.onmessage = (message) => port.postMessage(message.data + 1);
});

// A port handed to the app: each number on it comes back ten times over.
const { port1, port2 } = new MessageChannel();
port1.onmessage = (message) => port1.postMessage(message.data * 10);
ipcRenderer.postMessage("mine", "a port", [port2]);
