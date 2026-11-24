import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { WindowState } from "../window-state";
import { desktop } from "./desktop";

describe("windows", () => {
  it("lists each window with undefined for what the client has not said", () => {
    const fake = new FakeDomicileHost();
    fake.appear("1", { title: "Terminal", width: 800 });

    expect(desktop(fake.host).windows.list).toStrictEqual([
      {
        anchor: undefined,
        appId: "1",
        clientFrame: false,
        cursor: "default",
        cursorImage: undefined,
        desktopId: "",
        dialog: false,
        frame: 0,
        gid: undefined,
        grab: false,
        height: undefined,
        inhibitsShortcuts: false,
        maxHeight: undefined,
        maxWidth: undefined,
        minHeight: undefined,
        minWidth: undefined,
        parent: undefined,
        pid: undefined,
        pidfdInode: undefined,
        pointerConstraint: undefined,
        pointerRegion: undefined,
        sandboxAppId: undefined,
        sandboxEngine: undefined,
        sandboxed: undefined,
        sandboxInstanceId: undefined,
        title: "Terminal",
        toplevelId: undefined,
        transientFor: undefined,
        uid: undefined,
        urgent: false,
        width: 800,
        x: undefined,
        y: undefined,
      },
    ]);
  });

  it("reads the same list until the windows change", () => {
    const fake = new FakeDomicileHost();
    fake.appear("1");
    const { windows } = desktop(fake.host);
    const first = windows.list;

    expect(windows.list).toBe(first);
    fake.appear("2");
    expect(windows.list).not.toBe(first);
  });

  it("reads which window has the keyboard", () => {
    const fake = new FakeDomicileHost();
    const { windows } = desktop(fake.host);

    expect(windows.focused).toBeUndefined();
    fake.set({ focusedWindow: "1" });
    expect(windows.focused).toBe("1");
  });

  it("moves the keyboard, closes a window, answers a pointer lock and places one", () => {
    const fake = new FakeDomicileHost();
    const { windows } = desktop(fake.host);
    windows.focus("1");
    windows.focusShell();
    windows.close("1");
    windows.pointerConstrained("1", true);
    windows.setBounds("1", { height: 4, width: 3, x: 1, y: 2 });
    windows.syncFrames();

    expect(fake.calls).toStrictEqual([
      ["focusApp", "1"],
      ["focusChrome"],
      ["closeApp", "1"],
      ["pointerConstrained", "1", true],
      ["setAppBounds", "1", 1, 2, 3, 4],
      ["syncFrames"],
    ]);
  });

  it("sets a window's states through the compositor", () => {
    const fake = new FakeDomicileHost();
    desktop(fake.host)
      .windows.setStates("1", [WindowState.Maximized])
      .catch(() => {
        /* never answered */
      });

    expect(fake.calls).toStrictEqual([
      [
        "callSystem",
        1,
        JSON.stringify({
          app_id: "1",
          call: "set_window_states",
          states: ["maximized"],
        }),
      ],
    ]);
  });

  describe("events", () => {
    it("says the list changed until unsubscribed", () => {
      const fake = new FakeDomicileHost();
      let heard = 0;
      const stop = desktop(fake.host).windows.on("change", () => {
        heard += 1;
      });
      fake.appear("1");
      stop();
      fake.appear("2");

      expect(heard).toBe(1);
    });

    it("says the keyboard moved", async () => {
      const fake = new FakeDomicileHost();
      const moved = new Promise((resolve) => {
        desktop(fake.host).windows.on("focuschange", () => {
          resolve(undefined);
        });
      });
      fake.set({ focusedWindow: "1" });

      expect(await moved).toBeUndefined();
    });

    it("says which window asked for the keyboard", async () => {
      const fake = new FakeDomicileHost();
      const asked = new Promise((resolve) => {
        desktop(fake.host).windows.on("focusrequest", resolve);
      });
      fake.dispatch("focusrequested", { appId: "1" });

      expect(await asked).toBe("1");
    });
  });
});
