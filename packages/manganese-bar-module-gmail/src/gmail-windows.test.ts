import { describe, expect, it } from "bun:test";
import type { DomicileBrowserWindow } from "@domicile-desktop/sdk/domicile-host";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";

import { watchGmailWindows } from "./gmail-windows";

const browser = (
  id: string,
  url: string,
  title: string,
): DomicileBrowserWindow => ({
  appId: "",
  height: 0,
  id,
  isApp: false,
  isCaptured: false,
  isHidden: false,
  isPrivate: false,
  menu: null,
  menuBarAutoHide: false,
  menuBarVisible: true,
  messageBox: null,
  parent: null,
  partition: "",
  popupMenu: null,
  popupWindow: null,
  profile: "default",
  title,
  toplevelId: null,
  url,
  wantsFullscreen: false,
  wantsMaximized: false,
  wantsMinimized: false,
  width: 0,
  x: 0,
  y: 0,
});

const INBOX = "https://mail.google.com/mail/u/0/#inbox";
const MESSAGE = "https://mail.google.com/mail/u/0/#inbox/FMfcgz";
const NEWS = "https://news.example.com/";

describe("watchGmailWindows", () => {
  it("calls back when a Gmail window opens, navigates, retitles or closes", () => {
    const fake = new FakeDomicileHost();
    const changes = { count: 0 };

    const stop = watchGmailWindows(fake.domicile, () => {
      changes.count += 1;
    });
    fake.set({ browserWindows: [browser("1", INBOX, "Inbox (2)")] });
    fake.set({ browserWindows: [browser("1", MESSAGE, "Hello")] });
    fake.set({ browserWindows: [browser("1", INBOX, "Inbox (1)")] });
    fake.set({ browserWindows: [] });
    stop();

    expect(changes.count).toBe(4);
  });

  it("ignores other windows, blank ones too, and stops", () => {
    const fake = new FakeDomicileHost();
    const changes = { count: 0 };
    const gmail = browser("1", INBOX, "Inbox (2)");

    const stop = watchGmailWindows(fake.domicile, () => {
      changes.count += 1;
    });
    fake.set({ browserWindows: [gmail] });
    fake.set({ browserWindows: [gmail, browser("2", NEWS, "News")] });
    fake.set({ browserWindows: [gmail, browser("2", NEWS, "Sports")] });
    fake.set({ browserWindows: [gmail, browser("3", "", "")] });
    stop();
    fake.set({ browserWindows: [] });

    expect(changes.count).toBe(1);
  });
});
