import { describe, expect, it } from "bun:test";
import type { Result } from "@cprussin/option-result";
import { Err, Ok } from "@cprussin/option-result";
import type { SystemHost } from "./desktop/system-calls";
import { system } from "./desktop/system-calls";
import { InhibitorAction } from "./inhibitor-action";
import { KeymapChoice } from "./keymap-choice";
import { PreviewedWindow } from "./previewed-window";
import type { SystemError } from "./system";
import {
  Bus,
  FileType,
  Listened,
  ScreenshotKept,
  Signal,
  SystemErrorKind,
  UnlockRefusal,
} from "./system";
import { ResizeEdge, WindowRequest, WindowState } from "./window-state";

/**
 * A desktop that records system calls and answers them as the
 * compositor would, by dispatching `system` events to its listeners.
 */
class FakeHost implements SystemHost {
  readonly calls: [id: number, request: unknown][] = [];
  readonly #listeners: ((event: MessageEvent<string>) => void)[] = [];

  callSystem(id: number, request: string): void {
    this.calls.push([id, JSON.parse(request)]);
  }

  addEventListener(
    type: "system",
    listener: (event: MessageEvent<string>) => void,
  ): void {
    expect(type).toBe("system");
    this.#listeners.push(listener);
  }

  /** Send a compositor line to every listener. */
  answer(line: object): void {
    const event = new MessageEvent("system", { data: JSON.stringify(line) });
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  reply(id: number, reply: object): void {
    this.answer({ id, reply, type: "system_reply" });
  }

  event(id: number, event: object): void {
    this.answer({ event, id, type: "system_event" });
  }

  end(id: number, end: object): void {
    this.answer({ end, id, type: "system_end" });
  }
}

/** How the browser ends a call whose compositor exited. */
const gone = {
  error: { kind: "compositor_gone", message: "the compositor exited" },
  kind: "failed",
};

const base64 = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The started call, or a failure that names the error. */
const started = <T extends NonNullable<unknown>>(
  result: Result<T, SystemError>,
): T =>
  result.match({
    Err: (error) => {
      throw new Error(`the call failed: ${error.message}`);
    },
    Ok: (value) => value,
  });

const read = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

describe("files", () => {
  it("reads a file", async () => {
    const host = new FakeHost();
    const reading = system(host).readFile(
      "/sys/class/power_supply/BAT0/capacity",
    );
    host.reply(1, { data: base64("97\n"), kind: "read" });

    expect(host.calls).toStrictEqual([
      [1, { call: "read_file", path: "/sys/class/power_supply/BAT0/capacity" }],
    ]);
    expect(await reading).toStrictEqual(Ok(new Uint8Array([0x39, 0x37, 0x0a])));
  });

  it("reads part of a file", async () => {
    const host = new FakeHost();
    const files = system(host);
    const middle = files.readFile("song.flac", { length: 4, offset: 8 });
    const front = files.readFile("song.flac", { length: 4 });
    host.reply(1, { data: base64("fLaC"), kind: "read" });
    host.reply(2, { data: base64("ID3"), kind: "read" });

    expect(host.calls).toStrictEqual([
      [1, { call: "read_file", length: 4, offset: 8, path: "song.flac" }],
      [2, { call: "read_file", length: 4, path: "song.flac" }],
    ]);
    expect(await middle).toStrictEqual(Ok(new TextEncoder().encode("fLaC")));
    expect(await front).toStrictEqual(Ok(new TextEncoder().encode("ID3")));
  });

  it("reads a file as text", async () => {
    const host = new FakeHost();
    const reading = system(host).readTextFile("note");
    host.reply(1, { data: base64("héllo"), kind: "read" });

    expect(await reading).toStrictEqual(Ok("héllo"));
  });

  it("says why a call failed", async () => {
    const host = new FakeHost();
    const reading = system(host).readFile("/missing");
    host.reply(1, {
      error: { kind: "not_found", message: "No such file" },
      kind: "failed",
    });

    expect(await reading).toStrictEqual(
      Err({ kind: SystemErrorKind.NotFound, message: "No such file" }),
    );
  });

  it("writes text or bytes as base64", async () => {
    const host = new FakeHost();
    const files = system(host);
    const text = files.writeFile("a", "hi");
    const bytes = files.writeFile("b", new Uint8Array([0xff]), {
      atomic: false,
    });
    host.reply(1, { kind: "written" });
    host.reply(2, { kind: "written" });

    expect(host.calls).toStrictEqual([
      [1, { atomic: true, call: "write_file", data: "aGk=", path: "a" }],
      [2, { atomic: false, call: "write_file", data: "/w==", path: "b" }],
    ]);
    expect(await text).toStrictEqual(Ok("written"));
    expect(await bytes).toStrictEqual(Ok("written"));
  });

  it("creates a directory", async () => {
    const host = new FakeHost();
    const creating = system(host).createDir("new");
    host.reply(1, { kind: "created" });

    expect(host.calls).toStrictEqual([
      [1, { call: "create_dir", path: "new" }],
    ]);
    expect(await creating).toStrictEqual(Ok("created"));
  });

  it("lists a directory", async () => {
    const host = new FakeHost();
    const listing = system(host).readDir("/sys/class/power_supply");
    host.reply(1, {
      entries: [
        { file_type: "symlink", name: "BAT0" },
        { file_type: "directory", name: "AC" },
      ],
      kind: "entries",
    });

    expect(await listing).toStrictEqual(
      Ok([
        { fileType: FileType.Symlink, name: "BAT0" },
        { fileType: FileType.Directory, name: "AC" },
      ]),
    );
  });

  it("describes a path", async () => {
    const host = new FakeHost();
    const described = system(host).stat("/sys");
    host.reply(1, {
      file_type: "directory",
      kind: "stat",
      modified_ms: null,
      size: 0,
    });

    expect(await described).toStrictEqual(
      Ok({
        fileType: FileType.Directory,
        modifiedMs: undefined,
        realPath: undefined,
        size: 0,
      }),
    );
  });
});

describe("processes", () => {
  it("streams a process's output and says how it exited", async () => {
    const host = new FakeHost();
    const spawning = system(host).spawn(["pactl", "subscribe"]);
    host.reply(1, { kind: "started" });
    const process = started(await spawning);
    host.event(1, {
      data: base64("Event 'change'\n"),
      kind: "output",
      stream: "stdout",
    });
    host.event(1, { data: base64("oops\n"), kind: "output", stream: "stderr" });
    host.end(1, { code: 0, kind: "exited", signal: null });

    expect(host.calls).toStrictEqual([
      [
        1,
        { argv: ["pactl", "subscribe"], call: "spawn", env: {}, stdin: false },
      ],
    ]);
    expect(await read(process.stdout)).toBe("Event 'change'\n");
    expect(await read(process.stderr)).toBe("oops\n");
    expect(await process.exited).toStrictEqual(
      Ok({ code: 0, signal: undefined }),
    );
  });

  it("drives a running process by its id", async () => {
    const host = new FakeHost();
    const spawning = system(host).spawn(["cat"], {
      cwd: "/tmp",
      env: { LANG: "C" },
      stdin: true,
    });
    host.reply(1, { kind: "started" });
    const process = started(await spawning);
    process.write("hi");
    process.closeStdin();
    process.kill();
    process.kill(Signal.Kill);

    expect(host.calls).toStrictEqual([
      [
        1,
        {
          argv: ["cat"],
          call: "spawn",
          cwd: "/tmp",
          env: { LANG: "C" },
          stdin: true,
        },
      ],
      [1, { call: "stdin", data: "aGk=" }],
      [1, { call: "close_stdin" }],
      [1, { call: "kill", signal: "term" }],
      [1, { call: "kill", signal: "kill" }],
    ]);
  });

  it("fails to start a program that is not installed", async () => {
    const host = new FakeHost();
    const spawning = system(host).spawn(["nope"]);
    host.reply(1, {
      error: { kind: "not_found", message: "No such file" },
      kind: "failed",
    });

    expect(await spawning).toStrictEqual(
      Err({ kind: SystemErrorKind.NotFound, message: "No such file" }),
    );
  });

  it("runs a program to its end", async () => {
    const host = new FakeHost();
    const running = system(host).run(["pactl", "-f", "json", "info"]);
    host.reply(1, { kind: "started" });
    host.event(1, { data: base64("{}"), kind: "output", stream: "stdout" });
    host.end(1, { code: null, kind: "exited", signal: 15 });

    expect(await running).toStrictEqual(
      Ok({ code: undefined, signal: 15, stderr: "", stdout: "{}" }),
    );
  });
});

describe("watches", () => {
  it("streams changes until it is stopped", async () => {
    const host = new FakeHost();
    const watching = system(host).watch("/home/ada/.config");
    host.reply(1, { kind: "started" });
    const watch = started(await watching);
    host.event(1, { kind: "changed", path: "/home/ada/.config/a" });
    watch.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "watch", path: "/home/ada/.config" }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(watch.items)).toStrictEqual([
      Listened.Heard("/home/ada/.config/a"),
    ]);
    expect(await watch.ended).toStrictEqual(Ok("stopped"));
  });

