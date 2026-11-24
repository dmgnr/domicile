//! Composition from an input method into native windows: `text-input-v3` for
//! editors, and `input-method-v2` with `virtual-keyboard-v1` for the input
//! method (fcitx5, IBus). See `docs/architecture/TEXT-INPUT.md`.
//!
//! Smithay relays between them: text-input focus follows keyboard focus, and
//! an input method that grabs the keyboard hears the keys the engine passes to
//! the focused native window. This module adds what Smithay leaves out:
//!
//! - One input method per seat. Smithay tells the input method already bound
//!   that it is `unavailable` and never stores the new one, so neither works.
//!   Here a second one gets `unavailable` and nothing else, as the protocol
//!   asks, and the first keeps working.
//! - Nothing reaches an editor while the desk is locked. Keys go to the lock
//!   page then, but a native window keeps the seat's focus, so an input
//!   method's text or a virtual keyboard's presses would land behind the lock.
//! - The candidate list. Smithay hands over the input method's popup surface
//!   while an editor has the keyboard; here it is announced to the shell as a
//!   popup of the editor's window, under the editor's text cursor, and moved
//!   when the cursor moves. See [`Candidates`].

use smithay::delegate_text_input_manager;
use smithay::reexports::wayland_protocols_misc::{
    zwp_input_method_v2::server::{
        zwp_input_method_keyboard_grab_v2::{self, ZwpInputMethodKeyboardGrabV2},
        zwp_input_method_manager_v2::{self, ZwpInputMethodManagerV2},
        zwp_input_method_v2::{self, ZwpInputMethodV2},
        zwp_input_popup_surface_v2::{self, ZwpInputPopupSurfaceV2},
    },
    zwp_virtual_keyboard_v1::server::{
        zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1,
        zwp_virtual_keyboard_v1::{self, ZwpVirtualKeyboardV1},
    },
};
use smithay::reexports::wayland_server::Resource as _;
use smithay::reexports::wayland_server::{
    backend::ClientId, protocol::wl_surface::WlSurface, Client, DataInit, Dispatch, DisplayHandle,
};
use smithay::utils::{Logical, Rectangle};
use smithay::wayland::compositor::{with_states, BufferAssignment, SurfaceAttributes};
use smithay::wayland::input_method::{
    InputMethodHandler, InputMethodManagerGlobalData, InputMethodManagerState,
    InputMethodPopupSurfaceUserData, InputMethodUserData, PopupSurface,
};
use smithay::wayland::text_input::TextInputManagerState;
use smithay::wayland::virtual_keyboard::{
    VirtualKeyboardManagerGlobalData, VirtualKeyboardManagerState, VirtualKeyboardUserData,
};
use tracing::debug;

use crate::surface_commit::Role;
use crate::DomicileCompositor;

/// The three managers' globals. Kept so they live as long as the display.
pub struct TextInput {
    _text_input: TextInputManagerState,
    _input_method: InputMethodManagerState,
    _virtual_keyboard: VirtualKeyboardManagerState,
    /// Whether an input method is bound to the seat. Domicile has one seat.
    input_method_bound: bool,
    /// The input method's candidate list, while an editor has the keyboard.
    candidates: Option<Candidates>,
}

/// An input method's candidate list: its `zwp_input_popup_surface_v2`, over
/// the editor that has the keyboard.
///
/// It is announced as a popup of the editor's window once it draws, under the
/// editor's text cursor rectangle (above it when below would leave the
/// screen), and closed when it draws nothing, when the editor loses the
/// keyboard and when the input method goes.
pub struct Candidates {
    popup: PopupSurface,
    /// The app id it was announced as, while it shows.
    shown: Option<String>,
    /// Its size as last drawn, logical.
    size: (f64, f64),
}

impl TextInput {
    /// Advertises the managers. Every client may be an editor; only an
    /// unsandboxed one may be an input method or a virtual keyboard, since
    /// either can type into any window.
    pub fn advertise(display: &DisplayHandle) -> Self {
        Self {
            _text_input: TextInputManagerState::new::<DomicileCompositor>(display),
            _input_method: InputMethodManagerState::new::<DomicileCompositor, _>(
                display,
                crate::clients::sees_privileged_globals,
            ),
            _virtual_keyboard: VirtualKeyboardManagerState::new::<DomicileCompositor, _>(
                display,
                crate::clients::sees_privileged_globals,
            ),
            input_method_bound: false,
            candidates: None,
        }
    }
}

