//! Converts between a display's pixel ratio and Wayland's scales.
//!
//! The chrome lays out in CSS pixels, the display has some device pixels per
//! CSS pixel, and Wayland uses logical units with an integer buffer scale.
//! The conversions live here, outside the commit path, so they can be tested.

/// The `wl_output` scale to advertise for a chrome reporting `ratio` device
/// pixels per CSS pixel, capped at `max`.
///
/// `wl_output.scale` is an integer, so a fractional ratio rounds up: a client
/// drawing extra pixels is downscaled and stays sharp, while one drawing too
/// few is stretched and blurry. Clients that bind `wp_fractional_scale_v1` get
/// the exact scale (`Screens::scale_for`).
///
/// `max` exists because scale N renders N² times the pixels, which may be
/// more than the machine can draw.
pub fn output_scale(ratio: f64, max: u32) -> i32 {
    // Wayland cannot express a ratio below 1, and such a display needs no
    // help staying sharp.
    let wanted = if ratio.is_finite() && ratio > 1.0 {
        ratio.ceil() as u32
    } else {
        1
    };
    wanted.clamp(1, max.max(1)) as i32
}

/// The logical size of a box the engine reports in device pixels, on a
/// display with `ratio` device pixels per CSS pixel.
///
/// Blink lays out in device pixels, so `SurfaceBoxChanged` reports the CSS box
/// times the density. `xdg_toplevel.configure` takes logical units (the client
/// applies the output scale itself), so the box is divided by `ratio`.
/// Otherwise the client lays out `ratio` times too much content, too small.
///
/// `ratio` comes from the chrome as JSON and is untrusted: anything not
/// positive and finite is treated as 1. The result is rounded and at least 1,
/// because a client configured to zero draws nothing.
pub fn logical_box(device: (u32, u32), ratio: f64) -> (u32, u32) {
    if !ratio.is_finite() || ratio <= 0.0 {
        return device;
    }
    let logical = |pixels: u32| ((f64::from(pixels) / ratio).round() as u32).max(1);
    (logical(device.0), logical(device.1))
}

/// The scale a window draws at: its display's `scale` times its CSS `zoom`.
///
/// For `wp_fractional_scale_v1`. A zoomed window is configured `zoom` times
/// smaller ([`logical_box`] at the zoomed ratio) and draws `zoom` times
/// denser, so its buffer still fills the box pixel for pixel.
///
/// Not clamped: the shell draws the window's popups at the same CSS `zoom`,
/// so any other factor here would put them in the wrong place. The engine
/// refuses a zoom that is not a positive number.
pub fn zoomed(scale: f64, zoom: f64) -> f64 {
    scale * zoom
}

/// `screen`, in desktop units, in the logical units of a window at `window`
/// zoomed by `zoom`, from the window's corner. What a popup's positioner or a
/// candidate list is kept inside.
pub fn screen_in_window(
    window: domicile_scene::Point,
    screen: domicile_scene::Bounds,
    zoom: f64,
) -> domicile_scene::Bounds {
    let into = |point: domicile_scene::Point| domicile_scene::Point {
        x: (point.x - window.x) / zoom,
        y: (point.y - window.y) / zoom,
    };
    domicile_scene::Bounds {
        min: into(screen.min),
        max: into(screen.max),
    }
}

/// The logical size of a surface whose buffer is `buffer` pixels at
/// `buffer_scale`.
///
/// Layout and pointer coordinates are logical; only the buffer is in pixels.
///
/// `buffer_scale` comes from the client and is untrusted: a non-positive
/// scale is treated as 1 rather than crashing the compositor.
pub fn logical_size(buffer: (u32, u32), buffer_scale: i32) -> (u32, u32) {
    let scale = u32::try_from(buffer_scale).unwrap_or(1).max(1);
    ((buffer.0 / scale).max(1), (buffer.1 / scale).max(1))
}

#[cfg(test)]
mod tests {
    use super::{logical_box, logical_size, output_scale, screen_in_window, zoomed};

    #[test]
    fn an_ordinary_display_asks_for_no_scaling() {
        assert_eq!(output_scale(1.0, 3), 1);
    }

    #[test]
    fn a_retina_display_asks_for_its_whole_ratio() {
        assert_eq!(output_scale(2.0, 3), 2);
    }

    #[test]
    fn a_fractional_ratio_rounds_up_rather_than_down() {
        // Rounding down makes the client draw too few pixels, which are then
        // stretched and blurry. Rounding up is downscaled and stays sharp.
        assert_eq!(output_scale(1.5, 3), 2);
        assert_eq!(output_scale(2.25, 3), 3);
    }

    #[test]
    fn the_cap_wins_over_what_the_display_wants() {
        // Scale N costs N² pixels, so a 4x display may be more than the
        // machine can draw.
        assert_eq!(output_scale(4.0, 2), 2);
    }

