# Gestures

Touchpad gestures and touchscreen fingers reach the window under them, and
the shell binds multi-finger gestures and swipes in from a screen's edge the
way it binds keys. Tracks
[#1908](https://github.com/cprussin/domicile/issues/1908).

## Design

```
libinput (engine, tty)  ─┐
host zwp_pointer_gestures ┴▶ engine ──▶ shell page ──▶ <app> ──▶ compositor ──▶ client
(engine, nested)             (ui::GestureEvent       (default    (pointer_pinch,  (zwp_pointer_
                              + NativePinch)          handling)   pointer_axis)    gestures_v1)
                                     │
                                     ├─▶ DomicileHost `gesture` ──▶ bindKeys
                                     │   (3+ fingers, grabbed)
                                     └─▶ compositor ──▶ client under the pointer
                                         (3+ finger swipe or hold, not grabbed:
                                          pointer_swipe, pointer_hold)
```

| Piece | Where | Does |
|---|---|---|
| Acquisition | engine `libinput_event_converter.cc`, `wayland_zwp_pointer_gestures.cc` (patch `0184`) | Turns libinput or host pinch into a `ui::GestureEvent` carrying `NativePinch`: phase, device, time, fingers, absolute scale, rotation, cancellation |
| Page | engine `touchpad_pinch_event_queue.cc`, `mouse_wheel_event_manager.cc` | Keeps native pinches out of coalescing and page zoom. A canceled `wheel` claims the gesture for the shell |
| Page zoom | engine `cross_process_frame_connector.cc`, `render_widget_host_view_aura.cc` (patch `0197`) | A pinch a `<webview>`'s page leaves alone magnifies that page, unless the page is a PDF: its viewer zooms by re-rendering, and a page scale would pixelate it. The desk never takes a plain pinch |
| Desk zoom | engine `render_widget_host_input_event_router.cc`, `event_factory_evdev.cc`, `wayland_event_source.cc` (patch `0197`) | A pinch begun with Meta held, or Meta+scroll, goes straight to the desk's page scale: no hit test and no synthetic ctrl+wheel, so no page or `<app>` sees it |
| `<app>` | `html_app_element.cc` | Forwards the pinch to its client as `pointer_pinch` |
| Wire | `domicile_protocol::pinch::Pinch` | `begin`, `update`, `end` |
| Delivery | `domicile-compositor` (`pinch.rs`) | One active pinch, owned by the connection and device that began it. Ends canceled on pointer leave, lock, window close or a dropped connection |
| Shell grab | engine `native_gesture_sink.*` (patch `0185`), `desk_gestures.*`, `DomicileHost.grabGesture` | libinput (or the host, nested) offers each gesture of three fingers or more to the sink before the pinch path. `DeskGestures` takes it when a page grabbed its kind and count, and sends every phase to the first such page as a `gesture` event. A swipe or hold nobody grabbed goes to the next row; a pinch goes on to the page |
| Unbound swipes and holds | `desk_gestures.*`, `control_channel.cc`, `domicile_protocol::swipe`, `domicile-compositor` (`swipe.rs`) | The first page's channel sends a swipe or hold of three fingers or more that nobody grabbed as `pointer_swipe` or `pointer_hold`, naming no window. The compositor gives it to the window under the pointer when it begins, if any. One at a time, owned by the connection that began it; ends canceled as a pinch does |
| Bindings | `@domicile-desktop/sdk/gesture-binding`, `bind-keys` | Parses sway's grammar, grabs each kind and count, follows the phases, and runs the binding the finished gesture fits in the current mode |

### Touchscreen

```
evdev (engine, tty)    ─┐
host wl_touch (nested) ─┴▶ engine ──▶ shell page ──▶ <app> ──▶ compositor ──▶ client
                                     (pointer events,  (default    (`touch`)     (wl_touch, or
                                      touch-action:     handling)                 the pointer)
                                      none on <app>)
```

| Piece | Where | Does |
|---|---|---|
| Acquisition | engine `TouchEventConverterEvdev`, bound to a display by patch `0122`; Ozone's `wl_touch` when nested | Upstream's touch path, unchanged |
| Page | `html.css` (patch `0186`) | `touch-action: none` on `<app>`, so a finger on a window is never the page's pan or zoom |
| `<app>` | `html_app_element.cc` | Forwards each touch pointer event as a touch point in the client's coordinates. The first finger also focuses the window, as a click does. Points end canceled when the element leaves the page or changes window |
| Wire | `domicile_protocol::touch::Touch` | `down`, `motion`, `up`, `cancel` |
| Delivery | `domicile-compositor` (`touch.rs`) | The seat always has `wl_touch`. One window's points at a time, owned by the connection that began them. A client that bound `wl_touch` gets touch points; one that did not gets the first finger as the pointer and its left button, as Weston and Mutter do. Ends canceled on window close, lock, input capture or a dropped connection |

- **Whether a client reads touch is fixed at the first finger.** A client
  that binds `wl_touch` mid-sequence is not sent an up it had no down for.
- **Smithay sends `cancel` only to points with an event since the last
  frame,** so the compositor first resends each point where it is.

### Edge swipes

One touchscreen finger in from a display's edge, which the shell binds as it
binds touchpad gestures. A tty only: nested, the host's edges are the host's.

```
evdev ──▶ EventFactoryEvdev ──▶ TouchEdgeSwipes ──▶ EdgeSwipe ──┬─▶ DeskGestures `gesture` ──▶ bindKeys
          (UI thread)           (per device:        (decides)    │   (taken: the page never has it)
                                 withholds, replays)             └─▶ DispatchTouchEventNow ──▶ page
                                                                     (withheld touches first, as they came)
```

| Piece | Where | Does |
|---|---|---|
| Hook | engine `event_factory_evdev.cc` (patch `0188`) | Hands each touch to `TouchEdgeSwipes` before dispatching it |
| Withholding | `ui/events/ozone/evdev/domicile/touch_edge_swipes.*` | Per touchscreen bound to a display: the display's rect (the device's corners through its touch transform), the withheld touches, and a 250 ms timer |
| Recognizing | `ui/events/domicile/edge_swipe.*` | A finger landing within 3% of an edge the shell grabbed is withheld; in a corner, the nearer edge the shell grabbed. 6% in, mostly away from the edge: the shell's, begin to end, in display pixels. Along the edge, back out, a tap, a second finger or 250 ms: released to the page |
| Grab | `DomicileHost.grabGesture("edge:left")` | Per side, so a finger at an edge nobody binds is never withheld |

