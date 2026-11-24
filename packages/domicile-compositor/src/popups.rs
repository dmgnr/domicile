//! Popups: announcing and placing them over their windows, keeping menus on
//! screen, and dismissing them.

use domicile_protocol::HostMessage;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Point, Rectangle, Transform};
use smithay::wayland::viewporter::ViewportCachedState;
use smithay::wayland::{
    compositor::{get_role, is_sync_subsurface, with_states, BufferAssignment, SurfaceAttributes},
    shell::xdg::{PopupSurface, PositionerState, XdgPopupSurfaceData, XDG_POPUP_ROLE},
};
use tracing::debug;

use crate::buffer_transform::upright_size;
use crate::surface_commit::{committed_buffer, Role};
use crate::viewport::{surface_size, Viewport};
use crate::DomicileCompositor;

impl DomicileCompositor {
    /// Announce a window's popup on its first buffer commit.
    ///
    /// A popup that never draws needs no placement. Popups over the chrome's
    /// own window belong to the engine and are ignored.
    pub fn announce_a_new_popup(&mut self, surface: &WlSurface) {
        if get_role(surface) != Some(XDG_POPUP_ROLE) || self.by_surface.contains_key(surface) {
            return;
        }
        let Some(popup) = self
            .xdg_shell_state
            .popup_surfaces()
            .iter()
            .find(|popup| popup.wl_surface() == surface)
            .cloned()
        else {
            return;
        };
        let has_a_buffer = with_states(surface, |states| {
            let mut attributes = states.cached_state.get::<SurfaceAttributes>();
            matches!(
                attributes.current().buffer,
                Some(BufferAssignment::NewBuffer(_))
            )
        });
        let Some(parent) = popup
            .get_parent_surface()
            .and_then(|parent| self.app_id_of(&parent))
        else {
            return;
        };
        if !has_a_buffer {
            return;
        }
        let (position, size) = committed_placement(surface);
        let placed = self.hub.host.lock().unwrap().popup_placed(
            &parent,
            position,
            size,
            self.grabbing.contains(&popup),
        );
        if let Some((app_id, message)) = placed {
            debug!(%app_id, %parent, "popup mapped -> Host::popup_placed");
            self.presentations.appeared(&app_id);
            self.by_surface.insert(
                surface.clone(),
                (app_id.clone(), Role::Popup(popup.clone())),
            );
            self.popups.push((app_id, popup));
            self.hub.broadcast(message);
        }
    }

    /// Place a popup again once its client commits a reposition
    /// (`xdg_popup.reposition`), with the frame that commit submits.
    pub fn place_a_repositioned_popup(&mut self, surface: &WlSurface) {
        let Some((app_id, _)) = self
            .popups
            .iter()
            .find(|(_, popup)| popup.wl_surface() == surface)
        else {
            return;
        };
        let (position, size) = committed_placement(surface);
        let moved = self
            .hub
            .host
            .lock()
            .unwrap()
            .popup_moved(app_id, position, size);
        if let Some(message) = moved {
            self.tell_the_move(message);
        }
    }

    /// Tell the chromes a popup moved: at once, or, if frames sync, once its
    /// commit transaction is applied. See
    /// `docs/architecture/WINDOW-COMPOSITING.md#synced-frames`.
    fn tell_the_move(&mut self, moved: HostMessage) {
        if self.syncs_frames() {
            self.synced_moves.hold(moved);
        } else {
            self.hub.broadcast(moved);
        }
    }

    /// Whether the engine and every chrome sync frames.
    fn syncs_frames(&self) -> bool {
        self.engine
            .as_ref()
            .is_some_and(|session| session.syncs_frames())
            && self.hub.syncs_frames()
    }

    /// Sync `app_id`'s next submit if it goes with a held move. Called just
    /// before the submit, so the frame is named only once it is submitted.
    pub fn sync_with_the_moves(&mut self, app_id: &str) {
        if !self.synced_moves.awaited() {
            return;
        }
        let Some(frame) = self.hub.host.lock().unwrap().sync_frame(app_id) else {
            return;
        };
        let session = self.engine.as_mut().expect("a held move needs an engine");
        if session.sync(app_id, frame) {
            self.synced_moves.synced(app_id, frame);
        }
    }

    /// Tell the chromes the moves a commit transaction held, once its last
    /// commit is applied. Smithay applies a sync subsurface's commit before
    /// its parent's (`Transaction::apply`).
    pub fn tell_the_held_moves(&mut self, surface: &WlSurface) {
        if is_sync_subsurface(surface) {
            return;
        }
        for moved in self.synced_moves.release() {
            self.hub.broadcast(moved);
        }
    }

    /// The window a popup is over, however many popups deep: the app id of
    /// the toplevel at the bottom of its chain.
    pub fn window_under(&self, popup: &PopupSurface) -> Option<String> {
        let mut parent = popup.get_parent_surface()?;
        loop {
            match self
                .popups
                .iter()
                .find(|(_, popup)| *popup.wl_surface() == parent)
            {
                Some((_, popup)) => parent = popup.get_parent_surface()?,
                None => return self.app_id_of(&parent),
            }
        }
    }

    /// Every grabbing popup dismissed, innermost first, as xdg-shell wants.
    pub fn dismiss_the_menus(&mut self) {
        if !self.grabbing.is_empty() {
            debug!(menus = self.grabbing.len(), "dismissing the open menus");
        }
        for menu in self.grabbing.drain(..).rev() {
            menu.send_popup_done();
        }
    }