  it("says why a watch broke", async () => {
    const host = new FakeHost();
    const watching = system(host).watch("/tmp");
    host.reply(1, { kind: "started" });
    const watch = started(await watching);
    host.end(1, {
      error: { kind: "other", message: "the watch broke" },
      kind: "failed",
    });

    expect(await watch.ended).toStrictEqual(
      Err({ kind: SystemErrorKind.Other, message: "the watch broke" }),
    );
  });
  // See "A compositor restart" in docs/architecture/ENGINE-FORK.md.
  it("watches again under the next compositor when the last one exits", async () => {
    const host = new FakeHost();
    const watching = system(host).watch("/tmp");
    host.reply(1, { kind: "started" });
    const watch = started(await watching);
    host.event(1, { kind: "changed", path: "/tmp/a" });
    host.end(1, gone);
    host.reply(2, { kind: "started" });
    host.event(2, { kind: "changed", path: "/tmp/b" });
    watch.stop();
    host.end(2, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "watch", path: "/tmp" }],
      [2, { call: "watch", path: "/tmp" }],
      [2, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(watch.items)).toStrictEqual([
      Listened.Heard("/tmp/a"),
      Listened.Missed(),
      Listened.Heard("/tmp/b"),
    ]);
    expect(await watch.ended).toStrictEqual(Ok("stopped"));
  });

  it("asks again when the compositor exits before it answers", async () => {
    const host = new FakeHost();
    const watching = system(host).watch("/tmp");
    host.reply(1, gone);
    host.reply(2, { kind: "started" });

    started(await watching);
    expect(host.calls).toStrictEqual([
      [1, { call: "watch", path: "/tmp" }],
      [2, { call: "watch", path: "/tmp" }],
    ]);
  });

  it("says why the next compositor would not watch", async () => {
    const host = new FakeHost();
    const watching = system(host).watch("/tmp");
    host.reply(1, { kind: "started" });
    const watch = started(await watching);
    host.end(1, gone);
    host.reply(2, {
      error: { kind: "locked", message: "the desktop is locked" },
      kind: "failed",
    });

    expect(await Array.fromAsync(watch.items)).toStrictEqual([]);
    expect(await watch.ended).toStrictEqual(
      Err({ kind: SystemErrorKind.Locked, message: "the desktop is locked" }),
    );
  });

  it("stays stopped when the compositor exits after a stop", async () => {
    const host = new FakeHost();
    const watching = system(host).watch("/tmp");
    host.reply(1, { kind: "started" });
    const watch = started(await watching);
    watch.stop();
    host.end(1, gone);

    expect(host.calls).toStrictEqual([
      [1, { call: "watch", path: "/tmp" }],
      [1, { call: "unwatch" }],
    ]);
    expect(await watch.ended).toStrictEqual(Ok("stopped"));
  });
});

