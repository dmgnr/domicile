//! The seat: keyboard focus, keys and pointer buttons from the chromes and EIS,
//! cursors, and the modifiers the chromes are told.

use smithay::backend::input::{ButtonState, KeyState};
use smithay::delegate_cursor_shape;
use smithay::input::{
    keyboard::{FilterResult, Keycode},
    pointer::{ButtonEvent, CursorIcon, CursorImageStatus, MotionEvent},
    Seat, SeatHandler, SeatState,
};
use smithay::reexports::{
    wayland_protocols::xdg::shell::server::xdg_toplevel,
    wayland_server::{protocol::wl_surface::WlSurface, Resource as _},
};
use smithay::utils::SERIAL_COUNTER;
use smithay::wayland::{
    compositor::with_states, selection::data_device::set_data_device_focus,
    selection::primary_selection::set_primary_focus, shell::xdg::XdgToplevelSurfaceData,
    tablet_manager::TabletSeatHandler,
};
use tracing::debug;

use domicile_protocol::{ChromeMessage, CursorShape, HostMessage};

use crate::chrome_hub::broadcast_focus_decision;
use crate::client_requests::ClientRequest;
use crate::eis;
use crate::modifiers::Modifiers;
use crate::{CalloopData, DomicileCompositor};

impl SeatHandler for DomicileCompositor {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<DomicileCompositor> {
        &mut self.seat_state
    }

    // The web engine draws the pointer, so forward a client's cursor request to
    // the chrome as a CSS cursor for the element under the pointer, or the
    // image the client drew on its own surface (`crate::cursor_surface`).
    fn cursor_image(&mut self, _seat: &Seat<Self>, image: CursorImageStatus) {
        let Some(app_id) = self.pointer_app.clone() else {
            return;
        };
        let cursor = match image {
            CursorImageStatus::Hidden => CursorShape::None,
            CursorImageStatus::Named(icon) => cursor_shape(icon),
            CursorImageStatus::Surface(surface) => {
                self.show_a_cursor_surface(app_id, &surface);
                return;
            }
        };
        self.cursor_surface = None;
        self.hub.broadcast(HostMessage::AppCursor {
            app_id,
            cursor,
            image: None,
        });
    }

    /// Both clipboards follow keyboard focus.
    ///
    /// Required for pasting: a selection is offered only to the client with
    /// data device focus. `wl_data_device` ties that to keyboard focus.
    ///
    /// `None` means no surface is focused. The chrome is an ordinary client
    /// here and gets the clipboard the same way.
    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let client = focused.and_then(|on| on.client());
        set_data_device_focus(&self.display_handle, seat, client.clone());
        // The primary selection follows the same rule, so both pastes work in
        // the same client.
        set_primary_focus(&self.display_handle, seat, client);
        self.activate(focused);
        self.report_running_apps(focused);
        self.read_notifications(focused);
    }
}

impl TabletSeatHandler for DomicileCompositor {}

// Smithay's `delegate_seat!`, but with `wl_seat` and `wl_touch` through
// [`crate::touch::CountTouches`], which counts the `wl_touch`es each client
// takes and hands everything else to Smithay.
smithay::reexports::wayland_server::delegate_global_dispatch!(DomicileCompositor: [
    smithay::reexports::wayland_server::protocol::wl_seat::WlSeat: smithay::wayland::seat::SeatGlobalData<DomicileCompositor>
] => smithay::input::SeatState<DomicileCompositor>);
smithay::reexports::wayland_server::delegate_dispatch!(DomicileCompositor: [
    smithay::reexports::wayland_server::protocol::wl_seat::WlSeat: smithay::wayland::seat::SeatUserData<DomicileCompositor>
] => crate::touch::CountTouches);
smithay::reexports::wayland_server::delegate_dispatch!(DomicileCompositor: [
    smithay::reexports::wayland_server::protocol::wl_pointer::WlPointer: smithay::wayland::seat::PointerUserData<DomicileCompositor>
] => smithay::input::SeatState<DomicileCompositor>);
smithay::reexports::wayland_server::delegate_dispatch!(DomicileCompositor: [
    smithay::reexports::wayland_server::protocol::wl_keyboard::WlKeyboard: smithay::wayland::seat::KeyboardUserData<DomicileCompositor>
] => smithay::input::SeatState<DomicileCompositor>);
smithay::reexports::wayland_server::delegate_dispatch!(DomicileCompositor: [
    smithay::reexports::wayland_server::protocol::wl_touch::WlTouch: smithay::wayland::seat::TouchUserData<DomicileCompositor>
] => crate::touch::CountTouches);
smithay::delegate_pointer_gestures!(DomicileCompositor);

