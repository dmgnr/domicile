import { describe, expect, it } from "bun:test";
import { KeyActionKind } from "@domicile-desktop/sdk/key-action";

import { parseCommand } from "./command";
import {
  brightness,
  clearNotifications,
  DEFAULT_KEYBINDINGS,
  exec,
  focus,
  idleInhibitor,
  keymap,
  launcher,
  layer,
  micMute,
  nightLight,
  notifications,
  overview,
  removeVirtualMonitor,
  screenshot,
  searchClipboard,
  stepWorkspace,
  terminal,
  virtualMonitor,
  volume,
} from "./commands";

describe("manganese's command builders", () => {
  it("build the notification, idle and night light commands manganese parses", () => {
    expect([
      notifications(),
      clearNotifications(),
      idleInhibitor(),
      nightLight(),
    ]).toEqual([
      { args: ["notifications"], kind: KeyActionKind.SendShell },
      { args: ["notifications", "clear"], kind: KeyActionKind.SendShell },
      { args: ["idle-inhibitor"], kind: KeyActionKind.SendShell },
      { args: ["night-light"], kind: KeyActionKind.SendShell },
    ]);
  });

  it("build the virtual monitor commands manganese parses", () => {
    expect([
      virtualMonitor(),
      virtualMonitor({ height: 1440, width: 2560 }),
      removeVirtualMonitor(),
    ]).toEqual([
      { args: ["virtual-monitor", "add"], kind: KeyActionKind.SendShell },
      {
        args: ["virtual-monitor", "add", "2560x1440"],
        kind: KeyActionKind.SendShell,
      },
      { args: ["virtual-monitor", "remove"], kind: KeyActionKind.SendShell },
    ]);
  });
});

describe("manganese's default keys", () => {
  // Every default binding must parse, or that key does nothing.
  it("are every one a command manganese knows", () => {
    for (const [chord, action] of Object.entries(DEFAULT_KEYBINDINGS)) {
      expect(action.kind, chord).toBe(KeyActionKind.SendShell);
      if (action.kind === KeyActionKind.SendShell) {
        expect(
          parseCommand(action.args).match({
            Err: () => false,
            Ok: () => true,
          }),
          chord,
        ).toBe(true);
      }
    }
  });

  it("are sway's: workspaces on Meta and a digit", () => {
    expect(DEFAULT_KEYBINDINGS["Meta+1"]).toEqual({
      args: ["workspace", "1"],
      kind: KeyActionKind.SendShell,
    });
    expect(DEFAULT_KEYBINDINGS["Meta+0"]).toEqual({
      args: ["workspace", "10"],
      kind: KeyActionKind.SendShell,
    });
  });

  it("take a screenshot on Print", () => {
    expect(DEFAULT_KEYBINDINGS.Print).toEqual(screenshot());
    expect(screenshot()).toEqual({
      args: ["screenshot"],
      kind: KeyActionKind.SendShell,
    });
  });

  it("change the volume and brightness on the media keys", () => {
    expect(DEFAULT_KEYBINDINGS).toMatchObject({
      XF86AudioLowerVolume: volume("down"),
      XF86AudioMicMute: micMute(),
      XF86AudioMute: volume("mute"),
      XF86AudioRaiseVolume: volume("up"),
      XF86MonBrightnessDown: brightness("down"),
      XF86MonBrightnessUp: brightness("up"),
    });
    expect([volume("up"), micMute(), brightness("down")]).toEqual([
      { args: ["volume", "up"], kind: KeyActionKind.SendShell },
      { args: ["mic", "mute"], kind: KeyActionKind.SendShell },
      { args: ["brightness", "down"], kind: KeyActionKind.SendShell },
    ]);
  });

  it("search the clipboard on Meta+Shift+space", () => {
    expect(DEFAULT_KEYBINDINGS["Meta+Shift+space"]).toEqual(searchClipboard());
    expect(searchClipboard()).toEqual({
      args: ["search-clipboard"],
      kind: KeyActionKind.SendShell,
    });
  });

  it("swipe four fingers between the screen's workspaces", () => {
    expect(DEFAULT_KEYBINDINGS).toMatchObject({
      "swipe:4:left": stepWorkspace("next"),
      "swipe:4:right": stepWorkspace("prev"),
    });
    expect(stepWorkspace("next")).toEqual({
      args: ["workspace", "next_on_output"],
      kind: KeyActionKind.SendShell,
    });
  });

  it("swipe in from the touchscreen's side edges between its workspaces", () => {
    expect(DEFAULT_KEYBINDINGS).toMatchObject({
      "edge:left": stepWorkspace("prev"),
      "edge:right": stepWorkspace("next"),
    });
  });

  it("step between the scratchpad, the desk and the overview with four fingers up and down", () => {
    expect(DEFAULT_KEYBINDINGS).toMatchObject({
      "swipe:4:down": layer("down"),
      "swipe:4:up": layer("up"),
    });
    expect(layer("up")).toEqual({
      args: ["layer", "up"],
      kind: KeyActionKind.SendShell,
    });
  });

  it("open the launcher by spreading three fingers", () => {
    expect(DEFAULT_KEYBINDINGS["pinch:3:outward"]).toEqual(launcher());
  });

  it("move focus where three fingers swipe", () => {
    expect(DEFAULT_KEYBINDINGS).toMatchObject({
      "swipe:3:down": focus("down"),
      "swipe:3:left": focus("left"),
      "swipe:3:right": focus("right"),
      "swipe:3:up": focus("up"),
    });
  });

  it("open the overview on Meta+O, a tap of Super or a four-finger pinch in", () => {
    expect(DEFAULT_KEYBINDINGS).toMatchObject({
      Meta: overview(),
      "Meta+o": overview(),
      "pinch:4:inward": overview("show"),
    });
    expect(overview()).toEqual({
      args: ["overview"],
      kind: KeyActionKind.SendShell,
    });
  });

  it("close the overview on a four-finger spread", () => {
    expect(DEFAULT_KEYBINDINGS["pinch:4:outward"]).toEqual(overview("hide"));
    expect(overview("hide")).toEqual({
      args: ["overview", "hide"],
      kind: KeyActionKind.SendShell,
    });
  });

  // The config's `terminal`; Domicile names no default one.
  it("open the desk's terminal on Meta+Return", () => {
    expect(DEFAULT_KEYBINDINGS["Meta+Return"]).toEqual(terminal());
    expect(terminal()).toEqual({
      args: ["terminal"],
      kind: KeyActionKind.SendShell,
    });
  });
});

describe("exec", () => {
  it("is Domicile's `exec`, which the SDK starts without the shell", () => {
    expect(exec("kitty", "--hold")).toEqual({
      argv: ["kitty", "--hold"],
      kind: KeyActionKind.Exec,
    });
  });
});

describe("keymap", () => {
  it("names the next keymap, or one by name", () => {
    expect([keymap("next"), keymap("us")]).toEqual([
      { args: ["keymap", "next"], kind: KeyActionKind.SendShell },
      { args: ["keymap", "us"], kind: KeyActionKind.SendShell },
    ]);
  });
});
