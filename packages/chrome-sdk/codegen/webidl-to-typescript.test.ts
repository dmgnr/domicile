import { describe, expect, it } from "bun:test";

import { parseWebIdl } from "./parse-webidl";
import { webIdlToTypeScript } from "./webidl-to-typescript";

const OPTIONS = { eventTypes: {}, header: ["Generated."] };

const emit = (
  source: string,
  options: Parameters<typeof webIdlToTypeScript>[1] = OPTIONS,
): string => webIdlToTypeScript(parseWebIdl(source), options);

describe("webIdlToTypeScript", () => {
  it("starts with the header", () => {
    expect(emit('enum Theme { "dark" };')).toStartWith("// Generated.\n");
  });

  it("takes a platform interface that lib.dom declares by its own name", () => {
    expect(
      emit(`interface Host {
  undefined warp(optional DOMRectReadOnly? box = null);
};`),
    ).toContain("warp(box?: DOMRectReadOnly | null): void;");
  });

  it("emits an enum as a union of its values, with its comment", () => {
    expect(
      emit(`// The theme.
enum Theme {
  "dark",
  "light",
};`),
    ).toContain('/** The theme. */\nexport type Theme = "dark" | "light";');
  });

  it("emits an interface's attributes as readonly properties of their TypeScript types", () => {
    expect(
      emit(`interface Display {
  // Its name.
  //
  // From the config.
  readonly attribute DOMString name;
  readonly attribute unsigned long width;
  readonly attribute double? scale;
  readonly attribute FrozenArray<Display>? children;
  readonly attribute FrozenArray<long?> sizes;
};`),
    ).toContain(`export type Display = {
  /**
   * Its name.
   *
   * From the config.
   */
  readonly name: string;
  readonly width: number;
  readonly scale: number | null;
  readonly children: readonly Display[] | null;
  readonly sizes: readonly (number | null)[];
};`);
  });

  it("emits an event interface as an Event with its attributes", () => {
    expect(
      emit(`interface AppEvent : Event {
  constructor(DOMString type, optional AppEventInit init = {});
  readonly attribute DOMString appId;
};`),
    ).toContain(
      "export type AppEvent = Event & {\n  readonly appId: string;\n};",
    );
  });

  it("makes a dictionary's defaulted members present where it is read, and optional where it is passed", () => {
    const typescript = emit(`dictionary Found {
  sequence<DOMString> files = [];
  boolean? more;
};
dictionary Shortcut {
  required unsigned long keycode;
  boolean altKey = false;
};
interface Host {
  Promise<Found> search(DOMString query);
  undefined grab(Shortcut shortcut);
};`);

    expect(typescript).toContain(
      "export type Found = {\n  readonly files: readonly string[];\n  readonly more?: boolean | null;\n};",
    );
    expect(typescript).toContain(
      "export type Shortcut = {\n  keycode: number;\n  altKey?: boolean;\n};",
    );
  });

  it("emits operations, merging overloads into one signature", () => {
    expect(
      emit(`dictionary Shortcut { required unsigned long keycode; };
interface Host {
  // Spawn it.
  undefined spawn(sequence<DOMString> command);
  // By keycode.
  undefined grab(Shortcut shortcut);
  // By name.
  undefined grab(DOMString chord);
};`),
    ).toContain(`  /** Spawn it. */
  spawn(command: readonly string[]): void;
  /**
   * By keycode.
   *
   * By name.
   */
  grab(shortcut: Shortcut | string): void;`);
  });

  it("emits a promise of nothing as a promise of void", () => {
    expect(
      emit(`interface Host {
  Promise<undefined> uninstall(DOMString id);
};`),
    ).toContain("  uninstall(id: string): Promise<void>;");
  });

  it("emits an optional argument as an optional parameter", () => {
    expect(
      emit(`interface Host {
  undefined open(USVString url, optional DOMString partition = "");
};`),
    ).toContain("  open(url: string, partition?: string): void;");
  });

  it("types an event target's listeners by an event map, Event unless the options say otherwise", () => {
    const typescript = emit(
      `interface Host : EventTarget {
  // A key was pressed.
  attribute EventHandler onshortcut;
  attribute EventHandler onchanged;
};`,
      { ...OPTIONS, eventTypes: { shortcut: "ShortcutEvent" } },
    );

    expect(typescript).toContain(`export type HostEventMap = {
  /** A key was pressed. */
  shortcut: ShortcutEvent;
  changed: Event;
};`);
    expect(typescript).toContain(
      "  addEventListener<T extends keyof HostEventMap>(type: T, listener: (event: HostEventMap[T]) => void): void;",
    );
    expect(typescript).toContain(
      "  removeEventListener<T extends keyof HostEventMap>(type: T, listener: (event: HostEventMap[T]) => void): void;",
    );
    expect(typescript).not.toContain("EventTarget &");
  });

  describe("throws", () => {
    it("on a type it cannot name", () => {
      expect(() =>
        emit("interface Host { readonly attribute Missing value; };"),
      ).toThrow("Missing");
    });

    it("on an event type for an event nothing fires", () => {
      expect(() =>
        emit(
          "interface Host : EventTarget { attribute EventHandler onshortcut; };",
          {
            ...OPTIONS,
            eventTypes: { shortcutt: "ShortcutEvent" },
          },
        ),
      ).toThrow("shortcutt");
    });
  });
});
