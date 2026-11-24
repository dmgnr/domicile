//! Subsurfaces (`wl_subsurface`): drawn inside their window's frame, and
//! hit-tested here for pointer and touch.
//!
//! Each subsurface is an engine surface of its own, under an id the compositor
//! gives it and the host never sees. Its parent's frames embed it at its place
//! (`domicile_surface_set_children`), so it moves, scales and fades with its
//! window the way any other compositor draws one. The chrome sends input for
//! the window, and the compositor finds the subsurface under it, as Smithay's
//! own `under_from_surface_tree` would. See
//! `docs/architecture/WINDOW-COMPOSITING.md#subsurfaces`.

use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::Resource as _;
use smithay::utils::{Logical, Point};
use smithay::wayland::compositor::{
    get_parent, is_sync_subsurface, with_states, with_surface_tree_upward, SubsurfaceCachedState,
    SurfaceAttributes, TraversalAction,
};
use tracing::debug;

use crate::engine_session::Child;
use crate::surface_commit::{window_geometry, Role};
use crate::DomicileCompositor;

/// A subsurface of a window, a popup or another subsurface. See
/// `DomicileCompositor::subsurfaces`.
pub struct Subsurface {
    /// The id the compositor gave it. The host never sees it.
    pub app_id: String,
    pub surface: WlSurface,
    /// The surface it is a subsurface of. Kept because a hidden one is no
    /// longer its child.
    pub parent: WlSurface,
}

impl DomicileCompositor {
    /// A commit of `surface`, before its frame goes up: start or stop
    /// tracking it as a subsurface, forget the subsurfaces it no longer has,
    /// and tell the engine its own subsurfaces. Returns whether those changed.
    ///
    /// Chromium hides a subsurface by destroying its `wl_subsurface` and
    /// keeping the surface, so a hidden one is noticed at the next commit of
    /// it or its parent.
    pub fn place_the_subsurfaces(&mut self, surface: &WlSurface) -> bool {
        let hidden: Vec<WlSurface> = self
            .subsurfaces
            .iter()
            .filter(|tracked| {
                (tracked.parent == *surface || tracked.surface == *surface)
                    && get_parent(&tracked.surface).as_ref() != Some(&tracked.parent)
            })
            .map(|tracked| tracked.surface.clone())
            .collect();
        for gone in hidden {
            self.subsurface_gone(&gone);
        }
        let _ = self.subsurface_id(surface);
        self.set_the_children(surface)
    }

    /// A commit of `surface`, after its frame went up: show what changed of
    /// its subsurfaces, and its new size in its parent's frame.
    ///
    /// `children_changed` is what [`DomicileCompositor::place_the_subsurfaces`]
    /// returned, and `drew` whether the commit put up a frame of its own,
    /// which shows them already. A sync subsurface's parent commits next in
    /// the same transaction, and its frame shows the subsurface's.
    pub fn show_the_subsurfaces(
        &mut self,
        surface: &WlSurface,
        children_changed: bool,
        drew: bool,
    ) {
        if children_changed && !drew {
            self.redraw(surface);
        }
        if is_sync_subsurface(surface) || !self.is_a_subsurface(surface) {
            return;
        }
        if let Some(parent) = get_parent(surface) {
            if self.set_the_children(&parent) {
                self.redraw(&parent);
            }
        }
    }

    /// A destroyed subsurface goes at once: no commit will come to notice it.
    pub fn subsurface_destroyed(&mut self, surface: &WlSurface) {
        if self.is_a_subsurface(surface) {
            self.subsurface_gone(surface);
        }
    }

    /// The surface that takes the pointer at `at`, a point on `surface`, and
    /// the point on it.
    ///
    /// The topmost subsurface whose input region holds the point, as any
    /// compositor hit-tests a surface tree, or else `surface` itself, which
    /// the chrome found under the pointer. Firefox draws its whole window
    /// into a subsurface with an empty input region and reads the pointer
    /// only on its toplevel.
    pub fn input_target(&self, surface: WlSurface, at: (f64, f64)) -> (WlSurface, (f64, f64)) {
        let (target, origin) = self.input_origin(&surface, at);
        (target, (at.0 - origin.0, at.1 - origin.1))
    }

    /// As [`DomicileCompositor::input_target`], but with where the target's
    /// top left is on `surface`, as a touch focus takes it.
    pub fn input_origin(&self, surface: &WlSurface, at: (f64, f64)) -> (WlSurface, (f64, f64)) {
        self.hit(surface, at, None)
            .unwrap_or_else(|| (surface.clone(), (0.0, 0.0)))
    }

    /// The topmost surface of `surface`'s tree that takes input at `at`, a
    /// point on it, and its origin on `surface`. `bounds` is `surface`'s own
    /// size, past which it takes nothing; its subsurfaces may reach further.
    fn hit(
        &self,
        surface: &WlSurface,
        at: (f64, f64),
        bounds: Option<(f64, f64)>,
    ) -> Option<(WlSurface, (f64, f64))> {
        let stack = stacked(surface);
        let in_child = |(child, _): &(WlSurface, bool)| {
            let size = self.subsurface_size(child)?;
            let location = subsurface_location(child);
            let (x, y) = (f64::from(location.x), f64::from(location.y));
            let (hit, origin) = self.hit(child, (at.0 - x, at.1 - y), Some(size))?;
            Some((hit, (origin.0 + x, origin.1 + y)))
        };
        let above = stack.iter().rev().filter(|(_, above)| *above);
        let below = stack.iter().rev().filter(|(_, above)| !*above);
        let within = bounds.is_none_or(|(width, height)| {
            (0.0..width).contains(&at.0) && (0.0..height).contains(&at.1)
        });
        above
            .filter_map(in_child)
            .next()
            .or_else(|| (within && takes_input(surface, at)).then(|| (surface.clone(), (0.0, 0.0))))
            .or_else(|| below.filter_map(in_child).next())
    }