delegate_cursor_shape!(DomicileCompositor);

impl eis::Compositor for CalloopData {
    fn desk(&self) -> eis::Desk {
        self.state.desk()
    }

    fn inject(&mut self, request: ClientRequest) {
        self.state.handle_client_request(request);
    }

    /// From the keysym table the shell's keybindings resolve against.
    fn keycode(&self, keysym: u32) -> Option<u32> {
        let name = smithay::input::keyboard::xkb::keysym_get_name(keysym.into());
        match self.state.hub.host.lock().unwrap().describe_shell_config() {
            Some(HostMessage::ShellConfig { keys, .. }) => keys.get(&name).copied(),
            _ => None,
        }
    }

    fn engine_takes_input(&self) -> bool {
        self.state.engine_takes_input
    }

    /// Dropped while no engine is up, as the seat drops input with no focus.
    /// A pointer goes to the engine pixel its monitor draws its desktop point
    /// at.
    fn inject_into_the_engine(&mut self, input: eis::DeskInput) {
        let input = match input {
            eis::DeskInput::Pointer { x, y } => {
                let (x, y) = self.state.screens.engine_pixel_of((x, y));
                eis::DeskInput::Pointer { x, y }
            }
            other => other,
        };
        let taken = self
            .state
            .engine
            .as_ref()
            .is_some_and(|engine| engine.inject_input(input));
        if !taken {
            debug!(?input, "no engine took emulated input");
        }
    }
}

/// Map a client's cursor request to the CSS keyword the chrome sets on its
/// `<app>` element.
///
/// `wp_cursor_shape_v1` mirrors the CSS keywords, so most map by name. Others,
/// including future additions, fall back to the nearest keyword.
pub fn cursor_shape(icon: CursorIcon) -> CursorShape {
    match icon {
        CursorIcon::Default => CursorShape::Default,
        CursorIcon::ContextMenu => CursorShape::ContextMenu,
        CursorIcon::Help => CursorShape::Help,
        CursorIcon::Pointer => CursorShape::Pointer,
        CursorIcon::Progress => CursorShape::Progress,
        CursorIcon::Wait => CursorShape::Wait,
        CursorIcon::Cell => CursorShape::Cell,
        CursorIcon::Crosshair => CursorShape::Crosshair,
        CursorIcon::Text => CursorShape::Text,
        CursorIcon::VerticalText => CursorShape::VerticalText,
        CursorIcon::Alias => CursorShape::Alias,
        CursorIcon::Copy => CursorShape::Copy,
        CursorIcon::Move | CursorIcon::AllResize => CursorShape::Move,
        CursorIcon::NoDrop => CursorShape::NoDrop,
        CursorIcon::NotAllowed => CursorShape::NotAllowed,
        CursorIcon::Grab => CursorShape::Grab,
        CursorIcon::Grabbing => CursorShape::Grabbing,
        CursorIcon::EResize => CursorShape::EResize,
        CursorIcon::NResize => CursorShape::NResize,
        CursorIcon::NeResize => CursorShape::NeResize,
        CursorIcon::NwResize => CursorShape::NwResize,
        CursorIcon::SResize => CursorShape::SResize,
        CursorIcon::SeResize => CursorShape::SeResize,
        CursorIcon::SwResize => CursorShape::SwResize,
        CursorIcon::WResize => CursorShape::WResize,
        CursorIcon::EwResize => CursorShape::EwResize,
        CursorIcon::NsResize => CursorShape::NsResize,
        CursorIcon::NeswResize => CursorShape::NeswResize,
        CursorIcon::NwseResize => CursorShape::NwseResize,
        CursorIcon::ColResize => CursorShape::ColResize,
        CursorIcon::RowResize => CursorShape::RowResize,
        CursorIcon::AllScroll => CursorShape::AllScroll,
        CursorIcon::ZoomIn => CursorShape::ZoomIn,
        CursorIcon::ZoomOut => CursorShape::ZoomOut,
        _ => CursorShape::Default,
    }
}

