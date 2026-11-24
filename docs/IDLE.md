# Idle blanking

The compositor turns the screens off after `idle.blank_after_seconds` without
input, and locks the desktop after `idle.lock_after_seconds`
([LOCK.md](LOCK.md)). What a shell does with this:
[SHELL-IDLE-AND-LOCK.md](SHELL-IDLE-AND-LOCK.md#idle).

## Two clocks

- Both timeouts count from the same last input, and the same inhibitors hold
  both off. Either may be the shorter.
- Blanking does not lock. Without `lock_after_seconds` the desktop locks only
  when the shell calls `lock()`, before the machine sleeps, or when logind
  locks the session ([LOCK.md](LOCK.md#sleep-and-logind)).
- `Idle::lock_due` reports the lock edge once per spell without input. The
  timer, and any inhibitor change, checks it before a modeset, so the lock
  screen is up before a screen lights.
- Blanking waits until 1 second after the lock (`LOCK_SCREEN_DRAWS_WITHIN`),
  so the shell draws its lock screen on every monitor first. A monitor the
  page is mirrored to can show its last frame when it lights again, and that
  frame must not be the unlocked desktop.
- Releasing the last inhibitor after either timeout acts at once.
- **The engine reports all of its input** (`activity`). Only input to a
  client's window is forwarded, so without it a key typed into a browser
  window or the shell's page would not reset the clock, and the desk would
  lock under somebody typing.
- **Input is a key, a click, a scroll or a pointer that moved on the
  screen.** aura synthesizes a move under a still pointer after a window
  changes or the displays are configured, and blanking can be such a change. The
  engine forwards it with `moved: false` (Blink's `movementX/Y` are zero), so
  the client still hears it and the clock does not.

## Blanking

Blanking uses the same path as any layout change,
`domicile_displays_configure`
([DISPLAYS.md](DISPLAYS.md#which-connectors-light)).

- **Blanking sends every connector with `enabled: false`.** An empty list would
  light everything.
- **The list comes from the engine's display list** (`crate::idle::darkened`),
  not `Screens::scanout`, which omits monitors no profile names.
- **Relighting sends `Screens::scanout` again:** the profile's connectors, or
  the empty list.
- **The engine keeps the desk through a blank** (`DeskPlacesKept`). A layout
  that lights nothing leaves the shell's window and every presenter in place,
  so each monitor shows the page's current frame when it lights again.
- The engine lights a new monitor on its own, so the hotplug path also calls
  `keep_the_screens_dark`. A monitor plugged in while blanked stays off.
- `crate::idle` holds the clock and is unit-tested. The compositor sends a
  configure only when the answer changes. Otherwise a blanked desktop would
  modeset every tick.

### Telling the shell

`HostMessage::Idle` says whether anyone is at the desktop. It is sent on both
edges, before the modeset.

- It carries the state, not the edge, and a page that says hello gets the
  current state. A reloaded page has missed every earlier edge.
- The idle message arrives with the blanking, not before the timeout.
- A desktop with no timeout sends neither.

### The shell's idle watches

A page watches for the desk going idle at a time it chose, so a shell can
pause media at two minutes and dim before the screens blank.

- **A watch is a system call stream**, `SystemRequest::IdleAfter { seconds }`
  or `SystemRequest::IdleBeforeBlanking { seconds }`
  ([SHELL-SYSTEM-ACCESS.md](SHELL-SYSTEM-ACCESS.md#wire)). Each
  `SystemEvent::Idle { idle }` is an edge: `true` at the time, `false` on the
  next input.
- **Same clock and inhibitors as blanking.** An inhibitor holds every watch;
  taken while one is idle, it ends the spell, and let go after the time it
  goes idle at once.
- **The clock runs without a timeout.** `Idle` always exists, so watches work
  on a desk that never blanks or locks; `Idle::times_out` says whether the
  blank and lock timer is armed.
- **One timer for the next watch due** (`settle_the_idle_watches`). Input
  only moves watches later, so it re-arms only when it ended an idle spell; a
  timer armed before the input fires early and arms the rest.
- **A new watch wakes the clock** (`ClientRequest::IdleWatched`), so a page
  that starts watching on a desk already still that long hears `true` at once.
- `domicile_host::idle_watches` holds the watches for every connection and
  decides the edges. A watch ends with its page or `Unwatch`; the SDK starts it
  again after a compositor restart.
- A config reload restarts the clock, as it does for blanking.
- `IdleBeforeBlanking` on screens that never blank, or blank sooner, is silent.

### Idle inhibitors

`zwp_idle_inhibit_manager_v1` is advertised. An inhibitor blocks blanking. It does not reset the timer, so:

- an inhibitor taken while blanked relights the screens, with the same `ComeBack` edge
  as a keystroke;
- when the last inhibitor goes away after the timeout has passed, the screens
  blank at once.

An inhibitor holds only while its surface is a toplevel window
(`crate::idle::holds`):

| Check | Source |
|---|---|
| The client is alive | `WlSurface::is_alive`, checked after each round of client events. A crashed client sends no release |
| The surface is a mapped toplevel | The window list `new_toplevel` and `toplevel_destroyed` maintain |
| The page shows the window | `crate::held_frames`: a window on another workspace or behind a tab is hidden. The protocol lets an inhibitor go once its surface is not visible |

- An inhibitor taken before its window maps starts holding when the window
  appears.
- An inhibitor whose window closes stops holding at once.
- An inhibitor on a subsurface holds nothing.
- An inhibitor on a hidden window stops holding, and holds again when the
  window is shown. An app in the background, like a chat app animating, keeps
  nothing on.

The Inhibit portal's idle flag (`8`) blocks blanking the same way while the
application holds it. It names no surface, so it holds with no window showing
(`Idle::held_by_applications`).

The compositor also serves `org.freedesktop.ScreenSaver` (`crate::screen_saver`):

- **Browsers ask here for a screen wake lock** (a video call, a film), as do
  Firefox, mpv and VLC. Chromium asks only when no GNOME session manager owns
  its name. Browser windows in the engine are not Wayland clients, so this is
  their only way to hold.
- **A hold from a process with windows holds only while one is shown**, like a
  Wayland inhibitor. A process with no windows, like the engine, always holds.
- **A hold ends** with `UnInhibit`, or when its application leaves the bus.
- A holder is found by the application name it passed.

A shell holds one the same way: `dbusCall` to
`org.freedesktop.portal.Inhibit.Inhibit`, and `Request.Close` on the returned
handle to let go. Manganese's idle inhibitor bar item does this.

### What holds the desktop awake

- **`SystemRequest::IdleHolds` streams the holders**, as app ids. Each
  `SystemEvent::IdleHolds` carries the full list, at once and on each change.
  - **The shell names and draws each holder** by its desktop entry, through
    `useApps` (see [APP_NAMES.md](guidelines/APP_NAMES.md)).
  - A Wayland inhibitor is found by its window's app id, and listed only while
    it holds.
  - A portal inhibitor is found by its app id, or, for an unsandboxed
    application, its process name (`/proc/<pid>/comm`). A shell page's own
    hold is `domicile`, unnamed, so the shell can leave it out.
  - A screen saver hold is found by the application name it passed, and listed
    only while it holds. One from the engine's own browser process, a page in
    a browser window, is `domicile-browser`, unnamed: the shell names the site
    from `<webview>`'s `wakeLock`.
  - A desktop with no timeout lists none.
- Manganese's keep awake eye shows while anything holds, and names the
  holders and the websites.
- Each change is logged at debug, `what holds this desktop awake changed`.

### Finding what keeps a desktop awake

Input that restarts the clock after the desktop sat still for half its shortest
timeout is logged at debug, `input restarts the idle clock`, with what it was
and how long the desktop had been still. For the browser's own input,
`detail` names the event and the device, e.g. `MouseMoved from Logitech USB
Receiver`. Start the desktop with `RUST_LOG=warn,domicile_compositor=debug`.
Where the compositor logs to the journal, read both lines with:

```sh
journalctl -b --grep 'idle clock|holds this desktop'
```

- **No new protocol:** the portal already reaches `crate::idle`.
- **A reload lets go:** each page has its own D-Bus connection, which closes
  with the page, and xdg-desktop-portal closes the requests of a caller that
  leaves the bus.

### Checking it on hardware

CI has no `/dev/dri`. On hardware, look for:

```
nobody is at this desktop; its screens go dark soon
nobody is at this desktop; its screens go dark connectors=2
somebody is at this desktop again; its screens come back on
```

and, with `--vmodule=drm*=1`, `configuring N display(s)`.

## Sleeping on demand

`domicile sleep-displays`, or a shell's `displays.sleep()`, turns every
monitor off at once. `SystemRequest::SleepDisplays` carries both.

- **It is the blanking path.** `state_the_connectors` sends
  `crate::idle::darkened`, so the desk, its windows and its presenters stay
  in place.
- **Input lights the monitors**, the same input that resets the idle clock
  (`crate::idle::somebody_is_here`), as do `domicile wake-displays` and
  `displays.wake()`. A wake also lights screens idle blanking turned off.
- **Input in the first second is ignored** (`crate::display_sleep::GRACE`).
  Letting go of Enter or of the keybinding that asked must not wake them.
- **It needs no idle timeout**, and holds through idle inhibitors: somebody
  asked for it.
- **It does not tell the shell** (`HostMessage::Idle`) and does not lock.
- **A locked desktop allows both** (`Reach::Powers`).
- A monitor plugged in while asleep stays off, as while blanked.

### One monitor

`sleep-displays <name>` turns one monitor off and leaves the rest lit.

- **It sleeps through input.** Only a wake that names it, or names none,
  lights it (`crate::display_sleep::DisplaySleep::sleeping`).
- **It keeps its place.** `crate::display_sleep::asleep_in` sends it dark
  with its `desk`. The engine keeps a dark connector with a desk on the desk
  page (`DeskPlace::lit`), so its windows and workspace stay, and the shell's
  display list does not change.
- **Without a profile** the list names every monitor at its place in the
  engine's row, unscaled, as the empty list would light them. A non-empty
  list turns off any connector it leaves out.
- **Nothing is shown on it.** It gets no presenter, and the pointer does not
  cross onto it.
- **It does not host the page.** A CRTC that is off sends no BeginFrames, so
  the fastest lit monitor hosts it. Sleeping the host moves the page's window
  to that monitor, as unplugging it does, and the shell keeps running.

On hardware, with `RUST_LOG=warn,domicile_compositor=debug`, look for
`somebody asked to turn this desktop's screens` and, after input,
`somebody is at this desktop again; its screens wake`.