/// Smithay calls these as the editor with the keyboard changes and as it moves
/// its text cursor. See [`Candidates`].
impl InputMethodHandler for DomicileCompositor {
    fn new_popup(&mut self, popup: PopupSurface) {
        debug!("input method: a candidate list over the editor");
        self.hide_the_candidates();
        self.text_input.candidates = Some(Candidates {
            popup,
            shown: None,
            size: (0.0, 0.0),
        });
        self.put_the_candidates_on_their_display();
    }

    fn dismiss_popup(&mut self, _: PopupSurface) {
        debug!("input method: the editor lost the keyboard; its candidate list goes");
        self.hide_the_candidates();
        self.text_input.candidates = None;
    }

    fn popup_repositioned(&mut self, _: PopupSurface) {
        self.move_the_candidates();
    }

    /// Not used: the candidate list is placed from the editor's window
    /// geometry when it shows.
    fn parent_geometry(&self, _: &WlSurface) -> Rectangle<i32, Logical> {
        Rectangle::default()
    }
}

impl DomicileCompositor {
    /// The surface the candidate list is over: the editor with the keyboard.
    pub fn candidates_editor(&self) -> Option<WlSurface> {
        let candidates = self.text_input.candidates.as_ref()?;
        Some(candidates.popup.get_parent()?.surface.clone())
    }

    /// Announce the candidate list once it draws, resize it as it draws again,
    /// and close it when it attaches no buffer. Runs on every commit.
    pub fn place_the_candidates(&mut self, surface: &WlSurface) {
        let Some(candidates) = &self.text_input.candidates else {
            return;
        };
        if candidates.popup.wl_surface() != surface {
            return;
        }
        let drawn = with_states(surface, |states| {
            let mut attributes = states.cached_state.get::<SurfaceAttributes>();
            match attributes.current().buffer {
                Some(BufferAssignment::NewBuffer(_)) => Some(true),
                Some(BufferAssignment::Removed) => Some(false),
                None => None,
            }
        });
        match drawn {
            Some(true) => {}
            Some(false) => return self.hide_the_candidates(),
            None => return,
        }
        let Some(size) = crate::popups::drawn_size(surface) else {
            return;
        };
        let candidates = self.text_input.candidates.as_mut().expect("checked above");
        candidates.size = size;
        if candidates.shown.is_some() {
            self.move_the_candidates();
            return;
        }
        let Some((parent, position, bounds)) = self.where_the_candidates_go() else {
            return;
        };
        let placed = self
            .hub
            .host
            .lock()
            .unwrap()
            .popup_placed(&parent, position, size, false);
        let Some((app_id, message)) = placed else {
            return;
        };
        debug!(%app_id, %parent, "candidate list drawn -> Host::popup_placed");
        self.place_window(surface, bounds);
        self.presentations.appeared(&app_id);
        self.by_surface
            .insert(surface.clone(), (app_id.clone(), Role::Candidates));
        self.text_input
            .candidates
            .as_mut()
            .expect("checked above")
            .shown = Some(app_id);
        self.hub.broadcast(message);
    }

    /// Place the shown candidate list again, after the editor's text cursor
    /// or window moved.
    pub fn move_the_candidates(&self) {
        let Some(app_id) = self
            .text_input
            .candidates
            .as_ref()
            .and_then(|candidates| candidates.shown.clone())
        else {
            return self.put_the_candidates_on_their_display();
        };
        let Some((_, position, bounds)) = self.where_the_candidates_go() else {
            return;
        };
        let size = self.text_input.candidates.as_ref().expect("shown").size;
        let moved = self
            .hub
            .host
            .lock()
            .unwrap()
            .popup_moved(&app_id, position, size);
        if let Some(message) = moved {
            debug!(%app_id, "the editor's text cursor moved -> Host::popup_moved");
            self.hub.broadcast(message);
        }
        if let Some(candidates) = &self.text_input.candidates {
            self.place_window(candidates.popup.wl_surface(), bounds);
        }
    }

    /// Put the candidate list on the display it will show on, so the input
    /// method draws it at that display's scale.
    pub fn put_the_candidates_on_their_display(&self) {
        let Some(candidates) = &self.text_input.candidates else {
            return;
        };
        if let Some((_, _, bounds)) = self.where_the_candidates_go() {
            self.place_window(candidates.popup.wl_surface(), bounds);
        }
    }

