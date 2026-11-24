//! Chrome requests that run on the Wayland thread, where the seat and surfaces
//! live, and the order the compositor handles each one in.

use std::time::Instant;

use smithay::backend::input::{Axis, AxisSource, ButtonState};
use smithay::input::pointer::{AxisFrame, MotionEvent};
use smithay::reexports::wayland_protocols::xdg::shell::server::xdg_toplevel;
use smithay::utils::SERIAL_COUNTER;
use smithay::wayland::compositor::with_states;
use smithay::wayland::shell::xdg::ToplevelSurface;
use tracing::{debug, warn};

use domicile_host::clipboard::{Contents, Removed};
use domicile_host::system::DisplayPower;
use domicile_host::theme_turnover::{Turnover, CAPTURE_WITHIN};
use domicile_host::white_point::WhitePoint;
use domicile_protocol::{
    InhibitorAction, KeymapChoice, Passphrase, PointerAxisSource, PortalAnswer, Scale, Theme,
    TrayAction, WindowState,
};

use crate::activation;
use crate::chrome_hub::announce_open_apps;
use crate::engine::{Clipboard, VirtualDisplay};
use crate::lock::Asked;
use crate::locking::say_what_the_lock_refused;
use crate::spawning::spawn_client;
use crate::surface_commit::window_geometry;
use crate::virtual_monitors::Resized;
use crate::DomicileCompositor;

