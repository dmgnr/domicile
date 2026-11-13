# @domicile-desktop/manganese-inbox-gmail

## 0.1.3

### Patch Changes

- Updated dependencies [d0fbc5b]
- Updated dependencies [d566f68]
- Updated dependencies [87ac040]
- Updated dependencies [24b88fb]
- Updated dependencies [81215c5]
- Updated dependencies [3e37020]
- Updated dependencies [3bdac3b]
- Updated dependencies [2a1913f]
- Updated dependencies [da632d6]
- Updated dependencies [a5ade39]
- Updated dependencies [8c477cc]
- Updated dependencies [996cc29]
- Updated dependencies [9bd54ab]
- Updated dependencies [8ff882e]
- Updated dependencies [25522ef]
- Updated dependencies [e821d1f]
- Updated dependencies [19cc2c5]
  - @domicile-desktop/sdk@2.3.0
  - @domicile-desktop/manganese-bar-module-gmail@2.0.3
  - @domicile-desktop/manganese-notifications@2.0.1
  - @domicile-desktop/react@0.1.3

## 0.1.2

### Patch Changes

- bc45b4c: Gmail's page no longer notifies the same mail again while its window is open.
- d69b2f4: A page's notification names its browser window, so only the Gmail inbox's own window has its duplicate notifications cleared; Gmail in another window notifies again.
- Updated dependencies [c664ef4]
- Updated dependencies [1af639c]
- Updated dependencies [bc45b4c]
- Updated dependencies [eba7d0d]
- Updated dependencies [af7415e]
- Updated dependencies [bb1e4cb]
- Updated dependencies [d69b2f4]
- Updated dependencies [8eaae53]
- Updated dependencies [f592184]
- Updated dependencies [18413ff]
- Updated dependencies [69fe0d8]
- Updated dependencies [a354497]
- Updated dependencies [9246b97]
- Updated dependencies [50318b4]
- Updated dependencies [cdb3534]
  - @domicile-desktop/sdk@2.2.0
  - @domicile-desktop/manganese-notifications@2.0.0
  - @domicile-desktop/manganese-bar-module-gmail@2.0.2
  - @domicile-desktop/react@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [fdad979]
  - @domicile-desktop/sdk@2.1.0
  - @domicile-desktop/manganese-bar-module-gmail@2.0.1
  - @domicile-desktop/manganese-notifications@1.1.1
  - @domicile-desktop/react@0.1.1

## 0.1.0

### Minor Changes

- bbcc610: New Gmail mail raises a desktop notification: the account's nickname, the sender and the subject, or one "5 new emails" notification when more than 3 arrive at once. A press opens the message. Mail already unread at startup or sign-in is not notified. Reading headers needs the `gmail.metadata` scope, so each account signs in again once. `deskInbox(domicile)(email, client, nickname)` takes the nickname notifications use.
- a113605: Inboxes open as app windows instead of a page in the notifications drawer. Messages is one window that keeps running in the background: closing it hides it. Each Gmail account has one window, reused by its inbox row, its bar counter and its new-mail notifications. `Inbox.Page` is replaced by `Inbox.Window`, and an inbox's `launcherName` adds a launcher entry that opens its window.
- be59aae: Inboxes in the notification drawer: `runManganese({ inboxes })` lists inboxes above the notifications, and their unread conversations count toward the bell. An inbox is plain data (`Inbox.Watched` or `Inbox.Page`, from `@domicile-desktop/manganese-notifications/inbox`). New packages `@domicile-desktop/manganese-inbox-gmail` (`gmailInbox`) and `@domicile-desktop/manganese-inbox-google-messages` (`messagesInbox`, which opens in the drawer, widened, with a back button). The Gmail and Google Messages bar items stay, and export what the inboxes share. `SlideOver` gains `keepMounted`, `onBack` and `wide`.
- 5bdc699: The launcher previews an inbox by its account, unread count and newest unread mail, instead of the command it runs.

