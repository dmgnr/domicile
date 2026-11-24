import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Serving } from "./serve";
import { DEV_MODULE, documentScripts, HMR_PATH, serve } from "./serve";

/** This checkout, which has the same layout as a Domicile install. */
const DOMICILE = path.resolve(import.meta.dir, "..", "..", "..");

/** The servers a test started, closed after it. */
const running: Serving[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((serving) => serving.close()));
});

/** A project in a new directory, with `files` written into it. */
const project = (files: Record<string, string>): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "domicile-builder-serve-"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), text);
  }
  return directory;
};

/** Serve `directory`'s `entry`, as `domicile dev` does. */
const served = async (
  directory: string,
  entry: string,
  config?: string,
): Promise<string> => {
  const socket = path.join(directory, "dev.sock");
  running.push(
    await serve({
      cache: path.join(directory, ".cache"),
      config: config === undefined ? undefined : path.join(directory, config),
      domicile: DOMICILE,
      entry: path.join(directory, entry),
      project: directory,
      socket,
    }),
  );
  return socket;
};

/** A request to the dev server, as the engine makes it: HTTP/1.0. */
const ask = (
  socket: string,
  route: string,
  body?: string,
): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const asked = request(
      {
        headers: { connection: "close", host: "shell" },
        method: body === undefined ? "GET" : "POST",
        path: route,
        socketPath: socket,
      },
      resolve,
    );
    asked.on("error", reject);
    asked.end(body);
  });

/** The whole body of a GET of `route`. */
const fetched = async (socket: string, route: string): Promise<string> => {
  const response = await ask(socket, route);
  expect(response.statusCode).toBe(200);
  return await response.toArray().then((chunks) => chunks.join(""));
};

/**
 * The page's HMR connection: its id, and the next payload line matching
 * `wanted`, after `edit` runs.
 */
const updates = async (socket: string) => {
  const response = await ask(socket, HMR_PATH);
  expect(response.statusCode).toBe(200);
  const lines: string[] = [];
  let pending = "";
  const heard: (() => void)[] = [];
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    pending += chunk;
    const whole = pending.split("\n");
    pending = whole.pop() ?? "";
    lines.push(...whole);
    for (const listener of heard.splice(0)) {
      listener();
    }
  });
  const next = async (wanted: (line: string) => boolean): Promise<string> => {
    for (;;) {
      const found = lines.findIndex(wanted);
      if (found !== -1) {
        return lines.splice(0, found + 1).at(-1) ?? "";
      }
      await new Promise<void>((resolve) => heard.push(resolve));
    }
  };
  return {
    client: String(response.headers["x-domicile-hmr-client"]),
    next,
    stop: () => response.destroy(),
  };
};

