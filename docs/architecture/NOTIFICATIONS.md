# Notifications

The compositor is the `org.freedesktop.Notifications` server for both Wayland
applications and web pages. The shell shows each notification as a toast and
keeps a history in a drawer.

## Design

```
application ─────── Notify / CloseNotification ──────▶ compositor
page: new Notification() ─▶ engine (Chrome's Linux bridge) ─Notify─▶ │
      ◀── ActionInvoked, NotificationReplied, NotificationClosed ──   │ HostMessage::Notifications { items }
                                                                      ▼
                                       engine: `notifications` attribute
                                                                      ▼
            shell: domicile.notifications, notificationschanged → toasts, bell, drawer
shell ─ dismissNotifications(ids) / invokeNotificationAction(id, key)
        / replyToNotification(id, text) ─▶ engine ─▶ compositor
```

| Piece | Where |
|---|---|
| Wire types: `HostMessage::Notifications`, `ChromeMessage::DismissNotifications`, `InvokeNotificationAction`, `ReplyToNotification`, `Notification`, `Urgency` | `packages/domicile-protocol` |
| History; mapping a `Notify` call to a notification (images, actions, urgency, page origin) | `packages/domicile-host/src/notifications.rs` |
| D-Bus: the name, `Notify`, the signals | `packages/domicile-compositor/src/notifications.rs` |
| `notifications` attribute, `dismissNotifications()`, `invokeNotificationAction()`, `replyToNotification()` | `control_channel.mojom`, `modules/domicile/domicile_notification*`, patch 0067 |
| Sites ask before they notify; the shell page is allowed; a notification that stays up is not marked critical | patch 0105, `guard-webview-notifications.sh`; for the shell page, `guard-shell-web-apis.sh` |
| Chrome waits for the server, which starts after the engine | patch 0133, `guard-notification-server-late.sh` |
| A page's notification names its browser window (`x-domicile-browser-window`) | patch 0172, `components/domicile/browser/notification_window.{h,cc}`, `guard-notification-window.sh` |
| A site's notification carries the site's favicon as its application icon | patch 0239, `guard-notification-site-icon.sh` |
| SDK: `DomicileNotification`, `notifications`, `dismissNotifications`, `invokeNotificationAction`, `replyToNotification`; `Notification` | `@domicile-desktop/sdk/domicile-host`, `@domicile-desktop/sdk/notification` |
| `Toaster` component | `@domicile-desktop/component-library/Toaster` |
| Manganese toasts, bell and drawer | `packages/manganese-notifications/src/` |

## Key decisions

- **One server for apps and pages.** Chrome on Linux sends Web Notifications
  over `org.freedesktop.Notifications`, so both arrive the same way.
- **The notification portal joins the same history.** Its notifications
  (`portals/notification.rs`) get history ids; a press goes back to the portal
  as `ActionInvoked` with the action's target, not over the bus. Each is
  named and drawn by its app's desktop entry, matched as the dialogs match it
  (see [PORTALS.md](/docs/PORTALS.md)). Mapping:
  `priority` `urgent` is critical and the rest normal; `display-hint`
  `persistent` keeps the toast up; buttons and `default-action` become actions
  and a click. `transient` and the lock-screen hints change nothing: the drawer
  keeps every notification, and the shell shows none while locked.
- **Chrome waits up to 20 seconds for the server.** The engine starts before
  the compositor, and Chrome's bridge looks for the server once. Patch 0133
  has it wait for the name first, so it neither shows its own popups nor
  starts an activatable daemon that would hold the compositor's name.
  Notifications shown meanwhile are queued.