describe("a compositor that exits", () => {
  it("fails a call it had not answered", async () => {
    const host = new FakeHost();
    const reading = system(host).stat("/tmp");
    host.reply(1, gone);

    expect(await reading).toStrictEqual(
      Err({
        kind: SystemErrorKind.CompositorGone,
        message: "the compositor exited",
      }),
    );
  });

  it("ends a process it was running", async () => {
    const host = new FakeHost();
    const spawning = system(host).spawn(["sleep", "9"]);
    host.reply(1, { kind: "started" });
    const process = started(await spawning);
    host.end(1, gone);

    expect(await process.exited).toStrictEqual(
      Err({
        kind: SystemErrorKind.CompositorGone,
        message: "the compositor exited",
      }),
    );
  });
});

describe("D-Bus", () => {
  it("calls a method with a typed body", async () => {
    const host = new FakeHost();
    const calling = system(host).dbusCall({
      body: ["org.freedesktop.UPower.Device"],
      bus: Bus.System,
      destination: "org.freedesktop.UPower",
      interface: "org.freedesktop.DBus.Properties",
      member: "GetAll",
      path: "/org/freedesktop/UPower/devices/DisplayDevice",
      signature: "s",
    });
    host.reply(1, {
      body: JSON.stringify([{ Percentage: { signature: "d", value: 97 } }]),
      kind: "returned",
      signature: "a{sv}",
    });

    expect(host.calls).toStrictEqual([
      [
        1,
        {
          body: '["org.freedesktop.UPower.Device"]',
          bus: "system",
          call: "dbus_call",
          destination: "org.freedesktop.UPower",
          interface: "org.freedesktop.DBus.Properties",
          member: "GetAll",
          path: "/org/freedesktop/UPower/devices/DisplayDevice",
          signature: "s",
        },
      ],
    ]);
    expect(await calling).toStrictEqual(
      Ok({
        body: [{ Percentage: { signature: "d", value: 97 } }],
        signature: "a{sv}",
      }),
    );
  });

  it("names a method's error", async () => {
    const host = new FakeHost();
    const calling = system(host).dbusCall({
      bus: Bus.Session,
      destination: "org.example",
      interface: "org.example",
      member: "Nothing",
      path: "/",
    });
    host.reply(1, {
      error: {
        kind: "dbus",
        message: "org.freedesktop.DBus.Error.UnknownMethod",
      },
      kind: "failed",
    });

    expect(host.calls[0]?.[1]).toMatchObject({ body: "[]", signature: "" });
    expect(await calling).toStrictEqual(
      Err({
        kind: SystemErrorKind.Dbus,
        message: "org.freedesktop.DBus.Error.UnknownMethod",
      }),
    );
  });

  it("streams the signals a match names until it is stopped", async () => {
    const host = new FakeHost();
    const matching = system(host).dbusMatch({
      bus: Bus.Session,
      interface: "org.freedesktop.DBus.Properties",
      member: "PropertiesChanged",
    });
    host.reply(1, { kind: "started" });
    const match = started(await matching);
    host.event(1, {
      body: '["org.mpris.MediaPlayer2.Player",{},[]]',
      interface: "org.freedesktop.DBus.Properties",
      kind: "signal",
      member: "PropertiesChanged",
      path: "/org/mpris/MediaPlayer2",
      sender: ":1.4",
      signature: "sa{sv}as",
    });
    match.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [
        1,
        {
          bus: "session",
          call: "dbus_match",
          interface: "org.freedesktop.DBus.Properties",
          member: "PropertiesChanged",
        },
      ],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(match.items)).toStrictEqual([
      Listened.Heard({
        body: ["org.mpris.MediaPlayer2.Player", {}, []],
        interface: "org.freedesktop.DBus.Properties",
        member: "PropertiesChanged",
        path: "/org/mpris/MediaPlayer2",
        sender: ":1.4",
        signature: "sa{sv}as",
      }),
    ]);
    expect(await match.ended).toStrictEqual(Ok("stopped"));
  });

  // See "A compositor restart" in docs/architecture/ENGINE-FORK.md.
  it("says what it missed while the compositor restarted", async () => {
    const host = new FakeHost();
    const matching = system(host).dbusMatch({ bus: Bus.System });
    host.reply(1, { kind: "started" });
    const match = started(await matching);
    host.end(1, gone);
    host.reply(2, { kind: "started" });
    match.stop();
    host.end(2, { kind: "stopped" });

    expect(await Array.fromAsync(match.items)).toStrictEqual([
      Listened.Missed(),
    ]);
  });
});

