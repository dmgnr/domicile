//! `zwp_pointer_constraints_v1`: a game or VM viewer locking the pointer in
//! place, or confining it to its window.
//!
//! The engine draws the pointer and moves it, so the compositor cannot hold it
//! still itself. It offers the ask to the page instead
//! ([`HostMessage::AppPointerConstraint`]), and only for the window under the
//! pointer. The page takes the pointer (a pointer lock on the window's
//! element, or confining it to the element) and says so with
//! [`ChromeMessage::PointerConstrained`](domicile_protocol::ChromeMessage::PointerConstrained);
//! only then is the client told `locked` or `confined`. The page lets go the
//! same way, so Escape and a focus change are the shell's to decide.
//!
//! The offer carries the constraint's region, the part of the window it holds,
//! as rectangles of the surface; the page keeps a confined pointer inside it.
//!
//! Smithay says nothing when a client destroys its constraint or changes its
//! region, so the offer is checked again at each pointer motion, which keeps
//! coming while a lock is held.

use domicile_protocol::{HostMessage, PointerConstraint, SurfaceRect};
use smithay::delegate_pointer_constraints;
use smithay::input::pointer::PointerHandle;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::utils::{Logical, Point, Rectangle};
use smithay::wayland::compositor::RegionAttributes;
use smithay::wayland::pointer_constraints::{
    with_pointer_constraint, PointerConstraint as Constraint, PointerConstraintsHandler,
};
use tracing::debug;

use crate::DomicileCompositor;

/// The constraint offered to the page: on which window, and which kind.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Offered {
    app_id: String,
    surface: WlSurface,
    constraint: PointerConstraint,
    region: Option<Vec<SurfaceRect>>,
}

/// `region` as rectangles that do not overlap: the cells of the grid its
/// rectangles' edges draw, kept where the region holds them, each row's
/// neighbors joined. A cell's top-left corner stands for the whole cell, since
/// no edge crosses it.
pub(crate) fn region_rects(region: &RegionAttributes) -> Vec<SurfaceRect> {
    let edges = |of: fn(&Rectangle<i32, Logical>) -> [i32; 2]| {
        let mut edges: Vec<i32> = region.rects.iter().flat_map(|(_, rect)| of(rect)).collect();
        edges.sort_unstable();
        edges.dedup();
        edges
    };
    let xs = edges(|rect| [rect.loc.x, rect.loc.x + rect.size.w]);
    let ys = edges(|rect| [rect.loc.y, rect.loc.y + rect.size.h]);
    let mut rects = Vec::new();
    for row in ys.windows(2) {
        let mut run: Option<SurfaceRect> = None;
        for column in xs.windows(2) {
            if region.contains((column[0], row[0])) {
                match run.as_mut() {
                    Some(run) => run.width = column[1] - run.x,
                    None => {
                        run = Some(SurfaceRect {
                            x: column[0],
                            y: row[0],
                            width: column[1] - column[0],
                            height: row[1] - row[0],
                        });
                    }
                }
            } else if let Some(ended) = run.take() {
                rects.push(ended);
            }
        }
        rects.extend(run);
    }
    rects
}

impl DomicileCompositor {
    /// The constraint the client asked for on `surface`, if any, and its
    /// region: `None` for the whole window.
    fn constraint_on(
        &self,
        surface: &WlSurface,
    ) -> Option<(PointerConstraint, Option<Vec<SurfaceRect>>)> {
        let pointer = self.seat.get_pointer()?;
        with_pointer_constraint(surface, &pointer, |constraint| {
            constraint.map(|constraint| {
                let kind = match &*constraint {
                    Constraint::Locked(_) => PointerConstraint::Lock,
                    Constraint::Confined(_) => PointerConstraint::Confine,
                };
                (kind, constraint.region().map(region_rects))
            })
        })
    }

    /// Whether the pointer is locked over `surface`: a lock the page took and
    /// the client was told of. Absolute motion then stays with the page.
    pub(crate) fn pointer_locked_over(&self, surface: &WlSurface) -> bool {
        let Some(pointer) = self.seat.get_pointer() else {
            return false;
        };
        with_pointer_constraint(surface, &pointer, |constraint| {
            constraint.is_some_and(|constraint| {
                matches!(&*constraint, Constraint::Locked(_)) && constraint.is_active()
            })
        })
    }

