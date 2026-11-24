import { describe, expect, it } from "bun:test";
import { FakeDomicileHost } from "@domicile-desktop/sdk/fake-host";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";
import { act, renderHook } from "@testing-library/react";

import type { InboxReading } from "./inbox";
import { Inbox, InboxReading as Reading } from "./inbox";
import { useMailLinks } from "./useMailLinks";

const LINK = "mailto:alex@example.com";

/** The system calls the shell made, by id, as the compositor reads them. */
const requests = (fake: FakeDomicileHost): [number, unknown][] =>
  fake.calls
    .filter(([method]) => method === "callSystem")
    .map(([, id, request]) => [Number(id), JSON.parse(String(request))]);

/** Send `message` for call `id` as the compositor would. */
const say = (fake: FakeDomicileHost, id: number, message: object) => {
  fake.dispatch("system", { data: JSON.stringify({ id, ...message }) });
};

const settled = () =>
  act(() => new Promise<void>((done) => setTimeout(done, 0)));

/** An inbox that keeps what it was asked to write. */
const mailInbox = (name: string, account: string, written: string[][]) =>
  Inbox.Watched({
    account,
    icon: EnvelopeSimpleIcon,
    name,
    notifiesAs: name,
    open: () => undefined,
    read: () => {
      throw new Error("not read");
    },
    write: (_, link, from) => {
      written.push([name, link, from]);
    },
  });

const hook = (
  inboxes: readonly Inbox[],
  readings: readonly (InboxReading | undefined)[],
) => {
  const fake = new FakeDomicileHost();
  const rendered = renderHook(() =>
    useMailLinks(fake.domicile, inboxes, readings),
  );
  return { fake, rendered };
};

/** Hand `url` to the shell as the compositor would, on claim `id`. */
const handOver = async (fake: FakeDomicileHost, url: string) => {
  say(fake, 1, { reply: { kind: "started" }, type: "system_reply" });
  await settled();
  say(fake, 1, {
    event: { app_id: "slack", kind: "link", url },
    type: "system_event",
  });
  await settled();
};

describe(useMailLinks, () => {
  it("claims mailto links, and asks which address to write one from", async () => {
    const written: string[][] = [];
    const { fake, rendered } = hook(
      [
        mailInbox("Home", "me@home.net", written),
        mailInbox("Work", "me@work.com", written),
      ],
      [Reading.Counted(1, 0, [], ["me@home.net", "me@alias.net"]), undefined],
    );

    await handOver(fake, LINK);

    expect(requests(fake)).toStrictEqual([
      [1, { call: "claim_links", schemes: ["mailto"] }],
    ]);
    expect(rendered.result.current.asking?.link).toBe(LINK);
    expect(rendered.result.current.asking?.appId).toBe("slack");
    expect(
      rendered.result.current.senders.map(({ address, inbox }) => [
        inbox,
        address,
      ]),
    ).toStrictEqual([
      ["Home", "me@home.net"],
      ["Home", "me@alias.net"],
      ["Work", "me@work.com"],
    ]);

    act(() => {
      rendered.result.current.choose("me@alias.net");
    });

    expect(written).toStrictEqual([["Home", LINK, "me@alias.net"]]);
    expect(rendered.result.current.asking).toBeUndefined();
    expect(rendered.result.current.lastChoice).toBe("me@alias.net");
  });

  it("writes at once from the one address there is", async () => {
    const written: string[][] = [];
    const { fake, rendered } = hook(
      [mailInbox("Home", "me@home.net", written)],
      [undefined],
    );

    await handOver(fake, LINK);

    expect(written).toStrictEqual([["Home", LINK, "me@home.net"]]);
    expect(rendered.result.current.asking).toBeUndefined();
  });

  it("asks for a link a page opened", () => {
    const written: string[][] = [];
    const { rendered } = hook(
      [
        mailInbox("Home", "me@home.net", written),
        mailInbox("Work", "me@work.com", written),
      ],
      [undefined, undefined],
    );

    act(() => {
      rendered.result.current.open(LINK);
    });

    expect(rendered.result.current.asking).toStrictEqual({
      appId: undefined,
      link: LINK,
    });
  });

  it("drops a link when canceled", async () => {
    const written: string[][] = [];
    const { fake, rendered } = hook(
      [
        mailInbox("Home", "me@home.net", written),
        mailInbox("Work", "me@work.com", written),
      ],
      [undefined, undefined],
    );
    await handOver(fake, LINK);

    act(() => {
      rendered.result.current.cancel();
    });

    expect(rendered.result.current.asking).toBeUndefined();
    expect(written).toStrictEqual([]);
  });

  it("opens mailto links, in any case", () => {
    const { rendered } = hook(
      [mailInbox("Home", "me@home.net", [])],
      [undefined],
    );

    expect(rendered.result.current.opens(LINK)).toBe(true);
    expect(rendered.result.current.opens("MAILTO:a@example.com")).toBe(true);
    expect(rendered.result.current.opens("zoommtg://zoom.us/join")).toBe(false);
  });

  it("claims and opens nothing when no inbox writes email", async () => {
    const { fake, rendered } = hook([], []);
    await settled();

    expect(requests(fake)).toStrictEqual([]);
    expect(rendered.result.current.opens(LINK)).toBe(false);
  });
});