describe("screenshots", () => {
  it("says where the screenshot the shell's dialog picked was saved", async () => {
    const host = new FakeHost();
    const taking = system(host).screenshot();
    host.reply(1, { kind: "saved", path: "/home/me/Pictures/a.png" });

    expect(host.calls).toStrictEqual([[1, { call: "screenshot" }]]);
    expect(await taking).toStrictEqual(
      Ok(ScreenshotKept.Saved("/home/me/Pictures/a.png")),
    );
  });

  it("says the screenshot was copied rather than saved", async () => {
    const host = new FakeHost();
    const taking = system(host).screenshot();
    host.reply(1, { kind: "copied" });

    expect(await taking).toStrictEqual(Ok(ScreenshotKept.Copied()));
  });

  it("says the dialog was dismissed", async () => {
    const host = new FakeHost();
    const taking = system(host).screenshot();
    host.reply(1, {
      error: { kind: "canceled", message: "dismissed" },
      kind: "failed",
    });

    expect(await taking).toStrictEqual(
      Err({ kind: SystemErrorKind.Canceled, message: "dismissed" }),
    );
  });
});

describe("screen recordings", () => {
  it("says where the recording went once it is stopped", async () => {
    const host = new FakeHost();
    const recording = system(host).screenRecord();
    host.reply(1, {
      kind: "saved",
      path: "/home/me/Videos/Screen recordings/a.webm",
    });

    expect(host.calls).toStrictEqual([[1, { call: "screen_record" }]]);
    expect(await recording).toStrictEqual(
      Ok("/home/me/Videos/Screen recordings/a.webm"),
    );
  });
});

