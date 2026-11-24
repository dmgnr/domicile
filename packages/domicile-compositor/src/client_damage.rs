//! The bounds of a client's damage, in buffer pixels.

use smithay::utils::Transform;
use smithay::wayland::compositor::Damage;

use crate::viewport::Viewport;

/// A rectangle of a client's buffer, in buffer pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Region {
    fn new(x: u32, y: u32, width: u32, height: u32) -> Self {
        Region {
            x,
            y,
            width,
            height,
        }
    }
}

/// The bounds of a client's damage since the last commit, clearing it.
///
/// Must take, not borrow: Smithay accumulates damage in the current state until
/// cleared, so reading it would return every rectangle ever reported and the
/// box would grow to the whole window. `pending_damage` tracks damage owed
/// across dropped frames.
pub fn take_damage(
    damage: &mut Vec<Damage>,
    buffer_scale: i32,
    viewport: Viewport,
) -> Option<Region> {
    damage_bounds(&std::mem::take(damage), buffer_scale, viewport)
}

/// `damage` as `(x, y, width, height)` in buffer pixels, where it marks the
/// pixels that changed on screen: `None` for a turned buffer, whose pixels
/// land elsewhere.
///
/// A viewport does not stop it: the crop and stretch apply to the damaged
/// pixels as to the rest.
pub fn exact_damage(damage: Option<Region>, transform: Transform) -> Option<(i32, i32, i32, i32)> {
    damage
        .filter(|_| transform == Transform::Normal)
        .map(|region| {
            (
                region.x as i32,
                region.y as i32,
                region.width as i32,
                region.height as i32,
            )
        })
}

/// The bounding box of a client's damage.
///
/// A box is enough to avoid redrawing a whole window for a cursor blink.
///
/// `Buffer` damage is already in buffer pixels. `Surface` damage is logical:
/// it is scaled, or mapped through the viewport's source, and is the whole
/// buffer under a viewport with no source. Mixing them up leaves stale bands
/// on a HiDPI window.
fn damage_bounds(damage: &[Damage], buffer_scale: i32, viewport: Viewport) -> Option<Region> {
    let scale = buffer_scale.max(1);
    damage
        .iter()
        .map(|reported| match reported {
            // Saturate: clients often send `(0, 0, i32::MAX, i32::MAX)` for
            // "everything". Overflow would panic the Wayland thread in debug
            // builds, or wrap negative and be dropped in release. The result is
            // clamped to the buffer later.
            Damage::Surface(rect) => surface_in_buffer(
                (rect.loc.x, rect.loc.y, rect.size.w, rect.size.h),
                scale,
                viewport,
            ),
            Damage::Buffer(rect) => (rect.loc.x, rect.loc.y, rect.size.w, rect.size.h),
        })
        .filter(|(_, _, w, h)| *w > 0 && *h > 0)
        .map(|(x, y, w, h)| (x, y, x.saturating_add(w), y.saturating_add(h)))
        .reduce(|(ax, ay, ar, ab), (bx, by, br, bb)| {
            (ax.min(bx), ay.min(by), ar.max(br), ab.max(bb))
        })
        .map(|(x, y, right, bottom)| {
            // Clip negative offsets; that part is off the buffer.
            let (x, y) = (x.max(0), y.max(0));
            Region::new(
                x as u32,
                y as u32,
                (right - x).max(0) as u32,
                (bottom - y).max(0) as u32,
            )
        })
}

