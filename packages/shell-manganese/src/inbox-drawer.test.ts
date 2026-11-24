import { describe, expect, it } from "bun:test";
import type { Inbox as InboxType } from "@domicile-desktop/manganese-notifications/inbox";
import {
  Inbox,
  InboxReading,
} from "@domicile-desktop/manganese-notifications/inbox";
import { sharedWatch } from "@domicile-desktop/react/shared-watch";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";
import { act, renderHook } from "@testing-library/react";

import {
  backgroundAppsOf,
  launcherAppsOf,
  useInboxDrawer,
} from "./inbox-drawer";

const CHAT_URL = "https://chat.example.com/";

/** A Work inbox read from outside, and a Chat inbox in a window. */
const inboxes = () => {
  const reading: { send: (reading: InboxReading) => void } = {
    send: () => undefined,
  };
  const chat: {
    countMatches: ((selector: string) => Promise<number>) | undefined;
    send: (unread: number) => void;
  } = { countMatches: undefined, send: () => undefined };
  const opened: (readonly unknown[])[] = [];
  const list: readonly InboxType[] = [
    Inbox.Watched({
      icon: EnvelopeSimpleIcon,
      name: "Work",
      notifiesAs: "Work",
      open: (_domicile, read) => {
        opened.push(["open work", read]);
      },
      read: () =>
        sharedWatch((onReading) => {
          reading.send = onReading;
          return () => undefined;
        }),
    }),
    Inbox.Window({
      appId: "chat",
      countUnread: (countMatches, onUnread) => {
        chat.countMatches = countMatches;
        chat.send = onUnread;
        return () => {
          chat.countMatches = undefined;
        };
      },
      icon: EnvelopeSimpleIcon,
      name: "Chat",
      notifiesAs: "chat.example.com",
      url: CHAT_URL,
    }),
  ];
  return { chat, list, opened, reading };
};

const drawer = () => {
  const { chat, list, opened, reading } = inboxes();
  const fake = new FakeDomicileHost();
  const hook = renderHook(() =>
    useInboxDrawer({
      domicile: fake.domicile,
      inboxes: list,
      onClose: () => {
        opened.push(["close"]);
      },
    }),
  );
  return { chat, fake, hook, opened, reading };
};

/** The app windows `fake` was asked to open. */
const appsOpened = (fake: FakeDomicileHost) =>
  fake.calls.filter(([name]) => name === "openAppWindow");

describe("useInboxDrawer", () => {
  it("reads every inbox, and adds up their unread conversations", () => {
    const { chat, fake, hook, reading } = drawer();
    act(() => {
      fake.openApp(CHAT_URL, "chat", "focus");
    });

    act(() => {
      reading.send(InboxReading.Counted(12, 2));
      chat.send(3);
    });

    expect(hook.result.current.drawer.readings).toEqual([
      InboxReading.Counted(12, 2),
      InboxReading.Unread(3),
    ]);
    expect(hook.result.current.unread).toBe(5);
  });

  it("counts an inbox in a window in that window's page", () => {
    const { chat, fake } = drawer();
    act(() => {
      fake.openApp(CHAT_URL, "chat", "focus");
    });

    chat.countMatches?.("p.unread").catch(() => {
      /* never answered */
    });

    expect(fake.calls).toContainEqual([
      "countBrowserWindowMatches",
      "1",
      "p.unread",
    ]);
  });

  it("opens an inbox's window at start, hidden, when it has none", () => {
    const { fake } = drawer();

    act(() => {
      fake.set({ browserWindows: [] });
    });

    expect(appsOpened(fake)).toEqual([
      ["openAppWindow", CHAT_URL, "chat", "focus", ""],
    ]);
  });

  it("opens no second window for an inbox with one", () => {
    const { fake } = drawer();

    act(() => {
      fake.set({ browserWindows: [] });
    });
    // The engine lists the window it opened, and lists again later.
    act(() => {
      fake.set({ browserWindows: fake.host.browserWindows });
    });

    expect(appsOpened(fake)).toHaveLength(1);
  });

  it("opens an inbox read from outside with its reading, closing the drawer", () => {
    const { hook, opened, reading } = drawer();
    act(() => {
      reading.send(InboxReading.SignedOut());
    });

    act(() => {
      hook.result.current.drawer.onOpen(0);
    });

    expect(opened).toEqual([
      ["open work", InboxReading.SignedOut()],
      ["close"],
    ]);
  });

  it("brings up an inbox's window, closing the drawer", () => {
    const { fake, hook, opened } = drawer();

    act(() => {
      hook.result.current.drawer.onOpen(1);
    });

    expect(appsOpened(fake)).toEqual([
      ["openAppWindow", CHAT_URL, "chat", "focus", ""],
    ]);
    expect(opened).toEqual([["close"]]);
  });

  it("brings up an inbox's window when its notification is pressed", () => {
    const { fake, hook, opened } = drawer();

    act(() => {
      hook.result.current.notificationPressed("chat.example.com");
    });

    expect(appsOpened(fake)).toEqual([
      ["openAppWindow", CHAT_URL, "chat", "focus", ""],
    ]);
    expect(opened).toEqual([]);
  });

  it("leaves other notifications' presses to their senders", () => {
    const { fake, hook, opened } = drawer();

    act(() => {
      hook.result.current.notificationPressed("Work");
      hook.result.current.notificationPressed("other.example.com");
    });

    expect(appsOpened(fake)).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe(launcherAppsOf, () => {
  it("lists each inbox with a window, by its launcher name or else its name", () => {
    const { list } = inboxes();

    expect(
      launcherAppsOf([
        ...list,
        Inbox.Watched({
          app: { appId: "mail", url: "https://mail.example/" },
          icon: EnvelopeSimpleIcon,
          launcherName: "Email",
          name: "Home",
          notifiesAs: "Home",
          open: () => undefined,
          read: () => sharedWatch(() => () => undefined),
        }),
      ]),
    ).toEqual([
      { appId: "chat", name: "Chat", url: CHAT_URL },
      { appId: "mail", name: "Email", url: "https://mail.example/" },
    ]);
  });
});

describe(backgroundAppsOf, () => {
  it("is the app id of each inbox in a window", () => {
    expect(backgroundAppsOf(inboxes().list)).toEqual(["chat"]);
  });
});
