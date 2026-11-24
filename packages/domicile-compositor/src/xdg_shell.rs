//! xdg-shell and xdg-activation: the windows and popups clients create, and what
//! they ask of them.

use smithay::input::pointer::MotionEvent;
use smithay::output::Output;
use smithay::reexports::{
    wayland_protocols::xdg::shell::server::xdg_toplevel,
    wayland_server::{
        protocol::{wl_output, wl_seat, wl_surface::WlSurface},
        Resource,
    },
};
use smithay::utils::{Serial, SERIAL_COUNTER};
use smithay::wayland::{
    compositor::with_states,
    shell::xdg::{
        PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
        XdgToplevelSurfaceData,
    },
    xdg_activation::{
        XdgActivationHandler, XdgActivationState, XdgActivationToken, XdgActivationTokenData,
    },
};
use smithay::{delegate_xdg_activation, delegate_xdg_shell};
use tracing::debug;

use domicile_protocol::{ResizeEdges, WindowRequest};

use crate::activation;
use crate::chrome_hub::broadcast_focus_request;
use crate::clients::{is_chrome_surface, owner_of};
use crate::surface_commit::Role;
use crate::{grepped, DomicileCompositor};

impl XdgShellHandler for DomicileCompositor {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        // The chrome's own window is the desktop, not a window on it.
        // Announcing it would make the chrome embed itself.
        if is_chrome_surface(surface.wl_surface()) {
            debug!("the chrome mapped its toplevel -> compositing it over the apps");
            for live in &self.outputs {
                live.output.enter(surface.wl_surface());
            }
            // Size it to the desktop, as a compositor does for a fullscreen
            // window.
            surface.with_pending_state(|state| {
                state.size = Some(self.screens.size().into());
            });
            self.chrome_toplevel = Some(surface);
            self.focus_chrome();
            return;
        }