/// Logical surface damage `(x, y, width, height)` in buffer pixels, rounded
/// outward.
fn surface_in_buffer(
    (x, y, width, height): (i32, i32, i32, i32),
    scale: i32,
    viewport: Viewport,
) -> (i32, i32, i32, i32) {
    match (viewport.source, viewport.size) {
        (None, None) => (
            x.saturating_mul(scale),
            y.saturating_mul(scale),
            width.saturating_mul(scale),
            height.saturating_mul(scale),
        ),
        (Some((sx, sy, sw, sh)), Some((dw, dh))) if dw > 0 && dh > 0 => {
            let scale = f64::from(scale);
            let along = |start: f64, length: f64, span: i32, from: i32, to: i32| {
                let ratio = length / f64::from(span);
                let near = ((start + f64::from(from) * ratio) * scale).floor();
                let far = ((start + f64::from(to) * ratio) * scale).ceil();
                (to_pixel(near), to_pixel(far))
            };
            let (left, right) = along(sx, sw, dw, x, x.saturating_add(width));
            let (top, bottom) = along(sy, sh, dh, y, y.saturating_add(height));
            (
                left,
                top,
                right.saturating_sub(left),
                bottom.saturating_sub(top),
            )
        }
        // A destination alone stretches the whole buffer, whose size is not
        // known here.
        _ => (0, 0, i32::MAX, i32::MAX),
    }
}

