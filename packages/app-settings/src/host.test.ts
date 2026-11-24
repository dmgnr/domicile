import { describe, expect, it } from "bun:test";
import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import {
  encodeFrame,
  frameDecoder,
} from "@domicile-desktop/component-library/app-host-frames";
import type { Processes } from "@domicile-desktop/sdk/desktop/processes";
import type {
  Exit,
  Subprocess,
  SystemError,
} from "@domicile-desktop/sdk/system";
import { Signal, SystemErrorKind } from "@domicile-desktop/sdk/system";
import type { SitePermission } from "./host";
import { spawnedHost } from "./host";

/** A started host process, as a test drives it. */
type FakeProcess = {
  /** Each message the app wrote to its stdin. */
  sent: unknown[];
  /** Writes `message` to its stdout, as one frame or split in two. */
  answer: (message: unknown, split?: number) => void;
  /** Ends it, after writing `stderr`. */
  end: (exit: Result<Exit, SystemError>, stderr?: string) => void;
  /** Each signal the app sent it. */
  killed: Signal[];
};

/**
 * A `spawn` that starts fake processes, or fails with each of `failures`
 * first.
 */
const fakeDesktop = (failures: SystemError[] = []) => {
  const processes: FakeProcess[] = [];
  const system: Pick<Processes, "spawn"> = {
    spawn: (argv, options) => {
      expect(argv).toEqual(["domicile-app-host"]);
      expect(options).toEqual({ stdin: true });
      const failure = failures.shift();
      return Promise.resolve(
        failure === undefined ? Ok(fakeProcess(processes)) : Err(failure),
      );
    },
  };
  return { processes, system };
};

/** A process whose controls go in `processes`. */
const fakeProcess = (processes: FakeProcess[]): Subprocess => {
  const stdout = pushed();
  const stderr = pushed();
  const { promise: exited, resolve: settle } =
    Promise.withResolvers<Result<Exit, SystemError>>();
  const decode = frameDecoder();
  const sent: unknown[] = [];
  const killed: Signal[] = [];
  const end = (exit: Result<Exit, SystemError>, text = "") => {
    stderr.push(new TextEncoder().encode(text));
    stdout.close();
    stderr.close();
    settle(exit);
  };
  processes.push({
    answer: (message, split = 0) => {
      const frame = encodeFrame(message);
      stdout.push(frame.slice(0, split));
      stdout.push(frame.slice(split));
    },
    end,
    killed,
    sent,
  });
  return {
    closeStdin: () => {
      throw new Error("The app never closes the host's stdin");
    },
    exited,
    kill: (signal = Signal.Term) => {
      killed.push(signal);
      end(Ok({ code: undefined, signal: 15 }));
    },
    stderr: stderr.stream,
    stdout: stdout.stream,
    write: (data) => {
      sent.push(
        ...decode(
          typeof data === "string" ? new TextEncoder().encode(data) : data,
        ),
      );
    },
  };
};

/** A stream the test writes to. */
const pushed = () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (started) => {
      controller = started;
    },
  });
  return {
    close: () => {
      controller?.close();
    },
    push: (chunk: Uint8Array) => {
      controller?.enqueue(chunk);
    },
    stream,
  };
};

/** Lets the host spawn and write what it was asked. */
const settled = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** The host over fake processes, with what it already asked. */
const started = async <T>(ask: (host: ReturnType<typeof spawnedHost>) => T) => {
  const fake = fakeDesktop();
  const host = spawnedHost(fake.system);
  const asked = ask(host);
  await settled();
  return { ...fake, asked, host };
};

const DEFAULTS = {
  "automatic-downloads": "ask",
  camera: "ask",
  clipboard: "ask",
  "idle-detection": "ask",
  "local-fonts": "ask",
  location: "ask",
  microphone: "ask",
  midi: "ask",
  notifications: "allow",
  "window-management": "ask",
} as const;

const FILES = {
  config: {
    path: "/home/me/.config/domicile/domicile.json",
    text: "{}",
    writable: true,
  },
  evaluated: null,
  options: '{"gaps":{"kind":"number","label":"Gaps","default":8}}',
  shell: null,
};