describe("window previews", () => {
  it("draws a client's window by its host app id", async () => {
    const host = new FakeHost();
    const drawing = system(host).previewWindow(PreviewedWindow.App("app-3"));
    host.reply(1, { frame: "data:image/png;base64,AA==", kind: "preview" });

    expect(host.calls).toStrictEqual([
      [1, { call: "preview_window", window: { id: "app-3", type: "app" } }],
    ]);
    expect(await drawing).toStrictEqual(Ok("data:image/png;base64,AA=="));
  });

  it("draws a browser window by the engine's id", () => {
    const host = new FakeHost();
    system(host)
      .previewWindow(PreviewedWindow.Browser("7"))
      .catch(() => {
        /* never answered */
      });

    expect(host.calls).toStrictEqual([
      [1, { call: "preview_window", window: { id: "7", type: "browser" } }],
    ]);
  });
});

describe("shell commands", () => {
  it("streams each command `domicile send-shell` sends until it is stopped", async () => {
    const host = new FakeHost();
    const lock = { description: "Lock the desktop.", usage: "lock" };
    const bound = {
      action: "send-shell lock",
      chord: "Meta+l",
      mode: "default",
    };
    const listening = system(host).shellCommands([lock], [bound]);
    host.reply(1, { kind: "started" });
    const commands = started(await listening);
    host.event(1, {
      command: ["focus", "right"],
      kind: "shell_command",
      sent: 4,
    });
    commands.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { bindings: [bound], call: "shell_commands", commands: [lock] }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(commands.items)).toStrictEqual([
      { sent: 4, words: ["focus", "right"] },
    ]);
  });

  it("says whether this page ran a command, what it printed, and why not", async () => {
    const host = new FakeHost();
    const calls = system(host);
    const ran = calls.answerShellCommand(4, Ok("ran"));
    host.reply(1, { kind: "set" });
    const refused = calls.answerShellCommand(5, Err("no command `x`"));
    host.reply(2, { kind: "set" });
    const printed = calls.answerShellCommand(6, Ok({ output: "[]" }));
    host.reply(3, { kind: "set" });

    expect(await ran).toStrictEqual(Ok("set"));
    expect(await refused).toStrictEqual(Ok("set"));
    expect(await printed).toStrictEqual(Ok("set"));
    expect(host.calls).toStrictEqual([
      [1, { call: "answer_shell_command", sent: 4 }],
      [2, { call: "answer_shell_command", refused: "no command `x`", sent: 5 }],
      [3, { call: "answer_shell_command", output: "[]", sent: 6 }],
    ]);
  });
});

describe("idle watches", () => {
  it("streams whether nobody has been at the desk for the time chosen", async () => {
    const host = new FakeHost();
    const listening = system(host).idleAfter(120);
    host.reply(1, { kind: "started" });
    const watch = started(await listening);
    host.event(1, { idle: true, kind: "idle" });
    host.event(1, { idle: false, kind: "idle" });
    watch.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "idle_after", seconds: 120 }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(watch.items)).toStrictEqual([true, false]);
  });

  // The next compositor's clock starts from its start, so an idle spell is
  // over.
  it("watches again under the next compositor, no longer idle", async () => {
    const host = new FakeHost();
    const listening = system(host).idleAfter(120);
    host.reply(1, { kind: "started" });
    const watch = started(await listening);
    host.event(1, { idle: true, kind: "idle" });
    host.end(1, gone);
    host.reply(2, { kind: "started" });
    watch.stop();
    host.end(2, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "idle_after", seconds: 120 }],
      [2, { call: "idle_after", seconds: 120 }],
      [2, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(watch.items)).toStrictEqual([true, false]);
  });

  it("watches a time before the screens blank", async () => {
    const host = new FakeHost();
    const listening = system(host).idleBeforeBlanking(30);
    host.reply(1, { kind: "started" });
    const watch = started(await listening);
    host.event(1, { idle: true, kind: "idle" });
    watch.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "idle_before_blanking", seconds: 30 }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(watch.items)).toStrictEqual([true]);
  });
});

describe("idle holds", () => {
  it("streams what holds the desk awake, at once and on each change", async () => {
    const host = new FakeHost();
    const listening = system(host).idleHolds();
    host.reply(1, { kind: "started" });
    const holds = started(await listening);
    host.event(1, { holders: [], kind: "idle_holds" });
    host.event(1, { holders: ["mpv", "slack"], kind: "idle_holds" });
    holds.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "idle_holds" }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(holds.items)).toStrictEqual([
      [],
      ["mpv", "slack"],
    ]);
  });
});