    /// The editor's app id, where the candidate list goes relative to its
    /// window geometry, and where that is on the desktop if the page has
    /// placed the window. `None` while it is over no announced window.
    fn where_the_candidates_go(
        &self,
    ) -> Option<(String, (f64, f64), Option<domicile_scene::Bounds>)> {
        let candidates = self.text_input.candidates.as_ref()?;
        let editor = candidates.popup.get_parent()?.surface.clone();
        let app_id = self.app_id_of(&editor)?;
        let geometry = with_states(&editor, crate::surface_commit::window_geometry)
            .map_or((0, 0), |(x, y, _, _)| (x, y));
        let window = self.bounds_of(&editor);
        let screen = window.and_then(|window| self.screens.screen_of(window));
        // The list is placed in the editor's logical units, which a zoomed
        // window draws larger on the desktop.
        let zoom = self.zoom_of(&editor);
        let corner = domicile_scene::Point { x: 0.0, y: 0.0 };
        let position = under_the_cursor(
            candidates.popup.text_input_rectangle(),
            geometry,
            candidates.size,
            window.zip(screen).map(|(window, screen)| {
                (
                    domicile_scene::Bounds {
                        min: corner,
                        max: corner,
                    },
                    crate::scale::screen_in_window(window.min, screen, zoom),
                )
            }),
        );
        let bounds = window.map(|window| {
            let min = domicile_scene::Point {
                x: window.min.x + position.0 * zoom,
                y: window.min.y + position.1 * zoom,
            };
            domicile_scene::Bounds {
                min,
                max: domicile_scene::Point {
                    x: min.x + candidates.size.0 * zoom,
                    y: min.y + candidates.size.1 * zoom,
                },
            }
        });
        Some((app_id, position, bounds))
    }

    /// Close the candidate list if it shows. The input method keeps it, and it
    /// shows again at its next frame.
    fn hide_the_candidates(&mut self) {
        let Some(app_id) = self
            .text_input
            .candidates
            .as_mut()
            .and_then(|candidates| candidates.shown.take())
        else {
            return;
        };
        let surface = self
            .text_input
            .candidates
            .as_ref()
            .expect("it was shown")
            .popup
            .wl_surface()
            .clone();
        self.by_surface.remove(&surface);
        debug!(%app_id, "candidate list hidden -> Host::app_closed");
        self.forget(&app_id);
    }

    /// Forget the candidate list once its surface is destroyed.
    pub fn candidates_destroyed(&mut self, surface: &WlSurface) {
        let ours = self
            .text_input
            .candidates
            .as_ref()
            .is_some_and(|candidates| candidates.popup.wl_surface() == surface);
        if ours {
            self.hide_the_candidates();
            self.text_input.candidates = None;
        }
    }

    /// Forget the candidate list once its popup role or its input method is
    /// destroyed: the editor sees no more of it.
    fn candidates_gone(&mut self, why: &str) {
        if self.text_input.candidates.is_some() {
            debug!("input method: {why}; its candidate list goes");
            self.hide_the_candidates();
            self.text_input.candidates = None;
        }
    }
}

/// Where a candidate list of `size` goes relative to the editor's window
/// geometry: under the text cursor `cursor` (surface-local, as text-input-v3
/// gives it), with `geometry` the window geometry's corner on the surface.
///
/// With the window's and its screen's bounds, it goes above the cursor when
/// under it would leave the screen's bottom, and is kept from the screen's
/// sides, as sway does.
fn under_the_cursor(
    cursor: Rectangle<i32, Logical>,
    geometry: (i32, i32),
    size: (f64, f64),
    on_screen: Option<(domicile_scene::Bounds, domicile_scene::Bounds)>,
) -> (f64, f64) {
    let x = f64::from(cursor.loc.x - geometry.0);
    let top = f64::from(cursor.loc.y - geometry.1);
    let under = top + f64::from(cursor.size.h);
    let Some((window, screen)) = on_screen else {
        return (x, under);
    };
    let y = if window.min.y + under + size.1 > screen.max.y
        && window.min.y + top - size.1 >= screen.min.y
    {
        top - size.1
    } else {
        under
    };
    let x = x
        .min(screen.max.x - window.min.x - size.0)
        .max(screen.min.x - window.min.x);
    (x, y)
}

delegate_text_input_manager!(DomicileCompositor);

// Smithay's `delegate_input_method_manager!`, but with the manager and each
// input method through `DomicileCompositor`, for the rules in the module docs.
smithay::reexports::wayland_server::delegate_global_dispatch!(DomicileCompositor: [
    ZwpInputMethodManagerV2: InputMethodManagerGlobalData
] => InputMethodManagerState);
smithay::reexports::wayland_server::delegate_dispatch!(DomicileCompositor: [
    ZwpInputMethodKeyboardGrabV2: smithay::wayland::input_method::InputMethodKeyboardUserData<DomicileCompositor>
] => InputMethodManagerState);

