//! One frame of the whole desk, for the Screenshot portal.
//!
//! A shot draws from the same display captures as monitor streams (see
//! [`captures`](crate::casting::captures)): every monitor, at the highest
//! density on the desk. It takes each display's newest frame, starting the
//! captures it needs and stopping them once it has its frames. See
//! `docs/PORTALS.md`.

use domicile_host::screenshot::Shot;
use domicile_protocol::{ShotArea, ShotRect, ShotWindow};
use smithay::backend::allocator::dmabuf::Dmabuf;
use smithay::backend::allocator::Buffer as _;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::backend::renderer::ImportDma as _;

use smithay::utils::Transform;

use crate::buffer_transform::Sampled;
use crate::casting::captured;
use crate::casting::gpu::{FillError, Layer, Snapshot};
use crate::casting::negotiation::Pixel;
use crate::casting::pacing::Rect;
use crate::casting::paint::paint;
use crate::casting::region::{intersection, Screen};
use crate::engine::CapturedFrame;

/// A frame of the whole desk, and where its monitors and windows are in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Desk {
    pub shot: Shot,
    /// Each monitor, by `wl_output` name, in the shot's pixels.
    pub monitors: Vec<ShotArea>,
    /// Each open window, shown or not.
    pub windows: Vec<ShotWindow>,
    /// Where the shot is on the desktop, in logical pixels.
    pub place: Rect,
}

/// Hears a shot: the desk, or why there is none. Called on the Wayland
/// thread, so it must not block.
pub type Developed = Box<dyn FnOnce(Result<Desk, String>) + Send>;

/// Hears a shot of one window, or why there is none. Called on the Wayland
/// thread, so it must not block.
pub type DevelopedWindow = Box<dyn FnOnce(Result<Shot, String>) + Send>;

/// The last frame a window showed, which the engine still holds.
pub struct Shown {
    pub dmabuf: Dmabuf,
    /// The part of the buffer that is the window, in buffer pixels, with
    /// `(0, 0, 0, 0)` for all of it, and the turn that makes it upright.
    pub sampled: Sampled,
}

/// The rectangle every monitor fits in, in logical pixels. `None` without
/// monitors.
pub fn desk_of(screens: &[Screen]) -> Option<Rect> {
    let (left, top, right, bottom) = screens
        .iter()
        .map(|screen| {
            let (x, y, width, height) = screen.desk;
            (x, y, x + width, y + height)
        })
        .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)))?;
    Some((left, top, right - left, bottom - top))
}

/// A shot `size` pixels big of `layers`. Off every layer is transparent.
pub fn compose(
    size: (u32, u32),
    layers: &[Layer],
    renderer: Option<&mut GlesRenderer>,
) -> Result<Shot, FillError> {
    let stride = size.0 as usize * 4;
    let mut bgra = vec![0; stride * size.1 as usize];
    paint(layers, &mut bgra, stride, Pixel::Bgra, renderer)?;
    Ok(Shot {
        width: size.0,
        height: size.1,
        bgra,
    })
}

/// `shown` alone, read back through `renderer`.
pub fn window(shown: &Shown, renderer: Option<&mut GlesRenderer>) -> Result<Shot, String> {
    let renderer = renderer.ok_or("no GPU renderer to read the window's frame")?;
    let size = shown.dmabuf.size();
    let sampled = match shown.sampled.crop {
        (_, _, 0, 0) => Sampled {
            crop: (0, 0, size.w, size.h),
            ..shown.sampled
        },
        _ => shown.sampled,
    };
    let snapshot = Snapshot::Texture(
        renderer
            .import_dmabuf(&shown.dmabuf, None)
            .map_err(|why| why.to_string())?,
    );
    compose(
        sampled.upright_size(),
        &[Layer::upright(&snapshot, sampled)],
        Some(renderer),
    )
    .map_err(|why| why.to_string())
}

/// The page in a browser window capture's `frame`, read back through
/// `renderer` when the frame is a dmabuf.
pub fn browser_window(
    frame: &CapturedFrame,
    mut renderer: Option<&mut GlesRenderer>,
) -> Result<Shot, String> {
    let (snapshot, _) =
        captured::snapshot(frame, renderer.as_deref_mut()).map_err(|why| why.to_string())?;
    let (_, _, width, height) = frame.content;
    compose(
        (width as u32, height as u32),
        &[Layer {
            snapshot: &snapshot,
            from: frame.content,
            to: (0, 0, width, height),
            transform: Transform::Normal,
        }],
        renderer,
    )
    .map_err(|why| why.to_string())
}

/// `page` with `views` drawn over it, bottom first: an Electron app's window
/// with the `WebContentsView`s it holds. Each view is a shot of its own page
/// and the rectangle the app placed it at in the window's page, in that
/// page's CSS pixels; it is drawn at its own density, which its shot's width
/// over its rectangle's says. What falls off the page is cut.
pub fn with_views(mut page: Shot, views: &[(Shot, Rect)]) -> Shot {
    for (view, (x, y, width, _)) in views {
        let scale = f64::from(view.width) / f64::from(*width);
        let left = (f64::from(*x) * scale).round() as i64;
        let top = (f64::from(*y) * scale).round() as i64;
        for row in 0..i64::from(view.height) {
            let to_row = top + row;
            if to_row < 0 || to_row >= i64::from(page.height) {
                continue;
            }
            for column in 0..i64::from(view.width) {
                let to_column = left + column;
                if to_column < 0 || to_column >= i64::from(page.width) {
                    continue;
                }
                let from = ((row * i64::from(view.width) + column) * 4) as usize;
                let to = ((to_row * i64::from(page.width) + to_column) * 4) as usize;
                over(&view.bgra[from..from + 4], &mut page.bgra[to..to + 4]);
            }
        }
    }
    page
}

