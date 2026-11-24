// What differs between the Electron apps `electron-host` runs, keyed by the
// app's `package.json` name, so a new app needs no new package. See
// "Apps inspected" in `docs/architecture/ELECTRON-APPS.md`.

export type Quirks = {
  /**
   * Why the app can't run on the engine, following its name: the host gives
   * up before its main runs, and the app runs on its own Electron.
   */
  readonly needsOwnElectron?: string;
};

/** The reason for an app whose pages need Node, given `why`. */
const needsNode = (why: string) =>
  `needs Node in its pages, which Domicile's engine doesn't run yet: ${why}`;

const QUIRKS: Readonly<Record<string, Quirks>> = {
  "@joplin/app-desktop": {
    needsOwnElectron: needsNode(
      "its windows ask for nodeIntegration and use @electron/remote",
    ),
  },
  // ChatGPT throws at start unless `app.showTaskManager` exists, and goes on
  // to call Owl's own APIs (`app.isRuntimeFeatureEnabled`,
  // `webContents.setAgentActive`, `_createWebViewAdoptionLease`).
  "openai-codex-electron": {
    needsOwnElectron:
      "needs OpenAI's own build of Electron, Owl, and refuses to start on any other",
  },
  "signal-desktop": {
    needsOwnElectron: needsNode("its pages load libsignal and ringrtc"),
  },
  "teams-for-linux": {
    needsOwnElectron: needsNode(
      "its preload uses Node with contextIsolation off",
    ),
  },
  zulip: {
    needsOwnElectron: needsNode(
      "it uses @electron/remote and <webview> with sandbox off",
    ),
  },
};

/** What the app named `name` in its `package.json` needs done its way. */
export const quirksOf = (name: string): Quirks => QUIRKS[name] ?? {};