describe("unlock refusals", () => {
  it("streams why each passphrase did not open the desk", async () => {
    const host = new FakeHost();
    const listening = system(host).unlockRefusals();
    host.reply(1, { kind: "started" });
    const refusals = started(await listening);
    for (const refusal of ["wrong_passphrase", "unverifiable", "too_soon"]) {
      host.event(1, {
        failures: 3,
        kind: "unlock_refused",
        refusal,
        retry_in_ms: 5000,
      });
    }
    refusals.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls[0]).toStrictEqual([1, { call: "unlock_refusals" }]);
    expect(await Array.fromAsync(refusals.items)).toStrictEqual(
      [
        UnlockRefusal.WrongPassphrase,
        UnlockRefusal.Unverifiable,
        UnlockRefusal.TooSoon,
      ].map((refusal) => ({ failures: 3, refusal, retryInMs: 5000 })),
    );
  });
});

describe("color temperature", () => {
  it("warms every monitor", async () => {
    const host = new FakeHost();
    const setting = system(host).setColorTemperature(3400);
    host.reply(1, { kind: "set" });

    expect(host.calls).toStrictEqual([
      [1, { call: "set_color_temperature", kelvin: 3400 }],
    ]);
    expect(await setting).toStrictEqual(Ok("set"));
  });

  it("warms one monitor, by name", async () => {
    const host = new FakeHost();
    const setting = system(host).setColorTemperature(3400, "eDP-2");
    host.reply(1, { kind: "set" });

    expect(host.calls).toStrictEqual([
      [1, { call: "set_color_temperature", display: "eDP-2", kelvin: 3400 }],
    ]);
    expect(await setting).toStrictEqual(Ok("set"));
  });

  it("sends a whole number of kelvin", () => {
    const host = new FakeHost();
    system(host)
      .setColorTemperature(3400.4)
      .catch(() => undefined);

    expect(host.calls).toStrictEqual([
      [1, { call: "set_color_temperature", kelvin: 3400 }],
    ]);
  });
});

describe("display power", () => {
  it("puts every monitor to sleep", async () => {
    const host = new FakeHost();
    const sleeping = system(host).sleepDisplays();
    host.reply(1, { kind: "set" });

    expect(host.calls).toStrictEqual([[1, { call: "sleep_displays" }]]);
    expect(await sleeping).toStrictEqual(Ok("set"));
  });

  it("puts one monitor to sleep, and wakes it, by name", () => {
    const host = new FakeHost();
    const calls = system(host);
    calls.sleepDisplays("DP-1").catch(() => undefined);
    calls.wakeDisplays("DP-1").catch(() => undefined);

    expect(host.calls).toStrictEqual([
      [1, { call: "sleep_displays", display: "DP-1" }],
      [2, { call: "wake_displays", display: "DP-1" }],
    ]);
  });

  it("wakes the monitors", async () => {
    const host = new FakeHost();
    const waking = system(host).wakeDisplays();
    host.reply(1, { kind: "set" });

    expect(host.calls).toStrictEqual([[1, { call: "wake_displays" }]]);
    expect(await waking).toStrictEqual(Ok("set"));
  });
});

describe("window states", () => {
  it("replaces the states the shell set on a window", async () => {
    const host = new FakeHost();
    const setting = system(host).setWindowStates("app-1", [
      WindowState.TiledLeft,
      WindowState.TiledRight,
      WindowState.TiledTop,
      WindowState.TiledBottom,
      WindowState.Maximized,
      WindowState.Fullscreen,
      WindowState.Resizing,
    ]);
    host.reply(1, { kind: "set" });

    expect(host.calls).toStrictEqual([
      [
        1,
        {
          app_id: "app-1",
          call: "set_window_states",
          states: [
            "tiled_left",
            "tiled_right",
            "tiled_top",
            "tiled_bottom",
            "maximized",
            "fullscreen",
            "resizing",
          ],
        },
      ],
    ]);
    expect(await setting).toStrictEqual(Ok("set"));
  });

  it("says the compositor knows no such window", async () => {
    const host = new FakeHost();
    const setting = system(host).setWindowStates("gone", []);
    host.reply(1, {
      error: { kind: "not_found", message: "no window gone" },
      kind: "failed",
    });

    expect(await setting).toStrictEqual(
      Err({ kind: SystemErrorKind.NotFound, message: "no window gone" }),
    );
  });

  it("streams each maximize, fullscreen, minimize, move and resize request clients make", async () => {
    const host = new FakeHost();
    const listening = system(host).windowRequests();
    host.reply(1, { kind: "started" });
    const requests = started(await listening);
    for (const request of [
      { kind: "maximize" },
      { kind: "unmaximize" },
      { display: "left", kind: "fullscreen" },
      { display: null, kind: "fullscreen" },
      { kind: "unfullscreen" },
      { kind: "minimize" },
      { kind: "move" },
      { edges: "top", kind: "resize" },
      { edges: "bottom_right", kind: "resize" },
    ]) {
      host.event(1, { app_id: "app-1", kind: "window_request", request });
    }
    requests.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "window_requests" }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(requests.items)).toStrictEqual([
      WindowRequest.Maximize("app-1"),
      WindowRequest.Unmaximize("app-1"),
      WindowRequest.Fullscreen("app-1", "left"),
      WindowRequest.Fullscreen("app-1", undefined),
      WindowRequest.Unfullscreen("app-1"),
      WindowRequest.Minimize("app-1"),
      WindowRequest.Move("app-1"),
      WindowRequest.Resize("app-1", ResizeEdge.Top),
      WindowRequest.Resize("app-1", ResizeEdge.BottomRight),
    ]);
  });
});