        // Register a new window with `Host`, which assigns an app id. The
        // chromes hear of it when it first draws, in `announce_a_new_window`,
        // by when its client has said what it is.
        let wl_surface = surface.wl_surface().clone();
        {
            let mut host = self.hub.host.lock().unwrap();
            let listing = self.foreign_toplevels.listing();
            let app_id = host.app_created(owner_of(surface.wl_surface()), listing.identifier());
            debug!(%app_id, "toplevel created -> Host::app_created");
            // Enter every output for now; the chrome has not placed the window.
            // Some toolkits (GLFW, kitty) wait for this before drawing.
            // `enter_the_displays_each_window_is_on` updates it on placement.
            for live in &self.outputs {
                live.output.enter(surface.wl_surface());
            }
            self.by_surface.insert(
                surface.wl_surface().clone(),
                (app_id.clone(), Role::Toplevel(surface.clone())),
            );
            self.unannounced.insert(app_id.clone());
            self.foreign_toplevels.opened(&app_id, listing);
            self.toplevels.push((app_id, surface));
        }
        self.the_running_apps_changed();
        // An inhibitor taken before the window mapped starts holding now (see
        // `crate::idle::holds`), which may wake a dark desktop.
        self.the_windows_changed("a window appeared under an inhibitor");
        self.a_window_may_have_taken_the_shortcuts(&wl_surface);
    }

    /// A client set or changed its window title.
    ///
    /// Titles arrive after the window is announced, and terminals rename
    /// constantly. Smithay filters unchanged titles before calling this.
    fn title_changed(&mut self, surface: ToplevelSurface) {
        // `None` for the chrome's own window, which is never announced.
        let Some(app_id) = self.app_id_of(surface.wl_surface()) else {
            return;
        };
        let title = with_states(surface.wl_surface(), |states| {
            states
                .data_map
                .get::<XdgToplevelSurfaceData>()
                .unwrap()
                .lock()
                .unwrap()
                .title
                .clone()
        });
        // The title itself is left out: it can say what someone is reading.
        debug!(%app_id, "a window renamed itself");
        // Separate `let` so the host guard drops at the `;`, before the
        // broadcast. Inside the `if let` it would be held for the whole body.
        let titled = self
            .hub
            .host
            .lock()
            .unwrap()
            .app_titled(&app_id, title.clone());
        if let Some(titled) = titled {
            self.hub.broadcast(titled);
        }
        self.foreign_toplevels
            .titled(&app_id, title.as_deref().unwrap_or_default());
        self.cast_if_asked(&app_id, title.as_deref());
    }

    /// A client set or changed its window's application id, which the
    /// Background portal reports and the chrome reads as its desktop id.
    fn app_id_changed(&mut self, surface: ToplevelSurface) {
        // `None` for the chrome's own window, which is never announced.
        if let Some(app_id) = self.app_id_of(surface.wl_surface()) {
            let desktop_id = with_states(surface.wl_surface(), |states| {
                states
                    .data_map
                    .get::<XdgToplevelSurfaceData>()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .app_id
                    .clone()
            })
            .expect("Smithay calls this only after the client set an app id");
            debug!(%app_id, %desktop_id, "a window named its app");
            self.foreign_toplevels.named(&app_id, &desktop_id);
            // Separate `let` so the host guard drops before the broadcast, as
            // in `title_changed`.
            let named = self
                .hub
                .host
                .lock()
                .unwrap()
                .app_desktop_id(&app_id, desktop_id);
            if let Some(named) = named {
                self.hub.broadcast(named);
            }
        }
        self.the_running_apps_changed();
    }

    /// A client set or cleared the window its toplevel is a dialog for.
    fn parent_changed(&mut self, surface: ToplevelSurface) {
        // `None` for the chrome's own window, which is never announced.
        let Some(app_id) = self.app_id_of(surface.wl_surface()) else {
            return;
        };
        let parent = surface.parent().and_then(|parent| self.app_id_of(&parent));
        debug!(%app_id, ?parent, "a window became a dialog for another, or stopped being one");
        // Separate `let` so the host guard drops before the broadcast, as in
        // `title_changed`.
        let parented = self
            .hub
            .host
            .lock()
            .unwrap()
            .app_transient_for(&app_id, parent);
        if let Some(parented) = parented {
            self.hub.broadcast(parented);
        }
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        if self
            .chrome_toplevel
            .as_ref()
            .is_some_and(|chrome| chrome.wl_surface() == surface.wl_surface())
        {
            debug!("the chrome's toplevel went away");
            self.chrome_toplevel = None;
            let keyboard = self.seat.get_keyboard().unwrap();
            let serial = SERIAL_COUNTER.next_serial();
            keyboard.set_focus(self, None, serial);
            return;
        }
        if let Some(pos) = self
            .toplevels
            .iter()
            .position(|(_, t)| t.wl_surface() == surface.wl_surface())
        {
            let (app_id, _) = self.toplevels.remove(pos);
            debug!(%app_id, surface = ?surface.wl_surface().id(), "toplevel destroyed");
            self.foreign_toplevels.closed(&app_id);
            self.by_surface.remove(surface.wl_surface());
            self.forget(&app_id);
            self.the_running_apps_changed();
            // Return the keyboard to the chrome. The shell usually refocuses
            // something, but a crashed client gives it no chance, so the
            // compositor must guarantee a holder.
            self.focus_chrome();
            // An inhibitor on the closed window's surface stops holding, even
            // if the client still runs.
            self.the_windows_changed("the window holding this desktop awake is gone");
        }
    }

    /// The client destroyed a popup, usually after a dismissal.
    fn popup_destroyed(&mut self, surface: PopupSurface) {
        if let Some(pos) = self
            .popups
            .iter()
            .position(|(_, popup)| popup.wl_surface() == surface.wl_surface())
        {
            let (app_id, _) = self.popups.remove(pos);
            self.by_surface.remove(surface.wl_surface());
            debug!(%app_id, "popup destroyed -> Host::app_closed");
            self.forget(&app_id);
        }
        // A grabbing menu hands the keyboard to its parent menu, or to its
        // window after the last one.
        if let Some(at) = self.grabbing.iter().position(|popup| *popup == surface) {
            let root = self.window_under(&surface);
            self.grabbing.remove(at);
            debug!(
                ?root,
                menus = self.grabbing.len(),
                "a grabbing menu went; the keyboard goes to the menu or window under it"
            );
            let next = self
                .grabbing
                .last()
                .map(|popup| popup.wl_surface().clone())
                .or_else(|| root.and_then(|app_id| self.surface_for(&app_id)));
            let keyboard = self.seat.get_keyboard().unwrap();
            let serial = SERIAL_COUNTER.next_serial();
            keyboard.set_focus(self, next, serial);
        }
    }

    fn new_popup(&mut self, surface: PopupSurface, positioner: PositionerState) {
        // Configure immediately: a popup cannot attach a buffer until
        // configured, and an unconfigured menu hangs the client silently.
        let geometry = self.kept_on_screen(&surface, positioner);
        debug!(
            surface = ?surface.wl_surface().id(),
            window = ?self.window_under(&surface),
            asked = ?positioner.get_geometry(),
            placed = ?geometry,
            "a new popup"
        );
        surface.with_pending_state(|state| {
            state.geometry = geometry;
            state.positioner = positioner;
        });
        if let Err(err) = surface.send_configure() {
            tracing::error!(%err, "could not configure a popup");
        }
        // On the displays its window is on, at that window's scale. Nothing
        // else moved.
        self.place_window(surface.wl_surface(), self.popup_bounds(&surface));
    }

    fn reposition_request(
        &mut self,
        surface: PopupSurface,
        positioner: PositionerState,
        token: u32,
    ) {
        let geometry = self.kept_on_screen(&surface, positioner);
        debug!(
            surface = ?surface.wl_surface().id(),
            window = ?self.window_under(&surface),
            placed = ?geometry,
            token,
            "a popup asked to move"
        );
        surface.with_pending_state(|state| {
            state.geometry = geometry;
            state.positioner = positioner;
        });
        surface.send_repositioned(token);
        // It, and any menu opened from it, may be on another display now.
        self.place_the_popups_over(&self.window_under_menus(surface.wl_surface()));
    }

    fn move_request(&mut self, surface: ToplevelSurface, _seat: wl_seat::WlSeat, serial: Serial) {
        if self.hand_the_press_to_the_shell(&surface, serial) {
            self.pass_on_a_window_request(&surface, WindowRequest::Move);
        }
    }

    fn maximize_request(&mut self, surface: ToplevelSurface) {
        self.pass_on_a_window_request(&surface, WindowRequest::Maximize);
    }

    fn unmaximize_request(&mut self, surface: ToplevelSurface) {
        self.pass_on_a_window_request(&surface, WindowRequest::Unmaximize);
    }

    fn fullscreen_request(
        &mut self,
        surface: ToplevelSurface,
        output: Option<wl_output::WlOutput>,
    ) {
        let display = output
            .as_ref()
            .and_then(Output::from_resource)
            .map(|output| output.name());
        self.pass_on_a_window_request(&surface, WindowRequest::Fullscreen { display });
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        self.pass_on_a_window_request(&surface, WindowRequest::Unfullscreen);
    }

    fn minimize_request(&mut self, surface: ToplevelSurface) {
        self.pass_on_a_window_request(&surface, WindowRequest::Minimize);
    }

    fn resize_request(
        &mut self,
        surface: ToplevelSurface,
        _seat: wl_seat::WlSeat,
        serial: Serial,
        edges: xdg_toplevel::ResizeEdge,
    ) {
        // `None` pulls no edge, so there is nothing to resize.
        let Some(edges) = resize_edges_of(edges) else {
            debug!(?edges, "a resize request pulling no edge -> dropped");
            return;
        };
        if self.hand_the_press_to_the_shell(&surface, serial) {
            self.pass_on_a_window_request(&surface, WindowRequest::Resize { edges });
        }
    }

    /// A menu grabbing the keyboard and pointer until dismissed.
    ///
    /// The serial is not checked: all presses come from the chrome, and a
    /// refused grab would be a menu that silently never opens.
    fn grab(&mut self, surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        if !self.grabbing.contains(&surface) {
            self.grabbing.push(surface.clone());
        }
        debug!(
            surface = ?surface.wl_surface().id(),
            window = ?self.window_under(&surface),
            menus = self.grabbing.len(),
            "a menu grabbed the keyboard"
        );
        let keyboard = self.seat.get_keyboard().unwrap();
        let serial = SERIAL_COUNTER.next_serial();
        keyboard.set_focus(self, Some(surface.wl_surface().clone()), serial);
    }
}

