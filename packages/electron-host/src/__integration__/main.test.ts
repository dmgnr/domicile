import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

import { writeAsar } from "../asar-fixture";
import { startFakeDesktopBus } from "../desktop-bus-fixture";
import { ELECTRON_VERSION } from "../electron/version";
import type { FakeEngine } from "../engine-fixture";
import { answerAsDefault, startFakeEngine } from "../engine-fixture";

const MAIN = join(import.meta.dir, "../main.ts");

const MAIN_JS = `
const { app, nativeTheme, session } = require("electron");
// Electron has made it before the app's main runs.
const userDataMade = require("node:fs").existsSync(app.getPath("userData"));
app.whenReady().then(() => {
  const userAgent = app.userAgentFallback;
  const sessionUserAgent = session.defaultSession.getUserAgent();
  app.userAgentFallback = "Custom/1";
  console.log(JSON.stringify({
    userAgent,
    sessionUserAgent,
    setUserAgent: session.defaultSession.getUserAgent(),
    appPath: app.getAppPath(),
    argv: process.argv.slice(1),
    dark: nativeTheme.shouldUseDarkColors,
    electron: process.versions.electron,
    name: app.getName(),
    resourcesPath: process.resourcesPath,
    type: process.type,
    userData: app.getPath("userData"),
    userDataMade,
  }));
  app.quit();
});
`;

const NOTIFY_JS = `
const { app, Notification } = require("electron");
app.whenReady().then(() => {
  const notification = new Notification({ title: "Done", body: "All set", silent: true });
  notification.on("show", () => app.quit());
  notification.on("failed", (_event, why) => { console.error(why); app.exit(2); });
  notification.show();
});
`;

const WINDOW_JS = `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const window = new BrowserWindow();
  await window.loadFile("index.html");
  console.log(JSON.stringify({ title: window.getTitle() }));
  app.quit();
});
`;

// Slack's way: a hidden window at the file, and will-download says where.
const DOWNLOAD_JS = `
const { app, BrowserWindow, session } = require("electron");
app.whenReady().then(() => {
  session.defaultSession.on("will-download", (_event, item, webContents) => {
    item.savePath = "/home/me/a.csv";
    item.on("done", (_event, state) => {
      console.log(JSON.stringify({ path: item.getSavePath(), state, window: webContents.id }));
      app.quit();
    });
  });
  new BrowserWindow({ show: false }).loadURL("https://files.test/a.csv").catch(() => undefined);
});
`;

