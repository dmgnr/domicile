import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { KeyAction } from "@domicile-desktop/sdk/key-action";
import type { ShellKeybindings } from "@domicile-desktop/sdk/own-keybindings";
import { act, renderHook } from "@testing-library/react";

import { Direction } from "../direction";
import type { WindowAction as Action } from "../window-state";
import { WindowAction } from "../window-state";
import { MediaKey } from "./media-key";
import { Query } from "./query";
import { useKeybindings } from "./useKeybindings";

/** A sample of manganese's bindings. */
const KEYS: ShellKeybindings = {
  keybindings: {
    "Meta+l": KeyAction.SendShell(["focus", "right"]),
    "Meta+o": KeyAction.SendShell(["overview"]),
    "Meta+Return": KeyAction.SendShell(["terminal"]),
    "Meta+r": KeyAction.Mode("resize"),
    "Meta+Shift+l": KeyAction.SendShell(["move", "right"]),
    "Meta+space": KeyAction.SendShell(["launcher"]),
    "Meta+t": KeyAction.SendShell(["get-tree"]),
    "Meta+v": KeyAction.SendShell(["clipboard"]),
    "Meta+x": KeyAction.SendShell(["teleport"]),
    Print: KeyAction.SendShell(["screenshot"]),
    "swipe:4:down": KeyAction.SendShell(["layer", "down"]),
    "swipe:4:up": KeyAction.SendShell(["layer", "up"]),
    XF86AudioRaiseVolume: KeyAction.SendShell(["volume", "up"]),
  },
  modes: {
    resize: { "Meta+l": KeyAction.SendShell(["resize", "grow", "right"]) },
  },
};

/** A fake host whose chord presses a test sends. */
const client = () => {
  const fake = new FakeDomicileHost();
  return {
    domicile: fake.domicile,
    presses: (chord: string) => {
      act(() => {
        fake.dispatch("shortcut", { chord });
      });
    },
  };
};

/** Render the hook over a fake host. */
const bound = (launcherOpen = false, overviewOpen = false) => {
  const { domicile, presses } = client();
  const acted: Action[] = [];
  const modes: string[] = [];
  const reported: string[] = [];
  const asked: Query[] = [];
  const { rerender } = renderHook(
    ({ mode }: { mode: string }) => {
      useKeybindings({
        answer: (query) => {
          asked.push(query);
          return "{}";
        },
        domicile,
        keybindings: KEYS,
        launcherOpen,
        mode,
        onAction: (action) => {
          acted.push(action);
        },
        onModeChanged: (entered) => {
          modes.push(entered);
        },
        overviewOpen,
        report: (error) => {
          reported.push(error);
        },
      });
    },
    { initialProps: { mode: "default" } },
  );
  return { acted, asked, modes, presses, reported, rerender };
};

describe("useKeybindings", () => {
  it("does what a `send-shell` binding says", () => {
    const { acted, presses } = bound();

    presses("Meta+l");

    expect(acted).toStrictEqual([WindowAction.FocusStepped(Direction.Right)]);
  });

  it("answers only the launcher's own key and Print while it is up", () => {
    // The launcher is modal, so keys must not act on windows behind it. A
    // screenshot acts on none, and is how the launcher is shot.
    const { acted, presses } = bound(true);

    presses("Meta+l");
    presses("Print");
    presses("Meta+space");

    expect(acted).toStrictEqual([
      WindowAction.ScreenshotTaken(),
      WindowAction.LauncherToggled(),
    ]);
  });

  it("answers only the overview's own keys while it is up, and the hardware keys", () => {
    // The overview is for picking a workspace: a key that opens a window or
    // works one behind it would act on a desk the user cannot see.
    const { acted, presses } = bound(false, true);

    presses("Meta+Return");
    presses("Meta+l");
    presses("Shift+Meta+l");
    presses("XF86AudioRaiseVolume");
    presses("Meta+v");
    presses("Meta+o");
    presses("swipe:4:up");
    presses("swipe:4:down");

    expect(acted).toStrictEqual([
      WindowAction.FocusStepped(Direction.Right),
      WindowAction.WindowStepped(Direction.Right),
      WindowAction.MediaKeyPressed(MediaKey.VolumeUp),
      WindowAction.ClipboardToggled(),
      WindowAction.OverviewToggled(),
      WindowAction.LayerRaised(),
      WindowAction.LayerLowered(),
    ]);
  });

  it("says which command it does not know, and does nothing", () => {
    const { acted, reported, presses } = bound();

    presses("Meta+x");

    expect(acted).toStrictEqual([]);
    expect(reported).toStrictEqual(["manganese: no command `teleport`"]);
  });

  it("answers a query without acting, even over the launcher", () => {
    const { acted, asked, presses, reported } = bound(true);

    presses("Meta+t");

    expect(asked).toStrictEqual([Query.Tree]);
    expect(acted).toStrictEqual([]);
    expect(reported).toStrictEqual([]);
  });

  it("says when a key enters a mode", () => {
    const { modes, presses } = bound();

    presses("Meta+r");

    expect(modes).toStrictEqual(["resize"]);
  });

  it("reads the keys in the mode the desktop is in", () => {
    // Another page may have entered the mode.
    const { acted, modes, rerender, presses } = bound();

    rerender({ mode: "resize" });
    presses("Meta+l");

    expect(acted).toStrictEqual([WindowAction.WindowGrown(Direction.Right)]);
    expect(modes).toStrictEqual([]);
  });
});
