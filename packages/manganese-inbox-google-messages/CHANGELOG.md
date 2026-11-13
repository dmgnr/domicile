# @domicile-desktop/manganese-inbox-google-messages

## 0.1.3

### Patch Changes

- @domicile-desktop/manganese-bar-module-google-messages@1.0.3
  - @domicile-desktop/manganese-notifications@2.0.1

## 0.1.2

### Patch Changes

- Updated dependencies [bc45b4c]
- Updated dependencies [d69b2f4]
- Updated dependencies [50318b4]
  - @domicile-desktop/manganese-notifications@2.0.0
  - @domicile-desktop/manganese-bar-module-google-messages@1.0.2

## 0.1.1

### Patch Changes

- @domicile-desktop/manganese-bar-module-google-messages@1.0.1
  - @domicile-desktop/manganese-notifications@1.1.1

## 0.1.0

### Minor Changes

- a113605: Inboxes open as app windows instead of a page in the notifications drawer. Messages is one window that keeps running in the background: closing it hides it. Each Gmail account has one window, reused by its inbox row, its bar counter and its new-mail notifications. `Inbox.Page` is replaced by `Inbox.Window`, and an inbox's `launcherName` adds a launcher entry that opens its window.
- be59aae: Inboxes in the notification drawer: `runManganese({ inboxes })` lists inboxes above the notifications, and their unread conversations count toward the bell. An inbox is plain data (`Inbox.Watched` or `Inbox.Page`, from `@domicile-desktop/manganese-notifications/inbox`). New packages `@domicile-desktop/manganese-inbox-gmail` (`gmailInbox`) and `@domicile-desktop/manganese-inbox-google-messages` (`messagesInbox`, which opens in the drawer, widened, with a back button). The Gmail and Google Messages bar items stay, and export what the inboxes share. `SlideOver` gains `keepMounted`, `onBack` and `wide`.

### Patch Changes

- d4b9da4: The bell counts an inbox's new mail or texts once: its own notifications stay out of the count, since its unread conversations already add to it. Every inbox names the sender its notifications arrive under, `notifiesAs`, and `useNotifications` takes the senders to leave out.
- Updated dependencies [a3c11aa]
- Updated dependencies [77fd631]
- Updated dependencies [c99bfef]
- Updated dependencies [d961736]
- Updated dependencies [c429bd5]
- Updated dependencies [f71cc09]
- Updated dependencies [3f7e261]
- Updated dependencies [b49fa3a]
- Updated dependencies [9f441cd]
- Updated dependencies [2b1b80f]
- Updated dependencies [4856cc9]
- Updated dependencies [35b8470]
- Updated dependencies [7a29c8f]
- Updated dependencies [a113605]
- Updated dependencies [f6f6e5b]
- Updated dependencies [d4b9da4]
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [5bdc699]
- Updated dependencies [0aa24da]
- Updated dependencies [cd83e49]
- Updated dependencies [40d7378]
- Updated dependencies [cbaa64e]
- Updated dependencies [1fcf33a]
- Updated dependencies [4ee2c21]
- Updated dependencies [3146073]
- Updated dependencies [e83ec4a]
- Updated dependencies [7a786a4]
- Updated dependencies [c15ba93]
- Updated dependencies [9664607]
- Updated dependencies [1971d87]
- Updated dependencies [5d2376e]
- Updated dependencies [44f23d6]
  - @domicile-desktop/manganese-notifications@1.1.0
  - @domicile-desktop/manganese-bar-module-google-messages@1.0.0