/// A chrome request that must run on the Wayland thread, where the seat and
/// surfaces live.
///
/// Emulated input from [`crate::eis`] becomes these too, so it takes the same
/// path and the lock refuses it the same way.
#[derive(Debug, PartialEq)]
pub enum ClientRequest {
    /// Every chrome in `chromes` was told `theme`. Switch the windows once
    /// they have captured. See [`chrome_key`](crate::theme_turnover::chrome_key).
    TurnTheWindows {
        theme: Theme,
        chromes: Vec<usize>,
    },
    /// A chrome's old frame is held for `theme`.
    ThemeCaptured {
        chrome: usize,
        theme: Theme,
    },
    PointerMotion {
        app_id: String,
        x: f64,
        y: f64,
        /// Whether the pointer moved on the screen. See
        /// [`ChromeMessage::PointerMotion`](domicile_protocol::ChromeMessage::PointerMotion).
        moved: bool,
    },
    /// See [`ChromeMessage::PointerRelative`](domicile_protocol::ChromeMessage::PointerRelative).
    PointerRelative {
        app_id: String,
        dx: f64,
        dy: f64,
        dx_unaccel: f64,
        dy_unaccel: f64,
    },
    /// See [`ChromeMessage::PointerConstrained`](domicile_protocol::ChromeMessage::PointerConstrained).
    PointerConstrained {
        app_id: String,
        active: bool,
    },
    PointerLeave,
    PointerPinch {
        owner: usize,
        app_id: String,
        pinch: domicile_protocol::pinch::Pinch,
    },
    /// A touchpad swipe the shell did not bind; see [`crate::swipe`].
    PointerSwipe {
        owner: usize,
        swipe: domicile_protocol::swipe::Swipe,
    },
    /// A touchpad hold the shell did not bind; see [`crate::swipe`].
    PointerHold {
        owner: usize,
        hold: domicile_protocol::swipe::Hold,
    },
    /// The connection that sent a pinch, swipe or hold went away.
    GestureOwnerGone {
        owner: usize,
    },
    Touch {
        owner: usize,
        app_id: String,
        touch: domicile_protocol::touch::Touch,
    },
    TouchOwnerGone {
        owner: usize,
    },
    /// Somebody used the desk; see [`ChromeMessage::Activity`](domicile_protocol::ChromeMessage::Activity).
    Activity {
        input: Option<String>,
    },
    /// Where the pointer is on the desk; see
    /// [`ChromeMessage::DeskPointer`](domicile_protocol::ChromeMessage::DeskPointer).
    DeskPointer {
        at: Option<(f64, f64)>,
        windows: Vec<domicile_protocol::PointerOverWindow>,
    },
    /// The pointer the engine draws; see
    /// [`ChromeMessage::DeskCursor`](domicile_protocol::ChromeMessage::DeskCursor).
    DeskCursor {
        image: Option<domicile_protocol::CursorImage>,
    },
    PointerButton {
        button: u32,
        pressed: bool,
    },
    PointerAxis {
        dx: f64,
        dy: f64,
        v120_x: i32,
        v120_y: i32,
        source: PointerAxisSource,
        stop_x: bool,
        stop_y: bool,
    },
    Key {
        keycode: u32,
        pressed: bool,
    },
    /// The browser's focused text field. See [`crate::chrome_editor`].
    TextInput {
        field: domicile_protocol::TextField,
    },
    /// A browser key for the input method. See [`crate::chrome_editor`].
    KeyForInputMethod {
        keycode: u32,
        pressed: bool,
    },
    KeyboardFocus {
        app_id: Option<String>,
    },
    /// The chrome reported its `devicePixelRatio`.
    ///
    /// `scale` is the integer the output advertises (see
    /// [`crate::scale::output_scale`]). `ratio` is the exact value, needed to
    /// convert the engine's device-pixel `<app>` bounds to logical units.
    SetOutputScale {
        ratio: f64,
        scale: i32,
    },
    /// The chrome's viewport changed. Re-advertise the output at that size.
    SetOutputSize {
        logical: (i32, i32),
    },
    /// The page put the window `app_id` at `bounds`, in desktop logical units.
    SetAppBounds {
        app_id: String,
        bounds: domicile_scene::Bounds,
    },
    /// The page replaced the states it set on window `app_id`. See
    /// [`set_window_states`].
    SetWindowStates {
        app_id: String,
        states: Vec<WindowState>,
    },
    /// A page added a virtual monitor. See [`crate::virtual_monitors`].
    AddVirtualMonitor {
        display: VirtualDisplay,
    },
    /// A page's virtual monitor ended.
    RemoveVirtualMonitor {
        id: i64,
    },
    /// A page resized its virtual monitor in place. See
    /// [`crate::virtual_monitors::resize`].
    ResizeVirtualMonitor {
        id: i64,
        mode: (u32, u32),
        refresh_mhz: u32,
        scale: Scale,
    },
    /// The page switched the keymap. See
    /// [`DomicileCompositor::switch_the_keymap`].
    SelectKeymap {
        keymap: KeymapChoice,
    },
    /// The page switched the keyboard window's shortcuts inhibitor. See
    /// [`DomicileCompositor::switch_the_shortcuts_inhibitor`].
    SwitchShortcutsInhibitor {
        action: InhibitorAction,
    },
    /// The page set the white point of `output`, or of every monitor. See
    /// [`crate::gamma`].
    SetWhitePoint {
        output: Option<String>,
        white_point: WhitePoint,
    },
    /// Somebody asked to turn the monitors off or on. See
    /// [`DomicileCompositor::power_the_displays`].
    PowerDisplays {
        power: DisplayPower,
        /// One monitor's `wl_output` name, or `None` for every one.
        display: Option<String>,
    },
    /// `domicile configure-display` asked to change a monitor's setup. See
    /// [`DomicileCompositor::configure_display`].
    ConfigureDisplay {
        display: String,
        change: domicile_protocol::DisplayChange,
        answer: crate::configured_displays::Answer,
    },
    /// The chrome asked the client of `app_id` to close its window.
    CloseApp {
        app_id: String,
    },
    /// The chrome, or `domicile exec`, asked to start a program.
    ///
    /// Handled here because the lock state lives here, and a locked desktop
    /// refuses spawns. See [`crate::lock::refused`]. With an `answer` the
    /// asker hears why it did not start; without one the person is told.
    Spawn {
        command: Vec<String>,
        answer: Option<crate::configured_displays::Answer>,
    },
    /// A chrome's page said `hello`. It holds no pixels yet.
    ///
    /// `served_by` is the peer process of the connection, which is the browser
    /// process. A new pid means the engine was replaced, not just reloaded. See
    /// [`crate::which_engine`].
    ChromeHello {
        served_by: Option<i32>,
    },
    /// A client's copy, read from its pipe.
    ///
    /// Sent by the reader thread, not a chrome, because a client may write
    /// slowly and the Wayland thread must not wait. See
    /// [`DomicileCompositor::read_what_was_copied`].
    ClipboardCopied {
        clipboard: Clipboard,
        contents: Contents,
    },
    /// The shell picked a clipboard history entry. Make it the seat's
    /// selection.
    ///
    /// The compositor owns this selection, so the entry stays pasteable after
    /// its original client exits.
    CopyClipboardEntry {
        entry: u32,
    },
    /// The shell removed a clipboard history entry. Removing the current one
    /// empties the seat's clipboard.
    RemoveClipboardEntry {
        entry: u32,
    },
    /// The shell clicked a tray icon. Routed through this thread so a locked
    /// desktop can refuse it. See [`crate::lock::refused`].
    ActivateTrayItem {
        id: String,
        action: TrayAction,
    },
    /// The shell's system call clicked an entry of the tray menu on `bus`,
    /// such as "Show Slack". Gets the item a token, as an icon click does.
    /// Sent before the call runs, so the token is minted before the app can
    /// ask with it. Routed here so a locked desktop can refuse it.
    TrayMenuClicked {
        bus: String,
    },
    /// The shell dismissed notifications. Routed here so a locked desktop can
    /// refuse it.
    DismissNotifications {
        ids: Vec<u32>,
    },
    /// The shell invoked a notification action. Routed here so a locked desktop
    /// can refuse it.
    InvokeNotificationAction {
        id: u32,
        action: String,
    },
    /// The shell replied to a notification. Routed here so a locked desktop
    /// can refuse it.
    ReplyToNotification {
        id: u32,
        text: String,
    },
    /// The shell answered a portal dialog. Routed here so a locked desktop can
    /// refuse it.
    AnswerPortalRequest {
        id: u32,
        answer: PortalAnswer,
    },
    /// A passphrase typed at the lock screen.
    ///
    /// Handled here because locking blocks input to the seat, and the seat
    /// lives on this thread. See [`crate::lock`].
    Unlock {
        passphrase: Passphrase,
    },
    /// The shell asked to lock now. See [`DomicileCompositor::shut_the_desk`].
    Lock,
    /// A page started an idle watch. See
    /// [`DomicileCompositor::settle_the_idle_watches`].
    IdleWatched,
    /// The applications holding idle inhibitors through the portal, one name
    /// per inhibitor. From the portal thread; see [`crate::portals`].
    HeldAwakeByThePortal {
        by: Vec<String>,
    },
    /// What applications asked `org.freedesktop.ScreenSaver` to hold, and
    /// why that changed. From its thread; see [`crate::screen_saver`].
    HeldAwakeByTheScreenSaver {
        by: Vec<crate::screen_saver::Hold>,
        change: crate::screen_saver::Change,
    },
}