/// A pixel coordinate, saturated to `i32`.
fn to_pixel(value: f64) -> i32 {
    value.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use smithay::utils::{Buffer as BufferCoords, Physical, Point, Rectangle, Size};

    use super::{damage_bounds, exact_damage, take_damage, Damage, Region};
    use crate::viewport::Viewport;
    use smithay::utils::Transform;

    fn buffer(x: i32, y: i32, w: i32, h: i32) -> Damage {
        Damage::Buffer(Rectangle::new(
            Point::<i32, BufferCoords>::from((x, y)),
            Size::<i32, BufferCoords>::from((w, h)),
        ))
    }

    fn surface(x: i32, y: i32, w: i32, h: i32) -> Damage {
        Damage::Surface(Rectangle::new(
            Point::<i32, Physical>::from((x, y)).to_logical(1),
            Size::<i32, Physical>::from((w, h)).to_logical(1),
        ))
    }

    #[test]
    fn taking_the_damage_leaves_none_for_the_next_commit() {
        // Smithay accumulates damage until cleared. Without taking it, the box
        // only grows to the whole window.
        let mut damage = vec![surface(1, 1, 2, 2)];

        let first = take_damage(&mut damage, 1, Viewport::default());
        let second = take_damage(&mut damage, 1, Viewport::default());

        assert_eq!(first, Some(Region::new(1, 1, 2, 2)));
        assert_eq!(second, None, "the next commit starts from nothing");
    }

    #[test]
    fn nothing_reported_is_no_bounds() {
        assert_eq!(damage_bounds(&[], 1, Viewport::default()), None);
    }

    #[test]
    fn two_rectangles_become_the_box_around_both() {
        assert_eq!(
            damage_bounds(
                &[surface(1, 1, 2, 2), surface(10, 5, 1, 1)],
                1,
                Viewport::default()
            ),
            Some(Region::new(1, 1, 10, 5))
        );
    }

    #[test]
    fn surface_damage_scales_to_buffer_pixels() {
        // Surface damage is logical; unscaled, a HiDPI window keeps a stale
        // band at the right and bottom.
        assert_eq!(
            damage_bounds(&[surface(3, 4, 5, 6)], 2, Viewport::default()),
            Some(Region::new(6, 8, 10, 12))
        );
    }

    #[test]
    fn a_client_claiming_everything_is_not_multiplied_into_nothing() {
        // `(0, 0, i32::MAX, i32::MAX)` means "everything changed". Scaling it
        // must not overflow: debug builds would panic, release builds would
        // wrap negative and drop it.
        let bounds = damage_bounds(&[surface(0, 0, i32::MAX, i32::MAX)], 2, Viewport::default());

        // Saturates at `i32::MAX`. The exact value does not matter; it is
        // clamped to the buffer later.
        assert_eq!(
            bounds,
            Some(Region::new(0, 0, i32::MAX as u32, i32::MAX as u32))
        );
    }

    #[test]
    fn damage_starting_near_the_end_of_the_axis_does_not_wrap() {
        let bounds = damage_bounds(&[surface(i32::MAX - 1, 0, 8, 8)], 1, Viewport::default());

        assert_eq!(
            bounds,
            Some(Region::new((i32::MAX - 1) as u32, 0, 1, 8)),
            "the far edge saturates rather than wrapping behind the near one"
        );
    }

    #[test]
    fn a_damage_offset_past_the_scale_saturates_rather_than_folding_back() {
        // Covers the scaled location, which the two tests above do not (one is
        // at scale 1, the other at the origin).
        //
        // Wrapping would put the far rectangle behind the near one, so the box
        // would stop short and leave stale pixels.
        let bounds = damage_bounds(
            &[surface(0, 0, 4, 4), surface(2_000_000_000, 0, 8, 8)],
            2,
            Viewport::default(),
        );

        assert_eq!(bounds, Some(Region::new(0, 0, i32::MAX as u32, 16)));
    }

    #[test]
    fn buffer_damage_is_already_in_buffer_pixels() {
        // Most clients use `damage_buffer` (preferred since `wl_compositor`
        // v4). Scaling it would over-damage HiDPI windows.
        assert_eq!(
            damage_bounds(&[buffer(3, 4, 5, 6)], 2, Viewport::default()),
            Some(Region::new(3, 4, 5, 6))
        );
    }

    #[test]
    fn damage_reaching_off_the_top_left_starts_at_the_corner() {
        assert_eq!(
            damage_bounds(&[surface(-4, -2, 8, 6)], 1, Viewport::default()),
            Some(Region::new(0, 0, 4, 4))
        );
    }

    #[test]
    fn surface_damage_under_a_viewport_maps_through_its_source() {
        // A 1000x500-pixel crop shown at 500x250: one logical unit is two
        // pixels, from the crop's corner.
        let viewport = Viewport {
            size: Some((500, 250)),
            source: Some((100.0, 50.0, 1000.0, 500.0)),
        };

        assert_eq!(
            damage_bounds(&[surface(10, 10, 20, 20)], 1, viewport),
            Some(Region::new(120, 70, 40, 40))
        );
    }

    #[test]
    fn surface_damage_under_a_fractional_viewport_rounds_outward() {
        // 1.5 pixels a unit: 3..7.5 must cover pixel 7.
        let viewport = Viewport {
            size: Some((100, 100)),
            source: Some((0.0, 0.0, 150.0, 150.0)),
        };

        assert_eq!(
            damage_bounds(&[surface(2, 2, 3, 3)], 1, viewport),
            Some(Region::new(3, 3, 5, 5))
        );
    }

    #[test]
    fn surface_damage_under_a_destination_alone_is_everything() {
        // Without a source, the buffer's size is needed to map it; the
        // whole buffer is safe.
        let viewport = Viewport {
            size: Some((500, 250)),
            source: None,
        };

        assert_eq!(
            damage_bounds(&[surface(10, 10, 20, 20)], 1, viewport),
            Some(Region::new(0, 0, i32::MAX as u32, i32::MAX as u32))
        );
    }

    #[test]
    fn buffer_damage_ignores_a_viewport() {
        // Chromium at a fractional scale sets a destination and damages in
        // buffer pixels: its damage holds as it is.
        let viewport = Viewport {
            size: Some((1280, 800)),
            source: None,
        };

        assert_eq!(
            damage_bounds(&[buffer(3, 4, 5, 6)], 1, viewport),
            Some(Region::new(3, 4, 5, 6))
        );
    }

    #[test]
    fn an_upright_buffers_damage_is_exact() {
        assert_eq!(
            exact_damage(Some(Region::new(3, 4, 5, 6)), Transform::Normal),
            Some((3, 4, 5, 6))
        );
    }

    #[test]
    fn a_turned_buffers_damage_is_not_exact() {
        // Buffer pixels of a turned buffer land elsewhere on screen.
        assert_eq!(
            exact_damage(Some(Region::new(3, 4, 5, 6)), Transform::_90),
            None
        );
    }
}