const run = async (
  resources: string,
  home: string,
  args: string[],
  engine: FakeEngine | undefined,
) => {
  const {
    DBUS_SESSION_BUS_ADDRESS: _theirBus,
    DOMICILE_ELECTRON_SOCK: _theirs,
    ...inherited
  } = env;
  const child = Bun.spawn(["bun", MAIN, resources, ...args], {
    env: {
      ...inherited,
      ...(engine === undefined ? {} : { DOMICILE_ELECTRON_SOCK: engine.path }),
      ...(desktopBus === undefined
        ? {}
        : { DBUS_SESSION_BUS_ADDRESS: desktopBus.address }),
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
    stdout: await new Response(child.stdout).text(),
  };
};

let engine: FakeEngine | undefined;
let desktopBus: Awaited<ReturnType<typeof startFakeDesktopBus>> | undefined;

afterEach(async () => {
  await engine?.close();
  await desktopBus?.close();
  engine = undefined;
  desktopBus = undefined;
});

describe("electron-host", () => {
  it("runs the app's main with the stand-in, from its mirror", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "main.js": { content: MAIN_JS },
      "package.json": {
        content: `{"main":"main.js","name":"notes","productName":"Notes","version":"1.2.3"}`,
      },
    });

    engine = await startFakeEngine();
    desktopBus = await startFakeDesktopBus({ colorScheme: 1, contrast: 0 });
    const { code, stdout } = await run(
      resources,
      home,
      ["--open", "x.txt"],
      engine,
    );
    const seen = JSON.parse(stdout);
    const electronUserAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Notes/1.2.3 Chrome/160.0.8155.0 Electron/45.2.1 Safari/537.36";

    expect(code).toBe(0);
    // Pages get Electron's user agent unless the app sets its own.
    expect(engine.heard).toContainEqual({
      type: "set_user_agent_fallback",
      user_agent: electronUserAgent,
    });
    expect(engine.heard).toContainEqual({
      type: "set_user_agent_fallback",
      user_agent: "Custom/1",
    });
    expect(seen).toMatchObject({
      argv: ["--open", "x.txt"],
      dark: true,
      electron: "45.2.1",
      name: "Notes",
      sessionUserAgent: electronUserAgent,
      setUserAgent: "Custom/1",
      type: "browser",
      userAgent: electronUserAgent,
      userData: join(home, ".config/Notes"),
      userDataMade: true,
    });
    expect(seen.appPath).toStartWith(join(home, ".cache/domicile/electron/"));
    expect(seen.appPath).toBe(join(seen.resourcesPath, "app.asar"));
  });

  it("hands an app known to need Node in its pages back to its own Electron, before its main runs", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "main.js": { content: MAIN_JS },
      "package.json": {
        content: `{"main":"main.js","name":"signal-desktop","productName":"Signal","version":"8.32.0"}`,
      },
    });

    const { code, stderr, stdout } = await run(resources, home, [], undefined);

    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "Signal needs Node in its pages, which Domicile's engine doesn't run yet: its pages load libsignal and ringrtc",
    );
  });

  it("says why when the app can't be read", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "package.json": { content: `{"name":"notes","version":"1.2.3"}` },
    });
    await writeFile(join(resources, "extra.asar"), "junk");

    const { code, stderr } = await run(resources, home, [], undefined);

    expect(code).toBe(1);
    expect(stderr).toContain(
      `${join(resources, "extra.asar")} is not an asar archive`,
    );
  });

  it("opens the app's windows on the engine as its own app", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "index.html": { content: "<title>Notes</title>" },
      "main.js": { content: WINDOW_JS },
      "package.json": {
        content: `{"main":"main.js","name":"notes","desktopName":"com.example.Notes.desktop","version":"1.2.3"}`,
      },
    });
    engine = await startFakeEngine((request) => {
      if (request.type === "open_window") {
        return [
          { type: "window_opened", window: 1 },
          // The page asks for itself, as a file: navigation does.
          {
            headers: [],
            method: "GET",
            request: 1,
            session: "",
            type: "protocol_request",
            url: (request as unknown as { url: string }).url,
          },
          { title: "Notes", type: "title_changed", window: 1 },
          { type: "window_loaded", window: 1 },
        ];
      } else {
        return answerAsDefault(request);
      }
    });

    desktopBus = await startFakeDesktopBus({ colorScheme: 2, contrast: 0 });
    const { code, stderr, stdout } = await run(resources, home, [], engine);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ title: "Notes" });
    expect(engine.heard[0]).toEqual({
      app_id: "com.example.Notes",
      electron_version: ELECTRON_VERSION,
      partition: "persist:electron-notes",
      // The app's resources as the host mirrored them, which its main sees
      // as process.resourcesPath too.
      resources_path: expect.stringMatching(
        new RegExp(
          `^${join(home, ".cache/domicile/electron/")}[^/]+/resources$`,
        ),
      ),
      type: "hello",
      version: 1,
    });
    expect(engine.heard[1]).toEqual({
      scheme: "file",
      session: "",
      type: "handle_protocol",
    });
    // Where the app's own session keeps its data, before its main runs.
    expect(engine.heard[2]).toEqual({
      call: 1,
      method: "storage_path",
      session: "",
      type: "session_call",
    });
    // The app's fallback user agent, before its first window.
    expect(engine.heard[3]).toMatchObject({ type: "set_user_agent_fallback" });
    expect(engine.heard[4]).toMatchObject({ type: "open_window", window: 1 });
    const { url } = engine.heard[4] as { url: string };
    expect(url).toEndWith("/app.asar/index.html");
    // loadFile's page comes from the app's mirror, read by the engine.
    expect(engine.heard).toContainEqual({
      file: fileURLToPath(url),
      headers: [],
      request: 1,
      status: 200,
      type: "protocol_response",
    });
  });

  it("asks the app's will-download where its page's download goes", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "main.js": { content: DOWNLOAD_JS },
      "package.json": {
        content: `{"main":"main.js","name":"chat","version":"1.0.0"}`,
      },
    });
    engine = await startFakeEngine((request) => {
      if (request.type === "open_window") {
        return [
          { type: "window_opened", window: 1 },
          {
            content_disposition: "attachment",
            download: 1,
            etag: "",
            filename: "a.csv",
            has_user_gesture: false,
            initiator_origin: "",
            last_modified: "",
            mime_type: "text/csv",
            session: "",
            start_time: 1,
            total_bytes: 3,
            type: "will_download",
            url: "https://files.test/a.csv",
            url_chain: ["https://files.test/a.csv"],
            window: 1,
          },
        ];
      } else if (request.type === "download_answer") {
        return [
          {
            bytes_per_second: 0,
            can_resume: false,
            done: true,
            download: 1,
            end_time: 2,
            filename: "a.csv",
            mime_type: "text/csv",
            paused: false,
            received_bytes: 3,
            save_path: "/home/me/a.csv",
            state: "completed",
            total_bytes: 3,
            type: "download_updated",
          },
        ];
      } else {
        return answerAsDefault(request);
      }
    });

    desktopBus = await startFakeDesktopBus({ colorScheme: 2, contrast: 0 });
    const { code, stderr, stdout } = await run(resources, home, [], engine);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(engine.heard).toContainEqual({
      download: 1,
      path: "/home/me/a.csv",
      type: "download_answer",
    });
    expect(JSON.parse(stdout)).toEqual({
      path: "/home/me/a.csv",
      state: "completed",
      window: 1,
    });
  });

  it("says why when there is no desktop to open windows on", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "main.js": { content: MAIN_JS },
      "package.json": {
        content: `{"main":"main.js","name":"notes","version":"1.2.3"}`,
      },
    });

    const { code, stderr } = await run(resources, home, [], undefined);

    expect(code).toBe(1);
    expect(stderr).toContain("DOMICILE_ELECTRON_SOCK is not set");
  });

  it("says why when there is no session bus to read the theme from", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "main.js": { content: MAIN_JS },
      "package.json": {
        content: `{"main":"main.js","name":"notes","version":"1.2.3"}`,
      },
    });
    engine = await startFakeEngine();

    const { code, stderr } = await run(resources, home, [], engine);

    expect(code).toBe(1);
    expect(stderr).toContain("DBUS_SESSION_BUS_ADDRESS is not set");
  });

  it("shows the app's notifications on the desktop as the app's", async () => {
    const home = await mkdtemp(join(tmpdir(), "electron-host-main-"));
    const resources = join(home, "install/resources");
    await writeAsar(join(resources, "app.asar"), {
      "main.js": { content: NOTIFY_JS },
      "package.json": {
        content: `{"main":"main.js","name":"notes","productName":"Notes","desktopName":"com.example.Notes.desktop","version":"1.2.3"}`,
      },
    });
    engine = await startFakeEngine();
    desktopBus = await startFakeDesktopBus({ colorScheme: 0, contrast: 0 });

    const { code, stderr } = await run(resources, home, [], engine);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(desktopBus.notifications).toEqual([
      {
        actions: ["default", ""],
        appName: "Notes",
        body: "All set",
        hints: {
          "desktop-entry": "com.example.Notes",
          "suppress-sound": true,
          urgency: 1,
        },
        summary: "Done",
      },
    ]);
  });
});