    #[test]
    fn a_ratio_below_one_is_not_expressible_and_needs_no_help() {
        assert_eq!(output_scale(0.5, 3), 1);
        assert_eq!(output_scale(0.0, 3), 1);
    }

    #[test]
    fn a_nonsense_ratio_falls_back_to_unscaled() {
        // `devicePixelRatio` arrives as JSON, so it can be anything.
        assert_eq!(output_scale(f64::NAN, 3), 1);
        assert_eq!(output_scale(f64::INFINITY, 3), 1);
        assert_eq!(output_scale(-2.0, 3), 1);
    }

    #[test]
    fn a_cap_of_zero_still_leaves_a_usable_scale() {
        assert_eq!(output_scale(2.0, 0), 1);
    }

    #[test]
    fn a_layout_box_is_the_css_box_the_engine_was_given() {
        // A window laid out at 1493x1522 CSS pixels on a 1.2x display is
        // reported by the engine as 1792x1826. Sent unconverted, the client
        // lays out 1.2x too many columns, each 1.2x too small.
        assert_eq!(logical_box((1792, 1826), 1.2), (1493, 1522));
        assert_eq!(logical_box((766, 467), 1.2), (638, 389));
    }

    #[test]
    fn an_unscaled_display_leaves_the_box_alone() {
        // At ratio 1 the two coordinate systems are the same.
        assert_eq!(logical_box((640, 390), 1.0), (640, 390));
    }

    #[test]
    fn a_nonsense_ratio_leaves_the_box_alone() {
        // `devicePixelRatio` arrives as JSON, and dividing by zero would
        // configure the window to nothing.
        assert_eq!(logical_box((640, 390), 0.0), (640, 390));
        assert_eq!(logical_box((640, 390), f64::NAN), (640, 390));
        assert_eq!(logical_box((640, 390), -2.0), (640, 390));
    }

    #[test]
    fn a_box_never_rounds_away_to_nothing() {
        // A client configured to zero draws nothing, and rounding on a dense
        // display could produce zero.
        assert_eq!(logical_box((1, 1), 4.0), (1, 1));
    }

    #[test]
    fn a_scaled_buffer_is_logically_smaller_than_its_pixels() {
        assert_eq!(logical_size((1600, 1200), 2), (800, 600));
    }

    #[test]
    fn an_unscaled_buffer_is_its_own_logical_size() {
        assert_eq!(logical_size((800, 600), 1), (800, 600));
    }

    #[test]
    fn a_client_claiming_a_nonsense_scale_is_treated_as_unscaled() {
        // The scale comes from the client; dividing by zero would panic.
        assert_eq!(logical_size((800, 600), 0), (800, 600));
        assert_eq!(logical_size((800, 600), -2), (800, 600));
    }

    #[test]
    fn a_surface_never_goes_logically_empty() {
        // A buffer smaller than its own scale violates the protocol, but a zero
        // here would divide by zero in the chrome's pointer mapping.
        assert_eq!(logical_size((1, 1), 4), (1, 1));
    }

    #[test]
    fn an_unzoomed_window_draws_at_its_displays_scale() {
        assert_eq!(zoomed(1.5, 1.0), 1.5);
    }

    #[test]
    fn a_zoomed_window_draws_denser_by_its_zoom() {
        // Text 1.5x larger on a scale-1 display: drawn at 1.5, not resampled.
        assert_eq!(zoomed(1.0, 1.5), 1.5);
        assert_eq!(zoomed(2.0, 0.5), 1.0);
    }

    #[test]
    fn a_zoomed_box_is_configured_smaller_and_drawn_back_to_size() {
        // A 1200x800 device-pixel box on a 2x page, zoomed 1.5.
        let ratio = zoomed(2.0, 1.5);
        let logical = logical_box((1200, 800), ratio);
        assert_eq!(logical, (400, 267));
        // Drawn at the zoomed scale, the buffer fills the box again.
        assert_eq!((f64::from(logical.0) * ratio).round(), 1200.0);
    }

    #[test]
    fn a_screen_is_measured_from_a_zoomed_windows_corner_in_its_units() {
        let screen = domicile_scene::Bounds {
            min: domicile_scene::Point { x: 0.0, y: 0.0 },
            max: domicile_scene::Point {
                x: 1920.0,
                y: 1080.0,
            },
        };
        let window = domicile_scene::Point { x: 100.0, y: 80.0 };
        // At zoom 2 a window unit is two desktop pixels, so the screen is half
        // as many of them, starting 50 units left of the window.
        assert_eq!(
            screen_in_window(window, screen, 2.0),
            domicile_scene::Bounds {
                min: domicile_scene::Point { x: -50.0, y: -40.0 },
                max: domicile_scene::Point { x: 910.0, y: 500.0 },
            }
        );
    }
}
