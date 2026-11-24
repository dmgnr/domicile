import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "../fake-host";
import { CapturingKind, PortalAnswer, PortalKind } from "../portal";
import { desktop } from "./desktop";

const push = (fake: FakeDomicileHost, line: object): void => {
  fake.dispatch("portalrequests", {
    data: JSON.stringify({ items: [], type: "portal_requests", ...line }),
  });
};

describe("portals", () => {
  it("reads nothing until the compositor pushes", () => {
    const { portals } = desktop(new FakeDomicileHost().host);

    expect(portals.requests).toBeUndefined();
    expect(portals.capturing).toBeUndefined();
    expect(portals.boundShortcuts).toBeUndefined();
    expect(portals.wallpaper).toBeUndefined();
  });

  it("reads each part of the latest push", () => {
    const fake = new FakeDomicileHost();
    const { portals } = desktop(fake.host);
    push(fake, {
      capturing: [
        { app_id: "org.example.Meet", body: {}, id: 2, kind: "unheard_of" },
      ],
      items: [
        {
          app_id: "org.example.App",
          body: {
            body: "",
            destructive: false,
            grant_label: "Allow",
            subtitle: "",
            title: "?",
          },
          id: 1,
          kind: "access",
        },
      ],
      shortcuts: [{ app_id: "org.example.App", chord: "Meta+p", id: 3 }],
      wallpaper: { background: "/w.png" },
    });

    expect(portals.requests?.map(({ kind }) => kind)).toStrictEqual([
      PortalKind.Access,
    ]);
    expect(portals.capturing?.map(({ kind }) => kind)).toStrictEqual([
      CapturingKind.Unknown,
    ]);
    expect(portals.boundShortcuts).toStrictEqual([
      { appId: "org.example.App", chord: "Meta+p", id: 3 },
    ]);
    expect(portals.wallpaper).toStrictEqual({
      background: "/w.png",
      lockscreen: undefined,
    });
  });

  it("answers a request and ends a capture", () => {
    const fake = new FakeDomicileHost();
    const { portals } = desktop(fake.host);
    portals.answer(1, PortalAnswer.Access());
    portals.stopCapturing(2);

    expect(fake.calls).toStrictEqual([
      ["answerPortalRequest", 1, JSON.stringify({ kind: "access" })],
      ["answerPortalRequest", 2, JSON.stringify({ kind: "stop" })],
    ]);
  });

  it("asks the user again what an agent reaches", () => {
    const fake = new FakeDomicileHost();
    const { portals } = desktop(fake.host);
    portals.changeAgent(4);

    expect(fake.calls).toStrictEqual([
      ["answerPortalRequest", 4, JSON.stringify({ kind: "change" })],
    ]);
  });

  it("pauses, resumes and discards the shell's screen recording", () => {
    const fake = new FakeDomicileHost();
    const { portals } = desktop(fake.host);
    portals.pauseRecording(3);
    portals.resumeRecording(3);
    portals.discardRecording(3);

    expect(fake.calls).toStrictEqual([
      ["answerPortalRequest", 3, JSON.stringify({ kind: "pause" })],
      ["answerPortalRequest", 3, JSON.stringify({ kind: "resume" })],
      ["answerPortalRequest", 3, JSON.stringify({ kind: "discard" })],
    ]);
  });

  it("says the requests changed, after reading them", async () => {
    const fake = new FakeDomicileHost();
    const { portals } = desktop(fake.host);
    const changed = new Promise((resolve) => {
      portals.on("change", () => {
        resolve(portals.requests);
      });
    });
    push(fake, {});

    expect(await changed).toStrictEqual([]);
  });
});