// Smithay's `delegate_virtual_keyboard_manager!`, but with each virtual
// keyboard through `DomicileCompositor`, for the lock rule in the module docs.
smithay::reexports::wayland_server::delegate_global_dispatch!(DomicileCompositor: [
    ZwpVirtualKeyboardManagerV1: VirtualKeyboardManagerGlobalData
] => VirtualKeyboardManagerState);
smithay::reexports::wayland_server::delegate_dispatch!(DomicileCompositor: [
    ZwpVirtualKeyboardManagerV1: ()
] => VirtualKeyboardManagerState);

impl Dispatch<ZwpInputMethodManagerV2, ()> for DomicileCompositor {
    fn request(
        state: &mut Self,
        client: &Client,
        manager: &ZwpInputMethodManagerV2,
        request: zwp_input_method_manager_v2::Request,
        data: &(),
        display: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        let binding = matches!(
            request,
            zwp_input_method_manager_v2::Request::GetInputMethod { .. }
        );
        if binding && state.text_input.input_method_bound {
            let zwp_input_method_manager_v2::Request::GetInputMethod { input_method, .. } = request
            else {
                unreachable!("matched above")
            };
            debug!("input method: the seat has one already; this one is unavailable");
            init.init(input_method, Unavailable).unavailable();
            return;
        }
        <InputMethodManagerState as Dispatch<ZwpInputMethodManagerV2, (), Self>>::request(
            state, client, manager, request, data, display, init,
        );
        if binding {
            debug!("input method: bound to the seat");
            state.text_input.input_method_bound = true;
        }
    }
}

impl Dispatch<ZwpInputMethodV2, InputMethodUserData<DomicileCompositor>> for DomicileCompositor {
    fn request(
        state: &mut Self,
        client: &Client,
        input_method: &ZwpInputMethodV2,
        request: zwp_input_method_v2::Request,
        data: &InputMethodUserData<Self>,
        display: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        let writes = matches!(
            request,
            zwp_input_method_v2::Request::CommitString { .. }
                | zwp_input_method_v2::Request::SetPreeditString { .. }
                | zwp_input_method_v2::Request::DeleteSurroundingText { .. }
                | zwp_input_method_v2::Request::Commit { .. }
        );
        if writes && state.the_desk_is_locked() {
            debug!("input method: the desk is locked; its text reaches no editor");
            return;
        }
        <InputMethodManagerState as Dispatch<ZwpInputMethodV2, _, Self>>::request(
            state,
            client,
            input_method,
            request,
            data,
            display,
            init,
        );
    }

    fn destroyed(
        state: &mut Self,
        client: ClientId,
        input_method: &ZwpInputMethodV2,
        data: &InputMethodUserData<Self>,
    ) {
        <InputMethodManagerState as Dispatch<ZwpInputMethodV2, _, Self>>::destroyed(
            state,
            client,
            input_method,
            data,
        );
        debug!("input method: gone; the seat takes another");
        state.text_input.input_method_bound = false;
        state.candidates_gone("gone");
    }
}

impl Dispatch<ZwpInputPopupSurfaceV2, InputMethodPopupSurfaceUserData> for DomicileCompositor {
    fn request(
        state: &mut Self,
        client: &Client,
        popup: &ZwpInputPopupSurfaceV2,
        request: zwp_input_popup_surface_v2::Request,
        data: &InputMethodPopupSurfaceUserData,
        display: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        <InputMethodManagerState as Dispatch<ZwpInputPopupSurfaceV2, _, Self>>::request(
            state, client, popup, request, data, display, init,
        );
    }

    fn destroyed(
        state: &mut Self,
        client: ClientId,
        popup: &ZwpInputPopupSurfaceV2,
        data: &InputMethodPopupSurfaceUserData,
    ) {
        <InputMethodManagerState as Dispatch<ZwpInputPopupSurfaceV2, _, Self>>::destroyed(
            state, client, popup, data,
        );
        let ours = state
            .text_input
            .candidates
            .as_ref()
            .is_some_and(|candidates| candidates.popup.surface_role.id() == popup.id());
        if ours {
            state.candidates_gone("its popup was destroyed");
        }
    }
}

/// An input method, or one of its objects, that arrived while the seat had
/// one. It is told `unavailable` and does nothing; its client should destroy
/// it. Its requests are ignored rather than refused, since a client can send
/// some before it hears `unavailable`.
pub struct Unavailable;