- **The engine decides, not the compositor.** Touches reach the page before
  the compositor ever sees them, so withholding has to happen where they are
  read.
- **Edges are the display's, after its touch transform,** so a turned
  display's left is still its left.
- **A finger the shell did not take is replayed whole.** The page sees the
  same press and moves it would have, only late, so a scroll that starts at
  the edge still scrolls.
- **One gesture at a time.** `DeskGestures` follows one owner, so an edge
  swipe during a touchpad gesture cuts in on it.

Two-finger scrolling already reaches clients as finger `wl_pointer.axis` with
axis stops (patch `0174`), which is what Chrome's history swipe reads.

## Bindings

`<kind>[:<fingers>][:<direction>[+<direction>…]]`, as sway's `bindgesture`:

- `kind`: `swipe`, `pinch` or `hold`.
- `fingers`: three or more. Left out, any count of three or more.
- Directions: a swipe goes `up`, `down`, `left` or `right`; a pinch goes
  `inward` or `outward`, and `clockwise` or `counterclockwise`. A hold has
  none. Left out, any way.

An edge swipe is `edge[:<side>]`: one touchscreen finger in from `left`,
`right`, `top` or `bottom`, or from any side for `edge`. It always comes in,
so it has no direction.

A binding runs once its gesture ends without being canceled. A swipe went its
larger axis's way, and also its smaller one's when that moved at least half as
far, so `swipe:3:up+left` is a diagonal. A pinch went by its last scale and its
summed rotation. Of the bindings a gesture fits, one with a count or a side
wins over one without, then more directions over fewer.