describe("bells", () => {
  it("streams each bell a client rings, with its window or none", async () => {
    const host = new FakeHost();
    const listening = system(host).bells();
    host.reply(1, { kind: "started" });
    const bells = started(await listening);
    host.event(1, { app_id: "app-1", kind: "bell" });
    host.event(1, { app_id: null, kind: "bell" });
    bells.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "bells" }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(bells.items)).toStrictEqual([
      { appId: "app-1" },
      { appId: undefined },
    ]);
  });
});

describe("virtual monitors", () => {
  const aTv = {
    height: 1080,
    name: "Living Room TV",
    refreshMhz: 60_000,
    width: 1920,
  };

  it("adds a monitor until the shell removes it", async () => {
    const host = new FakeHost();
    const adding = system(host).addVirtualMonitor(aTv);
    host.reply(1, { kind: "virtual_monitor", output: "virtual-1" });
    const monitor = started(await adding);
    monitor.remove();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [
        1,
        {
          call: "virtual_monitor",
          height: 1080,
          name: "Living Room TV",
          refresh_mhz: 60_000,
          scale: 1,
          width: 1920,
        },
      ],
      [1, { call: "unwatch" }],
    ]);
    expect(monitor.output).toBe("virtual-1");
    expect(await monitor.ended).toStrictEqual(Ok("removed"));
  });

  it("resizes the monitor in place", async () => {
    const host = new FakeHost();
    const adding = system(host).addVirtualMonitor(aTv);
    host.reply(1, { kind: "virtual_monitor", output: "virtual-1" });
    const monitor = started(await adding);
    monitor.resize({ height: 720, refreshMhz: 30_000, width: 1280 });

    expect(host.calls.at(-1)).toStrictEqual([
      1,
      {
        call: "resize_virtual_monitor",
        height: 720,
        refresh_mhz: 30_000,
        scale: 1,
        width: 1280,
      },
    ]);
  });

  it("gives the monitor a scale of its own", async () => {
    const host = new FakeHost();
    const adding = system(host).addVirtualMonitor({ ...aTv, scale: 1.25 });
    host.reply(1, { kind: "virtual_monitor", output: "virtual-1" });
    const monitor = started(await adding);
    monitor.resize({
      height: 720,
      refreshMhz: 60_000,
      scale: 1.5,
      width: 1280,
    });

    expect(host.calls).toStrictEqual([
      [1, expect.objectContaining({ scale: 1.25 })],
      [1, expect.objectContaining({ scale: 1.5 })],
    ]);
  });

  it("says the desk cannot extend", async () => {
    const host = new FakeHost();
    const adding = system(host).addVirtualMonitor(aTv);
    host.reply(1, {
      error: { kind: "other", message: "nested" },
      kind: "failed",
    });

    expect(await adding).toStrictEqual(
      Err({ kind: SystemErrorKind.Other, message: "nested" }),
    );
  });

  it("ends with the compositor, which takes the monitor with it", async () => {
    const host = new FakeHost();
    const adding = system(host).addVirtualMonitor(aTv);
    host.reply(1, { kind: "virtual_monitor", output: "virtual-1" });
    const monitor = started(await adding);
    host.end(1, gone);

    expect(await monitor.ended).toStrictEqual(
      Err({
        kind: SystemErrorKind.CompositorGone,
        message: "the compositor exited",
      }),
    );
  });
});

describe("ids", () => {
  // The compositor names calls per connection, and a page has one.
  it("are shared by every system on one host", () => {
    const host = new FakeHost();
    system(host)
      .stat("/a")
      .catch(() => {
        /* never answered */
      });
    system(host)
      .stat("/b")
      .catch(() => {
        /* never answered */
      });

    expect(host.calls.map(([id]) => id)).toStrictEqual([1, 2]);
  });
});

