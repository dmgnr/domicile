import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import type { Link } from "@domicile-desktop/sdk/shell-command";
import type { Listening } from "@domicile-desktop/sdk/system";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Inbox, InboxReading } from "./inbox";
import { InboxKind, sendersOf } from "./inbox";
import type { Sender } from "./MailPicker";

/** The scheme of email links. */
const MAILTO = "mailto";

/** A `mailto:` link waiting for the user to pick an address. */
export type MailAsk = {
  link: string;
  /** The desktop file id of the application that opened it, if known. */
  appId: string | undefined;
};

/** A {@link Sender}, with what writes from it. */
type Writer = Sender & { write: (link: string) => void };

/**
 * `mailto:` links, written from the inboxes that write email: the desktop's
 * (claimed from the compositor while any inbox writes) and those `open` is
 * given, such as a page's, which `opens` says it takes. With one address to write from, a link is written
 * at once; with several, it waits in `asking` until `choose` or `cancel`.
 * `lastChoice` is the address picked last.
 */
export const useMailLinks = (
  domicile: Domicile,
  inboxes: readonly Inbox[],
  readings: readonly (InboxReading | undefined)[],
) => {
  const writers = useMemo(
    () => writersOf(domicile, inboxes, readings),
    [domicile, inboxes, readings],
  );
  const claims = useMemo(
    () =>
      inboxes.some(
        (inbox) =>
          inbox.kind === InboxKind.Watched && inbox.write !== undefined,
      ),
    [inboxes],
  );
  const [asking, setAsking] = useState<MailAsk | undefined>();
  const [lastChoice, setLastChoice] = useState<string | undefined>();
  // Read when a link arrives, so the claim outlives a change of readings.
  const current = useRef(writers);
  current.current = writers;

  const open = useCallback((link: string, appId?: string) => {
    const [only, ...others] = current.current;
    if (only !== undefined && others.length === 0) {
      only.write(link);
    } else {
      setAsking({ appId, link });
    }
  }, []);

  useEffect(() => {
    if (claims) {
      return claimLinks(domicile, [MAILTO], ({ appId, url }) => {
        open(url, appId);
      });
    } else {
      return undefined;
    }
  }, [claims, domicile, open]);

  const choose = useCallback(
    (address: string) => {
      const writer = writers.find((one) => one.address === address);
      if (asking === undefined || writer === undefined) {
        throw new Error(`nothing waits to be written from ${address}`);
      } else {
        writer.write(asking.link);
        setLastChoice(address);
        setAsking(undefined);
      }
    },
    [asking, writers],
  );
  const cancel = useCallback(() => {
    setAsking(undefined);
  }, []);
  const opens = useCallback(
    (link: string) => claims && link.toLowerCase().startsWith(`${MAILTO}:`),
    [claims],
  );

  return {
    asking,
    cancel,
    choose,
    lastChoice,
    open,
    opens,
    senders: writers as readonly Sender[],
  };
};

/** Every address the inboxes write from, inbox by inbox. */
const writersOf = (
  domicile: Domicile,
  inboxes: readonly Inbox[],
  readings: readonly (InboxReading | undefined)[],
): Writer[] =>
  inboxes.flatMap((inbox, index) =>
    inbox.kind === InboxKind.Watched && inbox.write !== undefined
      ? sendersOf(inbox, readings[index]).map((address) => ({
          address,
          icon: inbox.icon,
          inbox: inbox.name,
          write: (link: string) => {
            inbox.write?.(domicile, link, address);
          },
        }))
      : [],
  );

/**
 * Claims `schemes`' links from the compositor, calling `onLink` with each,
 * until the returned function is called. A stop before the claim starts ends
 * it once it does.
 */
const claimLinks = (
  domicile: Domicile,
  schemes: readonly string[],
  onLink: (link: Link) => void,
): (() => void) => {
  const state: { stopped: boolean; listening: Listening<Link> | undefined } = {
    listening: undefined,
    stopped: false,
  };
  domicile.shell
    .links(schemes)
    .then((result) => {
      result.match({
        Err: report,
        Ok: (listening) => {
          if (state.stopped) {
            listening.stop();
          } else {
            state.listening = listening;
          }
          eachOf(listening.items, onLink).catch(report);
        },
      });
    })
    .catch(report);
  return () => {
    state.stopped = true;
    state.listening?.stop();
  };
};

/** Call `each` with every item `items` brings, until it closes. */
const eachOf = async <T>(
  items: ReadableStream<T>,
  each: (item: T) => void,
): Promise<void> => {
  for await (const item of items) {
    each(item);
  }
};

const report = (error: unknown): void => {
  // biome-ignore lint/suspicious/noConsole: email links then open in the desk's mail app, if any
  console.error("this page cannot claim email links", error);
};
