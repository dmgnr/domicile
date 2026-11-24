import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import type { NotificationsBus, NotifyCall } from "./notification";
import { createNotification } from "./notification";

/** A notification server that numbers each notification from 1. */
const setUp = (refuse?: string) => {
  const calls: NotifyCall[] = [];
  const closed: number[] = [];
  const signals = new EventEmitter();
  const bus: NotificationsBus = {
    close: (id) => {
      closed.push(id);
      return Promise.resolve();
    },
    notify: (call) => {
      calls.push(call);
      return refuse === undefined
        ? Promise.resolve(call.replaces === 0 ? calls.length : call.replaces)
        : Promise.reject(new Error(refuse));
    },
    on: (event, listener) => signals.on(event, listener),
  };
  const Notification = createNotification(bus, {
    appId: "com.example.Notes",
    name: "Notes",
  });
  /** Lets the server's answer to show() arrive. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { calls, closed, Notification, settle, signals };
};

describe(createNotification, () => {
  it("is supported", () => {
    const { Notification } = setUp();

    expect(Notification.isSupported()).toBe(true);
  });

  it("shows on the desktop as the app's, clickable", async () => {
    const { calls, Notification, settle } = setUp();
    const notification = new Notification({
      body: "Claude finished your task",
      title: "Done",
    });
    let shown = 0;
    notification.on("show", () => {
      shown += 1;
    });

    notification.show();
    await settle();

    expect(calls).toEqual([
      {
        actions: ["default", ""],
        appName: "Notes",
        body: "Claude finished your task",
        hints: {
          "desktop-entry": ["s", "com.example.Notes"],
          urgency: ["y", 1],
        },
        icon: "",
        replaces: 0,
        summary: "Done",
        timeout: -1,
      },
    ]);
    expect(shown).toBe(1);
  });

  it("carries the app's buttons, reply field, urgency, sound and icon", async () => {
    const { calls, Notification, settle } = setUp();

    new Notification({
      actions: [
        { text: "Open", type: "button" },
        { text: "Snooze", type: "button" },
      ],
      body: "",
      hasReply: true,
      icon: "/opt/notes/icon.png",
      replyPlaceholder: "Answer",
      silent: true,
      timeoutType: "never",
      title: "Ping",
      urgency: "critical",
    }).show();
    await settle();

    expect(calls[0]).toMatchObject({
      actions: [
        "default",
        "",
        "0",
        "Open",
        "1",
        "Snooze",
        "inline-reply",
        "Answer",
      ],
      hints: {
        "image-path": ["s", "/opt/notes/icon.png"],
        "suppress-sound": ["b", true],
        urgency: ["y", 2],
      },
      icon: "/opt/notes/icon.png",
      timeout: 0,
    });
  });

  it("asks the desktop for the app's sound, by name or file", async () => {
    const { calls, Notification, settle } = setUp();

    new Notification({ sound: "message-new-instant", title: "a" }).show();
    new Notification({ sound: "/opt/app/ping.oga", title: "b" }).show();
    await settle();

    expect(calls.map(({ hints }) => hints)).toMatchObject([
      { "sound-name": ["s", "message-new-instant"] },
      { "sound-file": ["s", "/opt/app/ping.oga"] },
    ]);
  });

  it("keeps a close button's text, which the desktop's notifications don't show", () => {
    const { Notification } = setUp();

    expect(
      new Notification({ closeButtonText: "Dismiss" }).closeButtonText,
    ).toBe("Dismiss");
    expect(new Notification().closeButtonText).toBe("");
    expect(new Notification().sound).toBe("");
  });

  it("labels a reply with no placeholder Reply, as macOS does", async () => {
    const { calls, Notification, settle } = setUp();

    new Notification({ hasReply: true, title: "Ping" }).show();
    await settle();

    expect(calls[0]?.actions).toEqual(["default", "", "inline-reply", "Reply"]);
  });

  it("tells the app what the user did with it", async () => {
    const { Notification, settle, signals } = setUp();
    const notification = new Notification({ title: "Ping" });
    const heard: unknown[] = [];
    notification.on("click", () => heard.push("click"));
    notification.on("action", (_event, index: number) =>
      heard.push(["action", index]),
    );
    notification.on("reply", (_event, reply: string) =>
      heard.push(["reply", reply]),
    );
    notification.on("close", () => heard.push("close"));
    notification.show();
    await settle();

    signals.emit("ActionInvoked", 1, "default");
    signals.emit("ActionInvoked", 1, "1");
    signals.emit("NotificationReplied", 1, "on my way");
    signals.emit("ActionInvoked", 2, "default");
    signals.emit("NotificationClosed", 1, 2);
    signals.emit("ActionInvoked", 1, "default");

    expect(heard).toEqual([
      "click",
      ["action", 1],
      ["reply", "on my way"],
      "close",
    ]);
  });

  it("replaces itself when shown again", async () => {
    const { calls, Notification, settle } = setUp();
    const notification = new Notification({ title: "1 message" });
    notification.show();
    await settle();

    notification.title = "2 messages";
    notification.show();
    await settle();

    expect(calls.map(({ replaces, summary }) => [replaces, summary])).toEqual([
      [0, "1 message"],
      [1, "2 messages"],
    ]);
  });

  it("closes from the app, once shown", async () => {
    const { closed, Notification, settle } = setUp();
    const notification = new Notification({ title: "Ping" });
    notification.close();
    notification.show();
    await settle();

    notification.close();

    expect(closed).toEqual([1]);
  });

  it("says when the desktop would not show it, with why", async () => {
    const { Notification, settle } = setUp(
      "org.freedesktop.DBus.Error.ServiceUnknown",
    );
    const notification = new Notification({ title: "Ping" });
    const failures: string[] = [];
    notification.on("failed", (_event, why: string) => failures.push(why));

    notification.show();
    await settle();

    expect(failures).toEqual(["org.freedesktop.DBus.Error.ServiceUnknown"]);
  });

  it("refuses an icon it can't carry yet, rather than drop it", () => {
    const { Notification } = setUp();

    expect(() => new Notification({ icon: {} as never, title: "x" })).toThrow(
      "a notification's icon must be a file path",
    );
  });
});