describe("serve", () => {
  it("serves the module the engine imports: the document's scripts, then the entry's exports", async () => {
    const directory = project({
      "shell.ts": `export const Shell = () => {};`,
    });
    const socket = await served(directory, "shell.ts");

    expect(await fetched(socket, `/${DEV_MODULE}`)).toMatch(
      /^import "\/@domicile\/preamble\.js";\nexport \* from "\/shell\.ts";/,
    );
    expect(await fetched(socket, "/@domicile/preamble.js")).toContain(
      'import "/@vite/client"',
    );
  });

  // The shell page cannot open a WebSocket to its own origin, so a client
  // still opening one would get no updates.
  it("gives Vite's client a connection over requests instead of a WebSocket", async () => {
    const socket = await served(
      project({ "shell.ts": `export const Shell = () => {};` }),
      "shell.ts",
    );

    const client = await fetched(socket, "/@vite/client");
    expect(client).toContain("class DomicileHmrSocket");
    expect(client).not.toContain("new WebSocket(");
  });

  // Only this user may read the shell's sources.
  it("listens on a socket only this user can open", async () => {
    const socket = await served(
      project({ "shell.ts": `export const Shell = () => {};` }),
      "shell.ts",
    );

    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });

  it("sends the page an update when a module the shell accepts changes", async () => {
    const directory = project({
      "label.ts": `export const label = "one";`,
      "shell.ts": `import { label } from "./label";
        export const Shell = () => label;
        import.meta.hot?.accept("./label", () => {});`,
    });
    const socket = await served(directory, "shell.ts");
    // Vite knows a module's importers once the page has loaded it.
    await fetched(socket, "/shell.ts");
    await fetched(socket, "/label.ts");
    const page = await updates(socket);
    await page.next((line) => line.includes('"connected"'));

    writeFileSync(
      path.join(directory, "label.ts"),
      `export const label = "two";`,
    );

    const update = JSON.parse(
      await page.next((line) => line.includes('"update"')),
    );
    page.stop();
    expect(update.updates).toEqual([
      expect.objectContaining({
        acceptedPath: "/label.ts",
        path: "/shell.ts",
        type: "js-update",
      }),
    ]);
  });

  // Vite's client swaps a stylesheet in place on a CSS update.
  it("sends the page a CSS update when an imported stylesheet changes", async () => {
    const directory = project({
      "shell.ts": `import "./style.css"; export const Shell = () => {};`,
      "style.css": `body { color: red; }`,
    });
    const socket = await served(directory, "shell.ts");
    await fetched(socket, "/shell.ts");
    await fetched(socket, "/style.css");
    const page = await updates(socket);
    await page.next((line) => line.includes('"connected"'));

    writeFileSync(path.join(directory, "style.css"), `body { color: blue; }`);

    const update = JSON.parse(
      await page.next((line) => line.includes('"update"')),
    );
    page.stop();
    expect(update.updates).toEqual([
      expect.objectContaining({
        acceptedPath: "/style.css",
        type: "js-update",
      }),
    ]);
  });

  // Nothing accepts an edit to the entry, so the page loads again.
  it("reloads the page when the entry itself changes", async () => {
    const directory = project({ "shell.ts": `export const Shell = () => 1;` });
    const socket = await served(directory, "shell.ts");
    await fetched(socket, `/${DEV_MODULE}`);
    await fetched(socket, "/shell.ts");
    const page = await updates(socket);
    await page.next((line) => line.includes('"connected"'));

    writeFileSync(
      path.join(directory, "shell.ts"),
      `export const Shell = () => 2;`,
    );

    const reload = JSON.parse(
      await page.next((line) => line.includes('"full-reload"')),
    );
    page.stop();
    expect(reload.type).toBe("full-reload");
  });

  // `import.meta.hot.send` and Vite's own messages, such as invalidations,
  // go from the page to the server's listeners.
  it("hands the page's messages to the server's listeners, which can answer it", async () => {
    const directory = project({
      "shell.ts": `export const Shell = () => {};`,
      "vite.config.mjs": `export default {
        plugins: [{
          name: "echo",
          configureServer(server) {
            server.environments.client.hot.on("echo", (data, client) => {
              client.send("echoed", data);
            });
          },
        }],
      };`,
    });
    const socket = await served(directory, "shell.ts", "vite.config.mjs");
    const page = await updates(socket);
    await page.next((line) => line.includes('"connected"'));

    const sent = await ask(
      socket,
      `${HMR_PATH}?client=${page.client}`,
      JSON.stringify({ data: { said: "hi" }, event: "echo", type: "custom" }),
    );

    expect(sent.statusCode).toBe(204);
    const answer = JSON.parse(
      await page.next((line) => line.includes('"echoed"')),
    );
    page.stop();
    expect(answer).toEqual({
      data: { said: "hi" },
      event: "echoed",
      type: "custom",
    });
  });

  it("refuses a message from a page that is not connected", async () => {
    const socket = await served(
      project({ "shell.ts": `export const Shell = () => {};` }),
      "shell.ts",
    );

    const sent = await ask(
      socket,
      `${HMR_PATH}?client=nobody`,
      JSON.stringify({ data: {}, event: "echo", type: "custom" }),
    );

    expect(sent.statusCode).toBe(404);
  });

  it("applies the project's vite config", async () => {
    const directory = project({
      "greeting.ts": `export const greeting = "hello";`,
      "shell.ts": `import { greeting } from "~greeting";
        export const Shell = () => greeting;`,
      "vite.config.mjs": `export default {
        resolve: { alias: { "~greeting": "/greeting.ts" } },
      };`,
    });
    const socket = await served(directory, "shell.ts", "vite.config.mjs");

    expect(await fetched(socket, "/shell.ts")).toContain('from "/greeting.ts"');
  });

  // A React shell keeps its state across an edit only with Fast Refresh,
  // whose plugin adds its preamble to a document.
  it("runs the React plugin's Fast Refresh preamble before the shell", async () => {
    const directory = project({
      "shell.tsx": `export const Shell = () => <main />;`,
      "vite.config.mjs": `import react from "@vitejs/plugin-react";
        export default { plugins: [react()] };`,
    });
    symlinkSync(
      path.join(import.meta.dir, "..", "node_modules"),
      path.join(directory, "node_modules"),
    );
    const socket = await served(directory, "shell.tsx", "vite.config.mjs");

    const preamble = await fetched(socket, "/@domicile/preamble.js");
    expect(preamble).toContain("injectIntoGlobalHook(window)");
    expect(preamble).toContain('import "/@vite/client"');
    expect(await fetched(socket, "/shell.tsx")).toContain("$RefreshReg$");
  });
});

describe("documentScripts", () => {
  it("turns a document's scripts into module code, in order", () => {
    expect(
      documentScripts(
        `<html><head><script type="module">window.a = 1;</script><script type="module" src="/@vite/client"></script></head><body></body></html>`,
      ),
    ).toBe(`window.a = 1;\nimport "/@vite/client";`);
  });

  // A module cannot add a stylesheet link or a meta, and a shell missing one
  // would look broken for no reason it can see.
  it("refuses a document with a tag a module cannot add", () => {
    expect(() =>
      documentScripts(
        `<html><head><link rel="stylesheet" href="/x.css"></head><body></body></html>`,
      ),
    ).toThrow('a Vite plugin adds <link rel="stylesheet" href="/x.css">');
  });
});
