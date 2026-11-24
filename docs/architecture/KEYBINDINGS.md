# Keybindings

A shell passes its keybindings as props, in sway style: each chord maps to an
action. The compositor sends the keyboard layout. The engine resolves and grabs
each chord by name. The SDK grabs the shell's chords and runs the actions.

```ts
bindKeys(domicile, {
  keybindings: {
    "Meta+Return": KeyAction.Exec(["kitty"]),
    "Meta+r": KeyAction.Mode("resize"),
  },
  modes: {
    resize: {
      "Meta+l": KeyAction.SendShell(["resize", "grow", "right"]),
      "Meta+Escape": KeyAction.Mode("default"),
    },
  },
}, { commands, onCommand, onModeChanged });
```

Manganese takes the same shape as `runManganese({ keybindings })`, built with
its typed commands (`focus("right")`, `mode("resize")`). With no keybindings it
binds sway's defaults on Meta.

`domicile send-shell focus right` in a terminal on the desktop runs the same
command as a `SendShell(["focus", "right"])` binding. `Exec` is Domicile's, not
the shell's: the SDK starts the program as `domicile exec` does, and the desktop
tells the person when it does not start.

## Design

```
compositor: keymap.rs ─▶ shell_config { keys } ─▶ engine ─────────────▶ SDK bindKeys
(keysym → evdev key)                              (grabShortcut(chord): (grabs every chord,
                                                   resolves, matches,    runs `shortcut` by
                                                   `shortcut.chord`)     chord and mode)
```

| Piece | Where | Does |
|---|---|---|
| Key table | `domicile-compositor` (`keymap.rs`, `shell_config.rs`) | Maps each keysym the layout can type to the lowest key that types it |
| Wire | `HostMessage::ShellConfig { keys }`, `packages/e2e-harness/src/protocol.ts` | Sends the table on connect and when a reload changes the keyboard |
| Chords | engine `modules/domicile/domicile_chord.*`, `DomicileHost.grabShortcut` | Parses chords and resolves them against the table, again when it changes. Throws `SyntaxError` on a bad chord and `NotFoundError` on a keysym the layout cannot type. A press arrives as `shortcut` with its `chord`, its release as `shortcutrelease` |
| Modes | `@domicile-desktop/sdk/own-keybindings` | Gives each chord one spelling and files the bindings by mode |
| Dispatch | `@domicile-desktop/sdk/bind-keys` | Grabs every chord, matches `shortcut.chord` in the current mode, runs `Mode`, passes `SendShell` to `onCommand`, runs a `Hold`'s release on the `shortcutrelease` of the chord its press armed, gives the chords back on `unbind` |

**Chord syntax:** `+`-separated modifiers, then one xkb keysym name.

- Modifiers (any case): `Meta`/`Super`/`Logo`/`Mod4`, `Shift`,
  `Ctrl`/`Control`, `Alt`/`Mod1`.
- Modifiers match exactly: `Meta+l` does not fire while Shift is held.
- A modifier alone, `Meta`, is a tap of it: either side's key pressed and let
  go with nothing in between. Another key, a click, a scroll, a pinch, a touch
  or a touchpad gesture the shell takes while it is held makes it no tap, so
  `Meta+Return` and Super-dragging a window still work. So does holding it
  longer than 300 ms, as on GNOME: Super held and let go does nothing.
  `keyboard.grab("Meta", { longestTap })` sets another limit. Manganese binds
  `Meta` to the overview, as GNOME and KDE do.

