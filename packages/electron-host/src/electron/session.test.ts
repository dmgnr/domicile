import { describe, expect, it } from "bun:test";

import type { PermissionMessage } from "./permissions";
import { createPermissions } from "./permissions";
import type { ProtocolRequest } from "./protocol";
import { createProtocols } from "./protocol";
import {
  createSessions,
  followNetworkEmulation,
  framePreloadsOf,
  learnStoragePath,
  sessionPartition,
} from "./session";
import type { SessionCallMessage } from "./session-calls";
import { createSessionCalls } from "./session-calls";
import type { WebRequestMessage } from "./web-request";
import { createWebRequests } from "./web-request";

const setUp = () => {
  const sent: (
    | ProtocolRequest
    | WebRequestMessage
    | SessionCallMessage
    | PermissionMessage
  )[] = [];
  const calls = createSessionCalls(
    (m) => sent.push(m),
    () => "Notes/1 Electron/45",
  );
  const created: unknown[] = [];
  const sessions = createSessions(
    createProtocols((r) => sent.push(r)),
    createWebRequests(
      (m) => sent.push(m),
      () => undefined,
    ),
    calls,
    createPermissions(
      (m) => sent.push(m),
      () => undefined,
      () => undefined,
    ),
    (session) => created.push(session),
  );
  return { calls, created, sent, sessions };
};