- **Sites ask before they notify.** The profile's default is ask, reset at
  every start, and the shell answers the prompt. An allow-all default would
  let any site a browser window opened push notifications from the
  background. A site's setting can be changed in its site permissions
  ([SHELL-BROWSER-WINDOWS.md](/docs/SHELL-BROWSER-WINDOWS.md#permissions)).
- **The shell page may always notify.** `domicile://shell` has no prompt to
  ask through, and Chrome stores no content settings for its scheme.
- **Urgency is the sender's.** Chrome marks a notification that does not time
  out as critical unless the server is one it knows keeps such notifications
  up. Patch 0105 adds `Domicile` to that list, so `requireInteraction` alone
  does not draw a notification as critical.
- **The compositor keeps the history.**
  - It sends the full list on every change and on connect, so a reload keeps
    it and every monitor's page sees the same list.
  - It keeps a notification until the user clears it, reads it or its
    application closes it, up to 100.
  - Only toasts expire; notifications do not.
- **The shell decides what to toast.** A new id, or a replaced one (its `time`
  changed), shows a toast. The first list a page receives is history and shows
  no toasts.
- **A site's notification is drawn with the site's favicon.** Chrome sends
  its own logo as every notification's application icon. The engine sends
  the site's favicon there instead (patch 0239), so a page that gives no
  `icon` of its own is drawn as the site. A page's `icon` still comes first,
  as `image-path`. The logo stays for a site with no favicon yet and for a
  private page, whose profile keeps none.
- **No `body-markup`.** Bodies are plain text. The server does not advertise
  markup, so senders send none.
- **`x-kde-origin-name` is advertised** so Chrome sends the page's origin as a
  hint. The origin becomes the notification's source, and Chrome's `settings`
  action is dropped.
- **A page's notification names its browser window.** The engine sends the
  window's id as `x-domicile-browser-window` (`browserWindow` in the SDK), so
  the shell can tell a site's app window from its other pages. Manganese
  clears what a Gmail inbox's window notifies, since the inbox notifies the
  same mail. Absent for a worker's notification, the shell's own, and
  anything not from a page.
- **Clicking an action** runs it and closes the notification, unless the
  notification is `resident`.
- **Inline reply.** The server advertises `inline-reply`. An `inline-reply`
  action stays in `actions`, so the engine carries it unchanged. The shell
  draws it as a text field labeled with the action's label, with a send
  button. Manganese labels an empty one "Reply". Sending emits
  `NotificationReplied` and closes the notification as an action does.
  - The `x-kde-reply-placeholder-text` hint is dropped: the field's label is
    its placeholder.
  - Portal notifications have no reply field.
  - Chrome sends a Web Notification's text action (`type: "text"`) as
    `inline-reply`, and takes the reply back from `NotificationReplied`.
- **A press raises the notification's source.**
  - The compositor mints an `xdg-activation` token for each press and emits
    `ActivationToken` before `ActionInvoked`, as spec 1.2 orders. A portal
    notification gets it as `activation-token` in the platform data. The app
    raises its window with it, and the shell shows that window's workspace and
    tab and warps the pointer to it.
  - The press also lets the process that sent the notification (as the bus
    knows it) raise its window once with a token of its own, while the
    press's token is good. Electron before 42, so Slack, ignores
    `ActivationToken` and asks that way.
  - An app that has quit is started instead, from its `desktop-entry` hint,
    when its bus name is gone. The portal starts its own apps.
  - An app still running with no window, as Slack closed to its tray, hears
    the press and is started again too, which shows its window. "No window"
    means none from the process that sent the notification. A site's
    notification is never started: its `desktop-entry` is the browser's.
  - A press in the drawer closes the drawer, which would cover the window.
- **A site raises its own window.** Its `client.focus()` or `window.focus()`
  fires `domicile-focus-request` on the `<webview>`
  (`WebViewGuest::ActivateContents`), and the shell raises it.
- **Looking at an application reads its notifications,** and clears them as
  the user clearing them would. Slack, like most Linux applications, never
  closes its own once read in the app.
  - Its window getting the keyboard reads all of them: those its process sent
    over the bus, and the portal's for its app id. The chrome's own surfaces
    are no application's window, so a site's are not read this way.
  - Pressing one reads the rest of its application's, as GNOME does. The
    application is the sending process and its name, which for a page is its
    origin, so this covers sites too. For the portal, it is the app id.
- **Dismissing a toast** only hides the toast. **Clearing** a notification
  sends `NotificationClosed` (reason 2) to the application.
- **When locked,** the shell shows no toasts and no drawer, and the compositor
  refuses dismiss and action requests.
- **Critical** notifications stay up until dismissed and use the `danger`
  color.
- **Pausing,** from the drawer's header, shows no toasts but critical ones,
  for 1 hour, until 8 AM tomorrow, or until resumed. Notifications still
  collect in the drawer and count on the bell, which is struck through. The
  shell keeps the pause and its end in `localStorage`, so a reload keeps it,
  and ends it at that time.
- **Toasts show on the focused monitor,** the one with the keyboard, in its
  top-right corner under its bar.
