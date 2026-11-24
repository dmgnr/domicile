import { describe, expect, it } from "bun:test";

import type { SessionCallMessage } from "./session-calls";
import { createSessionCalls } from "./session-calls";

const setUp = () => {
  const sent: SessionCallMessage[] = [];
  const calls = createSessionCalls(
    (message) => sent.push(message),
    () => "Notes/1 Electron/45",
  );
  return { calls, sent };
};

describe(createSessionCalls, () => {
  it("asks the engine for a session's cookies in Electron's names", async () => {
    const { calls, sent } = setUp();
    const { cookies } = calls.forSession("persist:a");

    const got = cookies.get({ httpOnly: true, url: "https://a.test/" });
    calls.hear({
      call: 1,
      result: [{ domain: "a.test", name: "n", value: "v" }],
      type: "session_result",
    });

    expect(sent).toEqual([
      {
        call: 1,
        filter: { http_only: true, url: "https://a.test/" },
        method: "cookies_get",
        session: "persist:a",
        type: "session_call",
      },
    ]);
    expect(await got).toEqual([{ domain: "a.test", name: "n", value: "v" }]);
  });

  it("watches a session's cookies once something listens, and says each change", () => {
    const { calls, sent } = setUp();
    const { cookies } = calls.forSession("persist:a");
    const heard: unknown[][] = [];

    expect(sent).toEqual([]);
    cookies.on("changed", (_event, cookie, cause, removed) =>
      heard.push([cookie, cause, removed]),
    );
    cookies.on("changed", () => undefined);
    calls.heardCookie({
      cause: "inserted",
      cookie: { name: "lc", value: "1" },
      removed: false,
      session: "persist:a",
      type: "cookie_changed",
    });

    expect(sent).toEqual([
      {
        call: 1,
        method: "cookies_watch",
        session: "persist:a",
        type: "session_call",
      },
    ]);
    expect(heard).toEqual([[{ name: "lc", value: "1" }, "inserted", false]]);
  });

  it("refuses a change to a session nobody made", () => {
    const { calls } = setUp();

    expect(() =>
      calls.heardCookie({
        cause: "inserted",
        cookie: { name: "lc", value: "1" },
        removed: false,
        session: "persist:b",
        type: "cookie_changed",
      }),
    ).toThrow("persist:b");
  });

  it("sets and removes cookies, and rejects with the engine's reason", async () => {
    const { calls, sent } = setUp();
    const { cookies } = calls.forSession("");

    const set = cookies.set({
      expirationDate: 5,
      httpOnly: true,
      name: "n",
      sameSite: "strict",
      url: "https://a.test/",
      value: "v",
    });
    const removed = cookies.remove("https://a.test/", "n");
    calls.hear({ call: 1, error: "no", type: "session_result" });
    calls.hear({ call: 2, result: null, type: "session_result" });

    expect(sent).toEqual([
      {
        call: 1,
        details: {
          expiration_date: 5,
          http_only: true,
          name: "n",
          same_site: "strict",
          url: "https://a.test/",
          value: "v",
        },
        method: "cookies_set",
        session: "",
        type: "session_call",
      },
      {
        call: 2,
        method: "cookies_remove",
        name: "n",
        session: "",
        type: "session_call",
        url: "https://a.test/",
      },
    ]);
    expect(set).rejects.toThrow("no");
    expect(await removed).toBeUndefined();
  });

  it("clears a session's storage and cache", async () => {
    const { calls, sent } = setUp();
    const session = calls.forSession("");

    const cleared = session.clearStorageData({
      origin: "https://a.test",
      storages: ["cookies", "localstorage"],
    });
    const everything = session.clearStorageData();
    const cache = session.clearCache();
    const flushed = session.cookies.flushStore();
    for (const call of [1, 2, 3, 4]) {
      calls.hear({ call, result: null, type: "session_result" });
    }

    expect(sent.map(({ call, ...rest }) => rest)).toEqual([
      {
        method: "clear_storage_data",
        origin: "https://a.test",
        session: "",
        storages: ["cookies", "localstorage"],
        type: "session_call",
      },
      { method: "clear_storage_data", session: "", type: "session_call" },
      { method: "clear_cache", session: "", type: "session_call" },
      { method: "cookies_flush", session: "", type: "session_call" },
    ]);
    expect(await Promise.all([cleared, everything, cache, flushed])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("clears what Electron's clearData, clearAuthCache and clearCodeCaches name", async () => {
    const { calls, sent } = setUp();
    const session = calls.forSession("persist:a");

    const done = Promise.all([
      session.clearData({
        avoidClosingConnections: true,
        dataTypes: ["cookies", "cache"],
        excludeOrigins: ["https://b.test"],
        originMatchingMode: "origin-in-all-contexts",
      }),
      session.clearData(),
      session.clearAuthCache(),
      session.clearCodeCaches({ urls: ["https://a.test/app.js"] }),
      session.clearCodeCaches({}),
    ]);
    for (const call of [1, 2, 3, 4, 5]) {
      calls.hear({ call, result: null, type: "session_result" });
    }

    expect(sent.map(({ call, session: _, type, ...rest }) => rest)).toEqual([
      {
        avoid_closing_connections: true,
        data_types: ["cookies", "cache"],
        exclude_origins: ["https://b.test"],
        method: "clear_data",
        origin_matching_mode: "origin-in-all-contexts",
      },
      { method: "clear_data" },
      { method: "clear_auth_cache" },
      { method: "clear_code_caches", urls: ["https://a.test/app.js"] },
      { method: "clear_code_caches" },
    ]);
    expect(await done).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("resolves a host and preconnects through the session's network", async () => {
    const { calls, sent } = setUp();
    const session = calls.forSession("");

    const resolved = session.resolveHost("a.test", {
      cacheUsage: "disallowed",
      queryType: "AAAA",
      secureDnsPolicy: "disable",
      source: "dns",
    });
    session.preconnect({ numSockets: 2, url: "https://a.test/" });
    session.preconnect({ url: "https://b.test/" });
    calls.hear({
      call: 1,
      result: { endpoints: [{ address: "::1", family: "ipv6" }] },
      type: "session_result",
    });
    calls.hear({ call: 2, result: null, type: "session_result" });
    calls.hear({ call: 3, result: null, type: "session_result" });

    expect(sent.map(({ call, session: _, type, ...rest }) => rest)).toEqual([
      {
        cache_usage: "disallowed",
        host: "a.test",
        method: "resolve_host",
        query_type: "AAAA",
        secure_dns_policy: "disable",
        source: "dns",
      },
      { method: "preconnect_sockets", sockets: 2, url: "https://a.test/" },
      { method: "preconnect_sockets", sockets: 1, url: "https://b.test/" },
    ]);
    expect(await resolved).toEqual({
      endpoints: [{ address: "::1", family: "ipv6" }],
    });
  });

  it("refuses a preconnect of more sockets than Electron allows", () => {
    const { calls } = setUp();

    expect(() =>
      calls
        .forSession("")
        .preconnect({ numSockets: 7, url: "https://a.test/" }),
    ).toThrow("preconnect's numSockets is 1 to 6, not 7");
  });

  it("moves a session's code cache, refusing a relative path as Electron does", () => {
    const { calls, sent } = setUp();
    const session = calls.forSession("persist:a");

    session.setCodeCachePath("/home/a/.cache/code");

    expect(sent).toEqual([
      {
        call: 1,
        method: "set_code_cache_path",
        path: "/home/a/.cache/code",
        session: "persist:a",
        type: "session_call",
      },
    ]);
    expect(() => session.setCodeCachePath("code")).toThrow(
      "Absolute path must be provided to store code cache.",
    );
  });

  it("asks for a session's storage path", async () => {
    const { calls, sent } = setUp();

    const path = calls.forSession("persist:a").storagePath();
    calls.hear({ call: 1, result: "/data/Storage/a", type: "session_result" });

    expect(sent).toEqual([
      {
        call: 1,
        method: "storage_path",
        session: "persist:a",
        type: "session_call",
      },
    ]);
    expect(await path).toBe("/data/Storage/a");
  });

  it("reads and clears the session's shared dictionaries, with Electron's dates", async () => {
    const { calls, sent } = setUp();
    const session = calls.forSession("");
    const key = {
      frameOrigin: "https://a.test",
      topFrameSite: "https://a.test",
    };

    const info = session.getSharedDictionaryInfo(key);
    const usage = session.getSharedDictionaryUsageInfo();
    const cleared = session.clearSharedDictionaryCacheForIsolationKey(key);
    const all = session.clearSharedDictionaryCache();
    calls.hear({
      call: 1,
      result: [
        {
          dictionaryUrl: "https://a.test/d",
          expirationDuration: 1000,
          hash: "ab",
          id: "",
          lastFetchTime: 1,
          lastUsedTime: 2,
          match: "/*",
          matchDestinations: [],
          responseTime: 3,
          size: 10,
        },
      ],
      type: "session_result",
    });
    const used = [{ ...key, totalSizeBytes: 10 }];
    calls.hear({ call: 2, result: used, type: "session_result" });
    calls.hear({ call: 3, result: null, type: "session_result" });
    calls.hear({ call: 4, result: null, type: "session_result" });

    expect(sent.map(({ call, session: _, type, ...rest }) => rest)).toEqual([
      {
        frame_origin: "https://a.test",
        method: "get_shared_dictionary_info",
        top_frame_site: "https://a.test",
      },
      { method: "get_shared_dictionary_usage_info" },
      {
        frame_origin: "https://a.test",
        method: "clear_shared_dictionary_cache_for_isolation_key",
        top_frame_site: "https://a.test",
      },
      { method: "clear_shared_dictionary_cache" },
    ]);
    expect(await info).toEqual([
      {
        dictionaryUrl: "https://a.test/d",
        expirationDuration: 1000,
        hash: "ab",
        id: "",
        lastFetchTime: new Date(1),
        lastUsedTime: new Date(2),
        match: "/*",
        matchDestinations: [],
        responseTime: new Date(3),
        size: 10,
      },
    ]);
    expect(await usage).toEqual(used);
    expect(await Promise.all([cleared, all])).toEqual([undefined, undefined]);
  });

  it("gives a session the app's fallback user agent until it is set its own, and tells the engine", () => {
    const { calls, sent } = setUp();
    const session = calls.forSession("");

    expect(session.getUserAgent()).toBe("Notes/1 Electron/45");
    session.setUserAgent("Claude/1");

    expect(session.getUserAgent()).toBe("Claude/1");
    expect(sent).toEqual([
      {
        call: 1,
        method: "set_user_agent",
        session: "",
        type: "session_call",
        user_agent: "Claude/1",
      },
    ]);
  });

  it("fails loudly on a result nobody waits for", () => {
    const { calls } = setUp();

    expect(() =>
      calls.hear({ call: 9, result: null, type: "session_result" }),
    ).toThrow("the engine answered session call 9, which nothing waits for");
  });
});
