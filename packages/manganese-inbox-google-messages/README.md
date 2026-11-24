# @domicile-desktop/manganese-inbox-google-messages

Manganese's Google Messages inbox:
[Google Messages for web](https://messages.google.com/web/) in one app
window that runs in the background, listed in the notification drawer and the
launcher. Its unread conversations count toward the bell.

## Use

Put `messagesInbox()` in [`runManganese`](../shell-manganese/README.md)'s
`inboxes`.

```ts
import { runManganese } from "@domicile-desktop/manganese";
import { messagesInbox } from "@domicile-desktop/manganese-inbox-google-messages";

export const Shell = runManganese({
  inboxes: [messagesInbox({ launcherName: "SMS" })],
});
```

- `launcherName`: its name in the launcher. `Messages` if not given.
- `profile`: the browser profile its window opens in. Without one, Messages'
  site decides.

The window opens hidden when the shell starts, so its notifications come from
the start. A press, or a press of one of its notifications, brings it up;
closing it hides it. Pair it once there. Don't also use the `GoogleMessages`
bar item: Messages runs one web session at a time. What it
shows: [TOP-BAR.md](../shell-manganese/docs/TOP-BAR.md#inboxes).

## Test

```sh
bun run turbo test --filter @domicile-desktop/manganese-inbox-google-messages
```