    /// Where `positioner` puts `popup`, adjusted as its
    /// `constraint_adjustment` allows to stay on its window's screen
    /// ([`Screens::screen_of`]).
    ///
    /// As given when there is no screen to keep it on: it has no parent yet (a
    /// layer surface's popup), or the page has not put its window on a screen.
    pub fn kept_on_screen(
        &self,
        popup: &PopupSurface,
        positioner: PositionerState,
    ) -> Rectangle<i32, Logical> {
        let placed = popup.get_parent_surface().and_then(|parent| {
            let window = self.bounds_of(&self.window_under_menus(&parent))?;
            Some((parent, window, self.screens.screen_of(window)?))
        });
        match placed {
            None => positioner.get_geometry(),
            Some((parent, window, screen)) => {
                // The positioner works relative to the parent's geometry, in
                // its window's logical units, which a zoomed window draws
                // larger on the desktop.
                let screen =
                    crate::scale::screen_in_window(window.min, screen, self.zoom_of(&parent));
                let target = Rectangle::<f64, Logical>::new(
                    Point::from((screen.min.x, screen.min.y)) - self.menu_offset(&parent).to_f64(),
                    (screen.max.x - screen.min.x, screen.max.y - screen.min.y).into(),
                );
                positioner.get_unconstrained_geometry(target.to_i32_round())
            }
        }
    }

    /// Where `popup` is on the desktop: its window's bounds moved by where the
    /// menu is over the window, at the size it was configured to.
    ///
    /// `None`, like a window the page has not placed, when its window has no
    /// bounds: it has no parent (a layer surface's popup), or the page has
    /// not put the window on a screen.
    pub fn popup_bounds(&self, popup: &PopupSurface) -> Option<domicile_scene::Bounds> {
        let window = self.bounds_of(&self.window_under_menus(popup.wl_surface()))?;
        let at = self.menu_offset(popup.wl_surface());
        let size = popup.with_pending_state(|state| state.geometry.size);
        // The popup is in its window's logical units, which a zoomed window
        // draws larger on the desktop.
        let zoom = self.zoom_of(popup.wl_surface());
        let min = domicile_scene::Point {
            x: window.min.x + f64::from(at.x) * zoom,
            y: window.min.y + f64::from(at.y) * zoom,
        };
        Some(domicile_scene::Bounds {
            min,
            max: domicile_scene::Point {
                x: min.x + f64::from(size.w) * zoom,
                y: min.y + f64::from(size.h) * zoom,
            },
        })
    }

    /// Place each popup open over the window `surface` again, after it moved.
    pub fn place_the_popups_over(&self, surface: &WlSurface) {
        for popup in self.xdg_shell_state.popup_surfaces() {
            if self.window_under_menus(popup.wl_surface()) == *surface {
                self.place_window(popup.wl_surface(), self.popup_bounds(popup));
            }
        }
        if self.candidates_editor().as_ref() == Some(surface) {
            self.move_the_candidates();
        }
    }

    /// Where `surface` is relative to the window under its menus: the sum of
    /// their positions, or zero for a surface that is not a menu.
    fn menu_offset(&self, surface: &WlSurface) -> Point<i32, Logical> {
        self.xdg_shell_state
            .popup_surfaces()
            .iter()
            .find(|popup| popup.wl_surface() == surface)
            .map_or_else(Point::default, |popup| {
                let at = popup.with_pending_state(|state| state.geometry.loc);
                popup
                    .get_parent_surface()
                    .map_or(at, |parent| at + self.menu_offset(&parent))
            })
    }

    /// The window a menu (or nested menu) was opened over, or `surface` itself
    /// if it is not a menu.
    ///
    /// Asks the shell, not `popups`, because a menu grabs the keyboard before
    /// it has drawn.
    pub fn window_under_menus(&self, surface: &WlSurface) -> WlSurface {
        self.xdg_shell_state
            .popup_surfaces()
            .iter()
            .find(|popup| popup.wl_surface() == surface)
            .and_then(|popup| popup.get_parent_surface())
            .map_or_else(
                || surface.clone(),
                |parent| self.window_under_menus(&parent),
            )
    }
}

/// The logical size of the buffer `surface` is committing, or `None` if it
/// commits none.
pub fn drawn_size(surface: &WlSurface) -> Option<(f64, f64)> {
    with_states(surface, |states| {
        let viewport = Viewport::from(&*states.cached_state.get::<ViewportCachedState>().current());
        let mut attributes = states.cached_state.get::<SurfaceAttributes>();
        let attributes = attributes.current();
        let Some(BufferAssignment::NewBuffer(buffer)) = &attributes.buffer else {
            return None;
        };
        let (width, height) = surface_size(
            upright_size(
                committed_buffer(buffer)?.size(),
                Transform::from(attributes.buffer_transform),
            ),
            attributes.buffer_scale,
            viewport.size,
        );
        Some((f64::from(width), f64::from(height)))
    })
}

/// Where a popup is over its parent and its size, logical, as its client last
/// committed them: the configure it acked before this commit.
fn committed_placement(surface: &WlSurface) -> ((f64, f64), (f64, f64)) {
    let geometry = with_states(surface, |states| {
        states
            .data_map
            .get::<XdgPopupSurfaceData>()
            .expect("an xdg popup's surface has its role data")
            .lock()
            .unwrap()
            .current
            .geometry
    });
    (
        (f64::from(geometry.loc.x), f64::from(geometry.loc.y)),
        (f64::from(geometry.size.w), f64::from(geometry.size.h)),
    )
}
