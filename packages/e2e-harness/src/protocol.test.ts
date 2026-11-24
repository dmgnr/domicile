import { describe, expect, it } from "bun:test";

import {
  PROTOCOL_VERSION,
  parseHostMessage,
  pointerAxisSchema,
  pointerPinchSchema,
} from "./protocol";

describe("parseHostMessage", () => {
  it("decodes a welcome frame", () => {
    expect(
      parseHostMessage(
        `{"type":"welcome","protocol_version":${PROTOCOL_VERSION.toString()}}`,
      ),
    ).toEqual({
      protocol_version: PROTOCOL_VERSION,
      type: "welcome",
    });
  });

  it("decodes a cursor frame", () => {
    expect(
      parseHostMessage('{"type":"app_cursor","app_id":"term","cursor":"text"}'),
    ).toEqual({
      app_id: "term",
      cursor: "text",
      type: "app_cursor",
    });
  });

  it("throws on an appearance whose pointer theme has no size", () => {
    expect(() =>
      parseHostMessage(
        '{"type":"appearance","high_contrast":false,"reduced_motion":false,"cursor":{"name":"Adwaita"}}',
      ),
    ).toThrow();
  });

  it("decodes what a search found", () => {
    expect(
      parseHostMessage(
        '{"type":"found_files","query":"src","files":["src/"],"matched":1,"indexing":true}',
      ),
    ).toEqual({
      files: ["src/"],
      indexing: true,
      matched: 1,
      query: "src",
      type: "found_files",
    });
  });

  it("throws on a cursor that is not a CSS keyword the chrome knows", () => {
    expect(() =>
      parseHostMessage(
        '{"type":"app_cursor","app_id":"term","cursor":"wiggle"}',
      ),
    ).toThrow();
  });

  it("normalizes a missing app title and desktop id to undefined", () => {
    const message = parseHostMessage(
      '{"type":"app_appeared","app_id":"term","title":null,"desktop_id":null,"size":[640,480],"dialog":true,"client_frame":false,"owner":{"pid":7,"uid":1000,"gid":1000,"pidfd_inode":null,"sandbox":null},"toplevel_id":"Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa"}',
    );
    expect(message).toStrictEqual({
      app_id: "term",
      client_frame: false,
      desktop_id: undefined,
      dialog: true,
      owner: {
        gid: 1000,
        pid: 7,
        pidfd_inode: undefined,
        sandbox: undefined,
        uid: 1000,
      },
      size: [640, 480],
      title: undefined,
      toplevel_id: "Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa",
      type: "app_appeared",
    });
  });

  it("decodes each browser window's toplevel id", () => {
    const message = parseHostMessage(
      '{"type":"browser_toplevel_ids","toplevel_ids":{"3":"Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE"}}',
    );
    expect(message).toStrictEqual({
      toplevel_ids: { "3": "Xy7pQ2mN8vB4cZ1kL6tR9wF3hD5sJ0gE" },
      type: "browser_toplevel_ids",
    });
  });

  it("decodes the process that owns a window", () => {
    const message = parseHostMessage(
      '{"type":"app_appeared","app_id":"term","title":null,"desktop_id":null,"size":[640,480],"dialog":false,"client_frame":false,"owner":{"pid":4242,"uid":1001,"gid":100,"pidfd_inode":5021,"sandbox":null},"toplevel_id":"Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa"}',
    );
    expect(message).toMatchObject({
      owner: { gid: 100, pid: 4242, pidfd_inode: 5021, uid: 1001 },
    });
  });

  it("decodes the sandbox a window's client connected from", () => {
    const message = parseHostMessage(
      '{"type":"app_appeared","app_id":"term","title":null,"desktop_id":null,"size":[640,480],"dialog":false,"client_frame":false,"owner":{"pid":4242,"uid":1001,"gid":100,"pidfd_inode":null,"sandbox":{"engine":"org.flatpak","app_id":null,"instance_id":"3"}},"toplevel_id":"Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa"}',
    );
    expect(message).toMatchObject({
      owner: {
        sandbox: { app_id: undefined, engine: "org.flatpak", instance_id: "3" },
      },
    });
  });

  it("throws on a window with no owner", () => {
    expect(() =>
      parseHostMessage(
        '{"type":"app_appeared","app_id":"term","title":null,"desktop_id":null,"size":[640,480],"dialog":false,"client_frame":false}',
      ),
    ).toThrow();
  });

  it("throws on an announcement without its size or dialog hints", () => {
    // A window is announced when it draws, so these are always known.
    expect(() =>
      parseHostMessage(
        '{"type":"app_appeared","app_id":"term","title":null,"desktop_id":null,"size":null,"dialog":false,"client_frame":false}',
      ),
    ).toThrow();
    expect(() =>
      parseHostMessage(
        '{"type":"app_appeared","app_id":"term","title":null,"desktop_id":null,"size":[640,480]}',
      ),
    ).toThrow();
  });

  it("decodes which desktop entry a client says it is", () => {
    expect(
      parseHostMessage(
        '{"type":"app_desktop_id","app_id":"term","desktop_id":"kitty"}',
      ),
    ).toStrictEqual({
      app_id: "term",
      desktop_id: "kitty",
      type: "app_desktop_id",
    });
  });

  it("decodes what a client calls its window", () => {
    // The title arrives after `app_appeared`, and again on each change.
    expect(
      parseHostMessage(
        '{"type":"app_titled","app_id":"term","title":"a terminal"}',
      ),
    ).toStrictEqual({
      app_id: "term",
      title: "a terminal",
      type: "app_titled",
    });
  });

  it("reads a client that named its window nothing as having no name", () => {
    // xdg-shell cannot clear a title, so clients send `set_title("")`.
    expect(
      parseHostMessage('{"type":"app_titled","app_id":"term","title":""}'),
    ).toStrictEqual({ app_id: "term", title: undefined, type: "app_titled" });
  });

  it("keeps unknown fields so a newer host can add them", () => {
    const message = parseHostMessage(
      '{"type":"app_closed","app_id":"term","reason":"crashed"}',
    );
    expect(message).toMatchObject({ app_id: "term", type: "app_closed" });
  });

  it("reports an unknown message type as undefined rather than throwing", () => {
    expect(parseHostMessage('{"type":"who_knows","data":1}')).toBeUndefined();
  });

  it("throws on a frame that is not JSON", () => {
    expect(() => parseHostMessage("not json")).toThrow();
  });

  it("throws when a known message type has the wrong payload", () => {
    expect(() =>
      parseHostMessage('{"type":"app_resized","app_id":"term"}'),
    ).toThrow();
  });

  it("decodes who holds the keyboard, both ways round", () => {
    // `null` means the chrome has focus.
    expect(
      parseHostMessage(
        JSON.stringify({ app_id: "app-1", type: "focus_changed" }),
      ),
    ).toStrictEqual({ app_id: "app-1", type: "focus_changed" });

    expect(
      parseHostMessage(JSON.stringify({ app_id: null, type: "focus_changed" })),
    ).toStrictEqual({ app_id: undefined, type: "focus_changed" });
  });

  it("decodes the synced frames a move goes with", () => {
    expect(
      parseHostMessage(
        '{"type":"popup_placed","app_id":"app-3","parent":"app-2","position":[12,48],"size":[180,240],"grab":false,"frames":[{"app_id":"app-2","frame":4}]}',
      ),
    ).toStrictEqual({
      app_id: "app-3",
      frames: [{ app_id: "app-2", frame: 4 }],
      grab: false,
      parent: "app-2",
      position: [12, 48],
      size: [180, 240],
      type: "popup_placed",
    });
  });

  it("throws on a synced frame that is no frame number", () => {
    expect(() =>
      parseHostMessage(
        '{"type":"popup_placed","app_id":"app-3","parent":"app-2","position":[12,48],"size":[180,240],"grab":false,"frames":[{"app_id":"app-2","frame":-1}]}',
      ),
    ).toThrow();
    expect(() =>
      parseHostMessage(
        '{"type":"app_appeared","app_id":"term","title":null,"desktop_id":null,"size":[640,480],"dialog":false,"client_frame":false,"owner":{"pid":7,"uid":1000,"gid":1000,"pidfd_inode":null,"sandbox":null},"toplevel_id":"Vb1vFz0gXrYJ8Kq2sLmN4tPw6dHc9eRa","frame":1.5}',
      ),
    ).toThrow();
  });

  it("decodes a dialog with no parent as undefined", () => {
    expect(
      parseHostMessage(
        JSON.stringify({
          app_id: "app-4",
          transient_for: null,
          type: "app_transient_for",
        }),
      ),
    ).toStrictEqual({
      app_id: "app-4",
      transient_for: undefined,
      type: "app_transient_for",
    });
  });

  it("decodes whether anybody is at the desk, both ways round", () => {
    // Sent as a state, not an edge, so a reloaded page learns the current
    // value. Both values must decode.
    expect(
      parseHostMessage(JSON.stringify({ idle: true, type: "idle" })),
    ).toStrictEqual({ idle: true, type: "idle" });

    expect(
      parseHostMessage(JSON.stringify({ idle: false, type: "idle" })),
    ).toStrictEqual({ idle: false, type: "idle" });
  });

  it("decodes whether the desk is locked, both ways round", () => {
    // A reloaded page must learn the desk is still locked. An inverted value
    // would hide the lock screen while locked.
    expect(
      parseHostMessage(JSON.stringify({ locked: true, type: "locked" })),
    ).toStrictEqual({ locked: true, type: "locked" });

    expect(
      parseHostMessage(JSON.stringify({ locked: false, type: "locked" })),
    ).toStrictEqual({ locked: false, type: "locked" });
  });

  it("decodes the desktop's displays", () => {
    // One page spans every display; `position` places each `<Screen>`.
    expect(
      parseHostMessage(
        JSON.stringify({
          displays: [
            {
              adaptive_sync: "unsupported",
              mode: [1920, 1080],
              name: "left",
              position: [0, 0],
              scale: 1,
              size: [1920, 1080],
              transform: "normal",
            },
            {
              adaptive_sync: "unsupported",
              hdr: "on",
              mode: [5120, 2880],
              name: "right",
              peak_luminance: 1000,
              position: [1920, 0],
              scale: 2,
              sdr_white: 203,
              size: [2560, 1440],
              transform: "normal",
            },
          ],
          type: "displays",
        }),
      ),
    ).toStrictEqual({
      displays: [
        {
          adaptive_sync: "unsupported",
          hdr: "unsupported",
          mode: [1920, 1080],
          name: "left",
          peak_luminance: 0,
          position: [0, 0],
          refresh_mhz: 0,
          scale: 1,
          sdr_white: 0,
          size: [1920, 1080],
          transform: "normal",
        },
        {
          adaptive_sync: "unsupported",
          hdr: "on",
          mode: [5120, 2880],
          name: "right",
          peak_luminance: 1000,
          position: [1920, 0],
          refresh_mhz: 0,
          scale: 2,
          sdr_white: 203,
          size: [2560, 1440],
          transform: "normal",
        },
      ],
      type: "displays",
    });
  });

  it("decodes a monitor on its side", () => {
    // `size`, `mode` and `transform` are independent: `scale` is the integer
    // `wl_output` scale, so `size` times `scale` need not equal `mode`.
    expect(
      parseHostMessage(
        JSON.stringify({
          displays: [
            {
              adaptive_sync: "unsupported",
              mode: [3840, 2160],
              name: "drm-3",
              position: [0, 0],
              scale: 2,
              size: [1800, 3200],
              transform: "rotate-270",
            },
          ],
          type: "displays",
        }),
      ),
    ).toStrictEqual({
      displays: [
        {
          adaptive_sync: "unsupported",
          hdr: "unsupported",
          mode: [3840, 2160],
          name: "drm-3",
          peak_luminance: 0,
          position: [0, 0],
          refresh_mhz: 0,
          scale: 2,
          sdr_white: 0,
          size: [1800, 3200],
          transform: "rotate-270",
        },
      ],
      type: "displays",
    });
  });

  it("decodes a display from before any of it was turned or scanned out", () => {
    // Captured or hand-written frames may omit `mode` and `transform`. They
    // default to `[0, 0]` (unknown) and `normal`.
    expect(
      parseHostMessage(
        JSON.stringify({
          displays: [
            { name: "left", position: [0, 0], scale: 1, size: [1920, 1080] },
          ],
          type: "displays",
        }),
      ),
    ).toStrictEqual({
      displays: [
        {
          adaptive_sync: "unsupported",
          hdr: "unsupported",
          mode: [0, 0],
          name: "left",
          peak_luminance: 0,
          position: [0, 0],
          refresh_mhz: 0,
          scale: 1,
          sdr_white: 0,
          size: [1920, 1080],
          transform: "normal",
        },
      ],
      type: "displays",
    });
  });

  it("decodes a desktop of no displays as an empty one, not a missing one", () => {
    // The compositor never sends this, but it must still decode as a valid
    // (empty) layout.
    expect(
      parseHostMessage(JSON.stringify({ displays: [], type: "displays" })),
    ).toStrictEqual({ displays: [], type: "displays" });
  });

  // `looseObject` accepts unknown keys, so only rejections prove the schema
  // validates.
  it.each([
    ["a position of one number", { position: [0] }],
    ["a fractional position", { position: [0.5, 0] }],
    ["a fractional position in its other half", { position: [0, 0.5] }],
    ["a size of one number", { size: [1920] }],
    ["a fractional size", { size: [1920.5, 1080] }],
    ["a fractional size in its other half", { size: [1920, 1080.5] }],
    ["a name that is not anything", { name: "" }],
    ["a size with no pixels", { size: [0, 1080] }],
    ["a negative size", { size: [1920, -1080] }],
    ["a fractional scale", { scale: 1.5 }],
    ["a scale of nothing", { scale: 0 }],
    ["a name that is not one", { name: 7 }],
    ["no name at all", { name: undefined }],
    ["no position at all", { position: undefined }],
    ["no size at all", { size: undefined }],
    ["no scale at all", { scale: undefined }],
  ])("throws on a display with %s", (_what, broken) => {
    const display = {
      name: "left",
      position: [0, 0],
      scale: 1,
      size: [1920, 1080],
      ...broken,
    };
    expect(() =>
      parseHostMessage(
        JSON.stringify({ displays: [display], type: "displays" }),
      ),
    ).toThrow();
  });

  it("throws when the desktop itself is missing from the message", () => {
    // A missing list must not decode as an empty one.
    expect(() => parseHostMessage('{"type":"displays"}')).toThrow();
  });

  it("throws on a display that describes nothing at all", () => {
    expect(() =>
      parseHostMessage(JSON.stringify({ displays: [{}], type: "displays" })),
    ).toThrow();
  });

  it("knows no message the compositor does not send", () => {
    // The engine matches shortcuts itself, and a shell previews a file with
    // its system calls.
    expect(
      parseHostMessage(
        JSON.stringify({
          shortcut: {
            alt: true,
            ctrl: false,
            key: 28,
            logo: false,
            shift: false,
          },
          type: "shortcut",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseHostMessage(
        JSON.stringify({ kind: "binary", path: "a", type: "file_preview" }),
      ),
    ).toBeUndefined();
  });

  it("decodes the tray, with the bus each icon answers on", () => {
    const icon = {
      bus: ":1.42",
      id: "nm",
      item_is_menu: false,
      menu: "/MenuBar",
      title: "Network",
    };

    expect(
      parseHostMessage(JSON.stringify({ items: [icon], type: "tray" })),
    ).toStrictEqual({ items: [icon], type: "tray" });
    expect(() =>
      parseHostMessage(
        JSON.stringify({
          items: [{ id: "nm", title: "Network" }],
          type: "tray",
        }),
      ),
    ).toThrow();
    expect(() =>
      parseHostMessage(
        JSON.stringify({
          items: [{ bus: ":1.42", id: "nm", title: "Network" }],
          type: "tray",
        }),
      ),
    ).toThrow();
  });

  it("decodes every keysym's key and the shell's options as JSON text", () => {
    expect(
      parseHostMessage(
        JSON.stringify({
          keys: { l: 38, Return: 28 },
          options: '{"gaps":4}',
          type: "shell_config",
        }),
      ),
    ).toStrictEqual({
      keys: { l: 38, Return: 28 },
      options: '{"gaps":4}',
      type: "shell_config",
    });
  });

  it("throws on a key that is not a key number", () => {
    expect(() =>
      parseHostMessage(
        JSON.stringify({
          keys: { Return: -1 },
          options: "{}",
          type: "shell_config",
        }),
      ),
    ).toThrow();
  });

  it("throws on options that are not JSON text", () => {
    expect(() =>
      parseHostMessage(
        JSON.stringify({
          keys: {},
          options: { gaps: 4 },
          type: "shell_config",
        }),
      ),
    ).toThrow();
  });
});

describe("pointerAxisSchema", () => {
  it("parses sources and independent axis stops without changing distances", () => {
    for (const source of [
      "wheel",
      "finger",
      "continuous",
      "wheel_tilt",
    ] as const) {
      const wire = {
        app_id: "term",
        dx: 0,
        dy: 4.5,
        source,
        stop_x: true,
        stop_y: false,
        type: "pointer_axis" as const,
        v120_x: 0,
        v120_y: 0,
      };
      expect(pointerAxisSchema.parse(wire)).toEqual(wire);
      expect(() =>
        pointerAxisSchema.parse({ ...wire, source: "mouse" }),
      ).toThrow();
    }
  });
});

describe("pointerPinchSchema", () => {
  it("preserves native phases and unsigned timestamps", () => {
    for (const phase of [
      { fingers: 3, phase: "begin" },
      { dx: 1.25, dy: -2.5, phase: "update", rotation: -12, scale: 1.6 },
      { canceled: true, phase: "end" },
    ] as const) {
      const wire = {
        app_id: "term",
        device: 7,
        time: 3_000_000_000,
        type: "pointer_pinch" as const,
        ...phase,
      };
      expect(pointerPinchSchema.parse(wire)).toEqual(wire);
    }
  });

  it("rejects fields that cannot reach the native gesture protocol", () => {
    const begin = {
      app_id: "term",
      device: 7,
      fingers: 2,
      phase: "begin",
      time: 0,
      type: "pointer_pinch",
    };
    for (const invalid of [
      { ...begin, device: -1 },
      { ...begin, time: 0x1_00_00_00_00 },
      { ...begin, fingers: 0x1_00_00_00_00 },
      { ...begin, fingers: 0 },
      { ...begin, dx: 0, dy: 0, phase: "update", rotation: 0, scale: 0 },
    ]) {
      expect(() => pointerPinchSchema.parse(invalid)).toThrow();
    }
  });
});
