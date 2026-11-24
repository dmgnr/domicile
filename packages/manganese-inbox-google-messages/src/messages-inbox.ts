import { watchUnreadWith } from "@domicile-desktop/manganese-bar-module-google-messages/watch-unread";
import { Inbox } from "@domicile-desktop/manganese-notifications/inbox";
import { ChatCircleTextIcon } from "@phosphor-icons/react/dist/ssr/ChatCircleText";

type Options = {
  /** Its name in the launcher, such as `SMS`. `Messages` if not given. */
  launcherName?: string;
  /**
   * The id of the browser profile its window opens in, such as `personal`.
   * By default, the one Messages' site opens in.
   */
  profile?: string;
};

/**
 * Google Messages in the notification drawer and the launcher: one window,
 * running in the background so its notifications keep coming, with its unread
 * conversations counted toward the bell. Goes in `runManganese`'s `inboxes`.
 *
 * Messages for web runs in one place at a time, so this window is the only
 * Messages page to open.
 */
export const messagesInbox = ({ launcherName, profile }: Options = {}): Inbox =>
  Inbox.Window({
    appId: "google-messages",
    countUnread: watchUnreadWith,
    icon: ChatCircleTextIcon,
    ...(launcherName === undefined ? {} : { launcherName }),
    name: "Messages",
    notifiesAs: "messages.google.com",
    ...(profile === undefined ? {} : { profile }),
    url: "https://messages.google.com/web/",
  });