### Patch Changes

- d4b9da4: The bell counts an inbox's new mail or texts once: its own notifications stay out of the count, since its unread conversations already add to it. Every inbox names the sender its notifications arrive under, `notifiesAs`, and `useNotifications` takes the senders to leave out.
- Updated dependencies [a3c11aa]
- Updated dependencies [fe90bca]
- Updated dependencies [77fd631]
- Updated dependencies [9e60e1e]
- Updated dependencies [a62f35a]
- Updated dependencies [923e65b]
- Updated dependencies [3980a9a]
- Updated dependencies [66d220b]
- Updated dependencies [c99bfef]
- Updated dependencies [d961736]
- Updated dependencies [d3a65c5]
- Updated dependencies [eca2588]
- Updated dependencies [c429bd5]
- Updated dependencies [22844b3]
- Updated dependencies [c03a44b]
- Updated dependencies [9fe15f8]
- Updated dependencies [f71cc09]
- Updated dependencies [40f5af3]
- Updated dependencies [ab2d2f0]
- Updated dependencies [17064a7]
- Updated dependencies [a88ce23]
- Updated dependencies [ecd3fba]
- Updated dependencies [0e8c788]
- Updated dependencies [62a671f]
- Updated dependencies [56e1c22]
- Updated dependencies [98d378e]
- Updated dependencies [e42226f]
- Updated dependencies [bbcc610]
- Updated dependencies [73dd960]
- Updated dependencies [fd40a91]
- Updated dependencies [690c592]
- Updated dependencies [3f7e261]
- Updated dependencies [35b8470]
- Updated dependencies [6730912]
- Updated dependencies [2a87739]
- Updated dependencies [a113605]
- Updated dependencies [f6f6e5b]
- Updated dependencies [d4b9da4]
- Updated dependencies [4967b5d]
- Updated dependencies [be59aae]
- Updated dependencies [a999398]
- Updated dependencies [9d4a876]
- Updated dependencies [44d0983]
- Updated dependencies [dc90c70]
- Updated dependencies [5bdc699]
- Updated dependencies [57b5b1f]
- Updated dependencies [b2c6fd5]
- Updated dependencies [93f015d]
- Updated dependencies [b85d9bb]
- Updated dependencies [01b9340]
- Updated dependencies [fccc784]
- Updated dependencies [2bf4b18]
- Updated dependencies [0aa24da]
- Updated dependencies [cd83e49]
- Updated dependencies [40d7378]
- Updated dependencies [cbaa64e]
- Updated dependencies [1fcf33a]
- Updated dependencies [4ee2c21]
- Updated dependencies [3146073]
- Updated dependencies [bbf849b]
- Updated dependencies [e83ec4a]
- Updated dependencies [7a786a4]
- Updated dependencies [3bb9bd5]
- Updated dependencies [c15ba93]
- Updated dependencies [2fe5852]
- Updated dependencies [52a1d65]
- Updated dependencies [3e5b976]
- Updated dependencies [ae7874c]
- Updated dependencies [75799a0]
- Updated dependencies [2430e48]
- Updated dependencies [9fd298a]
- Updated dependencies [b1041f8]
- Updated dependencies [20a1fc5]
- Updated dependencies [ee63a45]
- Updated dependencies [66bfb0d]
- Updated dependencies [9664607]
- Updated dependencies [d9f5353]
- Updated dependencies [1971d87]
- Updated dependencies [5d2376e]
- Updated dependencies [44f23d6]
- Updated dependencies [6c3db42]
- Updated dependencies [9c89f16]
- Updated dependencies [ca86667]
- Updated dependencies [0c58b28]
- Updated dependencies [ee1cc17]
- Updated dependencies [eb6b52a]
  - @domicile-desktop/manganese-notifications@1.1.0
  - @domicile-desktop/sdk@2.0.0
  - @domicile-desktop/manganese-bar-module-gmail@2.0.0
  - @domicile-desktop/react@0.1.0