describe(spawnedHost, () => {
  describe("requests", () => {
    it("reads the files, matching the reply to its request", async () => {
      const { asked, processes } = await started((host) => host.read());
      expect(processes[0]?.sent).toEqual([{ id: 1, type: "read" }]);
      processes[0]?.answer({ id: 1, type: "files", ...FILES });
      expect(await asked).toEqual({
        config: FILES.config,
        evaluated: undefined,
        options: FILES.options,
        shell: undefined,
      });
    });

    it("takes a reply split across reads", async () => {
      const { asked, processes } = await started((host) => host.read());
      processes[0]?.answer({ id: 1, type: "files", ...FILES }, 2);
      expect((await asked).config).toEqual(FILES.config);
    });

    it("rejects with the host's reason when it refuses", async () => {
      const { asked, processes } = await started((host) =>
        host.write("shell", "x"),
      );
      expect(processes[0]?.sent).toEqual([
        { file: "shell", id: 1, text: "x", type: "write" },
      ]);
      processes[0]?.answer({
        id: 1,
        type: "refused",
        why: "shell.ts is read-only",
      });
      await expect(asked).rejects.toThrow("shell.ts is read-only");
    });

    it("lists and sets site permissions", async () => {
      const { asked, host, processes } = await started((host) =>
        host.sitePermissions(),
      );
      const sites: SitePermission[] = [
        {
          origin: "https://meet.example",
          permission: "camera",
          setting: "allow",
        },
      ];
      processes[0]?.answer({
        defaults: DEFAULTS,
        id: 1,
        sites,
        type: "site_permissions",
      });
      expect(await asked).toEqual({ defaults: DEFAULTS, sites });

      const site = {
        origin: "https://meet.example",
        permission: "camera",
        setting: "block",
      } as const;
      const stored = host.setSitePermission(site);
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 2,
        site,
        type: "set_site_permission",
      });
      processes[0]?.answer({ id: 2, type: "stored" });
      await stored;
    });

    it("lists the monitors", async () => {
      const { asked, processes } = await started((host) => host.monitors());
      const monitors = [{ hdr: "unsupported" as const, names: ["drm-1"] }];
      expect(processes[0]?.sent.at(-1)).toEqual({ id: 1, type: "monitors" });
      processes[0]?.answer({ id: 1, monitors, type: "monitors" });
      expect(await asked).toEqual(monitors);
    });

    it("lists, stops and forgets agents", async () => {
      const { asked, host, processes } = await started((host) => host.agents());
      expect(processes[0]?.sent.at(-1)).toEqual({ id: 1, type: "agents" });
      processes[0]?.answer({
        agents: {
          connected: [
            { agent: "Claude Code", reach: { type: "desk" }, session: 4 },
          ],
          remembered: [{ agent: "Codex", last_used_ms: 9 }],
        },
        id: 1,
        type: "agents",
      });
      expect(await asked).toEqual({
        connected: [
          { agent: "Claude Code", reach: { type: "desk" }, session: 4 },
        ],
        remembered: [{ agent: "Codex", lastUsedMs: 9 }],
      });

      const stopped = host.stopAgent(4);
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 2,
        session: 4,
        type: "stop_agent",
      });
      processes[0]?.answer({ id: 2, type: "done" });
      await stopped;

      const forgot = host.forgetAgent("Codex");
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        agent: "Codex",
        id: 3,
        type: "forget_agent",
      });
      processes[0]?.answer({ id: 3, type: "done" });
      await forgot;
    });

    it("lists media devices and prefers one", async () => {
      const { asked, host, processes } = await started((host) =>
        host.mediaDevices(),
      );
      const devices = {
        cameras: [{ id: "/dev/video2", name: "USB Camera" }],
        microphones: [],
      };
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 1,
        type: "media_devices",
      });
      processes[0]?.answer({ ...devices, id: 1, type: "media_devices" });
      expect(await asked).toEqual(devices);

      const stored = host.setMediaDevice("camera", "/dev/video2");
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        device: "/dev/video2",
        id: 2,
        kind: "camera",
        type: "set_media_device",
      });
      processes[0]?.answer({ id: 2, type: "stored" });
      await stored;
    });

    it("lists site data and clears a host's", async () => {
      const { asked, host, processes } = await started((host) =>
        host.siteData(),
      );
      const sites = [{ bytes: 2048, cookies: 1, host: "a.example" }];
      expect(processes[0]?.sent.at(-1)).toEqual({ id: 1, type: "site_data" });
      processes[0]?.answer({ id: 1, sites, type: "site_data" });
      expect(await asked).toEqual(sites);

      const cleared = host.clearSiteData("a.example");
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        host: "a.example",
        id: 2,
        type: "clear_site_data",
      });
      processes[0]?.answer({ id: 2, type: "cleared" });
      await cleared;
    });

    it("loads and uninstalls extensions, and lists the config's", async () => {
      const id = "b".repeat(32);
      const { asked, host, processes } = await started((host) =>
        host.loadUnpacked("~/src/my-extension"),
      );
      expect(processes[0]?.sent.at(-1)).toEqual({
        directory: "~/src/my-extension",
        id: 1,
        type: "load_unpacked",
      });
      processes[0]?.answer({ extension: id, id: 1, type: "loaded_unpacked" });
      expect(await asked).toBe(id);

      const uninstalled = host.uninstallExtension(id);
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        extension: id,
        id: 2,
        type: "uninstall_extension",
      });
      processes[0]?.answer({ id: 2, type: "uninstalled" });
      await uninstalled;

      const listed = host.configExtensions();
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 3,
        type: "config_extensions",
      });
      processes[0]?.answer({ id: 3, ids: [id], type: "config_extensions" });
      expect(await listed).toEqual([id]);
    });

    it("lists the installed extensions, with or without options pages", async () => {
      const { asked, processes } = await started((host) => host.extensions());
      expect(processes[0]?.sent).toEqual([{ id: 1, type: "extensions" }]);
      const extension = {
        description: "An efficient content blocker.",
        enabled: true,
        id: "a".repeat(32),
        name: "uBlock Origin Lite",
        settings: { file_access: false, site_access: ["github.com"] },
        version: "2025.1",
      };
      processes[0]?.answer({
        extensions: [
          {
            ...extension,
            icon: "data:image/png;base64,iVBORw==",
            options_url: "chrome-extension://a/options.html",
          },
          { ...extension, icon: null, options_url: null },
          extension,
        ],
        id: 1,
        type: "extensions",
      });
      expect(await asked).toEqual([
        {
          ...extension,
          icon: "data:image/png;base64,iVBORw==",
          optionsUrl: "chrome-extension://a/options.html",
        },
        { ...extension, icon: undefined, optionsUrl: undefined },
        { ...extension, icon: undefined, optionsUrl: undefined },
      ]);
    });

    it("switches an extension and opens a URL", async () => {
      const { asked, host, processes } = await started((host) =>
        host.setExtensionEnabled("a".repeat(32), false),
      );
      expect(processes[0]?.sent.at(-1)).toEqual({
        enabled: false,
        extension: "a".repeat(32),
        id: 1,
        type: "set_extension_enabled",
      });
      processes[0]?.answer({ id: 1, type: "stored" });
      await asked;

      const opened = host.openUrl("chrome-extension://a/options.html");
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 2,
        type: "open_url",
        url: "chrome-extension://a/options.html",
      });
      processes[0]?.answer({ id: 2, type: "opened" });
      await opened;
    });

    it("changes an extension's settings", async () => {
      const { asked, processes } = await started((host) =>
        host.configureExtension("a".repeat(32), { site_access: "on_click" }),
      );
      expect(processes[0]?.sent.at(-1)).toEqual({
        extension: "a".repeat(32),
        id: 1,
        settings: { site_access: "on_click" },
        type: "configure_extension",
      });
      processes[0]?.answer({ id: 1, type: "stored" });
      await asked;
    });

    it("asks the desktop's picker for a folder", async () => {
      const { asked, host, processes } = await started((host) =>
        host.chooseFolder(),
      );
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 1,
        type: "choose_folder",
      });
      processes[0]?.answer({ id: 1, path: "/home/me/src/x", type: "folder" });
      expect(await asked).toBe("/home/me/src/x");

      const canceled = host.chooseFolder();
      await settled();
      processes[0]?.answer({ id: 2, path: null, type: "folder" });
      expect(await canceled).toBeUndefined();
    });

    it("reads and switches detailed logging", async () => {
      const { asked, host, processes } = await started((host) =>
        host.detailedLogging(),
      );
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 1,
        type: "detailed_logging",
      });
      processes[0]?.answer({ id: 1, on: false, type: "detailed_logging" });
      expect(await asked).toBe(false);

      const switched = host.setDetailedLogging(true);
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 2,
        on: true,
        type: "set_detailed_logging",
      });
      processes[0]?.answer({ id: 2, on: true, type: "detailed_logging" });
      expect(await switched).toBe(true);
    });

    it("saves the logs and opens Downloads", async () => {
      const { asked, host, processes } = await started((host) =>
        host.exportLogs(false),
      );
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 1,
        redact: false,
        type: "export_logs",
      });
      processes[0]?.answer({
        id: 1,
        path: "/home/me/Downloads/domicile-logs.txt",
        type: "exported_logs",
        unhidden: "web addresses and window titles are not hidden",
      });
      expect(await asked).toEqual({
        path: "/home/me/Downloads/domicile-logs.txt",
        unhidden: "web addresses and window titles are not hidden",
      });

      const opened = host.openDownloads();
      await settled();
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 2,
        type: "open_downloads",
      });
      processes[0]?.answer({ id: 2, type: "opened" });
      await opened;
    });

    it("tells listeners a file changed on disk", async () => {
      const { asked, processes } = await started(
        (host) =>
          new Promise<void>((resolve) => {
            host.onChange(resolve);
          }),
      );
      processes[0]?.answer({ type: "changed" });
      await asked;
    });
  });

  describe("the process", () => {
    it.each([
      [
        "its stderr",
        Ok({ code: 1, signal: undefined }),
        "domicile-app-host: DOMICILE_SOCK is not set\n",
        "domicile-app-host: DOMICILE_SOCK is not set",
      ],
      [
        "its exit code",
        Ok({ code: 1, signal: undefined }),
        "",
        "The settings host exited with code 1",
      ],
      [
        "the signal that killed it",
        Ok({ code: undefined, signal: 9 }),
        "",
        "The settings host was killed by signal 9",
      ],
      [
        "why it could not be followed",
        Err({ kind: SystemErrorKind.Other, message: "the desktop went away" }),
        "",
        "the desktop went away",
      ],
    ] satisfies [string, Result<Exit, SystemError>, string, string][])(
      "fails what was asked with %s when it ends, and starts again for the next",
      async (_, exit, stderr, why) => {
        const { asked, host, processes } = await started((host) => host.read());
        processes[0]?.end(exit, stderr);
        await expect(asked).rejects.toThrow(why);

        const again = host.read();
        await settled();
        expect(processes).toHaveLength(2);
        processes[1]?.answer({ id: 2, type: "files", ...FILES });
        expect((await again).config).toEqual(FILES.config);
      },
    );

    it("fails what was asked when it cannot start, and tries again for the next", async () => {
      const { processes, system } = fakeDesktop([
        {
          kind: SystemErrorKind.NotFound,
          message: "No such file or directory",
        },
      ]);
      const host = spawnedHost(system);
      await expect(host.read()).rejects.toThrow("No such file or directory");

      const again = host.read();
      await settled();
      processes[0]?.answer({ id: 2, type: "files", ...FILES });
      expect((await again).config).toEqual(FILES.config);
    });

    it("stops a host that sends a bad message, failing what was asked", async () => {
      const { asked, processes } = await started((host) => host.read());
      processes[0]?.answer({ id: 1, type: "nonsense" });
      await expect(asked).rejects.toThrow(
        "The settings host sent a bad message",
      );
      expect(processes[0]?.killed).toEqual([Signal.Term]);
    });
  });
});