describe("keymaps", () => {
  // As the SDK hands them over: a missing description is `undefined`.
  const LISTED = [
    { description: "English (programmer Dvorak)", name: "dvp" },
    { description: undefined, name: "us" },
  ];

  it("streams the keymaps and the one the desktop types on", async () => {
    const host = new FakeHost();
    const listening = system(host).keymaps();
    host.reply(1, { kind: "started" });
    const keymaps = started(await listening);
    const wire = [
      { description: "English (programmer Dvorak)", name: "dvp" },
      { name: "us" },
    ];
    host.event(1, { active: "dvp", keymaps: wire, kind: "keymaps" });
    host.event(1, { active: "us", keymaps: wire, kind: "keymaps" });
    keymaps.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "keymaps" }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(keymaps.items)).toStrictEqual([
      { active: "dvp", keymaps: LISTED },
      { active: "us", keymaps: LISTED },
    ]);
  });

  it("switches the keyboard window's shortcuts inhibitor", async () => {
    const host = new FakeHost();
    const switched = [
      InhibitorAction.Activate,
      InhibitorAction.Deactivate,
      InhibitorAction.Toggle,
    ].map((action, index) => {
      const call = system(host).switchShortcutsInhibitor(action);
      host.reply(index + 1, { kind: "set" });
      return call;
    });

    expect(host.calls).toStrictEqual([
      [1, { action: "activate", call: "shortcuts_inhibitor" }],
      [2, { action: "deactivate", call: "shortcuts_inhibitor" }],
      [3, { action: "toggle", call: "shortcuts_inhibitor" }],
    ]);
    expect(await Promise.all(switched)).toStrictEqual([
      Ok("set"),
      Ok("set"),
      Ok("set"),
    ]);
  });

  it("switches to the next keymap or one by name", async () => {
    const host = new FakeHost();
    const next = system(host).selectKeymap(KeymapChoice.Next());
    host.reply(1, { kind: "set" });
    const named = system(host).selectKeymap(KeymapChoice.Named("us"));
    host.reply(2, { kind: "set" });

    expect(host.calls).toStrictEqual([
      [1, { call: "select_keymap", keymap: { kind: "next" } }],
      [2, { call: "select_keymap", keymap: { kind: "named", name: "us" } }],
    ]);
    expect(await next).toStrictEqual(Ok("set"));
    expect(await named).toStrictEqual(Ok("set"));
  });
});

describe("agents", () => {
  it("lists the agents in now and those remembered", async () => {
    const host = new FakeHost();
    const listing = system(host).agents();
    host.reply(1, {
      connected: [
        { agent: "Claude Code", reach: { type: "desk" }, session: 4 },
      ],
      kind: "agents",
      remembered: [{ agent: "Codex", last_used_ms: 9 }],
    });

    expect(host.calls).toStrictEqual([[1, { call: "agents" }]]);
    expect(await listing).toStrictEqual(
      Ok({
        connected: [
          { agent: "Claude Code", reach: { kind: "desk" }, session: 4 },
        ],
        remembered: [{ agent: "Codex", lastUsedMs: 9 }],
      }),
    );
  });

  it("forgets a remembered agent", async () => {
    const host = new FakeHost();
    const forgetting = system(host).forgetAgent("Codex");
    host.reply(1, { kind: "set" });

    expect(host.calls).toStrictEqual([
      [1, { agent: "Codex", call: "forget_agent" }],
    ]);
    expect(await forgetting).toStrictEqual(Ok("set"));
  });
});

describe("links", () => {
  it("streams each link of the claimed schemes until it is stopped", async () => {
    const host = new FakeHost();
    const listening = system(host).claimLinks(["mailto"]);
    host.reply(1, { kind: "started" });
    const links = started(await listening);
    host.event(1, {
      app_id: "slack",
      kind: "link",
      url: "mailto:a@example.com",
    });
    host.event(1, { kind: "link", url: "mailto:b@example.com" });
    links.stop();
    host.end(1, { kind: "stopped" });

    expect(host.calls).toStrictEqual([
      [1, { call: "claim_links", schemes: ["mailto"] }],
      [1, { call: "unwatch" }],
    ]);
    expect(await Array.fromAsync(links.items)).toStrictEqual([
      { appId: "slack", url: "mailto:a@example.com" },
      { appId: undefined, url: "mailto:b@example.com" },
    ]);
  });
});
