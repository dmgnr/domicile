//! The part of a window's frame that changed, as the engine takes it.
//!
//! The engine damages its render pass in box pixels, where the crop of the
//! buffer fills the box, and an empty rectangle is the whole box. A client's
//! damage is relative to its previous commit, so it holds only when the engine
//! shows that commit at the same box, stretched from the same crop of a
//! buffer of the same size. Anything else is the whole box: a rectangle too
//! small leaves stale pixels on screen.

use std::collections::HashMap;

/// The whole box: the ABI's empty rectangle.
const WHOLE: (i32, i32, i32, i32) = (0, 0, 0, 0);

/// A window's commit the engine shows whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    /// The box it was submitted at.
    pub at_box: u64,
    /// The part of the buffer that filled the box, as in [`Next::crop`].
    pub crop: (i32, i32, i32, i32),
    /// The buffer's size in pixels.
    pub buffer: (u32, u32),
    /// Whether nothing turned the buffer. A later upright commit's damage
    /// misses pixels a turned one put elsewhere.
    pub upright: bool,
    /// For an shm frame, copied through the surface's texture, the fourcc it
    /// was uploaded as. `None` for a client's dmabuf.
    pub texture: Option<u32>,
}

/// Each window's previous commit, if the engine shows it whole.
///
/// A window missing here committed something the engine does not show, or
/// shows only in part, so its next frame is whole.
#[derive(Debug, Default)]
pub struct Shown {
    frames: HashMap<String, Frame>,
}

impl Shown {
    /// The engine shows `app_id`'s commit whole. Updates in place, so a
    /// window's steady commits allocate nothing.
    pub fn shown(&mut self, app_id: &str, frame: Frame) {
        match self.frames.get_mut(app_id) {
            Some(shown) => *shown = frame,
            None => {
                self.frames.insert(app_id.to_owned(), frame);
            }
        }
    }

    /// `app_id` committed something the engine does not show whole, or went.
    pub fn missed(&mut self, app_id: &str) {
        self.frames.remove(app_id);
    }

    /// A new engine shows none of the old one's frames.
    pub fn clear(&mut self) {
        self.frames.clear();
    }

    /// The damage to submit for `app_id`'s next commit. See [`for_engine`].
    pub fn damage(&self, app_id: &str, next: Next) -> (i32, i32, i32, i32) {
        for_engine(self.frames.get(app_id).copied(), next)
    }

    /// Whether `app_id`'s shm texture holds its previous commit as `fourcc`,
    /// so the next upload needs only the client's damage.
    pub fn texture_is_current(&self, app_id: &str, fourcc: u32) -> bool {
        self.frames
            .get(app_id)
            .is_some_and(|frame| frame.texture == Some(fourcc))
    }
}

/// A commit about to be submitted.
#[derive(Clone, Copy, Debug)]
pub struct Next {
    /// The client's damage in buffer pixels, `(x, y, width, height)`. `None`
    /// when unknown or not exact.
    pub damage: Option<(i32, i32, i32, i32)>,
    /// The box it is submitted at.
    pub at_box: u64,
    /// That box's size in device pixels. `None` when the compositor does not
    /// know which box the engine shows it at.
    pub box_size: Option<(u32, u32)>,
    /// The part of the buffer that fills the box, in buffer pixels. Empty is
    /// the whole buffer.
    pub crop: (i32, i32, i32, i32),
    /// The buffer's size in pixels.
    pub buffer: (u32, u32),
}

/// The damage to submit for `next`, given the frame the engine shows.
///
/// The client's damage only when the engine shows its previous commit at the
/// same box, from the same crop of a buffer of the same size, drawn upright;
/// [`WHOLE`] otherwise. A new crop, buffer size or transform moves every
/// pixel. `next` has damage only when it is upright.
fn for_engine(previous: Option<Frame>, next: Next) -> (i32, i32, i32, i32) {
    match (previous, next.damage, next.box_size) {
        (Some(previous), Some(damage), Some(box_size))
            if previous.upright
                && previous.at_box == next.at_box
                && previous.crop == next.crop
                && previous.buffer == next.buffer =>
        {
            in_box(damage, next.crop, next.buffer, box_size)
        }
        _ => WHOLE,
    }
}

