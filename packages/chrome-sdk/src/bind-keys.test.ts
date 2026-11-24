import { afterEach, describe, expect, it } from "bun:test";

import { Err, Ok } from "@cprussin/option-result";

import type { KeyDesktop } from "./bind-keys";
import { bindKeys } from "./bind-keys";
import type { Gesture } from "./desktop/gestures";
import { gestures } from "./desktop/gestures";
import { keyboard } from "./desktop/keyboard";
import { processes } from "./desktop/processes";
import { shell } from "./desktop/shell";
import { system } from "./desktop/system-calls";
import type { DomicileHost } from "./domicile-host";
import { KeyAction } from "./key-action";
import type { ShellKeybindings } from "./own-keybindings";
import { SystemErrorKind } from "./system";

/** The shell's keybindings. */
const DESK: ShellKeybindings = {
  keybindings: {
    "Meta+Return": KeyAction.SendShell(["terminal"]),
    "Meta+r": KeyAction.Mode("resize"),
  },
  modes: {
    resize: {
      "Meta+Escape": KeyAction.Mode("default"),
      "Super+Return": KeyAction.SendShell(["resize", "grow", "right"]),
    },
  },
};

/**
 * A host that records grabs and system calls, and dispatches `shortcut` and
 * `system` events. The engine resolves presses, so `pressed` sends any chord.
 */
class FakeHost extends EventTarget {
  readonly grabbed: string[] = [];
  readonly grabbedWhileInhibited: string[] = [];
  readonly ungrabbed: string[] = [];
  readonly grabbedGestures: string[] = [];
  readonly ungrabbedGestures: string[] = [];
  readonly calls: [id: number, request: unknown][] = [];
  readonly spawned: (readonly string[])[] = [];

  spawn(command: readonly string[]): void {
    this.spawned.push(command);
  }

  grabShortcut(chord: string, whileInhibited = false): void {
    this.grabbed.push(chord);
    if (whileInhibited) {
      this.grabbedWhileInhibited.push(chord);
    }
  }

  ungrabShortcut(chord: string): void {
    this.ungrabbed.push(chord);
  }

  grabGesture(gesture: string): void {
    this.grabbedGestures.push(gesture);
  }

  ungrabGesture(gesture: string): void {
    this.ungrabbedGestures.push(gesture);
  }

  /**
   * Send a whole gesture: its begin, one update, and an end. An edge swipe's
   * every phase has the edge of `update`.
   */
  gestured(
    kind: Gesture["kind"],
    fingers: number,
    update: Partial<Gesture>,
    canceled = false,
  ): void {
    const base = {
      canceled: false,
      dx: 0,
      dy: 0,
      edge: update.edge ?? "",
      fingers,
      kind,
      rotation: 0,
      scale: 1,
    };
    for (const phase of [
      { ...base, phase: "begin" },
      { ...base, ...update, phase: "update" },
      { ...base, canceled, phase: "end" },
    ]) {
      this.dispatchEvent(Object.assign(new Event("gesture"), phase));
    }
  }

  callSystem(id: number, request: string): void {
    this.calls.push([id, JSON.parse(request)]);
  }

  pressed(chord: string): void {
    this.dispatchEvent(Object.assign(new Event("shortcut"), { chord }));
  }

  released(chord: string): void {
    this.dispatchEvent(Object.assign(new Event("shortcutrelease"), { chord }));
  }

  /** Send a compositor line for system call 1, the one `bindKeys` makes. */
  answer(line: object): void {
    this.dispatchEvent(
      new MessageEvent("system", { data: JSON.stringify({ id: 1, ...line }) }),
    );
  }