/// `pixel` drawn over `under`, both premultiplied BGRA.
fn over(pixel: &[u8], under: &mut [u8]) {
    let clear = 255 - u32::from(pixel[3]);
    for (to, &from) in under.iter_mut().zip(pixel) {
        *to = (u32::from(from) + (u32::from(*to) * clear + 127) / 255) as u8;
    }
}

/// The monitors of a shot of `desk` at `scale` shot pixels per logical
/// pixel, each with what `describe` says of it by name.
pub fn monitors(
    desk: Rect,
    scale: f64,
    screens: &[Screen],
    describe: impl Fn(&str) -> Option<String>,
) -> Vec<ShotArea> {
    screens
        .iter()
        .filter_map(|screen| {
            let (x, y, width, height) = intersection(screen.desk, desk)?;
            let pixels = |logical: i32| (f64::from(logical) * scale).round() as u32;
            let (left, top) = (x - desk.0, y - desk.1);
            Some(ShotArea {
                name: screen.name.clone(),
                description: describe(&screen.name).unwrap_or_default(),
                area: ShotRect {
                    x: pixels(left),
                    y: pixels(top),
                    width: pixels(left + width) - pixels(left),
                    height: pixels(top + height) - pixels(top),
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use smithay::utils::Transform;

    use super::*;
    use crate::casting::gpu::Snapshot;

    /// A 2x1 monitor at 1x, and a 1x1 one at 2x to its right.
    fn screens() -> [Screen; 2] {
        [
            Screen {
                name: "drm-1".into(),
                display: 1,
                desk: (0, 0, 2, 1),
                scale: 1.0,
            },
            Screen {
                name: "drm-2".into(),
                display: 2,
                desk: (2, -1, 1, 1),
                scale: 2.0,
            },
        ]
    }

    /// One pixel a byte: `bytes` names each pixel's blue byte.
    fn pixels(bytes: &[u8], size: (u32, u32)) -> Snapshot {
        Snapshot::Pixels {
            bytes: bytes.iter().flat_map(|&byte| [byte, 0, 0, 0]).collect(),
            stride: size.0 as usize * 4,
            alpha: false,
            size,
        }
    }

    #[test]
    fn the_desk_spans_every_monitor() {
        assert_eq!(desk_of(&screens()), Some((0, -1, 3, 2)));
        assert_eq!(desk_of(&[]), None);
    }

    #[test]
    fn a_lower_density_monitor_is_scaled_up_beside_a_higher_one() {
        let (one, two) = (pixels(&[1, 2], (2, 1)), pixels(&[3, 4, 5, 6], (2, 2)));
        let layers = [
            Layer {
                snapshot: &one,
                from: (0, 0, 2, 1),
                to: (0, 2, 4, 2),
                transform: Transform::Normal,
            },
            Layer {
                snapshot: &two,
                from: (0, 0, 2, 2),
                to: (4, 0, 2, 2),
                transform: Transform::Normal,
            },
        ];

        let shot = compose((6, 4), &layers, None).expect("composed on the CPU");

        let blue: Vec<u8> = shot.bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!(
            blue,
            [
                [0, 0, 0, 0, 3, 4],
                [0, 0, 0, 0, 5, 6],
                [1, 1, 2, 2, 0, 0],
                [1, 1, 2, 2, 0, 0],
            ]
            .concat()
        );
        assert_eq!((shot.width, shot.height), (6, 4));
        assert_eq!(shot.bgra[3], 0, "off every monitor is transparent");
        assert_eq!(shot.bgra[4 * 4 + 3], 255, "a frame without alpha is opaque");
    }

    /// A shot of `size` whose pixels' blue bytes are `blues`, row by row,
    /// opaque but where `blues` is 0.
    fn shot(size: (u32, u32), blues: &[u8]) -> Shot {
        Shot {
            width: size.0,
            height: size.1,
            bgra: blues
                .iter()
                .flat_map(|&blue| [blue, 0, 0, if blue == 0 { 0 } else { 255 }])
                .collect(),
        }
    }

    #[test]
    fn views_are_drawn_over_the_page_where_the_app_placed_them_bottom_first() {
        // A 4x3 page at 2x: 2x1.5 CSS pixels.
        let page = shot((4, 3), &[1; 12]);
        let sidebar = (shot((2, 2), &[2; 4]), (0, 0, 1, 1));
        // Over the sidebar, and off the page's right edge.
        let chat = (shot((4, 2), &[3; 8]), (1, 0, 2, 1));
        // Clear but for one pixel.
        let badge = (shot((2, 2), &[0, 0, 0, 4]), (0, 0, 1, 1));

        let drawn = with_views(page, &[sidebar, chat, badge]);

        let blue: Vec<u8> = drawn.bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!(blue, [[2, 2, 3, 3], [2, 4, 3, 3], [1, 1, 1, 1]].concat());
        assert_eq!((drawn.width, drawn.height), (4, 3));
    }

    #[test]
    fn monitors_are_found_in_the_shots_pixels_and_described() {
        let described = |name: &str| (name == "drm-1").then(|| "Dell U3219Q".to_string());

        let monitors = monitors((0, -1, 3, 2), 2.0, &screens(), described);

        let at = |name: &str, description: &str, x, y, width, height| ShotArea {
            name: name.into(),
            description: description.into(),
            area: ShotRect {
                x,
                y,
                width,
                height,
            },
        };
        assert_eq!(
            monitors,
            [
                at("drm-1", "Dell U3219Q", 0, 2, 4, 2),
                at("drm-2", "", 4, 0, 2, 2)
            ]
        );
    }
}