delegate_xdg_shell!(DomicileCompositor);

impl XdgActivationHandler for DomicileCompositor {
    fn activation_state(&mut self) -> &mut XdgActivationState {
        &mut self.xdg_activation_state
    }

    /// A client asked for a window to be activated. Forwarded, not granted.
    ///
    /// A token made before the keyboard last moved, or a stale one the
    /// compositor minted, is dropped, unless the asking app holds the keyboard (see [`activation::granted`]): the window
    /// is asking on its own, not for the user, and is marked urgent instead
    /// (`app_urgent`). Unless its process just had a notification pressed
    /// (see [`activation::invites`]), which uses that press up. The rest are
    /// broadcast as `focus_requested`; a shell grants one with `focus_app`.
    fn request_activation(
        &mut self,
        token: XdgActivationToken,
        token_data: XdgActivationTokenData,
        surface: WlSurface,
    ) {
        // Always remove the token; nothing else prunes the pool, so clients
        // could grow it without bound.
        self.xdg_activation_state.remove_token(&token);
        let keyboard = self.seat.get_keyboard().unwrap();
        let last_enter = keyboard.last_enter();
        // Whether the asking app holds the keyboard, so is moving it between
        // its own windows.
        let holds = keyboard
            .current_focus()
            .and_then(|focused| focused.client())
            .is_some_and(|holder| surface.client().as_ref() == Some(&holder));
        // `None` for the chrome's own surface, which is never announced.
        let app_id = self.app_id_of(&surface);
        if !activation::granted(&token_data, last_enter, holds)
            && !(app_id.is_some() && self.invited(&surface))
        {
            let asked = token_data.serial.map(|(serial, _)| serial);
            debug!(
                ?app_id,
                ?asked,
                ?last_enter,
                "{} -> dropped",
                grepped::FOCUS_REQUEST_DROPPED
            );
            // Separate `let` so the host guard drops before the broadcast, as
            // in `title_changed`.
            let urgent =
                app_id.and_then(|app_id| self.hub.host.lock().unwrap().app_urgent(&app_id));
            if let Some(urgent) = urgent {
                self.hub.broadcast(urgent);
            }
        } else if let Some(app_id) = app_id {
            broadcast_focus_request(&self.hub, &app_id);
        }
    }
}