impl DomicileCompositor {
    /// The displays and windows, as EIS sees them.
    pub fn desk(&self) -> eis::Desk {
        let state = self;
        let focused = state.seat.get_keyboard().unwrap().current_focus();
        let windows = state
            .held_frames
            .shown(&state.app_bounds)
            .filter_map(|(app_id, bounds)| {
                state.toplevel_for(app_id).map(|toplevel| eis::Window {
                    app_id: app_id.clone(),
                    bounds: *bounds,
                    focused: focused.as_ref() == Some(toplevel.wl_surface()),
                })
            })
            .collect();
        eis::Desk::new(state.screens.outputs().cloned().collect(), windows)
    }

    /// Whether an InputCapture session took `event` from the seat.
    pub fn captured(&self, event: &ClientRequest) -> bool {
        let input = matches!(
            event,
            ClientRequest::Key { .. }
                | ClientRequest::PointerMotion { .. }
                | ClientRequest::PointerLeave
                | ClientRequest::PointerButton { .. }
                | ClientRequest::PointerAxis { .. }
                | ClientRequest::Touch { .. }
        );
        input
            && self
                .captures
                .as_ref()
                .is_some_and(|captures| captures.divert(event, &self.desk()))
    }

    /// Mark the window with keyboard focus as activated, and no other.
    ///
    /// Chromium treats `activated` as page focus. Without it, Electron windows
    /// accept typed characters but ignore Backspace and shortcuts.
    ///
    /// A menu with the keyboard activates its window; toolkits close menus when
    /// their window deactivates.
    pub fn activate(&self, focused: Option<&WlSurface>) {
        let window = focused.map(|on| self.window_under_menus(on));
        for (_, toplevel) in &self.toplevels {
            let active = window.as_ref() == Some(toplevel.wl_surface());
            toplevel.with_pending_state(|state| {
                if active {
                    state.states.set(xdg_toplevel::State::Activated);
                } else {
                    state.states.unset(xdg_toplevel::State::Activated);
                }
            });
            // Before the first configure, that configure carries it.
            if toplevel.is_initial_configure_sent() {
                toplevel.send_pending_configure();
            }
        }
    }

    /// Tell the Background portal each window's application and whether it
    /// has the keyboard (`focused`).
    fn report_running_apps(&self, focused: Option<&WlSurface>) {
        let window = focused.map(|on| self.window_under_menus(on));
        self.hub
            .portals
            .running(self.toplevels.iter().map(|(_, toplevel)| {
                let app_id = with_states(toplevel.wl_surface(), |states| {
                    states
                        .data_map
                        .get::<XdgToplevelSurfaceData>()
                        .unwrap()
                        .lock()
                        .unwrap()
                        .app_id
                        .clone()
                });
                (
                    app_id.unwrap_or_default(),
                    window.as_ref() == Some(toplevel.wl_surface()),
                )
            }));
    }

    /// Clear the notifications of the application whose window has the
    /// keyboard (`focused`): looking at it reads them. The chrome's own
    /// surfaces are no application's window.
    fn read_notifications(&self, focused: Option<&WlSurface>) {
        let Some(window) = focused.map(|on| self.window_under_menus(on)) else {
            return;
        };
        let Some((_, toplevel)) = self
            .toplevels
            .iter()
            .find(|(_, toplevel)| toplevel.wl_surface() == &window)
        else {
            return;
        };
        let Some(notifications) = self.hub.notifications.get() else {
            return;
        };
        let pid = window
            .client()
            .and_then(|client| client.get_credentials(&self.display_handle).ok())
            .and_then(|credentials| u32::try_from(credentials.pid).ok());
        let app_id = with_states(toplevel.wl_surface(), |states| {
            states
                .data_map
                .get::<XdgToplevelSurfaceData>()
                .unwrap()
                .lock()
                .unwrap()
                .app_id
                .clone()
        });
        notifications.seen(pid, &app_id.unwrap_or_default());
    }