impl DomicileCompositor {
    /// Handle a request from a chrome on the Wayland thread.
    pub fn handle_client_request(&mut self, event: ClientRequest) {
        crate::input_trace::trace(&event);
        // First, for every request: this is how the compositor knows someone is
        // present.
        self.keep_the_desktop_awake(&event);
        // After counting activity, before anything reaches the seat. Input to a
        // locked desktop still wakes the screens but reaches no client. The
        // lock must act here, not at the socket, because the shell's own lock
        // screen needs its keys. [`crate::lock::refused`] lists what is
        // refused.
        let refusal = if self.the_desk_is_locked() {
            crate::lock::refused(Asked::OnTheWaylandThread(&event))
        } else {
            None
        };
        if let Some(refusal) = refusal {
            say_what_the_lock_refused(refusal);
            return;
        }
        // Input the lock let through, before it reaches the seat.
        if self.captured(&event) {
            self.cancel_pinch();
            self.cancel_swipe();
            self.cancel_touches();
            return;
        }
        match event {
            ClientRequest::PointerPinch {
                owner,
                app_id,
                pinch,
            } => self.forward_pinch(owner, &app_id, pinch),
            ClientRequest::PointerSwipe { owner, swipe } => self.forward_swipe(owner, swipe),
            ClientRequest::PointerHold { owner, hold } => self.forward_hold(owner, hold),
            ClientRequest::GestureOwnerGone { owner } => {
                self.pinch_owner_gone(owner);
                self.swipe_owner_gone(owner);
            }
            ClientRequest::Touch {
                owner,
                app_id,
                touch,
            } => self.forward_touch(owner, &app_id, touch),
            ClientRequest::TouchOwnerGone { owner } => self.touch_owner_gone(owner),
            ClientRequest::PointerMotion { app_id, x, y, .. } => {
                if self.pointer_app.as_deref() != Some(&app_id) {
                    self.cancel_pinch();
                    self.cancel_swipe();
                }
                let Some(surface) = self.surface_for(&app_id) else {
                    tracing::debug!(%app_id, "pointer motion: no surface");
                    return;
                };
                self.cast_pointer(Some((app_id.clone(), (x, y))));
                // The chrome's box is the window geometry, not the surface, so
                // offset for client-side shadows.
                let (x, y) = crate::window_geometry::surface_point(
                    with_states(&surface, window_geometry),
                    (x, y),
                );
                let (surface, (x, y)) = self.input_target(surface, (x, y));
                self.pointer_app = Some(app_id);
                self.cursor_surface = None;
                self.pointer_surface = Some(surface.clone());
                self.offer_pointer_constraint();
                if self.pointer_locked_over(&surface) {
                    // The page holds the pointer still for a lock; only
                    // relative motion reaches the client.
                    return;
                }
                let pointer = self.seat.get_pointer().unwrap();
                let (serial, time) = (SERIAL_COUNTER.next_serial(), self.now_ms());
                // The chrome sends surface-local coords, so anchor the focus at
                // the origin and treat the location as already surface-local.
                pointer.motion(
                    self,
                    Some((surface, (0.0, 0.0).into())),
                    &MotionEvent {
                        location: (x, y).into(),
                        serial,
                        time,
                    },
                );
                pointer.frame(self);
            }
            ClientRequest::PointerRelative {
                app_id,
                dx,
                dy,
                dx_unaccel,
                dy_unaccel,
            } => {
                self.move_relatively(&app_id, (dx, dy), (dx_unaccel, dy_unaccel));
            }
            ClientRequest::PointerConstrained { app_id, active } => {
                self.page_constrained(&app_id, active);
            }
            ClientRequest::PointerLeave => {
                self.cancel_pinch();
                self.cancel_swipe();
                self.cast_pointer(None);
                self.pointer_app = None;
                self.cursor_surface = None;
                self.pointer_surface = None;
                self.offer_pointer_constraint();
                let pointer = self.seat.get_pointer().unwrap();
                let (serial, time) = (SERIAL_COUNTER.next_serial(), self.now_ms());
                pointer.motion(
                    self,
                    None,
                    &MotionEvent {
                        location: (0.0, 0.0).into(),
                        serial,
                        time,
                    },
                );
                pointer.frame(self);
            }
            ClientRequest::PointerButton { button, pressed } => {
                tracing::debug!(button, pressed, "pointer button -> client");
                let state = if pressed {
                    self.let_go_of_lost_presses();
                    self.held_buttons.push(button);
                    ButtonState::Pressed
                } else if self.held_buttons.contains(&button) {
                    self.held_buttons.retain(|held| *held != button);
                    ButtonState::Released
                } else {
                    // Its press was let go of already, or handed to the shell
                    // by a move or resize request; the client was told.
                    tracing::debug!(button, "a release of a button no client holds -> dropped");
                    return;
                };
                self.pointer_button(button, state);
            }
            ClientRequest::PointerAxis {
                dx,
                dy,
                v120_x,
                v120_y,
                source,
                stop_x,
                stop_y,
            } => {
                let pointer = self.seat.get_pointer().unwrap();
                let axis_source = match source {
                    PointerAxisSource::Wheel => AxisSource::Wheel,
                    PointerAxisSource::Finger => AxisSource::Finger,
                    PointerAxisSource::Continuous => AxisSource::Continuous,
                    PointerAxisSource::WheelTilt => AxisSource::WheelTilt,
                };
                let mut frame = AxisFrame::new(self.now_ms()).source(axis_source);
                if dx != 0.0 {
                    frame = frame.value(Axis::Horizontal, dx);
                }
                if dy != 0.0 {
                    frame = frame.value(Axis::Vertical, dy);
                }
                if v120_x != 0 {
                    frame = frame.v120(Axis::Horizontal, v120_x);
                }
                if v120_y != 0 {
                    frame = frame.v120(Axis::Vertical, v120_y);
                }
                if stop_x {
                    frame = frame.stop(Axis::Horizontal);
                }
                if stop_y {
                    frame = frame.stop(Axis::Vertical);
                }
                pointer.axis(self, frame);
                pointer.frame(self);
            }
            ClientRequest::Key { keycode, pressed } => {
                // Start timing here, the moment the client can know about the
                // key.
                //
                // Presses only, as the chrome does: a release changes nothing
                // on screen and would time some unrelated redraw.
                if pressed {
                    self.pending_key.get_or_insert_with(Instant::now);
                }
                self.inject_key(keycode, pressed);
                self.tell_the_chromes_the_modifiers();
            }
            ClientRequest::TextInput { field } => self.take_the_browsers_field(field),
            ClientRequest::KeyForInputMethod { keycode, pressed } => {
                self.key_for_the_input_method(keycode, pressed);
                self.tell_the_chromes_the_modifiers();
            }
            ClientRequest::KeyboardFocus { app_id } => {
                // A menu over the target window keeps the keyboard. Focus
                // anywhere else dismisses it, like a click elsewhere.
                if let Some(menu) = self.grabbing.last().cloned() {
                    if app_id.is_some() && app_id == self.window_under(&menu) {
                        let keyboard = self.seat.get_keyboard().unwrap();
                        let serial = SERIAL_COUNTER.next_serial();
                        keyboard.set_focus(self, Some(menu.wl_surface().clone()), serial);
                        return;
                    }
                    self.dismiss_the_menus();
                }
                let requested = match &app_id {
                    Some(id) => self.surface_for(id),
                    None => None,
                };
                if let Some(id) = &app_id {
                    if requested.is_some() {
                        debug!(app_id = %id, "keyboard focus -> client");
                    } else {
                        // The window closed or has not mapped yet. Focusing
                        // nothing would leave the desktop deaf, since nothing
                        // would take focus back.
                        debug!(app_id = %id, "keyboard focus -> a window with no surface; the chrome keeps it");
                    }
                }
                // Fall back to the chrome, so the keyboard always has a holder.
                let surface = requested.or_else(|| {
                    self.chrome_toplevel
                        .as_ref()
                        .map(|toplevel| toplevel.wl_surface().clone())
                });
                let keyboard = self.seat.get_keyboard().unwrap();
                let serial = SERIAL_COUNTER.next_serial();
                keyboard.set_focus(self, surface, serial);
            }
            ClientRequest::ClipboardCopied {
                clipboard,
                contents,
            } => {
                self.took_a_copy(clipboard, contents);
                self.tell_the_engine_a_clipboard(clipboard);
            }
            // Forward to the tray worker, which talks to the session bus,
            // with a token so the application can raise its window.
            ClientRequest::ActivateTrayItem { id, action } => {
                if let Some(tray) = self.hub.tray.get() {
                    let token = activation::mint(&mut self.xdg_activation_state, tray.pid(&id));
                    tray.activate(id, action, token);
                }
            }
            ClientRequest::TrayMenuClicked { bus } => {
                if let Some(tray) = self.hub.tray.get() {
                    let token = activation::mint(&mut self.xdg_activation_state, tray.pid_on(&bus));
                    tray.provide(bus, token);
                }
            }
            // Forward to the notification server's worker.
            ClientRequest::DismissNotifications { ids } => {
                if let Some(server) = self.hub.notifications.get() {
                    server.dismiss(ids);
                }
            }
            // With a token, so the application can raise its window.
            ClientRequest::InvokeNotificationAction { id, action } => {
                if let Some(server) = self.hub.notifications.get() {
                    let pid = server.pid(id);
                    let token = activation::mint(&mut self.xdg_activation_state, pid);
                    let windowed = pid.is_some_and(|pid| self.has_a_window(pid));
                    server.invoke(id, action, token, windowed);
                }
            }
            ClientRequest::ReplyToNotification { id, text } => {
                if let Some(server) = self.hub.notifications.get() {
                    server.reply(id, text);
                }
            }
            ClientRequest::AnswerPortalRequest { id, answer } => {
                self.hub.portals.answer(id, answer);
            }
            ClientRequest::CopyClipboardEntry { entry } => match self.clipboard.restore(entry) {
                // Paste now yields this entry, which is now the newest row.
                // See [`DomicileCompositor::holding`].
                Some(contents) => {
                    self.tell_the_chromes_the_clipboard();
                    self.hold_on_the_clipboard(contents);
                }
                // The history dropped this entry. Set nothing rather than
                // substitute another entry for what the user picked.
                None => warn!(
                    entry,
                    "the shell asked for a clipboard entry this desktop no longer holds"
                ),
            },
            ClientRequest::RemoveClipboardEntry { entry } => match self.clipboard.remove(entry) {
                Some(Removed::Earlier) => self.tell_the_chromes_the_clipboard(),
                Some(Removed::Current) => {
                    self.tell_the_chromes_the_clipboard();
                    self.empty_the_clipboard();
                }
                None => warn!(
                    entry,
                    "the shell removed a clipboard entry this desktop no longer holds"
                ),
            },
            ClientRequest::Unlock { passphrase } => self.offered_the_passphrase(&passphrase),
            ClientRequest::HeldAwakeByThePortal { by } => self.held_awake_by_the_portal(by),
            ClientRequest::HeldAwakeByTheScreenSaver { by, change } => {
                self.held_awake_by_the_screen_saver(by, change)
            }
            // Counted by `keep_the_desktop_awake` above, and for nobody else.
            ClientRequest::Activity { .. } => {}
            ClientRequest::DeskPointer { at, windows } => self.cast_desk_pointer(at, windows),
            ClientRequest::DeskCursor { image } => self.cast_desk_cursor(image),
            ClientRequest::Lock => {
                self.shut_the_desk("the shell asked for this desktop to be locked")
            }
            ClientRequest::IdleWatched => self.settle_the_idle_watches(),
            ClientRequest::TurnTheWindows { theme, chromes } => {
                // Replace any turnover in progress; its windows are about to
                // get a newer theme.
                let (turnover, step) = Turnover::begin(theme, chromes);
                self.turnover = Some(turnover);
                self.arm_the_turnover_deadline(CAPTURE_WITHIN, Turnover::capture_deadline);
                self.follow_the_turnover(step);
            }
            ClientRequest::ThemeCaptured { chrome, theme } => match &mut self.turnover {
                Some(turnover) => {
                    let step = turnover.captured(&chrome, theme);
                    self.follow_the_turnover(step);
                }
                // Nothing to turn, as when a shell wipes from its remembered
                // theme to the one the desk came up in. The page holds its wipe
                // until it hears the windows' theme, so tell it now: unanswered,
                // the wipe and the page's input stay held for good.
                None => {
                    let windows = self.hub.host.lock().unwrap().describe_windows_theme();
                    self.hub.broadcast(windows);
                }
            },
            ClientRequest::ChromeHello { served_by } => {
                // A page started, so any keys the previous page held will never
                // be released. Release them.
                //
                // Every new connection sends `hello`, so on a two-chrome
                // desktop one page starting releases keys held through another.
                // `held` is cleared on the same terms.
                self.release_pressed_keys();
                self.tell_the_browser_if_composing();
                // The new page has reported no boxes, so it has hidden
                // nothing. One that never reports them would otherwise leave
                // windows suspended for good.
                self.show_every_window();
                // A hello is the only sign the engine was replaced; see
                // [`crate::which_engine`]. Rejoin before announcing windows, so
                // each has a frame sink again.
                self.rejoin_the_engine(served_by);
                // Catch up the new page on state it would otherwise only learn
                // on the next change.
                announce_open_apps(&self.hub);
                // An empty clipboard is a valid message, so the normal
                // broadcast works.
                self.tell_the_chromes_the_clipboard();
                // A shell that reloaded while the screens were dark would
                // otherwise assume someone is present.
                self.tell_a_new_chrome_whether_anybody_is_here();
                // A shell that reloaded, or an engine that restarted, would
                // otherwise show an unlocked desktop.
                self.tell_a_new_chrome_whether_the_desk_is_locked();
            }
            ClientRequest::SetOutputScale { ratio, scale } => {
                // Keep the ratio even if the scale is refused: the engine
                // reports boxes in the page's device pixels regardless.
                self.device_pixel_ratio = ratio;
                self.set_output_scale(scale);
            }
            ClientRequest::SetOutputSize { logical } => self.set_output_size(logical),
            ClientRequest::SetAppBounds { app_id, bounds } => match self.toplevel_for(&app_id) {
                // An empty box is a window the page does not draw. It keeps
                // its displays and scale for when it is shown.
                Some(toplevel) if bounds.is_empty() => self.hide(&app_id, &toplevel),
                Some(toplevel) => {
                    // Only this window and its menus moved.
                    self.place_window(toplevel.wl_surface(), Some(bounds));
                    self.app_bounds.insert(app_id.clone(), bounds);
                    self.place_the_popups_over(toplevel.wl_surface());
                    self.show(&app_id, &toplevel);
                }
                // Usually the window closed while the message was in flight.
                // Logged in case the chrome sent a bogus id.
                None => debug!(%app_id, "bounds: a window with no toplevel"),
            },
            ClientRequest::SetWindowStates { app_id, states } => match self.toplevel_for(&app_id) {
                Some(toplevel) => set_window_states(&toplevel, &states),
                // The window closed while the message was in flight; the
                // connection checked the id.
                None => debug!(%app_id, "window states: a window with no toplevel"),
            },
            ClientRequest::AddVirtualMonitor { display } => {
                self.virtual_displays.push(display);
                self.state_the_virtual_monitors();
            }
            ClientRequest::RemoveVirtualMonitor { id } => {
                self.virtual_displays.retain(|display| display.id != id);
                self.state_the_virtual_monitors();
            }
            ClientRequest::ResizeVirtualMonitor {
                id,
                mode,
                refresh_mhz,
                scale,
            } => match crate::virtual_monitors::resize(
                &mut self.virtual_displays,
                id,
                mode,
                refresh_mhz,
                scale,
            ) {
                // The engine reports the new mode, and the desk is laid out
                // again then.
                Resized::Mode => self.state_the_virtual_monitors(),
                Resized::Scale => self.lay_out_the_engines_displays(),
                Resized::Nothing => {}
                // The page let go of it while the resize was in flight.
                Resized::Gone => debug!(id, "resize: a virtual monitor that is gone"),
            },
            ClientRequest::SelectKeymap { keymap } => self.switch_the_keymap(&keymap),
            ClientRequest::SwitchShortcutsInhibitor { action } => {
                self.switch_the_shortcuts_inhibitor(action);
            }
            ClientRequest::SetWhitePoint {
                output,
                white_point,
            } => {
                self.night_light
                    .set(output.as_deref(), white_point, Instant::now());
                self.draw_the_night_light();
            }
            ClientRequest::PowerDisplays { power, display } => {
                self.power_the_displays(power, display.as_deref());
            }
            ClientRequest::ConfigureDisplay {
                display,
                change,
                answer,
            } => answer.give(self.configure_display(&display, &change)),
            // A launch from a key or the launcher, so it may raise the
            // window of an app already running.
            ClientRequest::Spawn { command, answer } => {
                let started = spawn_client(
                    &command,
                    &self.hub.wayland_display,
                    self.scope_clients,
                    self.hub.child_nice,
                    Some(&activation::mint(&mut self.xdg_activation_state, None)),
                    self.launched.as_ref(),
                );
                match (started, answer) {
                    (started, Some(answer)) => answer.give(started),
                    (Ok(()), None) => {}
                    (Err(why), None) => {
                        tracing::error!(why, ?command, "failed to spawn client");
                        self.hub
                            .notifications
                            .get()
                            .expect("the notification server is handed to the hub before chromes connect")
                            .warn_that_a_program_did_not_start(&why);
                    }
                }
            }
            ClientRequest::CloseApp { app_id } => match self.toplevel_for(&app_id) {
                Some(toplevel) => {
                    debug!(%app_id, "close -> client");
                    self.release_before_closing(&app_id);
                    toplevel.send_close();
                }
                // Dismiss a popup instead; the client then destroys it
                // (`popup_destroyed`).
                None => match self.popups.iter().find(|(id, _)| *id == app_id) {
                    Some((_, popup)) => {
                        debug!(%app_id, "dismiss -> client");
                        popup.send_popup_done();
                    }
                    // Usually the window closed while the message was in
                    // flight. Logged in case the chrome sent a bogus id.
                    None => debug!(%app_id, "close: a window with no toplevel"),
                },
            },
        }
    }
}

