import type { WebApp } from "@domicile-desktop/manganese-launcher/app-search";
import type {
  Inbox,
  InboxReading as Reading,
} from "@domicile-desktop/manganese-notifications/inbox";
import {
  InboxKind,
  InboxReading,
  unreadIn,
} from "@domicile-desktop/manganese-notifications/inbox";
import type { DrawerInboxes } from "@domicile-desktop/manganese-notifications/NotificationDrawer";
import { AppReuse } from "@domicile-desktop/sdk/desktop/browser";
import type { Domicile } from "@domicile-desktop/sdk/desktop/desktop";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

type Options = {
  domicile: Domicile;
  /** The config's inboxes. */
  inboxes: readonly Inbox[];
  /** Closes the notification drawer. */
  onClose: () => void;
};

/**
 * The notification drawer's inboxes: what each reads, what a press opens, and
 * the unread conversations the bell adds to its count. `notificationPressed`
 * takes a pressed notification's sender, and brings up the window of the inbox
 * in a window it notifies for.
 *
 * An inbox in a window runs in the background: its window opens at start if
 * none is open, and its count is read from that window.
 */
export const useInboxDrawer = ({ domicile, inboxes, onClose }: Options) => {
  const watched = useWatchedReadings(domicile, inboxes);
  const counted = useWindowCounts(domicile, inboxes);
  const readings = useMemo(
    () =>
      inboxes.map((inbox, index) => {
        const unread = counted.get(index);
        if (inbox.kind === InboxKind.Watched) {
          return watched[index];
        } else {
          return unread === undefined ? undefined : InboxReading.Unread(unread);
        }
      }),
    [counted, inboxes, watched],
  );
  const open = useCallback(
    (index: number) => {
      const inbox = inboxes[index];
      if (inbox !== undefined) {
        openInbox(domicile, inbox, readings[index]);
        onClose();
      }
    },
    [domicile, inboxes, onClose, readings],
  );
  const drawer = useMemo<DrawerInboxes>(
    () => ({ inboxes, onOpen: open, readings }),
    [inboxes, open, readings],
  );
  const unread = useMemo(
    () => readings.reduce((sum, reading) => sum + unreadIn(reading), 0),
    [readings],
  );
  // A page may not answer its notification's press by asking to be in front,
  // so the press brings an inbox's window up itself.
  const notificationPressed = useCallback(
    (appName: string) => {
      const inbox = inboxes.find(
        (candidate) =>
          candidate.kind === InboxKind.Window &&
          candidate.notifiesAs === appName,
      );
      if (inbox !== undefined) {
        openInbox(domicile, inbox, undefined);
      }
    },
    [domicile, inboxes],
  );
  return { drawer, notificationPressed, unread };
};

/**
 * Opens `inbox`, as a press of its row or its launcher entry does: an inbox
 * read from outside opens with its `reading`, and one in a window brings that
 * window up, opening it if none is.
 */
export const openInbox = (
  domicile: Domicile,
  inbox: Inbox,
  reading: Reading | undefined,
): void => {
  switch (inbox.kind) {
    case InboxKind.Watched: {
      inbox.open(domicile, reading);
      break;
    }
    case InboxKind.Window: {
      domicile.browser.openApp(inbox.url, {
        id: inbox.appId,
        reuse: AppReuse.Focus,
        ...profileOf(inbox),
      });
      break;
    }
  }
};

/**
 * The inboxes the launcher lists, as the app windows they open: each in a
 * window, and each read from outside that names one. Named by its launcher
 * name, else its name.
 */
export const launcherAppsOf = (inboxes: readonly Inbox[]): WebApp[] =>
  inboxes.flatMap((inbox) => {
    const name = inbox.launcherName ?? inbox.name;
    switch (inbox.kind) {
      case InboxKind.Watched: {
        return inbox.app === undefined ? [] : [{ ...inbox.app, name }];
      }
      case InboxKind.Window: {
        return [
          { appId: inbox.appId, name, url: inbox.url, ...profileOf(inbox) },
        ];
      }
    }
  });