    /// The running applications as the keyboard stands, for a window that
    /// came, went or renamed its application.
    pub fn the_running_apps_changed(&self) {
        let focused = self.seat.get_keyboard().unwrap().current_focus();
        self.report_running_apps(focused.as_ref());
    }

    /// Give the chrome keyboard focus.
    ///
    /// There is one seat, shared by turns: the chrome holds the keyboard until
    /// it focuses a window. A second seat is not an option because clients need
    /// not bind more than one (GTK asserts on a second).
    ///
    /// Also called when the window is focused, not only when the chrome maps,
    /// in case the client had not bound its keyboard the first time and missed
    /// the enter.
    pub fn focus_chrome(&mut self) {
        let Some(surface) = self
            .chrome_toplevel
            .as_ref()
            .map(|toplevel| toplevel.wl_surface().clone())
        else {
            return;
        };
        let keyboard = self.seat.get_keyboard().unwrap();
        if keyboard.current_focus().as_ref() == Some(&surface) {
            return;
        }
        debug!("the chrome has the window's keyboard");
        let serial = SERIAL_COUNTER.next_serial();
        keyboard.set_focus(self, Some(surface), serial);
        // Update `Host` too, or `keyboard_target` would name a window that no
        // longer has the keyboard. Clicks on the desktop go through
        // `focus_pointed_at`, not here.
        broadcast_focus_decision(&self.hub, ChromeMessage::FocusChrome);
    }

    /// Take the keyboard from any window for the lock screen.
    ///
    /// The chrome's toplevel, or nothing when there is none. Every chrome is
    /// told, so the engine stops sending keys to the window that had it.
    pub fn hand_the_keyboard_to_the_lock_screen(&mut self) {
        let chrome = self
            .chrome_toplevel
            .as_ref()
            .map(|toplevel| toplevel.wl_surface().clone());
        let keyboard = self.seat.get_keyboard().unwrap();
        let serial = SERIAL_COUNTER.next_serial();
        keyboard.set_focus(self, chrome, serial);
        broadcast_focus_decision(&self.hub, ChromeMessage::FocusChrome);
    }

    /// Send one key through the seat to the focused client.
    ///
    /// Shared by chrome keys and the latency run, so the measurement uses the
    /// real input path.
    pub fn inject_key(&mut self, keycode: u32, pressed: bool) {
        let keyboard = self.seat.get_keyboard().unwrap();
        let (serial, time) = (SERIAL_COUNTER.next_serial(), self.now_ms());
        let state = if pressed {
            KeyState::Pressed
        } else {
            KeyState::Released
        };
        // wl keymaps use X keycodes (evdev + 8); callers speak evdev.
        let key: Keycode = (keycode + 8).into();
        // Drop releases for keys the seat does not hold. With several monitors,
        // every page forwards every release it hears, since the release may
        // reach a different page than the press.
        if !pressed && !keyboard.pressed_keys().contains(&key) {
            return;
        }
        keyboard.input::<(), _>(self, key, state, serial, time, |_, _, _| {
            FilterResult::Forward
        });
    }

    /// Release every key the seat still has down.
    ///
    /// A key comes up only when told. A reloaded or crashed page sends no
    /// `keyup`, but the seat outlives it, so the key stays down for the
    /// session.
    ///
    /// For a lock key this is unrecoverable: xkb unlocks only on the release of
    /// the press that locked it. The default `caps:swapescape` puts `Caps_Lock`
    /// on Escape, so one lost release means typing in capitals until restart.
    ///
    /// Releasing a key the user still holds only costs its repeat; the real
    /// release later finds nothing down.
    pub fn release_pressed_keys(&mut self) {
        let keyboard = self.seat.get_keyboard().unwrap();
        let pressed = keyboard.pressed_keys();
        if !pressed.is_empty() {
            debug!(
                count = pressed.len(),
                "releasing the keys the seat had down"
            );
        }
        let time = self.now_ms();
        for key in pressed {
            let serial = SERIAL_COUNTER.next_serial();
            keyboard.input::<(), _>(
                self,
                key,
                KeyState::Released,
                serial,
                time,
                // Always forwarded. The chrome matches its own chords before
                // forwarding keys, so there is nothing to intercept here.
                |_, _, _| FilterResult::<()>::Forward,
            );
        }
        self.tell_the_chromes_the_modifiers();
    }