  /** Let the system call's promise settle. */
  settled(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** The desktop's keys and shell commands, as `desktop` makes them. */
const keysOf = (fake: FakeHost): KeyDesktop => {
  const host = fake as unknown as DomicileHost;
  const calls = system(host);
  return {
    gestures: gestures(host),
    keyboard: keyboard(host, calls),
    processes: processes(host, calls),
    shell: shell(host, calls),
  };
};

/** The handler calls, in order. */
type Heard =
  | readonly ["command", readonly string[]]
  | readonly ["mode", string]
  | readonly ["report", unknown]
  | readonly ["refused", string];

/** DESK's bindings, as `domicile list-bindings` prints them. */
const DESK_BOUND = [
  { action: "send-shell terminal", chord: "Meta+Return", mode: "default" },
  { action: "mode resize", chord: "Meta+r", mode: "default" },
  { action: "mode default", chord: "Meta+Escape", mode: "resize" },
  {
    action: "send-shell resize grow right",
    chord: "Meta+Return",
    mode: "resize",
  },
];

/** The commands the shell in these tests describes. */
const HELP = [{ description: "Open a terminal.", usage: "terminal" }];

let unbind: () => void = () => undefined;

afterEach(() => {
  unbind();
});

const bound = (own: ShellKeybindings = DESK) => {
  const host = new FakeHost();
  const heard: Heard[] = [];
  const binding = bindKeys(keysOf(host), own, {
    commands: HELP,
    onCommand: (args) => {
      heard.push(["command", args]);
      switch (args[0]) {
        case "nonsense": {
          return Err("no command `nonsense`");
        }
        case "get-tree": {
          return Ok({ output: "[]" });
        }
        default: {
          return Ok("ran");
        }
      }
    },
    onModeChanged: (mode) => {
      heard.push(["mode", mode]);
    },
    report: (error) => {
      heard.push(["report", error]);
    },
    reportRefusal: (why) => {
      heard.push(["refused", why]);
    },
  });
  unbind = binding.unbind;
  return { heard, host, setMode: binding.setMode };
};

describe("bindKeys", () => {
  it("grabs every chord of every mode, each once, in its one spelling", () => {
    const { host } = bound({
      keybindings: { "Meta+Return": KeyAction.Mode("x") },
      modes: { x: { "Super+Return": KeyAction.Mode("default") } },
    });

    expect(host.grabbed).toStrictEqual(["Meta+Return"]);
  });

  it("grabs an --inhibited chord to stay the shell's under an inhibitor", () => {
    const { heard, host } = bound({
      keybindings: {
        "--inhibited Meta+Escape": KeyAction.SendShell(["inhibitor"]),
        "Meta+Return": KeyAction.SendShell(["terminal"]),
      },
    });

    host.pressed("Meta+Escape");

    expect(host.grabbed).toStrictEqual(["Meta+Escape", "Meta+Return"]);
    expect(host.grabbedWhileInhibited).toStrictEqual(["Meta+Escape"]);
    expect(heard).toStrictEqual([["command", ["inhibitor"]]]);
  });

  it("refuses a chord written wrong before grabbing anything", () => {
    const host = new FakeHost();
    expect(() =>
      bindKeys(
        keysOf(host),
        { keybindings: { "Hyper+l": KeyAction.Mode("x") } },
        {
          commands: HELP,
          onCommand: () => Ok("ran"),
          onModeChanged: () => undefined,
          report: () => undefined,
        },
      ),
    ).toThrow("Hyper+l");
    expect(host.grabbed).toStrictEqual([]);
  });

  it("runs the command bound to a press", () => {
    const { heard, host } = bound();

    host.pressed("Meta+Return");

    expect(heard).toStrictEqual([["command", ["terminal"]]]);
  });

  it("starts the program an exec binding names, without the shell", () => {
    const { heard, host } = bound({
      keybindings: {
        "Meta+Return": KeyAction.Exec(["foot", "--hold"]),
        "swipe:3:up": KeyAction.Exec(["btop"]),
      },
    });

    host.pressed("Meta+Return");
    host.gestured("swipe", 3, { dy: -200 });

    expect(host.spawned).toStrictEqual([["foot", "--hold"], ["btop"]]);
    expect(heard).toStrictEqual([]);
  });

  it("reports a pressed binding whose command the shell does not run", () => {
    const { heard, host } = bound({
      keybindings: { "Meta+x": KeyAction.SendShell(["nonsense"]) },
    });

    host.pressed("Meta+x");

    expect(heard).toStrictEqual([
      ["command", ["nonsense"]],
      ["refused", "no command `nonsense`"],
    ]);
  });

  it("leaves a press grabbed as a keycode, or by somebody else, alone", () => {
    const { heard, host } = bound();

    host.pressed("");
    host.pressed("Ctrl+q");

    expect(heard).toStrictEqual([]);
  });

  it("gives back every chord it grabbed once unbound, and only once", () => {
    const { host } = bound({
      keybindings: {
        "Meta+Return": KeyAction.Mode("x"),
      },
      modes: { x: { "Meta+Escape": KeyAction.Mode("default") } },
    });

    unbind();
    unbind();

    expect(host.ungrabbed).toStrictEqual(["Meta+Return", "Meta+Escape"]);
  });

  it("stops listening once unbound", () => {
    const { heard, host } = bound();

    unbind();
    host.pressed("Meta+Return");

    expect(heard).toStrictEqual([]);
  });

  describe("commands from a terminal", () => {
    it("runs a command `domicile send-shell` sent, as its binding would, and says so", async () => {
      const { heard, host } = bound();
      host.answer({ reply: { kind: "started" }, type: "system_reply" });
      await host.settled();

      host.answer({
        event: { command: ["focus", "right"], kind: "shell_command", sent: 4 },
        type: "system_event",
      });
      await host.settled();

      expect(host.calls).toStrictEqual([
        [1, { bindings: DESK_BOUND, call: "shell_commands", commands: HELP }],
        [2, { call: "answer_shell_command", sent: 4 }],
      ]);
      expect(heard).toStrictEqual([["command", ["focus", "right"]]]);
    });

    it("answers with what a command printed, such as a query's JSON", async () => {
      const { host } = bound();
      host.answer({ reply: { kind: "started" }, type: "system_reply" });
      await host.settled();

      host.answer({
        event: { command: ["get-tree"], kind: "shell_command", sent: 6 },
        type: "system_event",
      });
      await host.settled();

      expect(host.calls.at(-1)).toStrictEqual([
        2,
        { call: "answer_shell_command", output: "[]", sent: 6 },
      ]);
    });

    it("says why it did not run a command it does not know", async () => {
      // `domicile send-shell` fails with the reason, rather than a command
      // dropped silently.
      const { host } = bound();
      host.answer({ reply: { kind: "started" }, type: "system_reply" });
      await host.settled();

      host.answer({
        event: { command: ["nonsense"], kind: "shell_command", sent: 5 },
        type: "system_event",
      });
      await host.settled();

      expect(host.calls.at(-1)).toStrictEqual([
        2,
        {
          call: "answer_shell_command",
          refused: "no command `nonsense`",
          sent: 5,
        },
      ]);
    });

    it("stops hearing them once unbound", async () => {
      const { host } = bound();
      host.answer({ reply: { kind: "started" }, type: "system_reply" });
      await host.settled();

      unbind();

      expect(host.calls.at(-1)).toStrictEqual([1, { call: "unwatch" }]);
    });

    it("stops hearing them once listening starts, if unbound before", async () => {
      const { host } = bound();

      unbind();
      host.answer({ reply: { kind: "started" }, type: "system_reply" });
      await host.settled();

      expect(host.calls.at(-1)).toStrictEqual([1, { call: "unwatch" }]);
    });

    it("reports a page that cannot hear them, and keeps its keys", async () => {
      const { heard, host } = bound();

      host.answer({
        reply: {
          error: { kind: "other", message: "no" },
          kind: "failed",
        },
        type: "system_reply",
      });
      await host.settled();
      host.pressed("Meta+Return");

      expect(heard).toStrictEqual([
        ["report", { kind: SystemErrorKind.Other, message: "no" }],
        ["command", ["terminal"]],
      ]);
    });
  });

  describe("modes", () => {
    it("enters the mode a binding names, tells the shell and reads the keys in it", () => {
      const { heard, host } = bound({
        ...DESK,
        modes: {
          resize: {
            "Meta+Escape": KeyAction.Mode("default"),
            "Super+Return": KeyAction.SendShell(["resize", "grow", "right"]),
          },
        },
      });

      host.pressed("Meta+r");
      host.pressed("Meta+Return");
      host.pressed("Meta+Escape");
      host.pressed("Meta+Return");

      expect(heard).toStrictEqual([
        ["mode", "resize"],
        ["command", ["resize", "grow", "right"]],
        ["mode", "default"],
        ["command", ["terminal"]],
      ]);
    });

    it("reads the keys in a mode the shell sets, without telling it back", () => {
      // Another page entered the mode, so the shell already knows.
      const { heard, host, setMode } = bound({
        ...DESK,
        modes: { resize: { "Meta+Return": KeyAction.SendShell(["grow"]) } },
      });

      setMode("resize");
      host.pressed("Meta+Return");

      expect(heard).toStrictEqual([["command", ["grow"]]]);
    });

    it("does nothing for the mode the keys are already in", () => {
      const { heard, host, setMode } = bound();
      host.pressed("Meta+r");

      setMode("resize");

      expect(heard).toStrictEqual([["mode", "resize"]]);
    });

    it("goes back to the default mode for one the shell does not have", () => {
      const { heard, host, setMode } = bound();
      host.pressed("Meta+r");

      setMode("move");
      host.pressed("Meta+Return");

      expect(heard.slice(1)).toStrictEqual([
        ["mode", "default"],
        ["command", ["terminal"]],
      ]);
    });
  });

  describe("held actions", () => {
    const PEEK: ShellKeybindings = {
      keybindings: {
        "Meta+r": KeyAction.Mode("resize"),
        "Meta+s": KeyAction.Hold(
          KeyAction.Mode("resize"),
          KeyAction.Mode("default"),
        ),
        "Meta+Tab": KeyAction.Hold(
          KeyAction.SendShell(["peek"]),
          KeyAction.SendShell(["unpeek"]),
        ),
      },
      modes: { resize: { "Meta+Escape": KeyAction.Mode("default") } },
    };

    it("runs the press action on press and the release action on release, once each", () => {
      const { heard, host } = bound(PEEK);

      host.pressed("Meta+Tab");
      host.pressed("Meta+Tab");
      host.released("Meta+Tab");
      host.released("Meta+Tab");

      expect(heard).toStrictEqual([
        ["command", ["peek"]],
        ["command", ["unpeek"]],
      ]);
    });

    it("runs the release its press armed, whatever mode the keys are in", () => {
      const { heard, host } = bound(PEEK);

      host.pressed("Meta+Tab");
      host.pressed("Meta+r");
      host.released("Meta+Tab");

      expect(heard).toStrictEqual([
        ["command", ["peek"]],
        ["mode", "resize"],
        ["command", ["unpeek"]],
      ]);
    });

    it("runs no release for a press its mode did not bind", () => {
      const { heard, host } = bound(PEEK);

      host.pressed("Meta+r");
      host.pressed("Meta+Tab");
      host.released("Meta+Tab");

      expect(heard).toStrictEqual([["mode", "resize"]]);
    });

    it("holds a mode while the chord is down", () => {
      const { heard, host } = bound(PEEK);

      host.pressed("Meta+s");
      host.released("Meta+s");

      expect(heard).toStrictEqual([
        ["mode", "resize"],
        ["mode", "default"],
      ]);
    });

    it("refuses a held action on a gesture, which has no press of its own", () => {
      expect(() =>
        bound({
          keybindings: {
            "swipe:3:left": KeyAction.Hold(
              KeyAction.SendShell(["peek"]),
              KeyAction.SendShell(["unpeek"]),
            ),
          },
        }),
      ).toThrow("swipe:3:left");
    });

    it("runs each armed release once unbound", () => {
      const { heard, host } = bound(PEEK);
      host.pressed("Meta+Tab");

      unbind();
      host.released("Meta+Tab");

      expect(heard).toStrictEqual([
        ["command", ["peek"]],
        ["command", ["unpeek"]],
      ]);
    });
  });

  describe("gestures", () => {
    const SWIPES: ShellKeybindings = {
      keybindings: {
        "Meta+r": KeyAction.Mode("resize"),
        "pinch:4:inward": KeyAction.SendShell(["overview"]),
        "swipe:3:left": KeyAction.SendShell(["workspace", "next"]),
        "swipe:3:right": KeyAction.SendShell(["workspace", "prev"]),
      },
      modes: {
        resize: {
          "Meta+Escape": KeyAction.Mode("default"),
          "swipe:left": KeyAction.SendShell(["resize", "shrink", "width"]),
        },
      },
    };

    it("grabs each gesture's kind and count once, not its direction", () => {
      const { host } = bound(SWIPES);

      expect(host.grabbed).toStrictEqual(["Meta+r", "Meta+Escape"]);
      expect(host.grabbedGestures).toStrictEqual([
        "pinch:4",
        "swipe:3",
        "swipe",
      ]);
    });

    it("runs the binding a finished gesture fits", () => {
      const { heard, host } = bound(SWIPES);

      host.gestured("swipe", 3, { dx: -40, dy: 3 });
      host.gestured("pinch", 4, { scale: 0.5 });
      host.gestured("swipe", 4, { dx: -40 });

      expect(heard).toStrictEqual([
        ["command", ["workspace", "next"]],
        ["command", ["overview"]],
      ]);
    });

    it("runs nothing for a canceled gesture", () => {
      const { heard, host } = bound(SWIPES);

      host.gestured("swipe", 3, { dx: -40 }, true);

      expect(heard).toStrictEqual([]);
    });

    it("reads gestures in the mode the keys are in", () => {
      const { heard, host } = bound(SWIPES);

      host.pressed("Meta+r");
      host.gestured("swipe", 4, { dx: -40 });
      host.gestured("swipe", 3, { dx: 40 });

      expect(heard).toStrictEqual([
        ["mode", "resize"],
        ["command", ["resize", "shrink", "width"]],
      ]);
    });

    it("grabs and runs an edge swipe by its side", () => {
      const { heard, host } = bound({
        keybindings: {
          edge: KeyAction.SendShell(["overview"]),
          "edge:left": KeyAction.SendShell(["workspace", "prev"]),
        },
      });

      host.gestured("edge", 1, { dx: 80, edge: "left" });
      host.gestured("edge", 1, { dy: -80, edge: "bottom" });

      expect(host.grabbedGestures).toStrictEqual(["edge", "edge:left"]);
      expect(heard).toStrictEqual([
        ["command", ["workspace", "prev"]],
        ["command", ["overview"]],
      ]);
    });

    it("gives every gesture back once unbound, and stops listening", () => {
      const { heard, host } = bound(SWIPES);

      unbind();
      unbind();
      host.gestured("swipe", 3, { dx: -40 });

      expect(host.ungrabbedGestures).toStrictEqual([
        "pinch:4",
        "swipe:3",
        "swipe",
      ]);
      expect(heard).toStrictEqual([]);
    });
  });
});