/// Replace the states a shell sets on `toplevel` with `states`, and configure
/// it if they changed.
///
/// `activated` and `suspended` are the compositor's and are kept.
fn set_window_states(toplevel: &ToplevelSurface, states: &[WindowState]) {
    let maximized_for_tiled = toplevel.version() < TILED_SINCE
        && !states.contains(&WindowState::Fullscreen)
        && states.iter().copied().any(is_tiled);
    toplevel.with_pending_state(|pending| {
        for state in SHELL_STATES {
            pending.states.unset(state);
        }
        for state in states {
            pending.states.set(xdg_state(*state));
        }
        // Smithay drops tiled states for these clients. `maximized` is the
        // nearest they know: no shadows, and the configured size.
        if maximized_for_tiled {
            pending.states.set(xdg_toplevel::State::Maximized);
        }
    });
    // Before the first configure, that configure carries them.
    if toplevel.is_initial_configure_sent() {
        toplevel.send_pending_configure();
    }
}

/// Every `xdg_toplevel` state a shell sets.
const SHELL_STATES: [xdg_toplevel::State; 7] = [
    xdg_toplevel::State::TiledLeft,
    xdg_toplevel::State::TiledRight,
    xdg_toplevel::State::TiledTop,
    xdg_toplevel::State::TiledBottom,
    xdg_toplevel::State::Maximized,
    xdg_toplevel::State::Fullscreen,
    xdg_toplevel::State::Resizing,
];

/// The `xdg_wm_base` version that added the tiled states.
const TILED_SINCE: u32 = 2;

fn is_tiled(state: WindowState) -> bool {
    matches!(
        state,
        WindowState::TiledLeft
            | WindowState::TiledRight
            | WindowState::TiledTop
            | WindowState::TiledBottom
    )
}

fn xdg_state(state: WindowState) -> xdg_toplevel::State {
    match state {
        WindowState::TiledLeft => xdg_toplevel::State::TiledLeft,
        WindowState::TiledRight => xdg_toplevel::State::TiledRight,
        WindowState::TiledTop => xdg_toplevel::State::TiledTop,
        WindowState::TiledBottom => xdg_toplevel::State::TiledBottom,
        WindowState::Maximized => xdg_toplevel::State::Maximized,
        WindowState::Fullscreen => xdg_toplevel::State::Fullscreen,
        WindowState::Resizing => xdg_toplevel::State::Resizing,
    }
}
