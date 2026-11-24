//! The desktop as an EIS client sees it: the displays as regions, and the
//! windows a point lands on.
//!
//! Everything is in desktop logical units, as `crate::screens` places the
//! displays and the page places windows. A region's offset is unsigned in the
//! protocol, and a display may sit left of or above the origin, so regions are
//! shifted to start at 0,0. The shift is private to the compositor, as the
//! protocol allows.

use domicile_scene::{Bounds, Point};

use crate::screens::Advertised;

/// One display as an EIS region.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub offset: (u32, u32),
    pub size: (u32, u32),
    /// Device pixels per logical pixel.
    pub scale: f32,
}

/// A window on the desktop, as the page last placed it.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub app_id: String,
    pub bounds: Bounds,
    /// Whether it has the keyboard.
    pub focused: bool,
}

/// The displays and windows, at the moment an event arrives.
#[derive(Debug, Clone, PartialEq)]
pub struct Desk {
    displays: Vec<Advertised>,
    windows: Vec<Window>,
}

impl Desk {
    /// Panics with no displays: the compositor always advertises one (see
    /// `crate::screens`).
    pub fn new(displays: Vec<Advertised>, windows: Vec<Window>) -> Desk {
        assert!(
            !displays.is_empty(),
            "a desktop has a display, even a placeholder"
        );
        Desk { displays, windows }
    }

    /// Every display, as a region.
    pub fn regions(&self) -> Vec<Region> {
        let origin = self.origin();
        self.displays
            .iter()
            .map(|display| Region {
                offset: (
                    unsigned(display.position.0 - origin.0),
                    unsigned(display.position.1 - origin.1),
                ),
                size: (unsigned(display.logical.0), unsigned(display.logical.1)),
                scale: display.scale as f32,
            })
            .collect()
    }

    /// The desktop point at a region coordinate, if a display holds it.
    pub fn at(&self, x: f64, y: f64) -> Option<Point> {
        let origin = self.origin();
        let point = Point::new(x + f64::from(origin.0), y + f64::from(origin.1));
        self.display_holding(point).map(|_| point)
    }

    /// `to`, kept on the displays. A point off every display stops at the edge
    /// of the one `from` is on.
    pub fn held(&self, from: Point, to: Point) -> Point {
        match self.display_holding(to) {
            Some(_) => to,
            None => {
                // `from` is off every display only after one was unplugged
                // under it. The pointer then lands on the first.
                let display = self.display_holding(from).unwrap_or(&self.displays[0]);
                let bounds = display.bounds();
                Point::new(
                    to.x.clamp(bounds.min.x, last(bounds.max.x)),
                    to.y.clamp(bounds.min.y, last(bounds.max.y)),
                )
            }
        }
    }

    /// Where a relative pointer starts: the middle of the first display.
    pub fn middle(&self) -> Point {
        let bounds = self.displays[0].bounds();
        Point::new(
            (bounds.min.x + bounds.max.x) / 2.0,
            (bounds.min.y + bounds.max.y) / 2.0,
        )
    }

    /// The desktop point at `x`, `y` in window `app_id`, as the engine
    /// reports the pointer. `None` for a window the page has not placed.
    pub fn point_in(&self, app_id: &str, x: f64, y: f64) -> Option<Point> {
        self.windows
            .iter()
            .find(|window| window.app_id == app_id)
            .map(|window| Point::new(window.bounds.min.x + x, window.bounds.min.y + y))
    }

    /// The window under `point`, and the point relative to it.
    ///
    /// The page knows the stacking and this does not. Where windows overlap,
    /// the one with the keyboard wins, then the smallest, which is usually a
    /// dialog over its parent.
    pub fn window_under(&self, point: Point) -> Option<(String, Point)> {
        self.windows
            .iter()
            .filter(|window| holds(&window.bounds, point))
            .min_by(|a, b| {
                b.focused
                    .cmp(&a.focused)
                    .then(area(&a.bounds).total_cmp(&area(&b.bounds)))
            })
            .map(|window| {
                (
                    window.app_id.clone(),
                    Point::new(point.x - window.bounds.min.x, point.y - window.bounds.min.y),
                )
            })
    }

    fn display_holding(&self, point: Point) -> Option<&Advertised> {
        self.displays
            .iter()
            .find(|display| holds(&display.bounds(), point))
    }

    /// The top-left corner of everything, which regions count from.
    fn origin(&self) -> (i32, i32) {
        self.displays
            .iter()
            .map(|display| display.position)
            .fold((i32::MAX, i32::MAX), |(x, y), at| {
                (x.min(at.0), y.min(at.1))
            })
    }
}

/// Whether `point` is inside `bounds`. The far edges belong to the neighbor.
fn holds(bounds: &Bounds, point: Point) -> bool {
    (bounds.min.x..bounds.max.x).contains(&point.x)
        && (bounds.min.y..bounds.max.y).contains(&point.y)
}