Manganese binds `swipe:3:<way>` to `focus <way>`, pointing where focus goes,
as Meta+H/J/K/L do. Four fingers move things: `swipe:4:left` and
`swipe:4:right` are `workspace next_on_output` and `prev_on_output`, the
workspace following the fingers, as do `edge:right` and `edge:left`, and
`swipe:4:down` and `swipe:4:up` are `layer down` and `layer up`: the
scratchpad hangs above the desk and the overview sits under it, so up puts the
scratchpad away or else opens the overview, and down closes the overview or
else pulls the scratchpad down. `pinch:4:inward` opens the overview and `pinch:4:outward`
closes it, zooming out to the workspaces and back in. `pinch:3:outward`, three
fingers spreading, toggles the launcher.

## Key decisions

- **Two fingers go to the page, three or more to the shell.** Pinch zoom and
  history swipes belong to the window; workspace and overview gestures belong
  to the shell. Meta+pinch is the shell's, below.
- **Phases, not end-only.** Bindings match on direction once committed, and
  shell animations follow the fingers.
- **Pinch works as on a Mac** (user, 2026-11-09). A pinch magnifies the page
  under the pointer, as Chrome does in a tab, without reflowing it; Ctrl+Plus
  and Ctrl+Minus still change the zoom level. A native app gets its pinch.
  Meta+pinch or Meta+scroll magnifies the whole desk around the pointer, like
  macOS's Control+scroll. The desk never takes a plain pinch, so a pinch does
  one thing over each window.
- **libinput recognizes; the engine keeps its numbers.** No thresholds of our
  own and no new settings.
- **Grabs name a kind and count, not a direction.** The engine has to take a
  gesture at its begin, before it has gone anywhere.
- **The first page to grab a gesture gets all of it,** begin to end, as
  `DeskGestures` decides at the begin.
- **What the shell leaves, the apps get.** A swipe or hold the shell did not
  grab goes to the window under the pointer, so in Manganese, which binds
  swipes of three and four fingers, a five-finger swipe or any hold reaches
  the app. The browser recognizes these, not a page, so the compositor picks
  the window from where the pointer is. A browser window under the pointer
  gets nothing: Chrome has no use for them.
- **A shortcuts inhibitor passes gesture bindings through,** as it does keys.
  While the window with the keyboard holds one, each page tells
  `DeskGestures` (`KeyboardWindowInhibitsShortcuts`), and its grabs take
  nothing. A bound swipe or hold then goes the unbound way, to the window
  under the pointer; a bound pinch goes to the page under the pointer and an
  edge swipe to nobody, since neither is forwarded. The owner is picked at
  the begin, so an inhibitor taken or let go mid-gesture changes nothing until
  it ends.

## Plan

- [x] Touchpad pinch to native windows, on the tty and nested.
- [x] A tty VM test with a uinput touchpad (`touchpad-gestures-on-a-tty`).
- [x] Gesture bindings in `bindKeys`, sharing its modes; Manganese
  defaults.
- [x] Touchscreen: always advertise `wl_touch`; pointer fallback for clients
  without touch. Acquired through upstream's evdev touch path, which already
  reaches the page, not libinput.
- [x] A tty VM test with a uinput touchscreen (`touchscreen-on-a-tty`).
- [x] Edge swipes, recognized in the engine with withheld touches replayed
  (`EdgeSwipeTest`, `touchscreen-on-a-tty`). No touchpad hot corners.
- [x] Bind the host's swipes when nested, subject to what the host consumes.
- [x] Unbound swipes and holds of three fingers or more to the native window
  under the pointer (`DeskGesturesTest`, `domicile-compositor` `input`
  tests). One- and two-finger holds stay with the engine.