    /// Tell every chrome which modifiers are held, if that changed.
    ///
    /// Reads the seat because keys reach it three ways (the desktop keyboard,
    /// keys injected by a chrome, and releases for a dead chrome's keys), and
    /// only one runs a filter.
    pub fn tell_the_chromes_the_modifiers(&mut self) {
        let state = self.seat.get_keyboard().unwrap().modifier_state();
        let now = Modifiers {
            alt: state.alt,
            ctrl: state.ctrl,
            shift: state.shift,
            logo: state.logo,
        };
        if let Some(held) = self.modifiers.moved_to(now) {
            self.hub.broadcast(HostMessage::Modifiers {
                alt: held.alt,
                ctrl: held.ctrl,
                shift: held.shift,
                logo: held.logo,
            });
        }
    }

    /// Release the buttons held over another window before a press over this
    /// one.
    ///
    /// The page forwards a release only over the window's own element, so a
    /// button let go over the shell never reaches the seat. Smithay keeps the
    /// pointer on the pressed surface until every button is up, and keeps
    /// counting the button after that surface is gone, so the next press
    /// anywhere would hold the pointer for good.
    pub fn let_go_of_lost_presses(&mut self) {
        let pointer = self.seat.get_pointer().unwrap();
        let holder = pointer
            .grab_start_data()
            .and_then(|grab| grab.focus)
            .map(|(surface, _)| surface);
        let target = self.pointer_surface.clone();
        if self.held_buttons.is_empty() || holder == target {
            return;
        }
        debug!(buttons = ?self.held_buttons, "a press elsewhere -> releasing lost presses");
        for button in std::mem::take(&mut self.held_buttons) {
            self.pointer_button(button, ButtonState::Released);
        }
        // The grab kept the pointer on the holder, so enter the window the
        // press is over. The location is already local to it; see
        // `ClientRequest::PointerMotion`.
        let (serial, time) = (SERIAL_COUNTER.next_serial(), self.now_ms());
        let location = pointer.current_location();
        pointer.motion(
            self,
            target.map(|surface| (surface, (0.0, 0.0).into())),
            &MotionEvent {
                location,
                serial,
                time,
            },
        );
        pointer.frame(self);
    }

    /// Send one pointer button change to the seat.
    pub fn pointer_button(&mut self, button: u32, state: ButtonState) {
        let pointer = self.seat.get_pointer().unwrap();
        let (serial, time) = (SERIAL_COUNTER.next_serial(), self.now_ms());
        pointer.button(
            self,
            &ButtonEvent {
                button,
                state,
                serial,
                time,
            },
        );
        pointer.frame(self);
    }
}

#[cfg(test)]
mod tests {
    use smithay::input::pointer::CursorIcon;

    use domicile_protocol::CursorShape;

    use super::cursor_shape;

    #[test]
    fn cursor_icons_map_to_css_keywords() {
        assert_eq!(cursor_shape(CursorIcon::Default), CursorShape::Default);
        assert_eq!(cursor_shape(CursorIcon::Text), CursorShape::Text);
        assert_eq!(cursor_shape(CursorIcon::Grabbing), CursorShape::Grabbing);
        assert_eq!(
            cursor_shape(CursorIcon::NwseResize),
            CursorShape::NwseResize
        );
    }

    #[test]
    fn cursor_icons_without_a_css_keyword_fall_back() {
        // Shapes with no CSS keyword must still map to something the chrome can
        // use.
        assert_eq!(cursor_shape(CursorIcon::DndAsk), CursorShape::Default);
        assert_eq!(cursor_shape(CursorIcon::AllResize), CursorShape::Move);
    }
}