fn area(bounds: &Bounds) -> f64 {
    (bounds.max.x - bounds.min.x) * (bounds.max.y - bounds.min.y)
}

/// The last logical pixel before a far edge.
fn last(edge: f64) -> f64 {
    edge - 1.0
}

/// A measure that cannot be negative, from a coordinate.
///
/// Panics on a negative one: offsets are taken from the origin and sizes are
/// validated upstream, so that is a bug.
fn unsigned(measure: i32) -> u32 {
    u32::try_from(measure).expect("a region's offset and size are not negative")
}

#[cfg(test)]
mod tests {
    use domicile_config::Transform;
    use domicile_scene::{Bounds, Point};

    use super::{Desk, Region, Window};
    use crate::screens::Advertised;

    fn display(position: (i32, i32), logical: (i32, i32), scale: f64) -> Advertised {
        Advertised {
            name: format!("{position:?}"),
            position,
            logical,
            mode: logical,
            scale,
            transform: Transform::Normal,
            description: String::new(),
            edid: String::new(),
            connector: String::new(),
            display: None,
            physical_mm: (0, 0),
            refresh_mhz: 0,
            adaptive_sync: crate::engine::AdaptiveSync::Unsupported,
            hdr: Default::default(),
        }
    }

    fn window(app_id: &str, at: (f64, f64), size: (f64, f64), focused: bool) -> Window {
        Window {
            app_id: app_id.into(),
            bounds: Bounds {
                min: Point::new(at.0, at.1),
                max: Point::new(at.0 + size.0, at.1 + size.1),
            },
            focused,
        }
    }

    /// A laptop with a 2x monitor to its left, which starts left of the origin.
    fn laptop_and_monitor() -> Desk {
        Desk::new(
            vec![
                display((0, 0), (1280, 800), 1.0),
                display((-1920, -200), (1920, 1080), 2.0),
            ],
            Vec::new(),
        )
    }

    #[test]
    fn each_display_is_a_region_counted_from_the_top_left_of_everything() {
        assert_eq!(
            laptop_and_monitor().regions(),
            [
                Region {
                    offset: (1920, 200),
                    size: (1280, 800),
                    scale: 1.0,
                },
                Region {
                    offset: (0, 0),
                    size: (1920, 1080),
                    scale: 2.0,
                },
            ]
        );
    }

    #[test]
    fn a_region_coordinate_is_a_point_on_the_desktop() {
        assert_eq!(
            laptop_and_monitor().at(1930.0, 210.0),
            Some(Point::new(10.0, 10.0))
        );
        assert_eq!(
            laptop_and_monitor().at(10.0, 10.0),
            Some(Point::new(-1910.0, -190.0))
        );
    }

    #[test]
    fn a_coordinate_off_every_display_is_nowhere() {
        // Below the monitor, left of the laptop: inside the bounding box, on
        // no display.
        assert_eq!(laptop_and_monitor().at(10.0, 1100.0), None);
    }

    #[test]
    fn a_pointer_stays_on_the_displays() {
        let desk = laptop_and_monitor();
        assert_eq!(
            desk.held(Point::new(100.0, 100.0), Point::new(-50.0, 100.0)),
            Point::new(-50.0, 100.0),
            "it crosses onto a neighbor"
        );
        assert_eq!(
            desk.held(Point::new(100.0, 700.0), Point::new(100.0, 5000.0)),
            Point::new(100.0, 799.0),
            "and stops at the edge of the display it was on"
        );
    }

    #[test]
    fn a_relative_pointer_starts_in_the_middle_of_the_first_display() {
        assert_eq!(laptop_and_monitor().middle(), Point::new(640.0, 400.0));
    }

    #[test]
    fn a_point_lands_on_the_window_under_it_relative_to_that_window() {
        let desk = Desk::new(
            vec![display((0, 0), (1280, 800), 1.0)],
            vec![window("1", (100.0, 50.0), (400.0, 300.0), false)],
        );
        assert_eq!(
            desk.window_under(Point::new(110.0, 70.0)),
            Some(("1".into(), Point::new(10.0, 20.0)))
        );
        assert_eq!(desk.window_under(Point::new(600.0, 70.0)), None);
    }

    #[test]
    fn where_windows_overlap_the_focused_one_wins_then_the_smallest() {
        let big = window("big", (0.0, 0.0), (800.0, 600.0), false);
        let dialog = window("dialog", (100.0, 100.0), (200.0, 100.0), false);
        let unfocused = Desk::new(
            vec![display((0, 0), (1280, 800), 1.0)],
            vec![big.clone(), dialog.clone()],
        );
        assert_eq!(
            unfocused.window_under(Point::new(150.0, 150.0)).unwrap().0,
            "dialog"
        );
        let focused = Desk::new(
            vec![display((0, 0), (1280, 800), 1.0)],
            vec![
                Window {
                    focused: true,
                    ..big
                },
                dialog,
            ],
        );
        assert_eq!(
            focused.window_under(Point::new(150.0, 150.0)).unwrap().0,
            "big"
        );
    }
}