/** An inbox window's browser profile, as `openApp` takes it: none for its site's. */
const profileOf = ({ profile }: { profile?: string }): { profile?: string } =>
  profile === undefined ? {} : { profile };

/**
 * The app ids whose windows run in the background: each inbox in a window's.
 * The window manager opens them hidden and hides them when closed.
 */
export const backgroundAppsOf = (inboxes: readonly Inbox[]): string[] =>
  inboxes.flatMap((inbox) =>
    inbox.kind === InboxKind.Window ? [inbox.appId] : [],
  );

/** The latest reading of each inbox read from outside, by its place. */
const useWatchedReadings = (domicile: Domicile, inboxes: readonly Inbox[]) => {
  const watches = useMemo(
    () =>
      inboxes.map((inbox) =>
        inbox.kind === InboxKind.Watched ? inbox.read(domicile) : undefined,
      ),
    [domicile, inboxes],
  );
  const [readings, setReadings] = useState<readonly (Reading | undefined)[]>(
    () => watches.map((watch) => watch?.current()),
  );
  useEffect(() => {
    const stops = watches.map((watch, index) =>
      watch?.subscribe(() => {
        setReadings((read) => read.with(index, watch.current()));
      }),
    );
    setReadings(watches.map((watch) => watch?.current()));
    return () => {
      for (const stop of stops) {
        stop?.();
      }
    };
  }, [watches]);
  return readings;
};

/**
 * Each inbox in a window's unread count, by its place, read from its window.
 * Opens the window of each one that has none, once the engine has listed the
 * windows, so it runs from the start.
 */
const useWindowCounts = (domicile: Domicile, inboxes: readonly Inbox[]) => {
  const listed = useInboxWindows(domicile, inboxes);
  const [counts, setCounts] = useState<ReadonlyMap<number, number>>(
    () => new Map(),
  );
  useEffect(() => {
    const ids = listed?.split(" ") ?? [];
    const stops = inboxes.map((inbox, index) => {
      const id = ids[index];
      if (inbox.kind === InboxKind.Window && id !== undefined && id !== "") {
        return inbox.countUnread(
          (selector) => domicile.browser.countMatches(id, selector),
          (unread) => {
            setCounts((known) => new Map([...known, [index, unread]]));
          },
        );
      } else {
        return undefined;
      }
    });
    return () => {
      for (const stop of stops) {
        stop?.();
      }
    };
  }, [domicile, inboxes, listed]);
  useEffect(() => {
    if (listed !== undefined) {
      const ids = listed.split(" ");
      for (const [index, inbox] of inboxes.entries()) {
        if (inbox.kind === InboxKind.Window && ids[index] === "") {
          domicile.browser.openApp(inbox.url, {
            id: inbox.appId,
            reuse: AppReuse.Focus,
            ...profileOf(inbox),
          });
        }
      }
    }
  }, [domicile, inboxes, listed]);
  return counts;
};

/**
 * The engine id of each inbox's window, by its place, space-separated: `""`
 * for an inbox with none or read from outside. One string, so a list that
 * changes no inbox's window changes nothing. `undefined` until the engine
 * lists the windows.
 */
const useInboxWindows = (
  domicile: Domicile,
  inboxes: readonly Inbox[],
): string | undefined => {
  const subscribe = useCallback(
    (changed: () => void) => domicile.browser.on("change", changed),
    [domicile],
  );
  return useSyncExternalStore(subscribe, () => {
    const windows = domicile.browser.windows;
    return windows === undefined
      ? undefined
      : inboxes
          .map((inbox) =>
            inbox.kind === InboxKind.Window
              ? (windows.find(({ appId }) => appId === inbox.appId)?.id ?? "")
              : "",
          )
          .join(" ");
  });
};