**Gestures** bind in the same tables, in sway's `bindgesture` grammar:
`swipe:3:left`, `pinch:4:inward`, `hold`, and touchscreen swipes in from an
edge, `edge:left`. See
[GESTURES.md](GESTURES.md#bindings).

### Commands from a terminal

```
domicile send-shell ─▶ $DOMICILE_SOCK ─▶ supervisor ─▶ compositor ─────────────────▶ every page
                       (control socket)               (system_request send_shell)    (system_event shell_command
                                                                                       ─▶ bindKeys onCommand)
                    ◀─ sent (+ output), or why not ◀─ first page that ran it ◀─────── answer_shell_command

domicile list-shell-commands ─▶ ... ─▶ compositor (which_shell_commands): what every listening page described
domicile list-bindings       ─▶ ... ─▶ compositor (which_shell_bindings): every listening page's bindings
```

| Piece | Where | Does |
|---|---|---|
| Verb | `domicile-launch` (`cli.rs`, `control.rs`) | `send-shell <word>…`; every word after it is the command |
| Supervisor | `domicile-launch` (`compositor_socket::send_shell`) | Sends `send_shell` on the compositor's chrome socket without `hello`, as `domicile screenshot` does |
| Fan-out | `domicile_host::shell_commands`, `domicile_host::system` | Tells every page listening with `shell_commands`, numbered; answers `sent` once a page ran it, or fails with the pages' reasons, after one second unanswered, or when none listens |
| Listener | `domicile.shell.commands(help, bindings)`, `domicile.shell.answer`, `bindKeys` | `bindKeys` listens while bound, describes `commands` and its bindings, passes each command to `onCommand` and answers with its `Result`, carrying any `output` |

## Key decisions

- **Keybindings are shell props, not config.** They name the shell's
  commands, and TypeScript types them. Cost: a shell that fails to load has no
  keys. Recover with `domicile load-shell` from another VT or ssh.
- **Chords name keysyms** (`parenleft`), as in sway. The compositor owns the
  xkb keymap, so it reports which key types each keysym.
- **The compositor sends the key table; the chords stay in the page.** Data
  flows one way, so it needs no reply message. The engine reads the table, so
  a chord is resolved where its press is matched.
- **The engine matches.** The compositor never sees the press: the browser
  process matches a grabbed chord in a `<webview>` or on the page.
- **The SDK owns modes.** It reports the current mode through `onModeChanged`
  so the shell can display it. The shell never interprets keys.
- **Applications' global shortcuts are grabs too.** The GlobalShortcuts
  portal's chords use this syntax and grab path; see
  [PORTALS.md](../PORTALS.md).
- **A terminal command is a system call, not a host message.** The engine
  relays system lines whole, so the route needs no engine change. A new
  `HostMessage` would need a fork change and an engine release.
- **Every page listening hears a terminal command.** The compositor does not
  know which page the user is looking at.
- **A command nobody runs fails loudly.** One page running it is enough; a
  typo in a script or binding is an error with the shell's reason, not a
  silent no-op.
- **The shell describes its commands while it listens.** Commands are the
  shell's, so only it can list them; one listening request carries both.
- **A locked desktop refuses `send_shell` but allows `shell_commands`.** A
  page reloaded while locked still hears commands after unlock. See
  [LOCK.md](../LOCK.md).
- **Grabs are counted.** `ungrabShortcut(chord)` answers one
  `grabShortcut(chord)`; the last one gives the key back. So `bindKeys` and
  `<PortalDialogs />` can grab one chord and each let go. `bindKeys` gives
  back its chords on `unbind`.
- **Each page claims for itself.** `ShortcutRegistry` keeps a chord while any
  page claims it. A reloading page's claims stay until its successor lets go
  of that chord, so a reload leaves no gap. `domicile load-shell` to another
  shell drops the old shell's claims once its page closes.
- **A layout change moves the grab.** The old key is given back once no chord
  is on it.
- **A window's shortcuts inhibitor wins.** A client holding
  `zwp_keyboard_shortcuts_inhibitor_v1` (a VM, a remote desktop viewer) gets
  grabbed chords as keys while it has the keyboard. The compositor activates
  every inhibitor and sends `app_inhibits_shortcuts`; the engine skips the
  grab in `DomicileHost::PageKeyDown`; shells read
  `DomicileWindow.inhibitsShortcuts`. `Ctrl+Alt+F<n>` still switches consoles:
  the engine's DRM platform takes it below the page. A `<webview>` has no
  inhibitor, so chords pressed in one are always the shell's. The shell's
  bound swipes and holds go to the window too
  ([GESTURES.md](GESTURES.md)).
- **`--inhibited` keeps a chord the shell's,** as sway's `bindsym
  --inhibited`: a shell's way back to the desktop from a VM. `bindKeys` grabs
  a chord written `--inhibited Meta+Escape` with
  `keyboard.grab(chord, { whileInhibited: true })`, and the engine fires it
  while the keyboard window inhibits (`DomicileHost::StaysWhileInhibited`).
  Gestures take no flag; an inhibiting window gets them anyway.
- **A tap is heard in the browser process.** A modifier alone has no key for
  the shell to take, and a tap is only a tap once the key comes up with
  nothing in between, so the page never sees one. `grabShortcut("Meta")`
  sends `GrabModifierTap`; `DeskModifierTaps` (fed by an aura event observer,
  `StartModifierTaps`, which sees every key whoever has the keyboard) hands
  the tap to the first page that grabbed it, as `shortcut` then
  `shortcutrelease` with `keyCode` 0. It is held to the longest `longestTap`
  of the page's names for it and reports how long it was held, and the page
  fires only the names whose own `longestTap` that fits. The key itself still reaches the focused
  client. Under a shortcuts inhibitor the tap is the window's unless grabbed
  `--inhibited`, as a chord is. Nested in another compositor, the host may
  keep Super for itself, and then no tap arrives.
- **The shell switches the inhibitor.** `keyboard.switchShortcutsInhibitor`
  (`shortcuts_inhibitor` on the wire) activates, deactivates or toggles the
  keyboard window's inhibitor, as sway's `seat shortcuts_inhibitor`. The
  compositor tells the client (`active`/`inactive`) and the chromes
  (`app_inhibits_shortcuts`), so `inhibitsShortcuts` follows. A new inhibitor
  starts active; one whose window closes goes with it. Manganese's
  `shortcuts-inhibitor toggle` command calls it.