    /// The logical size of a subsurface's last buffer, or `None` if it shows
    /// none, so it and its own subsurfaces are not drawn.
    fn subsurface_size(&self, surface: &WlSurface) -> Option<(f64, f64)> {
        let tracked = self
            .subsurfaces
            .iter()
            .find(|tracked| tracked.surface == *surface)?;
        Some(self.last_buffers.get(&tracked.app_id)?.logical_size())
    }

    fn is_a_subsurface(&self, surface: &WlSurface) -> bool {
        self.subsurfaces
            .iter()
            .any(|tracked| tracked.surface == *surface)
    }

    /// The id of `surface` if it is a subsurface of a surface the compositor
    /// knows, tracked from now if new.
    fn subsurface_id(&mut self, surface: &WlSurface) -> Option<String> {
        if let Some(tracked) = self
            .subsurfaces
            .iter()
            .find(|tracked| tracked.surface == *surface)
        {
            return Some(tracked.app_id.clone());
        }
        let parent = get_parent(surface)?;
        if !self.by_surface.contains_key(&parent) {
            return None;
        }
        self.next_subsurface += 1;
        let app_id = format!("subsurface-{}", self.next_subsurface);
        debug!(%app_id, surface = %surface.id(), "a subsurface");
        self.by_surface
            .insert(surface.clone(), (app_id.clone(), Role::Subsurface));
        self.subsurfaces.push(Subsurface {
            app_id: app_id.clone(),
            surface: surface.clone(),
            parent,
        });
        Some(app_id)
    }

    /// Stop tracking a hidden or destroyed subsurface, and draw its parent
    /// without it.
    fn subsurface_gone(&mut self, surface: &WlSurface) {
        let Some(at) = self
            .subsurfaces
            .iter()
            .position(|tracked| tracked.surface == *surface)
        else {
            return;
        };
        let gone = self.subsurfaces.remove(at);
        self.by_surface.remove(&gone.surface);
        if self.pointer_surface.as_ref() == Some(&gone.surface) {
            self.pointer_surface = None;
        }
        debug!(app_id = %gone.app_id, "a subsurface went");
        self.forget_the_drawing(&gone.app_id);
        if gone.parent.is_alive() && self.set_the_children(&gone.parent) {
            self.redraw(&gone.parent);
        }
    }

    /// `surface`'s subsurfaces as its frames draw them, bottom to top. Those
    /// with no buffer are left out.
    fn children_of(&mut self, surface: &WlSurface) -> Vec<Child> {
        let (x, y) = with_states(surface, window_geometry).map_or((0, 0), |(x, y, _, _)| (x, y));
        stacked(surface)
            .into_iter()
            .filter_map(|(child, above)| {
                let app_id = self.subsurface_id(&child)?;
                let size = self.last_buffers.get(&app_id)?.logical_size();
                let location = subsurface_location(&child);
                Some(Child {
                    app_id,
                    position: (f64::from(location.x - x), f64::from(location.y - y)),
                    size,
                    above,
                })
            })
            .collect()
    }

    /// Tell the engine `surface`'s subsurfaces, and whether they changed.
    fn set_the_children(&mut self, surface: &WlSurface) -> bool {
        let Some(app_id) = self.app_id_of(surface) else {
            return false;
        };
        let children = self.children_of(surface);
        self.engine
            .as_mut()
            .is_some_and(|session| session.set_children(&app_id, children))
    }

    /// Show `surface`'s last frame again, with its subsurfaces as last set.
    fn redraw(&self, surface: &WlSurface) {
        if let (Some(app_id), Some(session)) = (self.app_id_of(surface), self.engine.as_ref()) {
            session.redraw(&app_id);
        }
    }
}

/// `surface`'s own subsurfaces, bottom to top, each with whether it is over
/// `surface` rather than under it.
pub fn stacked(surface: &WlSurface) -> Vec<(WlSurface, bool)> {
    let mut order = Vec::new();
    // Smithay keeps a surface in its own list of children, in its place.
    with_surface_tree_upward(
        surface,
        true,
        |_, _, root| {
            if *root {
                TraversalAction::DoChildren(false)
            } else {
                TraversalAction::SkipChildren
            }
        },
        |each, _, _| order.push(each.clone()),
        |_, _, _| true,
    );
    let own = order
        .iter()
        .position(|each| each == surface)
        .expect("a surface is in its own stack");
    order
        .into_iter()
        .enumerate()
        .filter(|(at, _)| *at != own)
        .map(|(at, child)| (child, at > own))
        .collect()
}

/// A subsurface's position on its parent, logical.
fn subsurface_location(surface: &WlSurface) -> Point<i32, Logical> {
    with_states(surface, |states| {
        states
            .cached_state
            .get::<SubsurfaceCachedState>()
            .current()
            .location
    })
}

/// Whether `surface`'s input region holds `at`, a point on it. No region is
/// the whole surface.
fn takes_input(surface: &WlSurface, at: (f64, f64)) -> bool {
    with_states(surface, |states| {
        states
            .cached_state
            .get::<SurfaceAttributes>()
            .current()
            .input_region
            .as_ref()
            .is_none_or(|region| region.contains((at.0.floor() as i32, at.1.floor() as i32)))
    })
}
