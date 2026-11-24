# The screen lock

The desktop locks after `idle.lock_after_seconds` without input
([IDLE.md](IDLE.md#two-clocks)), before the machine sleeps, when logind locks
the session ([Sleep and logind](#sleep-and-logind)) or when the shell calls
`lock()`, and the user's password unlocks it. While locked, nothing the
chrome forwards reaches a client, and nothing it asks of the desktop is done.
What a shell does with this:
[SHELL-IDLE-AND-LOCK.md](SHELL-IDLE-AND-LOCK.md#locking).

## Where the lock is enforced

The compositor enforces the lock because it is the only process that outlives
the page.

- A lock in the page would fall to a reload, an engine restart or devtools.
- A lock at the chrome socket would block the shell's own keys, so nobody could
  type a passphrase.
- The page keeps all its keys while locked so it can draw the lock screen.

The compositor checks each request in `handle_client_request`, and each
connection request in `answer_on_the_connection`, against
`crate::lock::refused`. That `match` is the source of truth. It has no
wildcard, so a new request does not compile until someone decides how a locked
desktop treats it.

| Category | Examples | Effect |
|---|---|---|
| Input | `Key`, pointer motion, buttons, axis, leave; the same from EIS clients (`crate::eis`) | Dropped (`debug` log) |
| Commands | `CloseApp`, `Spawn`, `CopyClipboardEntry`, `RemoveClipboardEntry`, tray, notifications | Refused (`warn` log) |
| Reads on the connection | `SearchFiles` | Answered with nothing (`warn` log) |
| System calls | `SystemRequest`, except reads under `/sys`, lock screen readouts, listening for shell commands, unlock refusals or window requests, setting window states or the color temperature, and calls that stop something running | A call that starts something is answered `locked`; `stdin` is dropped (`warn` log) |
| Allowed | `ChromeHello`, `Lock`, `Unlock`, `KeyboardFocus`, output scale and size, window bounds and states, `ClipboardCopied`, theme | Handled normally |

Why some requests are allowed:

- `ChromeHello`: a reloaded page learns the desktop is locked from the answer.
- `SetOutputScale`, `SetOutputSize`, `SetAppBounds`, `set_window_states`,
  `set_color_temperature`: nothing replays them after unlock.
- `KeyboardFocus`: refusing it would leave the shell and the compositor disagreeing
  about focus after unlock. No key reaches the window while locked anyway: the
  engine keeps every key on the page.
- `ClipboardCopied`: it is a client's copy, and the history must match pastes.
- `SetTheme`: it opens and reads nothing.
- System reads under `/sys`: the user can change nothing there. Only an
  absolute path with no `..` counts.
- Lock screen readouts: the calls `system-battery`, `system-backlight`,
  `system-audio` and `system-bluetooth` make, so a lock screen shows the
  battery and Bluetooth and sets the brightness and volume. See
  [Lock screen readouts](#lock-screen-readouts).
- `unwatch`, `close_stdin`, `kill`: they stop what the shell started.
- `shell_commands`, `window_requests`: they only listen. A page reloaded
  while locked still hears them after unlock. `send_shell` itself is refused.
- `unlock_refusals`: it only listens, and a lock screen needs it while locked.
- `keymaps`, `select_keymap`: a lock screen shows and switches the keymap the
  passphrase is typed on. The switch reaches the windows too, which take no
  keys while locked.

## Lock screen readouts

Each call reads state or changes what a laptop's brightness and volume keys
change, so someone at a locked desktop learns or does nothing more.
`domicile_host::lock_screen_readouts` lists each one field by field; `reach`
judges a request `Reach::Readout` only on a full match.
`packages/domicile-protocol/wire/lock-screen-readouts.jsonl` records what each
library sends; the libraries' tests and the allowlist's both check it.

| Library | Call |
|---|---|
| `system-battery` | UPower `DisplayDevice` `GetAll` of `org.freedesktop.UPower.Device`; a match on its `PropertiesChanged` with every field set |
| `system-backlight` | `udevadm monitor --kernel --subsystem-match=backlight`; logind `Session.SetBrightness("backlight", device, level)` on `session/auto`; iio-sensor-proxy's `GetAll`, `ClaimLight` and a match on its `PropertiesChanged`, for automatic brightness |
| `system-audio` | `pactl -f json info`, `list` and `subscribe`; `pactl -- set-sink-volume NAME N` and `set-sink-mute NAME 0\|1` |
| `system-bluetooth` | BlueZ `GetManagedObjects` on `/`: adapters' power, connected devices and their batteries; a match on every BlueZ signal |

- D-Bus calls are on the system bus only.
- A spawn has no `cwd` or `stdin`, and exactly the library's `env`: none for
  `udevadm`, `LC_ALL=C` for `pactl`.
- `argv[0]` is looked up on the compositor's `PATH`, like every spawn. The lock
  trusts whatever `udevadm` and `pactl` that `PATH` finds.
- Left out: inputs (unmuting a microphone would let a locked desktop record),
  `parec` meters, and every other `pactl` command.
- Left out of BlueZ: power, scanning, pairing and connecting. Someone at a
  locked desktop must not pair a device.

## Ordering

- **Input counts as activity before it is refused.** `keep_the_desktop_awake`
  runs first, so a key at a locked desktop lights the screens.
- **The lock state changes before the shell is told.** `Lock` updates the state
  that `Seen` reads, under its mutex, before queuing `locked`. A search sent
  after `locked: true` is refused. One sent after `unlock` but before the
  verdict is also refused.
- **The shell is told before the modeset**, so the lock screen is up before the
  screens light.
- **The compositor releases held keys when the desktop locks** (`release_pressed_keys`).
  The refusal would drop the release and leave the key stuck down.
- **The page takes the keyboard when the desktop locks**, after `locked` is
  sent (`hand_the_keyboard_to_the_lock_screen`). Every chrome hears
  `focus_changed` with no window, so the engine stops sending keys to the
  window that had it. The shell gives it back after unlocking.
- **The engine keeps every key on the page while locked**, even if a window
  has the keyboard, and logs an error naming the window. A key sent for a
  client is dropped, so taking it from the lock screen would lose the
  passphrase. `guard-locked-keys-stay-on-the-page.sh` checks it.

## Sleep and logind

`crate::logind` listens to logind on the system bus.

- **Sleep:** the compositor holds a `delay` inhibitor on `sleep`. On
  `PrepareForSleep(true)` it locks, waits 1 second for the shell to draw its
  lock screen, then closes the inhibitor and the machine sleeps. On waking it
  takes a new one. Closing the lid sleeps the same way.
- **`loginctl lock-session`:** logind sends the session's `Lock` signal, and
  the compositor locks. `loginctl unlock-session` does nothing; only the
  passphrase unlocks.
- **No logind**, or a compositor in no session: the log says so and the
  desktop runs as usual, without that lock.

## Verifiers

`crate::lock::Verifier` checks a passphrase. On a desk it is `crate::pam`:
`pam_authenticate` for the compositor's uid, through `lock.pam_service`, or
`domicile` when unset.

The machine declares the service; a home-manager module cannot:

- **NixOS:** `nixosModules.default`, or `security.pam.services.domicile = {};`.
- **Distribution packages** install `/etc/pam.d/domicile` (`packages/distro/pam/`).
- **Anywhere else**, add `/etc/pam.d/domicile`: copy the file for your
  distribution from `packages/distro/pam/`. Each includes the distribution's password
  stack.

Without the file the desktop does not lock: locked, nothing could unlock it.
`Lock::shut` asks the verifier on every lock, so adding the file turns the
lock on with no restart. The compositor says so at startup in an urgent
notification from Domicile, "This screen won't lock", and logs each lock it
skips. See [Failures fail closed](#failures-fail-closed).

Tests inject their own verifier: unit tests pass one to `Lock::held_by`, and
`tests/running` starts the compositor with `--pam-confdir` pointing at a
`pam_exec` service of its own.

## Reloading

A reload that changes `lock.pam_service` swaps the verifier
(`Lock::rekeyed`). It never unlocks the desktop.

- **The new service** checks the next passphrase. A check already running
  against the old one cannot unlock: its `Ok(true)` is refused, but not
  counted as a wrong passphrase.
- **The wait** after refused passphrases is kept
  ([Refusals and the wait](#refusals-and-the-wait)).
- **A machine without libpam** refuses the reload and logs it. The current lock
  stays.

## Checking a passphrase

- `pam_unix` sleeps on a wrong password, so the check runs on its own thread.
  `Lock::offered` starts it; the verdict returns over a calloop channel to
  `heard_the_verdict`, which calls `Lock::answered`.
- The desktop stays locked during the check. A second `unlock` during a check is
  dropped.
- A passphrase containing NUL is refused before PAM sees it. C would read only
  the part before the NUL.
- `domicile_protocol::Passphrase` does not print itself, so no log line holds
  what was typed. Linux-PAM overwrites its copy before freeing it.
- A refusal sends `SystemEvent::UnlockRefused` to every page listening with
  `unlock_refusals`, then `locked: true` to every chrome again.

## Refusals and the wait

`crate::unlock_backoff` counts refused passphrases and makes the compositor
wait before checking the next. The shell cannot skip the wait: it never sees
the verifier.

- The first 2 refused passphrases cost nothing. The 3rd starts a 5 second
  wait, and each one after doubles it, up to 5 minutes.
- A passphrase offered during the wait is refused `too_soon`, unchecked.
- `unverifiable` counts too: some PAM stacks fail a wrong passphrase with
  something other than `PAM_AUTH_ERR`.
- Unlocking resets the count.
- The count and wait are kept in memory only. Restarting the compositor resets
  them.

| `refusal` | Meaning |
|---|---|
| `wrong_passphrase` | The verifier checked it, and it is wrong |
| `unverifiable` | The verifier could not check it (see [Failures fail closed](#failures-fail-closed)) |
| `too_soon` | Offered during the wait |

Each refusal carries `failures`, the refused passphrases since the last unlock,
and `retry_in_ms`, the wait left.

## Failures fail closed

Only `PAM_AUTH_ERR` means a wrong passphrase. Any other PAM failure is
`Unlocking::Unverifiable`: the desktop stays locked and the log names the error.

| When | Missing | Result |
|---|---|---|
| Startup or reload | `/etc/pam.d/<service>` | An error names the file and what to declare, and a notification says the screen won't lock. The desktop starts |
| Each lock | `/etc/pam.d/<service>` | The desktop stays unlocked (`warn` log). Adding the file lets the next lock happen |
| Each attempt | `/etc/pam.d/<service>` | `Unverifiable`, naming the file: it went missing after the desktop locked. Adding the file fixes the next attempt, without a restart. Linux-PAM would otherwise fall back to its `other` service |
| Startup | `libpam.so.0` or its `pam_start_confdir` | The compositor exits, naming the library |
| Startup | a user for the uid | The compositor exits |

A desktop without libpam or a user cannot lock, so it does not start.

`pam_start_confdir` gets `/etc/pam.d` explicitly, so the checked directory and
the read directory match.

## Log lines

The routine ones (the machine can sleep, a refused request, a reloaded lock)
are debug. See them with `RUST_LOG=warn,domicile_compositor=debug`.

```
nobody is at this desktop; it locks itself
nothing holds this desktop awake now; it locks itself
the machine is going to sleep, so this desktop locks
this desktop is locked; the machine can sleep
logind asked for this desktop to be locked
this desktop does not hear logind, so it does not lock before the machine sleeps
this desktop does not hear its logind session, so `loginctl lock-session` does not lock it
this desktop is locked; what the shell forwarded reaches no client
this desktop is locked; what the shell asked for is not done
checking a passphrase; the desk stays locked meanwhile
a passphrase this desktop did not take; it stays locked
a passphrase offered during the wait after refused ones; it was not checked
the passphrase opened this desktop
this desktop could not check a passphrase, so it stays locked
this desktop does not lock until the file is added
this desktop does not lock: nothing could unlock it until the machine declares its PAM service (see docs/LOCK.md)
taking up a reloaded lock
the reloaded lock cannot be used; the current one stays
```
