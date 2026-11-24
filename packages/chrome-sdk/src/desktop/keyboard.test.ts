import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { KeymapChoice } from "../keymap-choice";
import { desktop } from "./desktop";

const pressed = {
  altKey: false,
  chord: "Meta+Return",
  ctrlKey: false,
  keycode: 28,
  metaKey: true,
  shiftKey: false,
};

describe("keyboard", () => {
  it("reads no modifiers until the compositor says", () => {
    expect(
      desktop(new FakeDomicileHost().host).keyboard.modifiers,
    ).toBeUndefined();
  });

  it("reads the seat's modifiers", () => {
    const fake = new FakeDomicileHost();
    fake.set({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true });

    expect(desktop(fake.host).keyboard.modifiers).toStrictEqual({
      alt: false,
      ctrl: true,
      meta: false,
      shift: true,
    });
  });

  it("grabs and gives back chords", () => {
    const fake = new FakeDomicileHost();
    const { keyboard } = desktop(fake.host);
    keyboard.grab("Meta+Return");
    keyboard.ungrab("Meta+Return");

    expect(fake.calls).toStrictEqual([
      ["grabShortcut", "Meta+Return"],
      ["ungrabShortcut", "Meta+Return"],
    ]);
  });

  it("grabs a chord that stays the shell's while a window inhibits", () => {
    const fake = new FakeDomicileHost();
    const { keyboard } = desktop(fake.host);
    keyboard.grab("Meta+Escape", { whileInhibited: true });

    expect(fake.calls).toStrictEqual([["grabShortcut", "Meta+Escape", true]]);
  });

  it("grabs a tap held no longer than it says", () => {
    const fake = new FakeDomicileHost();
    const { keyboard } = desktop(fake.host);
    keyboard.grab("Meta", { longestTap: 500 });
    keyboard.grab("Alt", { longestTap: 200, whileInhibited: true });

    expect(fake.calls).toStrictEqual([
      ["grabShortcut", "Meta", false, 500],
      ["grabShortcut", "Alt", true, 200],
    ]);
  });

  it("hears a grabbed chord pressed and let go", async () => {
    const fake = new FakeDomicileHost();
    const { keyboard } = desktop(fake.host);
    const press = new Promise((resolve) => {
      keyboard.on("shortcut", resolve);
    });
    const release = new Promise((resolve) => {
      keyboard.on("shortcutrelease", resolve);
    });
    fake.dispatch("shortcut", pressed);
    fake.dispatch("shortcutrelease", pressed);

    expect(await press).toStrictEqual(pressed);
    expect(await release).toStrictEqual(pressed);
  });

  it("says the modifiers changed", async () => {
    const fake = new FakeDomicileHost();
    const changed = new Promise((resolve) => {
      desktop(fake.host).keyboard.on("modifierschange", () => {
        resolve(undefined);
      });
    });
    fake.set({ altKey: true });

    expect(await changed).toBeUndefined();
  });
});

describe("pointer", () => {
  it("warps the pointer", () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host).pointer.warp(10, 20);

    expect(fake.calls).toStrictEqual([["warpPointer", 10, 20, undefined]]);
  });

  it("asks the engine to leave a pointer that is over a box", () => {
    // The page cannot see the pointer over a browser window's page; the
    // engine can.
    const fake = new FakeDomicileHost();
    desktop(fake.host).pointer.warp(10, 20, {
      height: 4,
      width: 3,
      x: 1,
      y: 2,
    });

    expect(fake.calls).toStrictEqual([
      ["warpPointer", 10, 20, new DOMRectReadOnly(1, 2, 3, 4)],
    ]);
  });

  it("asks the engine to hold the pointer in boxes, and to let go", () => {
    const fake = new FakeDomicileHost();
    const { pointer } = desktop(fake.host);
    pointer.confine([{ height: 4, width: 3, x: 1, y: 2 }]).catch(() => {
      /* never answered */
    });
    pointer.confine([]).catch(() => {
      /* never answered */
    });

    expect(fake.calls).toStrictEqual([
      ["confinePointer", [new DOMRectReadOnly(1, 2, 3, 4)]],
      ["confinePointer", []],
    ]);
  });

  it("hears the keymaps and switches them through the compositor", async () => {
    const fake = new FakeDomicileHost();
    const { keyboard } = desktop(fake.host);
    keyboard.keymaps().catch(() => {
      /* never answered */
    });
    keyboard.selectKeymap(KeymapChoice.Next()).catch(() => {
      /* never answered */
    });
    await Promise.resolve();

    expect(fake.calls).toStrictEqual([
      ["callSystem", 1, JSON.stringify({ call: "keymaps" })],
      [
        "callSystem",
        2,
        JSON.stringify({ call: "select_keymap", keymap: { kind: "next" } }),
      ],
    ]);
  });
});