delegate_xdg_activation!(DomicileCompositor);

impl DomicileCompositor {
    /// Whether the app `surface` belongs to just had a notification
    /// pressed, so may raise its window with a token of its own. Uses the
    /// press's token up.
    fn invited(&mut self, surface: &WlSurface) -> bool {
        let pid = u32::try_from(owner_of(surface).pid).expect("a process id is positive");
        let invitation = self
            .xdg_activation_state
            .tokens()
            .find(|(_, data)| activation::invites(data, pid))
            .map(|(token, _)| token.clone());
        invitation.is_some_and(|token| self.xdg_activation_state.remove_token(&token))
    }

    /// Tell the pages listening what a client asked of its window, and answer
    /// with a configure of the states it has.
    ///
    /// The shell decides and sets states with `set_window_states`. xdg-shell
    /// requires the configure even when nothing changed. Before the first
    /// configure, that configure is the answer.
    /// Whether `serial` is the press `surface`'s client still holds, as
    /// `xdg_toplevel.move` and `resize` must name. If it is, the client loses
    /// the pointer: it is told the pointer left and gets no release, as sway
    /// hands its seat to the move, and the shell runs the drag. See
    /// `docs/WRITING-A-SHELL.md#window-requests`.
    ///
    /// The shell takes the drag by capturing the pointer, so the window's
    /// element stops forwarding motion. A shell that ignores the request leaves
    /// the element forwarding it, and the client gets the pointer back with no
    /// button down. Either way the release is dropped; see
    /// `ClientRequest::PointerButton`.
    fn hand_the_press_to_the_shell(&mut self, surface: &ToplevelSurface, serial: Serial) -> bool {
        let pointer = self.seat.get_pointer().unwrap();
        let held_by_this_client = pointer
            .grab_start_data()
            .and_then(|grab| grab.focus)
            .is_some_and(|(focus, _)| focus.id().same_client_as(&surface.wl_surface().id()));
        if !pointer.has_grab(serial) || !held_by_this_client || self.held_buttons.is_empty() {
            debug!(
                ?serial,
                "a move or resize with no press of its own held -> dropped"
            );
            return false;
        }
        self.held_buttons.clear();
        self.pointer_app = None;
        self.pointer_surface = None;
        self.offer_pointer_constraint();
        let (serial, time) = (SERIAL_COUNTER.next_serial(), self.now_ms());
        pointer.unset_grab(self, serial, time);
        let location = pointer.current_location();
        pointer.motion(
            self,
            None,
            &MotionEvent {
                location,
                serial: SERIAL_COUNTER.next_serial(),
                time,
            },
        );
        pointer.frame(self);
        true
    }

    fn pass_on_a_window_request(&self, surface: &ToplevelSurface, request: WindowRequest) {
        // `None` for the chrome's own window, which is never announced.
        if let Some(app_id) = self.app_id_of(surface.wl_surface()) {
            debug!(%app_id, ?request, "a window request -> the shell");
            self.hub.outbound.window_request(app_id, request);
        }
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
    }
}

/// `edges` as the protocol names them, or `None` for an edge that pulls
/// nothing.
fn resize_edges_of(edges: xdg_toplevel::ResizeEdge) -> Option<ResizeEdges> {
    match edges {
        xdg_toplevel::ResizeEdge::Top => Some(ResizeEdges::Top),
        xdg_toplevel::ResizeEdge::Bottom => Some(ResizeEdges::Bottom),
        xdg_toplevel::ResizeEdge::Left => Some(ResizeEdges::Left),
        xdg_toplevel::ResizeEdge::Right => Some(ResizeEdges::Right),
        xdg_toplevel::ResizeEdge::TopLeft => Some(ResizeEdges::TopLeft),
        xdg_toplevel::ResizeEdge::TopRight => Some(ResizeEdges::TopRight),
        xdg_toplevel::ResizeEdge::BottomLeft => Some(ResizeEdges::BottomLeft),
        xdg_toplevel::ResizeEdge::BottomRight => Some(ResizeEdges::BottomRight),
        _ => None,
    }
}