impl Dispatch<ZwpInputMethodV2, Unavailable> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &ZwpInputMethodV2,
        request: zwp_input_method_v2::Request,
        _: &Unavailable,
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        match request {
            zwp_input_method_v2::Request::GetInputPopupSurface { id, .. } => {
                init.init(id, Unavailable);
            }
            zwp_input_method_v2::Request::GrabKeyboard { keyboard } => {
                init.init(keyboard, Unavailable);
            }
            _ => {}
        }
    }
}

impl Dispatch<ZwpInputPopupSurfaceV2, Unavailable> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &ZwpInputPopupSurfaceV2,
        _: zwp_input_popup_surface_v2::Request,
        _: &Unavailable,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}

impl Dispatch<ZwpInputMethodKeyboardGrabV2, Unavailable> for DomicileCompositor {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &ZwpInputMethodKeyboardGrabV2,
        _: zwp_input_method_keyboard_grab_v2::Request,
        _: &Unavailable,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}

impl Dispatch<ZwpVirtualKeyboardV1, VirtualKeyboardUserData<DomicileCompositor>>
    for DomicileCompositor
{
    fn request(
        state: &mut Self,
        client: &Client,
        keyboard: &ZwpVirtualKeyboardV1,
        request: zwp_virtual_keyboard_v1::Request,
        data: &VirtualKeyboardUserData<Self>,
        display: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        // A press while locked is dropped. A release still goes through, so a
        // key pressed before the lock does not stay down in the window.
        if let zwp_virtual_keyboard_v1::Request::Key { state: 1, .. } = request {
            if state.the_desk_is_locked() {
                debug!("virtual keyboard: the desk is locked; its press reaches no window");
                return;
            }
        }
        <VirtualKeyboardManagerState as Dispatch<ZwpVirtualKeyboardV1, _, Self>>::request(
            state, client, keyboard, request, data, display, init,
        );
    }

    fn destroyed(
        state: &mut Self,
        client: ClientId,
        keyboard: &ZwpVirtualKeyboardV1,
        data: &VirtualKeyboardUserData<Self>,
    ) {
        <VirtualKeyboardManagerState as Dispatch<ZwpVirtualKeyboardV1, _, Self>>::destroyed(
            state, client, keyboard, data,
        );
    }
}

#[cfg(test)]
mod tests {
    use domicile_scene::{Bounds, Point};
    use smithay::utils::Rectangle;

    use super::under_the_cursor;

    fn bounds(min: (f64, f64), max: (f64, f64)) -> Bounds {
        Bounds {
            min: Point { x: min.0, y: min.1 },
            max: Point { x: max.0, y: max.1 },
        }
    }

    /// A screen 1920 by 1080 at the desktop's corner.
    fn a_screen() -> Bounds {
        bounds((0.0, 0.0), (1920.0, 1080.0))
    }

    fn a_cursor(x: i32, y: i32) -> Rectangle<i32, smithay::utils::Logical> {
        Rectangle::new((x, y).into(), (2, 18).into())
    }

    #[test]
    fn the_list_goes_under_the_cursor_from_the_window_geometrys_corner() {
        assert_eq!(
            under_the_cursor(a_cursor(40, 30), (10, 5), (120.0, 30.0), None),
            (30.0, 43.0)
        );
    }

    #[test]
    fn the_list_goes_above_a_cursor_near_the_screens_bottom() {
        let window = bounds((100.0, 900.0), (900.0, 1080.0));
        assert_eq!(
            under_the_cursor(
                a_cursor(40, 150),
                (0, 0),
                (120.0, 30.0),
                Some((window, a_screen()))
            ),
            (40.0, 120.0),
            "under the cursor its bottom would be at 1098"
        );
    }

    #[test]
    fn the_list_stays_under_a_cursor_with_no_room_above_either() {
        let window = bounds((0.0, 0.0), (1920.0, 1080.0));
        assert_eq!(
            under_the_cursor(
                a_cursor(40, 10),
                (0, 0),
                (120.0, 1075.0),
                Some((window, a_screen()))
            ),
            (40.0, 28.0)
        );
    }

    #[test]
    fn the_list_is_kept_from_the_screens_sides() {
        let window = bounds((1800.0, 100.0), (2400.0, 600.0));
        assert_eq!(
            under_the_cursor(
                a_cursor(100, 30),
                (0, 0),
                (120.0, 30.0),
                Some((window, a_screen()))
            ),
            (0.0, 48.0),
            "its right edge stops at the screen's"
        );
        let window = bounds((-50.0, 100.0), (600.0, 600.0));
        assert_eq!(
            under_the_cursor(
                a_cursor(10, 30),
                (0, 0),
                (120.0, 30.0),
                Some((window, a_screen()))
            ),
            (50.0, 48.0),
            "its left edge stops at the screen's"
        );
    }
}