    /// Bring the page's offer in line with the window under the pointer:
    /// withdraw one for a window the pointer left or whose client withdrew
    /// it, and offer the one the window under the pointer asked for.
    pub(crate) fn offer_pointer_constraint(&mut self) {
        let wanted = match (self.pointer_app.clone(), self.pointer_surface.clone()) {
            (Some(app_id), Some(surface)) => {
                self.constraint_on(&surface)
                    .map(|(constraint, region)| Offered {
                        app_id,
                        surface,
                        constraint,
                        region,
                    })
            }
            _ => None,
        };
        if wanted == self.pointer_constraint_offered {
            return;
        }
        if let Some(offered) = self.pointer_constraint_offered.take() {
            self.release_constraint(&offered.surface);
            debug!(app_id = %offered.app_id, "pointer constraint withdrawn -> Host");
            self.hub.broadcast(HostMessage::AppPointerConstraint {
                app_id: offered.app_id,
                constraint: None,
                region: None,
            });
        }
        if let Some(wanted) = wanted {
            debug!(app_id = %wanted.app_id, constraint = ?wanted.constraint, region = ?wanted.region, "pointer constraint offered -> Host");
            self.hub.broadcast(HostMessage::AppPointerConstraint {
                app_id: wanted.app_id.clone(),
                constraint: Some(wanted.constraint),
                region: wanted.region.clone(),
            });
            self.pointer_constraint_offered = Some(wanted);
        }
    }

    /// A window went away: forget its offer without telling the page, which
    /// is dropping the window's element.
    pub(crate) fn forget_pointer_constraint(&mut self, app_id: &str) {
        if self
            .pointer_constraint_offered
            .as_ref()
            .is_some_and(|offered| offered.app_id == app_id)
        {
            self.pointer_constraint_offered = None;
        }
    }

    /// The page took (`active`) or let go of the pointer for `app_id`.
    ///
    /// Dropped unless that window holds the offer: the page answering an
    /// offer withdrawn since must not lock a window the pointer has left.
    pub(crate) fn page_constrained(&mut self, app_id: &str, active: bool) {
        let Some(offered) = self
            .pointer_constraint_offered
            .clone()
            .filter(|offered| offered.app_id == app_id)
        else {
            debug!(%app_id, active, "pointer constraint not offered -> dropped");
            return;
        };
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        if active {
            with_pointer_constraint(&offered.surface, &pointer, |constraint| {
                if let Some(constraint) = constraint.filter(|constraint| !constraint.is_active()) {
                    constraint.activate();
                }
            });
            debug!(%app_id, constraint = ?offered.constraint, "pointer constrained");
        } else {
            self.release_constraint(&offered.surface);
            debug!(%app_id, "pointer let go");
            // A oneshot constraint ends at release, which withdraws the offer.
            self.offer_pointer_constraint();
        }
    }

    /// Tell the client on `surface` its pointer is free, if it was told
    /// otherwise.
    fn release_constraint(&self, surface: &WlSurface) {
        let Some(pointer) = self.seat.get_pointer() else {
            return;
        };
        with_pointer_constraint(surface, &pointer, |constraint| {
            if let Some(constraint) = constraint.filter(|constraint| constraint.is_active()) {
                constraint.deactivate();
            }
        });
    }
}

impl PointerConstraintsHandler for DomicileCompositor {
    fn new_constraint(&mut self, _surface: &WlSurface, _pointer: &PointerHandle<Self>) {
        // Offered now if the pointer is over the window, otherwise when it
        // arrives.
        self.offer_pointer_constraint();
    }

    fn cursor_position_hint(
        &mut self,
        _surface: &WlSurface,
        _pointer: &PointerHandle<Self>,
        _location: Point<f64, Logical>,
    ) {
        // Where the client would like the pointer at unlock. The page puts it
        // back where the lock began, which is a place the user saw it.
    }
}

delegate_pointer_constraints!(DomicileCompositor);

#[cfg(test)]
mod tests {
    use super::*;
    use smithay::wayland::compositor::RectangleKind;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rectangle<i32, Logical> {
        Rectangle::new((x, y).into(), (width, height).into())
    }

    fn surface_rect(x: i32, y: i32, width: i32, height: i32) -> SurfaceRect {
        SurfaceRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn one_rectangle_is_itself() {
        let region = RegionAttributes {
            rects: vec![(RectangleKind::Add, rect(10, 20, 300, 200))],
        };
        assert_eq!(region_rects(&region), vec![surface_rect(10, 20, 300, 200)]);
    }

    #[test]
    fn a_hole_leaves_the_rectangles_around_it() {
        let region = RegionAttributes {
            rects: vec![
                (RectangleKind::Add, rect(0, 0, 30, 30)),
                (RectangleKind::Subtract, rect(10, 10, 10, 10)),
            ],
        };
        assert_eq!(
            region_rects(&region),
            vec![
                surface_rect(0, 0, 30, 10),
                surface_rect(0, 10, 10, 10),
                surface_rect(20, 10, 10, 10),
                surface_rect(0, 20, 30, 10),
            ]
        );
    }

    #[test]
    fn overlapping_rectangles_do_not_overlap_once_cut() {
        let region = RegionAttributes {
            rects: vec![
                (RectangleKind::Add, rect(0, 0, 20, 10)),
                (RectangleKind::Add, rect(10, 0, 20, 20)),
            ],
        };
        assert_eq!(
            region_rects(&region),
            vec![surface_rect(0, 0, 30, 10), surface_rect(10, 10, 20, 10)]
        );
    }

    #[test]
    fn an_empty_region_holds_nothing() {
        assert_eq!(region_rects(&RegionAttributes::default()), vec![]);
    }
}
