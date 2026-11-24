import { describe, expect, it } from "bun:test";

import { createUserAgentFallback, electronUserAgent } from "./user-agent";

const engine = {
  chromeVersion: "160.0.8155.0",
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/160.0.0.0 Safari/537.36",
};

describe(electronUserAgent, () => {
  it("names the app, Chrome's full version and Electron, as Electron does", () => {
    expect(electronUserAgent(engine, "Claude Desktop", "5.11.0")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ClaudeDesktop/5.11.0 Chrome/160.0.8155.0 Electron/45.2.1 Safari/537.36",
    );
  });

  it("throws for an engine user agent that names no Chrome", () => {
    expect(() =>
      electronUserAgent({ ...engine, userAgent: "Mozilla/5.0" }, "a", "1"),
    ).toThrow("the engine's user agent names no Chrome: Mozilla/5.0");
  });
});

describe(createUserAgentFallback, () => {
  const setUp = () => {
    const sent: unknown[] = [];
    let name = "Notes";
    const fallback = createUserAgentFallback(
      { send: (request) => sent.push(request) },
      () => `${name}/1 Electron/45`,
    );
    return {
      fallback,
      rename: (to: string) => {
        name = to;
      },
      sent,
    };
  };

  it("tells the engine again when the app is renamed, until it sets its own", () => {
    const { fallback, rename, sent } = setUp();
    fallback.announce();
    rename("Jots");
    fallback.renamed();
    fallback.set("Custom/1");
    rename("Scribbles");
    fallback.renamed();

    expect(fallback.get()).toBe("Custom/1");
    expect(sent).toEqual([
      { type: "set_user_agent_fallback", user_agent: "Notes/1 Electron/45" },
      { type: "set_user_agent_fallback", user_agent: "Jots/1 Electron/45" },
      { type: "set_user_agent_fallback", user_agent: "Custom/1" },
    ]);
  });

  it("goes back to Electron's when set to nothing, as Electron does", () => {
    const { fallback, sent } = setUp();
    fallback.set("Custom/1");
    fallback.set("");

    expect(fallback.get()).toBe("Notes/1 Electron/45");
    expect(sent.at(-1)).toEqual({
      type: "set_user_agent_fallback",
      user_agent: "Notes/1 Electron/45",
    });
  });
});