describe(createSessions, () => {
  it("makes each partition's session once, the app's own for '', and says each", () => {
    const { created, sessions } = setUp();

    expect(sessions.fromPartition("persist:a")).toBe(
      sessions.fromPartition("persist:a"),
    );
    expect(sessions.fromPartition("")).toBe(sessions.defaultSession);
    expect(sessions.fromPartition("a")).not.toBe(
      sessions.fromPartition("persist:a"),
    );
    expect(created).toEqual([
      sessions.defaultSession,
      sessions.fromPartition("persist:a"),
      sessions.fromPartition("a"),
    ]);
  });

  it("keeps a session made from a path, once per path", () => {
    const { sessions } = setUp();

    const session = sessions.fromPath("/home/me/.config/App/Partitions/a");

    expect(sessions.fromPath("/home/me/.config/App/Partitions/a")).toBe(
      session,
    );
    expect(session.isPersistent()).toBe(true);
    expect(sessionPartition(session)).toBe(
      "persist:/home/me/.config/App/Partitions/a",
    );
    expect(() => sessions.fromPath("Partitions/a")).toThrow(
      "An absolute path is required",
    );
  });

  it("keeps whether to check spelling, by method or property", () => {
    const { sessions } = setUp();
    const session = sessions.defaultSession;

    session.spellCheckerEnabled = false;

    expect(session.isSpellCheckerEnabled()).toBe(false);
    session.setSpellCheckerEnabled(true);
    expect(session.spellCheckerEnabled).toBe(true);
  });

  it("has a net log for Slack to read, which says what the engine doesn't do", async () => {
    const { netLog } = setUp().sessions.defaultSession;

    expect(netLog.currentlyLogging).toBe(false);
    await expect(netLog.startLogging("/tmp/net.log")).rejects.toThrow(
      "net log",
    );
  });

  it("watches its service workers once the app reaches for them", () => {
    const { sent, sessions } = setUp();
    sent.length = 0;
    const { serviceWorkers } = sessions.defaultSession;

    expect(sessions.defaultSession.serviceWorkers).toBe(serviceWorkers);
    expect(serviceWorkers.getAllRunning()).toEqual({});
    expect(sent).toEqual([
      {
        call: 1,
        method: "service_workers_watch",
        session: "",
        type: "session_call",
      },
    ]);
  });

  it("passes each service worker report to its session", () => {
    const { sessions } = setUp();
    const { serviceWorkers } = sessions.fromPartition("persist:a");
    const scopes: unknown[] = [];
    serviceWorkers.on("registration-completed", (_event, details) =>
      scopes.push(details),
    );

    sessions.heardServiceWorker({
      event: "registration_completed",
      scope: "https://a.test/",
      session: "persist:a",
      type: "service_worker",
    });

    expect(scopes).toEqual([{ scope: "https://a.test/" }]);
    expect(() =>
      sessions.heardServiceWorker({
        event: "registration_completed",
        scope: "https://a.test/",
        session: "persist:b",
        type: "service_worker",
      }),
    ).toThrow(
      'the engine reported a service worker of session "persist:b", which watches none',
    );
  });

  it("has a net log for Slack to read, which says the engine keeps none", async () => {
    const { sessions } = setUp();
    const { netLog } = sessions.defaultSession;

    expect(netLog.currentlyLogging).toBe(false);
    await expect(netLog.startLogging("/tmp/net.log")).rejects.toThrow(
      "net log",
    );
  });

  it("gives its storage path once the engine names it, and none in memory", async () => {
    const { calls, sessions } = setUp();
    const kept = sessions.fromPartition("persist:a");
    const memory = sessions.fromPartition("a");

    expect(() => kept.getStoragePath()).toThrow(
      "the engine hasn't named session \"persist:a\"'s storage path yet",
    );
    const learned = learnStoragePath(kept);
    calls.hear({ call: 1, result: "/data/a", type: "session_result" });
    await learned;

    expect(kept.getStoragePath()).toBe("/data/a");
    expect(kept.storagePath).toBe("/data/a");
    expect(memory.getStoragePath()).toBeNull();
    expect(await learnStoragePath(memory)).toBeUndefined();
  });

  it("tells its caller of each session it makes, once", () => {
    const seen: string[] = [];
    const calls = createSessionCalls(
      () => undefined,
      () => "",
    );
    const sessions = createSessions(
      createProtocols(() => undefined),
      createWebRequests(
        () => undefined,
        () => undefined,
      ),
      calls,
      createPermissions(
        () => undefined,
        () => undefined,
        () => undefined,
      ),
      (session) => seen.push(sessionPartition(session)),
    );

    sessions.fromPartition("persist:a");
    sessions.fromPartition("persist:a");

    expect(seen).toEqual(["", "persist:a"]);
  });

  it("keeps frame preloads it registers, and setPreloads replaces the ones it set", () => {
    const { sessions } = setUp();
    const session = sessions.defaultSession;

    const id = session.registerPreloadScript({
      filePath: "/app/a.js",
      type: "frame",
    });
    session.setPreloads(["/app/b.js", "/app/c.js"]);
    session.setPreloads(["/app/c.js"]);

    expect(session.getPreloads()).toEqual(["/app/a.js", "/app/c.js"]);
    expect(framePreloadsOf(session)).toEqual(["/app/a.js", "/app/c.js"]);
    expect(session.getPreloadScripts()).toMatchObject([
      { filePath: "/app/a.js", id, type: "frame" },
      { filePath: "/app/c.js", type: "frame" },
    ]);
    session.unregisterPreloadScript(id);
    expect(session.getPreloads()).toEqual(["/app/c.js"]);
  });

  it("refuses a preload it can't run as Electron would", () => {
    const { sessions } = setUp();
    const session = sessions.defaultSession;
    session.registerPreloadScript({
      filePath: "/app/a.js",
      id: "a",
      type: "frame",
    });

    expect(() =>
      session.registerPreloadScript({
        filePath: "/app/a.js",
        id: "a",
        type: "frame",
      }),
    ).toThrow('a preload script "a" is already registered');
    expect(() =>
      session.registerPreloadScript({ filePath: "a.js", type: "frame" }),
    ).toThrow("a preload script's filePath must be absolute, not a.js");
    expect(() =>
      session.registerPreloadScript({
        filePath: "/app/sw.js",
        type: "service-worker",
      }),
    ).toThrow("Domicile's engine runs no preload in service workers yet");
    expect(() =>
      session.registerPreloadScript({
        filePath: "/app/b.js",
        matches: ["https://a.test/*"],
        type: "frame",
      }),
    ).toThrow(
      "Domicile's engine runs a session's preloads in every page, so it can't match them yet",
    );
    expect(() => session.unregisterPreloadScript("b")).toThrow(
      'no preload script "b" is registered',
    );
  });

  it("reads its spell checker's enabling as a property too", () => {
    const { sessions } = setUp();
    const session = sessions.defaultSession;

    session.spellCheckerEnabled = false;

    expect(session.isSpellCheckerEnabled()).toBe(false);
    expect(session.spellCheckerEnabled).toBe(false);
  });

  it("finds no blob, since the engine names none to the app", async () => {
    const { sessions } = setUp();

    await expect(sessions.defaultSession.getBlobData("b1")).rejects.toThrow(
      "no blob b1: Domicile's engine names no blob to the app",
    );
  });

  it("takes the domains an app allows NTLM sign-in for, as Slack sets them", () => {
    const { sessions } = setUp();

    expect(() =>
      sessions.defaultSession.allowNTLMCredentialsForDomains("*"),
    ).not.toThrow();
  });

  it("takes a display media handler, leaving the desktop's picker to answer", () => {
    const { sent, sessions } = setUp();
    let asked = false;

    sessions.defaultSession.setDisplayMediaRequestHandler(
      () => {
        asked = true;
      },
      { useSystemPicker: true },
    );

    expect(asked).toBe(false);
    expect(sent).toEqual([
      { scheme: "file", session: "", type: "handle_protocol" },
    ]);
  });

  it("tells the session a page's preconnect names", async () => {
    const { sessions } = setUp();
    const heard = new Promise((resolve) =>
      sessions
        .fromPartition("persist:a")
        .once("preconnect", (_event, url, allowCredentials) =>
          resolve({ allowCredentials, url }),
        ),
    );

    sessions.heardPreconnect({
      allow_credentials: false,
      session: "persist:a",
      type: "preconnect",
      url: "https://b.test/",
    });

    expect(await heard).toEqual({
      allowCredentials: false,
      url: "https://b.test/",
    });
    expect(() =>
      sessions.heardPreconnect({
        allow_credentials: false,
        session: "never",
        type: "preconnect",
        url: "https://b.test/",
      }),
    ).toThrow('the engine named session "never", which the app never made');
  });

  it("tells each session of each dictionary loaded, sessions made later too", async () => {
    const { sessions } = setUp();
    const languagesOf = (
      session: ReturnType<typeof sessions.fromPartition>,
    ) => {
      const languages: string[] = [];
      session.on("spellcheck-dictionary-initialized", (_event, language) =>
        languages.push(language),
      );
      return languages;
    };
    const own = languagesOf(sessions.defaultSession);

    sessions.heardDictionary({ language: "en-US" });
    sessions.heardDictionary({ language: "de-DE" });
    const later = languagesOf(sessions.fromPartition("later"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(own).toEqual(["en-US", "de-DE"]);
    expect(later).toEqual(["en-US", "de-DE"]);
  });

  it("emulates network conditions in its own pages only", () => {
    const { sessions } = setUp();
    const own: unknown[] = [];
    const other: unknown[] = [];
    followNetworkEmulation(sessions.fromPartition("slow"), {
      set: (method) => own.push(method),
    });
    followNetworkEmulation(sessions.defaultSession, {
      set: (method) => other.push(method),
    });

    sessions.fromPartition("slow").enableNetworkEmulation({ offline: true });
    sessions.fromPartition("slow").disableNetworkEmulation();

    expect(own).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ offline: true }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({ offline: false }),
      }),
    ]);
    expect(other).toEqual([]);
  });

  it("names its partition for the engine", () => {
    const { sessions } = setUp();

    expect(sessionPartition(sessions.defaultSession)).toBe("");
    expect(sessionPartition(sessions.fromPartition("persist:a"))).toBe(
      "persist:a",
    );
  });

  it("gives each session its own protocol, serving file: from the start", () => {
    const { sent, sessions } = setUp();

    sessions
      .fromPartition("persist:a")
      .protocol.handle("app", () => new Response(""));

    expect(sessions.defaultSession.protocol.isProtocolHandled("app")).toBe(
      false,
    );
    expect(sent).toEqual([
      { scheme: "file", session: "", type: "handle_protocol" },
      { scheme: "file", session: "persist:a", type: "handle_protocol" },
      { scheme: "app", session: "persist:a", type: "handle_protocol" },
    ]);
  });

  it("gives each session its own webRequest", () => {
    const { sent, sessions } = setUp();
    const { webRequest } = sessions.fromPartition("persist:a");
    sent.length = 0;

    webRequest.onCompleted(() => undefined);

    expect(sent).toEqual([
      {
        events: ["completed"],
        session: "persist:a",
        type: "web_request_listen",
      },
    ]);
  });

  it("gives each session a permission request handler of its own", () => {
    const { sent, sessions } = setUp();
    const session = sessions.fromPartition("persist:a");
    sent.length = 0;

    session.setPermissionRequestHandler(() => undefined);

    expect(sent).toEqual([
      { handle: true, session: "persist:a", type: "permission_handler" },
    ]);
  });

  it("gives each session cookies and storage calls of its own partition", async () => {
    const { calls, sent, sessions } = setUp();
    sent.length = 0;

    const cleared = sessions.fromPartition("persist:a").clearCache();
    sessions.defaultSession.setUserAgent("Claude/1");
    const cookies = sessions.defaultSession.cookies.get({});
    calls.hear({ call: 1, result: null, type: "session_result" });
    calls.hear({ call: 3, result: [], type: "session_result" });

    // Less the file: handler each new session starts with.
    expect(sent.filter((m) => m.type === "session_call")).toEqual([
      {
        call: 1,
        method: "clear_cache",
        session: "persist:a",
        type: "session_call",
      },
      {
        call: 2,
        method: "set_user_agent",
        session: "",
        type: "session_call",
        user_agent: "Claude/1",
      },
      {
        call: 3,
        filter: {},
        method: "cookies_get",
        session: "",
        type: "session_call",
      },
    ]);
    expect(sessions.defaultSession.getUserAgent()).toBe("Claude/1");
    expect(await cleared).toBeUndefined();
    expect(await cookies).toEqual([]);
  });
});