/// Maps `damage` from buffer pixels onto a `box_size` box that `crop` fills,
/// rounding outward.
///
/// [`WHOLE`] when the damage misses the crop: the ABI has no empty damage, and
/// such a commit is rare.
fn in_box(
    damage: (i32, i32, i32, i32),
    crop: (i32, i32, i32, i32),
    buffer: (u32, u32),
    box_size: (u32, u32),
) -> (i32, i32, i32, i32) {
    let crop = if crop.2 == 0 || crop.3 == 0 {
        (0, 0, buffer.0 as i32, buffer.1 as i32)
    } else {
        crop
    };
    let left = damage.0.max(crop.0);
    let top = damage.1.max(crop.1);
    let right = damage.0.saturating_add(damage.2).min(crop.0 + crop.2);
    let bottom = damage.1.saturating_add(damage.3).min(crop.1 + crop.3);
    if left >= right || top >= bottom {
        WHOLE
    } else {
        let (x, right) = along((left, right), (crop.0, crop.2), box_size.0);
        let (y, bottom) = along((top, bottom), (crop.1, crop.3), box_size.1);
        (x, y, right - x, bottom - y)
    }
}

/// Maps the span `from..to` of a `crop` (`start`, `length`) onto `0..size`,
/// rounding outward.
///
/// A crop stretched to another size is filtered, which spreads a texel into
/// the box pixels around it, so the span first grows a texel each way.
fn along((from, to): (i32, i32), (start, length): (i32, i32), size: u32) -> (i32, i32) {
    let (from, to) = if i64::from(length) == i64::from(size) {
        (from, to)
    } else {
        ((from - 1).max(start), (to + 1).min(start + length))
    };
    let scale = f64::from(size) / f64::from(length);
    let from = (f64::from(from - start) * scale).floor() as i32;
    let to = (f64::from(to - start) * scale).ceil() as i32;
    (from.max(0), to.min(size as i32))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUFFER: (u32, u32) = (200, 100);

    fn next(damage: (i32, i32, i32, i32)) -> Next {
        Next {
            damage: Some(damage),
            at_box: 3,
            box_size: Some(BUFFER),
            crop: WHOLE,
            buffer: BUFFER,
        }
    }

    fn shown_at(at_box: u64) -> Shown {
        let mut shown = Shown::default();
        shown.shown("app-1", frame(at_box, None));
        shown
    }

    /// The engine shows a frame from the same crop as `next`, at its box.
    fn shown_as(next: Next) -> Shown {
        let mut shown = Shown::default();
        shown.shown(
            "app-1",
            Frame {
                crop: next.crop,
                ..frame(next.at_box, None)
            },
        );
        shown
    }

    fn frame(at_box: u64, texture: Option<u32>) -> Frame {
        Frame {
            at_box,
            crop: WHOLE,
            buffer: BUFFER,
            upright: true,
            texture,
        }
    }

    #[test]
    fn a_window_whose_last_frame_is_on_screen_damages_only_what_the_client_did() {
        assert_eq!(
            shown_at(3).damage("app-1", next((10, 20, 5, 6))),
            (10, 20, 5, 6)
        );
    }

    #[test]
    fn a_frame_after_one_the_engine_did_not_show_is_whole() {
        let mut shown = shown_at(3);
        shown.missed("app-1");

        assert_eq!(shown.damage("app-1", next((10, 20, 5, 6))), WHOLE);
        assert_eq!(
            Shown::default().damage("app-1", next((10, 20, 5, 6))),
            WHOLE
        );
    }

    #[test]
    fn a_frame_at_a_new_box_is_whole() {
        assert_eq!(shown_at(2).damage("app-1", next((10, 20, 5, 6))), WHOLE);
    }

    #[test]
    fn a_frame_from_a_new_crop_or_buffer_size_in_the_same_box_is_whole() {
        // The engine stretches the crop over the box, so either moves every
        // pixel.
        let new_crop = Next {
            crop: (0, 0, 100, 100),
            ..next((10, 20, 5, 6))
        };
        let new_buffer = Next {
            buffer: (300, 150),
            ..next((10, 20, 5, 6))
        };

        assert_eq!(shown_at(3).damage("app-1", new_crop), WHOLE);
        assert_eq!(shown_at(3).damage("app-1", new_buffer), WHOLE);
    }

    #[test]
    fn unknown_damage_or_an_unknown_box_is_whole() {
        let shown = shown_at(3);

        let unknown = Next {
            damage: None,
            ..next((10, 20, 5, 6))
        };
        let no_box = Next {
            box_size: None,
            ..next((10, 20, 5, 6))
        };

        assert_eq!(shown.damage("app-1", unknown), WHOLE);
        assert_eq!(shown.damage("app-1", no_box), WHOLE);
    }

    // A frame drawn turned put the pixels elsewhere in the box.
    #[test]
    fn an_upright_frame_after_a_turned_one_damages_the_whole_box() {
        let mut shown = Shown::default();
        shown.shown(
            "app-1",
            Frame {
                upright: false,
                ..frame(3, None)
            },
        );

        assert_eq!(shown.damage("app-1", next((10, 10, 5, 5))), WHOLE);
    }

    #[test]
    fn damage_is_moved_into_the_crop_and_cut_to_it() {
        let cropped = Next {
            crop: (20, 10, 160, 80),
            box_size: Some((160, 80)),
            ..next((0, 0, 30, 15))
        };

        assert_eq!(shown_as(cropped).damage("app-1", cropped), (0, 0, 10, 5));
    }

    #[test]
    fn damage_scales_to_a_smaller_box_with_a_texel_of_filtering_around_it() {
        // A 2x buffer in a box drawn at 1.5x: texels 2..7 land on 1.5..5.25.
        let scaled = Next {
            box_size: Some((150, 75)),
            ..next((3, 3, 3, 3))
        };

        assert_eq!(shown_at(3).damage("app-1", scaled), (1, 1, 5, 5));
    }

    #[test]
    fn damage_scales_to_a_larger_box_with_a_texel_of_filtering_around_it() {
        // A 1x buffer in a box drawn at 2x: a changed texel blends into the
        // box pixels half a texel past it, so texels 9..12 land on 18..24.
        let upscaled = Next {
            box_size: Some((400, 200)),
            ..next((10, 10, 1, 1))
        };

        assert_eq!(shown_at(3).damage("app-1", upscaled), (18, 18, 6, 6));
    }

    #[test]
    fn filtering_never_reaches_past_the_crop() {
        let upscaled = Next {
            box_size: Some((400, 200)),
            ..next((0, 0, 1, 1))
        };

        assert_eq!(shown_at(3).damage("app-1", upscaled), (0, 0, 4, 4));
    }

    #[test]
    fn a_client_claiming_everything_is_the_whole_box() {
        assert_eq!(
            shown_at(3).damage("app-1", next((0, 0, i32::MAX, i32::MAX))),
            (0, 0, 200, 100)
        );
    }

    #[test]
    fn damage_only_in_a_shadow_outside_the_crop_is_whole() {
        let shadow = Next {
            crop: (20, 10, 160, 80),
            box_size: Some((160, 80)),
            ..next((0, 0, 10, 10))
        };

        assert_eq!(shown_as(shadow).damage("app-1", shadow), WHOLE);
    }

    #[test]
    fn only_a_frame_copied_in_the_same_format_leaves_the_texture_current() {
        const XRGB: u32 = 1;
        const ARGB: u32 = 2;
        let mut shown = shown_at(3);
        assert!(!shown.texture_is_current("app-1", XRGB));

        shown.shown("app-1", frame(3, Some(XRGB)));
        assert!(shown.texture_is_current("app-1", XRGB));
        assert!(!shown.texture_is_current("app-1", ARGB));

        shown.clear();
        assert!(!shown.texture_is_current("app-1", XRGB));
    }
}
