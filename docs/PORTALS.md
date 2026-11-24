# Portals

Apps ask for file pickers, screen sharing, screenshots and other dialogs
through `xdg-desktop-portal`. The shell draws them.

## Quick start

Mount `PortalDialogs` once, anywhere in a React shell:

```tsx
/// <reference types="@domicile-desktop/react/elements" />

import { PortalDialogs } from "@domicile-desktop/component-library/PortalDialogs";
import { useDomicile } from "@domicile-desktop/react/domicile-provider";
import { mount } from "@domicile-desktop/react/mount";
import { useWindows } from "@domicile-desktop/react/windows";

const Desktop = () => (
  <>
    {useWindows().map(({ appId }) => (
      <app app-id={appId} key={appId} />
    ))}
    <PortalDialogs domicile={useDomicile()} />
  </>
);

export const Shell = mount(Desktop);
```

- `useDomicile()` reads the desktop from the `DomicileProvider` that `mount`
  puts around `Desktop`. Outside it, it throws.
- It shows one dialog at a time, oldest first, over the app that asked.
- Pass `holdKeyboard` to take the keyboard off your windows while a dialog is
  up. It is called when one appears; call the function it returns when the
  last goes. Without it, the app that asked keeps the keyboard and gets every
  key a dialog does not take, such as typing into a file chooser.
- It refuses every request kind it has no dialog for. The app gets response
  `2` and stops waiting.
- What each request becomes depends on the shell:

  | Shell | Request |
  |---|---|
  | No shell page connected | Refused at once |
  | Connected, ignores `domicile.portals` | Pending: the app waits until it gives up |
  | Mounts `PortalDialogs` | Drawn as a dialog, or refused |

Next:

- Its props, the kinds it draws, and refusing every request from a shell
  without React:
  [Application dialogs](SHELL-DESKTOP-EVENTS.md#application-dialogs).
- Drawing your own dialogs: read `domicile.portals.requests` and answer each
  with `domicile.portals.answer(id, answer)`. The kinds and answers are in
  `@domicile-desktop/sdk/portal`.
- How requests reach the shell: [Design](#design) and
  [Key decisions](#key-decisions) below.

## Design

Domicile is the session's only `xdg-desktop-portal` backend:

- The compositor implements every portal interface except `Secret`, which
  goes to the keyring.
- The shell draws every portal dialog.
- `xdg-desktop-portal-gtk` is not in the session.

```
app ──org.freedesktop.portal.*──▶ xdg-desktop-portal ──impl.portal.*──▶ compositor
                                                                         │ domicile_host::portals (queue)
                                    HostMessage::PortalRequests { items } ▼
                                         engine: `portalrequests` event (all kinds)
                                                                         ▼
                        shell: domicile.portals.on("change") → <PortalDialogs>
                        ◀── portals.answer(id, answer) ──── engine ── compositor ──▶ Response
```

One request channel carries all dialogs. Each interface's backend builds on it.

| Piece | Where |
|---|---|
| Wire types: `HostMessage::PortalRequests`, `ChromeMessage::AnswerPortalRequest`, `PortalRequest`, `PortalAnswer` | `packages/domicile-protocol` |
| Queue: pending requests, their apps, answer validation | `packages/domicile-host/src/portals.rs` |
| D-Bus service: one name, one object, all interfaces; `Request`/`Session` objects | `packages/domicile-compositor/src/portals/` (`Settings` in `settings.rs`) |
| `portalrequests` event, `answerPortalRequest()` | `control_channel.mojom`, `modules/domicile/`; new files only, no patch |
| Request kinds, parsed with Zod | `@domicile-desktop/sdk/portal` |
| Ready-made dialogs for any shell | `@domicile-desktop/component-library/PortalDialogs` |
| `parent_window` to window lookup | `zxdg_exporter_v2` / `v1` in the compositor |
| EIS server: devices per grant, regions, translation to seat input | `packages/domicile-compositor/src/eis.rs` |
| Interface routing | `packages/distro/share/domicile.portal`, `packages/distro/share/domicile-portals.conf` |

## Key decisions

- **No gtk fallback.** The shell already draws every dialog gtk would
  (manganese has a file picker, a launcher with desktop entries, a
  notification drawer). A fallback would give one session two looks and two
  keyboard models. The NixOS and home-manager modules offer no gtk backend.
- **The frontend starts under this desktop's name.** `xdg-desktop-portal`
  reads `XDG_CURRENT_DESKTOP` once, at startup. Without `domicile` it routes
  every interface to gtk as a last resort.
  - The launcher exports `XDG_CURRENT_DESKTOP` to the systemd user manager
    before starting any component (`graphical_session::name`). The engine
    starts first and can D-Bus activate the frontend.
  - The compositor sets it in the D-Bus and systemd activation environments,
    then restarts `xdg-desktop-portal.service` if its main process lacks the
    name (`portals::reroute_frontend`). It finds the process by the unit's
    `MainPID`, not the bus name, so a frontend still loading its backends is
    caught.
  - Check with `tr '\0' '\n' </proc/$(systemctl --user show -p MainPID
    --value xdg-desktop-portal)/environ | grep XDG_CURRENT_DESKTOP`.
- **Several desktops share one session bus.** A second login session on
  another tty, or a desktop nested in another, uses the same bus and user
  manager.
  - A login session takes the backend's, the notification server's and the
    tray watcher's names from the desktop holding them. A nested desktop
    queues behind its host. Every desktop stays queued, so a name goes to the
    next desktop when its holder exits (`bus_names`).
  - The compositor sets the activation environment each time it takes the
    backend's name, so it replaces an exited session's display.
  - A second login session's launcher gives the first its variables back when
    it exits, if the first still runs, instead of stopping
    `graphical-session.target` and the frontend (`graphical_session::end`).
- **`Secret` goes to the keyring.** `gnome-keyring` or `oo7-portal` implements
  it. It has no UI, and the store must outlive the session.
  `domicile-portals.conf` routes it to the keyring.
- **Requests are pushed whole.** `PortalRequests` carries every unanswered
  request on each change and on connect, as notifications do. A reloaded page
  or a second monitor's page still sees a pending dialog. The first answer
  wins; later answers are refused.
- **The engine relays request bodies untyped.** It carries each body as a
  `base::Value`; the SDK parses it with Zod. One engine change serves every
  kind, so a new portal needs no four-hour engine build. A typed mojom union
  per kind adds nothing: the compositor and SDK already validate both ends.
- **Who answers, and when.**
  - No shell page connected: the compositor refuses the request at once,
    with response `2`, as `domicile-file-chooser` does for `<webview>`.
  - A shell that ignores `domicile.portals`: the request stays pending, and
    the app waits until it gives up or the shell answers. A shell that draws
    no dialogs refuses them itself
    ([Application dialogs](SHELL-DESKTOP-EVENTS.md#application-dialogs)).
  - `<PortalDialogs />`: draws every kind it knows and refuses the rest. It is
    one element, so shell-simple gets every dialog by mounting it.
  - `Inhibit` requests are listed but need no answer.
- **Dialogs are modal over their parent.** `parent_window`
  (`wayland:<handle>`) resolves through the compositor's `xdg_foreign` export
  to an app id. The shell draws the dialog over that `<app>`. A missing or
  unknown handle puts the dialog over the focused screen.
- **Captures stack over other dialogs.** `<PortalDialogs />` shows the oldest
  dialog, and a screenshot, color pick or screen cast over it, so the user can
  capture that dialog. Anything asked after the capture waits for it.
- **File filters become extensions.** The picker matches extensions, so the
  compositor turns each glob (`*.[pP][nN][gG]` is `png`) and MIME type (through
  shared-mime-info's `globs2`) into a list. A filter with no extension, such as
  `Makefile`, is left out. The shell answers with paths and a filter index; the
  compositor answers the portal with `file://` URIs and the original filter.
- **Dialogs name the app.** The frontend's `app_id`, and a ScreenCast
  window's Wayland `app_id`, resolve in the shell through
  `@domicile-desktop/system-apps` to a name and icon ("Zoom wants to share
  your screen"). An id with no entry of its own matches the first entry whose
  id, `StartupWMClass` or `Name` is the id or its last reverse-DNS part,
  ignoring case: `com.chromium.Chromium` finds `chromium-browser.desktop`.
  With no match, the last part is the name (`org.example.my-app` is "My
  app").
- **Account shows what is shared.** The compositor looks the user up before
  asking; the dialog shows the name and picture.
- **AppChooser offers the frontend's `choices`.** The shell names them from
  their desktop entries and picks `last_choice`, else the first default
  `mimeapps.list` gives the type (`domicile-mimeapps.list` first). The
  compositor checks the answer is one of the current choices. With one
  choice the dialog asks "Open <app>?", as a browser does. With none, no
  installed desktop entry lists the type in `MimeType` (for a link,
  `x-scheme-handler/<scheme>`), and the dialog says no app can open it.
- **The compositor owns PipeWire.** A window source is the client's buffer,
  which the compositor already has. A monitor source is the composited
  output, which only viz has: the engine runs a `FrameSinkVideoCapturer` on
  the display's root frame sink and sends each frame's dmabuf over the broker
  socket. Frames come in shared memory instead when the GPU cannot make
  dmabufs, as nested in a Wayland session with no render node. A capture viz
  stops fails every stream and shot on it with viz's cause, such as a first
  frame it could not allocate. One producer keeps cursor modes and restore tokens in one place.
  The producer is `src/casting/`: `Casting::start` takes a `Source` and
  reports the node. `Source::Monitor` names a `wl_output`; `Source::Region`
  is a desktop rectangle in logical pixels. The pointer is drawn where the
  engine last saw it (`desk_pointer`), so it shows over pages and windows
  alike. It is the pointer the engine draws (`desk_cursor`): a hand over a
  link is a hand in the cast. Until the engine has said, it is a built-in
  arrow. While the engine hides the pointer, no cast shows it. The image is
  resized to the source's density, never below one pixel a logical pixel,
  or a call that scales the stream down would make it a speck. A window's
  density is its buffer pixels a surface point, which `wp_viewport` makes
  fractional under `wp_fractional_scale`. As metadata,
  the cursor's meta size is a range up to 384×384, as Mutter's is: a
  consumer makes room for its own largest cursor (WebRTC asks for 64×64),
  and PipeWire drops a meta whose sizes do not meet. A pointer larger than
  the room is shrunk into it.
  - `Source::BrowserWindow` is a browser window's page alone, by the
    engine's window id: the engine captures its frame sink
    (`CaptureBrowserWindow`), as a browser window screenshot does. The
    capture keeps the page drawing while the shell hides it, so a hidden
    tab still streams. The stream is the page's size. Its pointer is where the engine puts it
    over the page, as a fraction of it (`desk_pointer`'s `windows`).
  - The compositor does not list browser windows. The dialog says
    `browser_windows` when windows may be picked, and the shell offers
    `DomicileHost.browserWindows`. A pick of a closed window fails to start.
  - Restore tokens keep a browser window only while the compositor runs
    (persist mode 1): engine ids do not survive a restart.
  - The picker is laid out as the screenshot picker is (`SourcePicker`): screens
    and windows in a list beside a desk shot taken as it opens (`desk`, a
    `FrozenDesk`), which outlines each pick. Several picks are checkboxes.
    Without a shot it says there is no preview. A window not on screen is
    drawn alone instead (`previewWindow`), and a part of it may be dragged
    over it: the pick's `area`, in the pixels of the frame the preview drew.
    The stream is that part of the window's frame alone, kept inside the
    frame if the window shrinks. A restore token keeps a part only while
    the compositor runs (persist mode 1), so a page's capture restores it.
  - When the application may have a region, the list starts with
    "Everything", the whole desk as a region, picked as it opens.
- **Input uses EIS.** RemoteDesktop and InputCapture hand out a libei socket
  (`ConnectToEIS`) served by the compositor (`reis`). Emulated input takes the
  engine's input injection path, so the lock screen still blocks it.
  - A point lands on the window under it by the page's last window bounds;
    overlaps go to the focused window, then the smallest. A point over the
    shell reaches nothing: only the engine can deliver to the page.
  - An emulated touch is the left button, one finger at a time: it takes
    the engine's pointer injection path, not the touchscreen's.
  - On a headless desk, emulated input goes to the engine instead, which
    hands it to the shell's window as a real hand's, so it reaches the shell
    and its lock screen. See
    [A-HEADLESS-DESKTOP.md](architecture/A-HEADLESS-DESKTOP.md).
  - The legacy `NotifyPointerMotionAbsolute` and `NotifyTouch*` take a
    ScreenCast stream's coordinates. A session that shares no screen has no
    stream, so they are refused; EIS's absolute pointer covers the displays.
  - InputCapture sees only what the engine forwards: keys, and pointer events
    over a window. So the pointer reaches a barrier only over a window, and
    captured motion is the change between reported points, which stops at
    the screen's edge. Relative motion past the edge needs an engine change.
    No touchscreen capture.
  - A Clipboard paste hands the application the pasting client's pipe, so the
    data never passes through the compositor.
- **Grants live in the frontend's `PermissionStore`.** Domicile stores only
  ScreenCast and RemoteDesktop restore tokens and the global shortcut choices,
  under `$XDG_STATE_HOME/domicile/`.
- **Global shortcuts are the shell's grabs.** Only the engine sees keys, so the
  compositor lists each bound chord in the `PortalRequests` push
  (`shortcuts`); `<PortalDialogs />` grabs it with `keyboard.grab` and answers
  `pressed` under its id on `shortcut`, and `released` on `shortcutrelease`.
  It gives a chord back with `keyboard.ungrab` once no app holds it.
  The compositor signals `Activated` and `Deactivated` for them. A locked desk
  refuses both answers, and locking signals `Deactivated` once for each
  shortcut still held.
  - The review dialog spells each chord as `bindKeys` does and flags one the
    shell or another app holds.
  - Choices are kept per app id in `global-shortcuts.json`. A `BindShortcuts`
    whose every id has a choice binds without a dialog.
  - **Decline** clears every chord, so the app is not asked again; it can
    still ask with `ConfigureShortcuts`. Dismissing the dialog keeps no
    choice.
  - A chord is released when its key or one of its modifiers comes up,
    wherever the keyboard is. The page pairs each release with its press
    (`components/domicile/common/held_chords.h`). A key that comes up in a
    `<webview>` reaches the page through `ShortcutRegistry::Release`.
- **Multi-monitor regions use the highest density.** A stream has one scale,
  so a region spanning monitors is captured at the highest density it
  touches. Lower-density monitors lose nothing.
- **A screenshot freezes the desk first.** Each `Screenshot` and `PickColor`
  takes one frame of every monitor from the display captures, composed at the
  highest density (`Casting::shoot`). The picker and the color picker draw that
  frame, so they never capture themselves; the shell answers an area or a
  pixel in frame pixels. Saved as a PNG under
  `$XDG_PICTURES_DIR/Screenshots/`.
  - **Copy, or Ctrl+C, in the picker copies the pick** (desk, screen,
    window or area) to the clipboard as a PNG and closes it (`copy` on the answer). It
    becomes a clipboard history row. An application that asked still gets
    its file; the shell's own screenshot is not saved
    (`SystemReply::Copied`).
  - **The shell's own screenshot asked again while its picker is up**, such
    as a second Print, gets that picker's answer. It shows no second picker.
  - The picker lists "Everything" (the whole desk), then screens, then
    windows, beside the frozen desk. The desk outlines the pick with its
    size; arrow keys move through the list. "Select on screen" selects an
    area over the frozen desk drawn full size, as the screen cast picker's
    does over the live page, and copies (Copy, or Ctrl+C) or saves it from
    there. A screen is named by its make and model, a window by
    its title over its application's desktop entry.
  - A window is answered `screenshot_window` and saved from the last frame
    it showed, which the engine still holds. What is over it, such as a
    notification, is left out, and so is the shell's title bar or tab. This
    covers windows the shell does not show (a hidden tab, another
    workspace).
  - A window or browser window the shell does not show is drawn alone in
    place of the desk when picked: the `preview_window` system call draws
    it as the screenshot would save it. A part dragged over it is the
    answer's `area`, in that frame's pixels, and only that part is saved.
  - The picker outlines a shown window on the frozen desk by its box. The
    shell passes its boxes as `shownWindows`; without them the picker reads
    the page's `<app>` and `<webview window>` boxes. A box is placed with
    the frozen desk's `desk` rectangle: the page's CSS pixels are the desk's
    logical pixels.
  - A browser window is answered `screenshot_browser_window` by its
    browser window id. The engine captures its page's own frame sink
    (`CaptureBrowserWindow`) and the compositor saves the first frame. The
    shot is the page alone: no address bar, title bar or anything over it.
    One not on screen, such as a tab behind another, is offered too: the
    capture keeps its page drawing.
  - An Electron app's window is shot with the views it holds and shows
    (`WebContentsView`, such as Claude's whole chat), each captured on its
    own and drawn over the page where the app placed it, bottom first. The
    engine lists each window's views with their places to the compositor
    (`viewed_browser_windows`). A failed view capture fails the shot. A
    screen cast of the window draws them the same way, and follows the app
    as it adds, moves and drops views; a view that closes leaves the cast,
    and one whose capture fails ends it.
  - The frontend checks the `PermissionStore` for a non-interactive
    screenshot (`permission_store_checked`). Without that, the backend asks
    through an `Access` dialog once per app and keeps the answer in the same
    `screenshot` table.
  - The shell takes its own through the `screenshot` system call
    (`portals::screenshot::for_the_shell`): an interactive screenshot asked as
    `SHELL_APP_ID`, which the dialog draws without an asker. Given a file,
    it writes the whole desk there without a dialog. `domicile screenshot`
    sends either, with the file it was given or none.
- **No print preview.** The portal sends the document only after the dialog
  closes, so there is nothing to preview. Gtk's backend has none either.
- **Print speaks IPP itself.** `domicile_host::ipp` encodes the few message
  shapes CUPS needs, rather than adding the `ipp` crate and its HTTP stack. A
  token's choice lives in memory until `Print` takes it.
- **Save to PDF is a destination.** The dialog lists it after CUPS's
  printers, and alone when there are none. The shell's file picker chooses
  the file. GTK's settings say "Print to File" with that `output-uri`, and
  `Print` writes the application's own PDF there. A document that is not a
  PDF ends with `2`.
- **Browser windows print through the portal.** The engine's print dialog is
  Chromium's `PrintDialogLinuxPortal`, so `view.print()` and a page's
  `window.print()` reach this backend as any application's print does. Print
  Preview is off: it is a `chrome://` page.
- **Browser windows capture through the portal.** A page's
  `getDisplayMedia()` opens a ScreenCast session from the engine, as any
  application does, through webrtc's PipeWire capturer. The page gets the
  same picker and indicator. The engine asks before it answers the page, so a
  cancel rejects `getDisplayMedia()`; the capture then restores the pick from
  the picker session's restore token (`persist_mode` 1). The engine then
  asks the compositor's `org.domicile.ScreenCast.Pick(node)`, on this
  backend's bus name and path, what the picker stream's node shows: its
  source type, the browser window, and its sound node. The page's
  `displaySurface` is the source's, and asking for audio gets the sound
  node. A browser window is captured as a tab instead, with the tab's sound,
  `cropTo()` and capture handle. See
  [SHELL-BROWSER-WINDOWS.md](SHELL-BROWSER-WINDOWS.md#permissions).
- **A cast carries its source's sound.** A window's cast holds a PipeWire
  `Audio/Source/Virtual` node, `domicile-sound-window-<stream id>`, into
  which the compositor links the audio streams of the window's client
  process and its children (by each stream's PipeWire client's
  `application.process.id`, else its socket peer). A monitor's or region's
  cast holds `domicile-sound-desk`, which links every app's. Apps keep
  playing where they were. A node outlives its last cast and consumer by 5
  s, so a page capture that restores its pick in a new session finds it.
  The ScreenCast interface has no audio, so only the engine reads the node,
  by the name `Pick` gives, through PipeWire's PulseAudio server. An app in its own PID namespace, as Flatpak's are, may report a
  pid the compositor does not know, and is then not heard. The code is
  `src/casting/audio.rs`.
- **The shell shows active sharing.** `portal_requests` carries `capturing`:
  each running session (id, app, what it holds). A screen cast names its
  sources for people: a window with its app id, a monitor with its make and
  model, and a region as the monitor it covers exactly, as `desk` when it
  covers every monitor, else with the monitor it is mostly on. The shell
  stops one by answering its id with `stop`. `<PortalDialogs />` draws the indicator;
  `omitScreenCasts` leaves screen casts to a shell that shows them itself, as
  manganese's bar does.
- **A cast to a TV answers its own request.** A ScreenCast request a cast
  started is claimed with `claimCastRequest` (`@domicile-desktop/sdk/cast`):
  extending the desk answers it with the TV's virtual monitor and shows
  nothing; otherwise the picker is titled "Cast to <TV>". See
  [CASTING-TO-TVS.md](CASTING-TO-TVS.md).
- **The wallpaper rides the same push.** `PortalRequests` carries `wallpaper`:
  the background and lock-screen pictures applications set, as paths the shell
  reads with `read_file`. The engine relays that line untyped, so no engine
  change. The compositor copies each picture to
  `$XDG_STATE_HOME/domicile/wallpaper/` and keeps the choice there, so it
  outlives the application's file and the session.
- **Background asks through Access.** The frontend puts `RequestBackground` to
  the user as an `AccessDialog`; the impl interface has no such method.
  `NotifyBackground` posts a notification ("X is running in the background")
  through the desktop's own notification server and answers `2` (allow this
  instance): the user already chose once. `GetAppState` comes from each
  window's `app_id`; an application with no window is absent, which the
  frontend reads as background.
- **Restore tokens name windows by app id and title.** Host ids do not
  survive a restart. A window whose title changed matches by app id alone.
  A monitor is named by its `wl_output` name, and a region by its rectangle
  relative to the monitor it is mostly on, so it follows that monitor.
- **Asking for monitors offers a region too.** A region is part of a
  monitor, so a `types` with `MONITOR` or `VIRTUAL` lets the user drag one.
  Browsers ask for monitors and windows, never `VIRTUAL`.
- **Asking for monitors offers windows too.** Electron apps (Slack,
  Discord) ask for `MONITOR` alone, and their own pickers have no other way
  to share a window.
- **An app's share gets one picker.** A `Start` from the same D-Bus
  connection is canceled when it comes while that connection's picker is up,
  or when it asks for windows, with no restore token, within 60 seconds of
  that connection answering a picker for monitors alone. Slack asks for
  screens, then for windows, then for both when the user clicks its own
  Share, each in a new session, and shares what the first picker gave it
  through its restore token. A `Start` canceled because the picker was up
  answers half a second after the pick's `Start`: Electron frees both of its
  capturers when either fails, and a pick answered after that crashed Slack.
- **A restore cut short carries over.** Meet restarts a page's capture as
  it starts: webrtc closes the session restoring the pick before its `Start`
  answers, and opens another with the same token. The frontend deletes a
  token when it is used and saves it again only from an answer, so this
  backend gets none for the second. A connection's next ask without a token, within 2 seconds
  of closing a session while its `Start` restored, restores the same pick.
- **A region is dragged on the desk shot or selected on screen.** As in the
  screenshot picker, the user drags over the picker's desk preview, and the
  area is turned into the desktop's logical pixels, grown to whole ones.
  "Select on screen" hides the dialog and the user drags over the live page,
  whose pixels are the desktop's logical pixels (`RegionPicker`). The area
  stays, with corners to resize it and a drag inside to move it, until the
  user shares it, goes back (Back or Escape) or cancels.

- **The frontend installs launchers.** `Install`, `Uninstall`,
  `LaunchDesktopFile`, `GetDesktopEntry` and `GetIcon` are frontend methods:
  it writes the `.desktop` file and icon under
  `$XDG_DATA_HOME/xdg-desktop-portal/` and links them into `applications/`
  and `icons/`, where the shell's desktop entries (`system-apps`) find them.
  The backend only confirms (`PrepareInstall`).
- **No install tokens.** `RequestInstallToken` is refused for every app, so
  every launcher install shows the dialog. Domicile has no software store to
  trust; trusting an app id would let any app claiming it skip the user.
- **USB is granted whole.** The dialog allows every device asked for or none.
  The spec allows a subset, but an app asks for the devices it needs.

## Screen recording

The shell records the screen itself, not through a portal. `domicile
screen-record`, the Screen Record launcher entry and the SDK's
`desktop().capture.screenRecord()` all send the `screen_record` system call
(`portals::recording::for_the_shell`).

- **The picker is the screen cast one.** Asked as `SHELL_APP_ID` for one
  source of any kind: a screen, a window, a browser window or a region. The
  dialog then says "Record your screen" and names nobody.
- **The compositor casts it and `domicile-recorder` encodes it.** The pick is
  cast with the pointer drawn in, as any screen cast is. The recorder, beside
  the compositor, is a GStreamer pipeline: the cast's PipeWire node, and its
  sound node (`domicile-sound-desk`, or the window's), to video and Opus in a
  WebM under `$XDG_VIDEOS_DIR/Screen recordings/`, named for when it started.
  It takes `pause`, `resume` and `stop` on stdin.
- **The GPU encodes the video when it can.** The recorder takes the first
  VA-API encoder GStreamer has: AV1, then VP9. Without one, the CPU encodes
  VP8, which falls behind on a stream near 4K (about 15 frames a second on a
  laptop).
- **A screen or region is recorded at most 4K's pixels.** A whole desk of
  high-density monitors is past what even the GPU path keeps up with, so a
  bigger stream is scaled down on the GPU (`Casting::start_at_most`).
- **It is listed while it runs.** A `recording` capturing session carries its
  sources, its file, and its time: `recorded_ms`, and `running_since_ms` unless
  paused. The shell answers it `pause`, `resume`, `stop` or `discard`. A pause
  leaves no gap in the file. Discard deletes the file and the call fails
  `Canceled`. A source that goes, such as a closed window, ends the recording
  and keeps what was recorded.
- **The toolbar is left out of the recording.** `<PortalDialogs />` draws a
  floating toolbar for it: the time, pause or resume, stop and discard. It
  calls the SDK's `hideFromCaptures`, which makes it an Element Capture
  `RestrictionTarget`. The engine gives every restriction target of the
  shell's one id, and viz draws every capture of the desk without what has it
  (`components/viz/service/display/domicile`, patch `0143`). It shows on screen
  and in no recording, screen cast or screenshot.

## Agents

An agent connected through `domicile mcp` asks to see and use the desk with an
`agent` dialog, and is listed as an `agent` capturing session while it's in.
No portal asks: the `agent` system call puts it in the same queue. The answer
can ask to remember the agent, with the whole desk only. `PortalAnswer::Change`
on its session puts the dialog up again, with `current` set to what it reaches
now. See [AGENTS.md](AGENTS.md).

## Interfaces

| Interface | Compositor | Shell UI |
|---|---|---|
| Settings | `org.freedesktop.appearance` `color-scheme`, `accent-color`, `contrast`, `reduced-motion` from shell config; `org.gnome.desktop.interface` `color-scheme` (`prefer-dark`/`prefer-light`), `enable-animations` (the inverse of `reduced_motion`), and `icon-theme`, `cursor-theme`, `cursor-size`, `font-name`, `monospace-font-name` when the matching `theme` key is set; a per-mode `cursor-theme` follows the color scheme | — |
| FileChooser | `OpenFile`, `SaveFile`, `SaveFiles`; filters, `current_folder`, `choices` | picker (component-library's `FilePicker`) |
| AppChooser | candidates from desktop entries and `mimeapps.list`; `UpdateChoices` | app list |
| OpenURI | (frontend) | via AppChooser |
| Access | `grant_label`, `deny_label`; Domicile's own `destructive` makes the yes a danger button | yes/no prompt with the app's name; none for Domicile's own questions |
| Account | user name, avatar from `AccountsService`, else passwd | confirm; allowed with the `access` answer |
| Email | hands the `mailto:` link to the shell when it claims `mailto` ([Links](WRITING-A-SHELL.md#links)), else opens the handler from `mimeapps.list`, with the fields; attachments as `attach=`, which Thunderbird ignores | — |
| Notification | v2, direct to `domicile_host::notifications` | existing drawer |
| Inhibit | idle inhibit through `idle.rs`; logout/suspend inhibitors listed as `inhibit` requests; `QueryEndResponse` on session end (the desk has no session end yet, so no query-end is sent) | "X is preventing logout" |
| Lockdown | properties from the config's `lockdown`; signaled on reload | — |
| ScreenCast | windows, browser windows, monitors, region; cursor embedded/metadata/hidden; PipeWire streams; restore tokens | source picker, sharing indicator |
| Screenshot | one frame from the same sources, PNG to `$XDG_PICTURES_DIR`; `PickColor` | region picker, color picker |
| RemoteDesktop | EIS socket; legacy `Notify*` methods use the same path | device grant |
| Clipboard | selection to/from a RemoteDesktop session through `clipboard.rs` | part of that grant |
| InputCapture | pointer barriers at screen edges; EIS | grant |
| GlobalShortcuts | binds into the shell's keymap; `Activated`/`Deactivated` | review and rebind |
| Background | autostart entries (`EnableAutostart`); `GetAppState` from windows and focus; `NotifyBackground` as a notification | via Access |
| Wallpaper | copies the picture; `set-on` background, lock screen or both | preview dialog, shell wallpaper and lock screen |
| DynamicLauncher | `PrepareInstall` asks; no install tokens; `SupportedLauncherTypes` application and web app | install confirm, name editable |
| Usb | names each device from its udev properties, else udev's database | device grant, all or none |
| Print | printers and options from CUPS over IPP (`domicile_host::cups`, its own IPP codec); GTK `settings`/`page-setup` round-trip; `Print-Job` with the token's choice; Save to PDF writes the application's PDF to the file picked | printer or PDF, paper, copies, pages, sides, color, orientation, quality |
| Secret | keyring, not Domicile | — |

Outside the portal, the compositor serves `ext-data-control-v1`, so clipboard
managers and `wl-paste` work without a focused window.

## Sandboxed clients

The compositor serves `wp_security_context_v1`. A sandbox engine (Flatpak,
or an integrator's container launcher) opens a listener with it, and every
client that connects through that listener is sandboxed.

- **Hidden from sandboxed clients:** `ext-data-control-v1`,
  `zwlr_data_control_v1`, `ext-image-copy-capture-v1`,
  `ext-image-capture-source-v1`, `zwlr_screencopy_manager_v1` and
  `wp_security_context_manager_v1` (the protocol forbids nesting).
- **Kept:** `wl_data_device`, the clipboard while focused, and the portals,
  which ask the shell.
- **Unsandboxed clients** see every global.
- **The shell** reads each window's sandbox from `DomicileWindow`
  ([WRITING-A-SHELL.md](WRITING-A-SHELL.md#windows)). The engine, app id and
  instance id are claims by whichever client created the context, and any
  unsandboxed client can create one. Verify them with the window's `pid`,
  `uid` and `gid` before a security decision.
- New privileged globals filter on `sees_privileged_globals` in
  `packages/domicile-compositor/src/clients.rs`.

## Wayland capture

The compositor also serves `ext-image-copy-capture-v1` (with
`ext-image-capture-source-v1` output and toplevel sources),
`ext-foreign-toplevel-list-v1` and `zwlr_screencopy_manager_v1` v3, so `grim`
and `wf-recorder` work. The code is `src/screencopy/`.

- **Each session is a cast** of its monitor or window
  (`Casting::start_for_client`), at the monitor's density or the window's
  buffer size. The cast fills the client's buffers as it fills
  PipeWire's, and its display capture runs until the session ends.
  `src/screencopy/taking.rs` lends a frame's buffer to the cast.
- **The toplevel list** names each Wayland window and each browser window,
  in that order of arrival. The engine reports the browser's windows on
  connect and whenever one opens, closes or changes its title
  (`browser_windows` in `domicile_engine.h`), and they leave the list when
  the browser goes away. A browser window's handle has the page's title, and
  an app window's has its app id; any other browser window has no app id,
  since they are all the browser's. Capturing one shows its page alone, as
  the ScreenCast portal's browser window source does, without the shell's
  frame around it. With `paint_cursors` the pointer is drawn where it is
  over the page, and nowhere while it is off it. The shell reads each
  handle's identifier as `toplevelId`, so it can name a window to a capture
  tool.
- **A frame is ready once there is damage the client has not seen.** The
  first frame is damaged whole. Damage is reported in buffer pixels.
- **Buffers** are shm `xrgb8888` or `argb8888` with packed rows, or a dmabuf
  of either on the render node, with a modifier the renderer draws to. The
  cast draws a dmabuf on the GPU and an shm frame into a copy, which is
  copied into the client's buffer when ready.
- **The pointer** is drawn into the frame when the session asks for
  `paint_cursors`, or the wlr frame for `overlay_cursor`.
- **wlr frames** have no session. A client's frames of one monitor, region
  and pointer choice share one cast, which stops once the client has copied
  nothing for two seconds. `copy` fills the buffer at once;
  `copy_with_damage` waits for damage. A wlr region is cut at the monitor's
  edges. A wlr client may bring a dmabuf of any modifier.
- **A resized monitor** gets new constraints, and the frame being captured
  fails with `buffer_constraints`. An unplugged one stops its sessions.
- **No asking and no lock check.** Any unsandboxed client may capture, as it
  may use data control; a sandboxed one is offered neither
  ([Sandboxed clients](#sandboxed-clients)). The portal refuses no capture
  while locked either: a
  running cast or a granted screenshot shows the lock screen.
- **Cursor sessions** follow the pointer casts draw
  (`Streams::pointer_over`): `position` is the hotspot in the source's
  pixels, and the capture session copies the engine's pointer image at the
  source's density, as shm `argb8888`. A frame waits for an image it has not
  had. Until the pointer first enters, no buffer size is sent.
