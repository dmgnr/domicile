//! The `wl_output`s the compositor advertises, and which source defines the
//! desktop.
//!
//! - **Described:** `output.displays` defines the desktop outright.
//! - **Placed:** a matching `output.profiles` entry places the monitors DRM
//!   reports. Re-matched on every hotplug and reload.
//! - **The engine's reading:** monitors no profile matches, as ozone laid them
//!   out, unscaled and unrotated.
//! - **The window:** a nested run with nothing described. The window is the
//!   desktop.
//!
//! [`Screens::reloaded_into`] and [`Screens::replugged_into`] pick the source.
//! See `docs/DISPLAYS.md`. Kept free of Smithay so it can be unit tested.

use domicile_config::{
    ConfigError, Connected, Desk, Desktop, InputConfig, Layout, OutputConfig, Transform,
};
use domicile_protocol::{
    AdaptiveSync as WireAdaptiveSync, DisplayHdr, DisplayInfo, DisplayTransform, MonitorInfo, Scale,
};
use domicile_scene::{Bounds, Point};

use crate::engine::{AdaptiveSync, Connector, Display, Hdr, HdrState, Pointer, VirtualDisplay};
use crate::pnp_ids::Vendors;

/// The `wl_output` physical size for an output with no known size.
///
/// Zero is the protocol's value for "doesn't make sense for this output", which
/// clients check instead of dividing by it.
pub const UNKNOWN_PHYSICAL_MM: (i32, i32) = (0, 0);

/// The `wl_output` refresh rate, in mHz, for an output with no known rate.
///
/// Zero per the protocol. Clients are paced by `wl_surface.frame` anyway.
pub const UNKNOWN_REFRESH_MHZ: i32 = 0;

/// The placeholder desktop size, in logical units, before a real one is known.
///
/// Every run needs an output from startup, before DRM reports a monitor or the
/// nested window reports its size. Both replace this almost immediately, so it
/// is not configurable. Scale 1 avoids guessing a density.
const UNDESCRIBED_DESKTOP: (i32, i32) = (1280, 800);

/// One `wl_output` as the compositor advertises it.
#[derive(Debug, Clone, PartialEq)]
pub struct Advertised {
    /// The `wl_output` name, which is also what the chrome addresses.
    pub name: String,
    /// Its top-left corner in desktop coordinates.
    pub position: (i32, i32),
    /// Its size in logical units: the mode, turned by `transform`, over
    /// `scale`.
    pub logical: (i32, i32),
    /// The mode in physical pixels. Not rotated by `transform`, since the
    /// hardware scans out the same way either way.
    ///
    /// Stored rather than derived from the logical size, because multiplying a
    /// rounded logical size back up can miss the CRTC's mode by a pixel or two.
    pub mode: (i32, i32),
    /// Device pixels per logical pixel. Fractional.
    ///
    /// `wl_output.scale` sends it rounded up (see
    /// [`wl_output_scale`](Advertised::wl_output_scale)); `xdg_output` carries
    /// the resulting logical size.
    pub scale: f64,
    /// Which way up the monitor is, as `wl_output.geometry` states it.
    pub transform: Transform,
    /// The panel's `"<MAKE> <MODEL> <SERIAL>"` from its EDID, with the maker
    /// spelled out from hwdata's `pnp.ids` when known, or empty.
    ///
    /// Sent as `wl_output.description`. Profiles match either maker spelling.
    /// Only the engine's displays have one. See "Monitor names" in `docs/DISPLAYS.md`.
    pub description: String,
    /// The panel's `"<MAKE> <MODEL> <SERIAL>"` as its EDID spells it, with the
    /// maker as a three-letter code, or empty. Profiles match it as well as
    /// [`description`](Advertised::description).
    pub edid: String,
    /// The connector it is plugged into, as the kernel names it (`eDP-1`), or
    /// empty. Profiles match it too.
    pub connector: String,
    /// The engine display it shows, by [`Display::id`]. `None` on a described
    /// or nested desktop.
    pub display: Option<i64>,
    /// The panel's size in millimeters, or [`UNKNOWN_PHYSICAL_MM`]. Only the
    /// engine's displays report one.
    pub physical_mm: (i32, i32),
    /// The refresh rate in mHz, or [`UNKNOWN_REFRESH_MHZ`]. Only the engine's
    /// displays report one.
    pub refresh_mhz: i32,
    /// Whether it scans out with a variable refresh rate. Only the engine's
    /// displays can.
    pub adaptive_sync: AdaptiveSync,
    /// Whether it is driven in HDR10, and how bright its panel gets. Only the
    /// engine's displays can be.
    pub hdr: Hdr,
}

impl Advertised {
    /// The integer `wl_output.scale` for this display's density.
    ///
    /// Rounded up: a client drawing more pixels than needed is downscaled and
    /// stays sharp, while one drawing fewer is stretched and blurry.
    ///
    /// Panics on a non-positive or non-finite density. Densities are validated
    /// upstream, so that is a bug.
    pub fn wl_output_scale(&self) -> i32 {
        let ceiled = self.scale.ceil();
        if (1.0..=f64::from(i32::MAX)).contains(&ceiled) {
            ceiled as i32
        } else {
            // `panic!` rather than `assert!` so the payload is a `String`, like
            // every other panic here.
            panic!(
                "a display's density is a positive number a coordinate can hold, not {}",
                self.scale
            )
        }
    }

    /// The rectangle this output occupies on the desktop, in logical units,
    /// which is what windows are placed against.
    pub fn bounds(&self) -> Bounds {
        // `Advertised` is unvalidated, so check for overflow. A wrapped edge
        // would put `max` below `min`, which overlaps nothing and silently puts
        // every window on every output.
        let far = |at: i32, size: i32| {
            f64::from(
                at.checked_add(size)
                    .expect("a display's far edge fits a coordinate"),
            )
        };
        Bounds {
            min: Point::new(f64::from(self.position.0), f64::from(self.position.1)),
            max: Point::new(
                far(self.position.0, self.logical.0),
                far(self.position.1, self.logical.1),
            ),
        }
    }

    /// This output under the names a display profile can call it by, for
    /// Settings.
    pub fn monitor(&self) -> MonitorInfo {
        let mut names = vec![self.name.clone()];
        for name in [&self.connector, &self.edid, &self.description] {
            if !name.is_empty() && !names.contains(name) {
                names.push(name.clone());
            }
        }
        MonitorInfo {
            names,
            hdr: as_wire_hdr(self.hdr.state),
        }
    }

    /// This output as sent to the chrome.
    ///
    /// Panics on a negative size or scale instead of folding it to a plausible
    /// positive value.
    pub fn described(&self) -> DisplayInfo {
        DisplayInfo {
            name: self.name.clone(),
            position: [self.position.0, self.position.1],
            scale: as_measure(self.wl_output_scale()),
            size: [as_measure(self.logical.0), as_measure(self.logical.1)],
            mode: [as_measure(self.mode.0), as_measure(self.mode.1)],
            // Unknown is zero on both sides of the wire.
            refresh_mhz: u32::try_from(self.refresh_mhz).unwrap_or(0),
            adaptive_sync: as_wire_adaptive_sync(self.adaptive_sync),
            hdr: as_wire_hdr(self.hdr.state),
            peak_luminance: self.hdr.max_luminance,
            sdr_white: self.hdr.sdr_white,
            transform: as_wire_transform(self.transform),
        }
    }
}

/// Adaptive sync as the protocol spells it.
fn as_wire_adaptive_sync(adaptive_sync: AdaptiveSync) -> WireAdaptiveSync {
    match adaptive_sync {
        AdaptiveSync::Unsupported => WireAdaptiveSync::Unsupported,
        AdaptiveSync::Off => WireAdaptiveSync::Off,
        AdaptiveSync::On => WireAdaptiveSync::On,
    }
}

/// HDR as the protocol spells it.
fn as_wire_hdr(state: HdrState) -> DisplayHdr {
    match state {
        HdrState::Unsupported => DisplayHdr::Unsupported,
        HdrState::Off => DisplayHdr::Off,
        HdrState::On => DisplayHdr::On,
    }
}

/// A configured transform as the protocol spells it.
///
/// `domicile-config` and `domicile-protocol` do not depend on each other, so
/// each has its own transform type.
fn as_wire_transform(transform: Transform) -> DisplayTransform {
    match transform {
        Transform::Normal => DisplayTransform::Normal,
        Transform::Rotate90 => DisplayTransform::Rotate90,
        Transform::Rotate180 => DisplayTransform::Rotate180,
        Transform::Rotate270 => DisplayTransform::Rotate270,
    }
}

/// Where one output of a rearranged desktop comes from, one per output of the
/// new desktop, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// The `wl_output` at this index of the old list, updated in place.
    ///
    /// Kept even when size or scale changed: replacing the global looks to
    /// clients like an unplug.
    Kept(usize),
    /// No old output has this name, so one is created.
    New,
}

/// How to turn the advertised outputs into another desktop.
///
/// Outputs are matched by name, which is how the shell addresses a `<Screen>`.
/// A renamed display is a different display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rearrangement {
    /// One per display of the new desktop, in its order.
    pub slots: Vec<Slot>,
    /// Indices into the old list whose globals must be destroyed, ascending.
    ///
    /// Separate from `slots` because it indexes the old list.
    pub retired: Vec<usize>,
}

/// Every output the compositor advertises, and the desktop they make up.
#[derive(Debug, Clone, PartialEq)]
pub struct Screens {
    outputs: Vec<Advertised>,
    size: (i32, i32),
    follows_the_window: bool,
    /// Connector settings from a profile. Empty for every other desktop; see
    /// [`Screens::scanout`].
    scanout: Vec<Connector>,
}

impl Screens {
    /// The outputs a configured desktop describes, one per display, with
    /// positions already normalized by `Desktop`.
    pub fn described(desktop: &Desktop) -> Screens {
        Screens {
            follows_the_window: false,
            scanout: Vec::new(),
            outputs: desktop
                .displays()
                .map(|display| {
                    let logical = (as_coordinate(display.size.0), as_coordinate(display.size.1));
                    let scale = as_coordinate(display.scale);
                    Advertised {
                        logical,
                        mode: multiplied(logical, scale),
                        name: display.name.clone(),
                        position: display.position,
                        scale: f64::from(scale),
                        // A described display states its logical size, so there
                        // is no rotation to apply.
                        transform: Transform::Normal,
                        description: String::new(),
                        edid: String::new(),
                        connector: String::new(),
                        display: None,
                        physical_mm: UNKNOWN_PHYSICAL_MM,
                        refresh_mhz: UNKNOWN_REFRESH_MHZ,
                        adaptive_sync: AdaptiveSync::Unsupported,
                        hdr: Default::default(),
                    }
                })
                .collect(),
            size: (
                as_coordinate(desktop.size().0),
                as_coordinate(desktop.size().1),
            ),
        }
    }

    /// The outputs the engine reports, one per DRM display, unplaced by any
    /// profile.
    ///
    /// - Scale 1, because the engine reports none (see [`Display`]).
    /// - Millimeters and refresh rate pass through, zeros included.
    /// - Positions are the engine's. Ozone lays displays out from the origin,
    ///   so there is nothing to normalize.
    ///
    /// The engine lays out pixels in one row only. So the compositor lays the
    /// desk out instead when a virtual monitor extends it: above the
    /// monitors, or at a scale in `virtuals`. Each other display stays where
    /// the engine put it, and the virtual ones extend it (see
    /// [`Screens::extended_onto`]).
    pub fn from_the_engine(
        displays: &[Display],
        vendors: &Vendors,
        virtuals: &[VirtualDisplay],
    ) -> Screens {
        let monitors: Vec<Display> = displays
            .iter()
            .filter(|display| !display.is_virtual())
            .cloned()
            .collect();
        let extended = displays.iter().any(Display::is_virtual);
        let scaled = virtuals.iter().any(|display| display.scale != Scale::ONE);
        // A desk of virtual monitors alone, as on a headless engine, is the
        // engine's row unless one is scaled.
        if !extended || (monitors.is_empty() && !scaled) {
            return Screens::as_the_engine_placed(displays, vendors);
        }
        let placed = if monitors.is_empty() {
            Screens {
                follows_the_window: false,
                scanout: Vec::new(),
                outputs: Vec::new(),
                size: (0, 0),
            }
        } else {
            Screens {
                // A layout darkens each connector it leaves out.
                scanout: monitors
                    .iter()
                    .map(|display| Connector {
                        id: display.id,
                        enabled: true,
                        origin: display.position,
                        transform: Transform::Normal,
                        scale: 1.0,
                        desk: Some(Desk {
                            position: display.position,
                            size: display.size,
                        }),
                        mode: None,
                        refresh_mhz: None,
                        adaptive_sync: false,
                        hdr: false,
                        sdr_white: domicile_config::DEFAULT_SDR_WHITE,
                    })
                    .collect(),
                ..Screens::as_the_engine_placed(&monitors, vendors)
            }
        };
        placed.extended_onto(displays, virtuals)
    }

    /// Every display where the engine put it, unscaled and unrotated.
    fn as_the_engine_placed(displays: &[Display], vendors: &Vendors) -> Screens {
        let outputs: Vec<Advertised> = displays
            .iter()
            .map(|display| {
                let logical = (as_coordinate(display.size.0), as_coordinate(display.size.1));
                Advertised {
                    logical,
                    // Unscaled and unrotated, so the mode is the logical size.
                    mode: logical,
                    name: name_of(display),
                    position: display.position,
                    scale: 1.0,
                    transform: Transform::Normal,
                    description: advertised_description(display, vendors),
                    edid: display.description.clone(),
                    connector: display.connector.clone(),
                    display: Some(display.id),
                    physical_mm: display.physical_mm,
                    refresh_mhz: display.refresh_mhz,
                    adaptive_sync: display.adaptive_sync,
                    hdr: display.hdr,
                }
            })
            .collect();
        // Engine coordinates are not validated upstream, so check for overflow.
        let far = |at: i32, size: i32| {
            at.checked_add(size)
                .expect("a display's far edge fits a coordinate")
        };
        let size = outputs
            .iter()
            .map(|output| {
                (
                    far(output.position.0, output.logical.0),
                    far(output.position.1, output.logical.1),
                )
            })
            .reduce(|desktop, output| (desktop.0.max(output.0), desktop.1.max(output.1)))
            .expect("the engine reports at least one display");
        Screens {
            follows_the_window: false,
            scanout: Vec::new(),
            outputs,
            size,
        }
    }

    /// The single output a run with no described desktop starts on.
    ///
    /// [`UNDESCRIBED_DESKTOP`] is logical, so the mode scales with density
    /// instead of the desktop shrinking. The window resizes it later.
    pub fn nested() -> Screens {
        Screens::following_the_window(UNDESCRIBED_DESKTOP, 1)
    }

    /// The single output that follows Domicile's own window.
    ///
    /// Always named `domicile-0`, so clients stay on it across resizes.
    pub fn following_the_window(logical: (i32, i32), scale: i32) -> Screens {
        Screens {
            follows_the_window: true,
            scanout: Vec::new(),
            outputs: vec![Advertised {
                logical,
                mode: multiplied(logical, scale),
                name: "domicile-0".to_string(),
                position: (0, 0),
                scale: f64::from(scale),
                transform: Transform::Normal,
                description: String::new(),
                edid: String::new(),
                connector: String::new(),
                display: None,
                physical_mm: UNKNOWN_PHYSICAL_MM,
                refresh_mhz: UNKNOWN_REFRESH_MHZ,
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            }],
            size: logical,
        }
    }

    /// The outputs a matched profile makes of the engine's displays.
    ///
    /// The profile sets position, scale and rotation. The panel's own
    /// properties come from the engine's reading. Virtual displays, which no
    /// profile names, extend the desk; see [`Screens::extended_onto`].
    pub fn from_the_layout(
        layout: &Layout,
        displays: &[Display],
        vendors: &Vendors,
        virtuals: &[VirtualDisplay],
    ) -> Screens {
        let profiled = Screens {
            follows_the_window: false,
            // By the engine's id: an output name is this compositor's naming,
            // which the engine does not know.
            scanout: layout
                .scanout()
                .iter()
                .map(|display| Connector {
                    id: id_of(&display.name, displays),
                    enabled: display.enabled,
                    origin: display.origin,
                    transform: display.transform,
                    scale: display.scale,
                    desk: display.desk,
                    mode: display.mode,
                    refresh_mhz: display.refresh_mhz,
                    adaptive_sync: display.adaptive_sync,
                    hdr: display.hdr,
                    sdr_white: display.sdr_white,
                })
                .collect(),
            outputs: layout
                .placed()
                .map(|placed| {
                    // The layout was built from these displays.
                    let display = displays
                        .iter()
                        .find(|display| name_of(display) == placed.name)
                        .expect("a layout only places displays the engine reported");
                    Advertised {
                        logical: (
                            as_coordinate(placed.logical.0),
                            as_coordinate(placed.logical.1),
                        ),
                        mode: (as_coordinate(placed.mode.0), as_coordinate(placed.mode.1)),
                        name: placed.name.clone(),
                        position: placed.position,
                        scale: placed.scale,
                        transform: placed.transform,
                        description: advertised_description(display, vendors),
                        edid: display.description.clone(),
                        connector: display.connector.clone(),
                        display: Some(display.id),
                        physical_mm: display.physical_mm,
                        refresh_mhz: display.refresh_mhz,
                        adaptive_sync: display.adaptive_sync,
                        hdr: display.hdr,
                    }
                })
                .collect(),
            size: (
                as_coordinate(layout.size().0),
                as_coordinate(layout.size().1),
            ),
        };
        profiled.extended_onto(displays, virtuals)
    }

    /// This desktop with the virtual displays in `displays` added in a row,
    /// each at its scale in `virtuals` (1 if it has none).
    ///
    /// The row sits on the monitors' top edge, centered over them, so the
    /// pointer reaches a TV by going up. The monitors move down (and right,
    /// for a row wider than them) to keep the desktop's top-left at the
    /// origin. A desk of virtual displays alone is the row itself, top-aligned.
    ///
    /// On the engine's desktop each goes past the end of the connectors' row,
    /// where the engine places a display the layout does not name.
    fn extended_onto(mut self, displays: &[Display], virtuals: &[VirtualDisplay]) -> Screens {
        let mode_of = |id: i64| {
            displays
                .iter()
                .find(|display| display.id == id)
                .expect("a layout only names displays the engine reported")
                .size
        };
        let mut row_end = self
            .scanout
            .iter()
            .map(|connector| connector.origin.0 + as_coordinate(mode_of(connector.id).0))
            .max()
            .unwrap_or(0);
        let added: Vec<(&Display, f64, (u32, u32))> = displays
            .iter()
            .filter(|display| display.is_virtual())
            .map(|display| {
                let scale = virtuals
                    .iter()
                    .find(|virtual_display| virtual_display.id == display.id)
                    .map_or(1.0, |virtual_display| virtual_display.scale.get());
                (display, scale, logical_of(display.size, scale))
            })
            .collect();
        let row = (
            added
                .iter()
                .map(|(_, _, logical)| as_coordinate(logical.0))
                .sum::<i32>(),
            added
                .iter()
                .map(|(_, _, logical)| as_coordinate(logical.1))
                .max()
                .unwrap_or(0),
        );
        let on_the_monitors = !self.outputs.is_empty();
        let row_left = if on_the_monitors {
            (self.size.0 - row.0).div_euclid(2)
        } else {
            0
        };
        let moved = if on_the_monitors {
            ((-row_left).max(0), row.1)
        } else {
            (0, 0)
        };
        for output in &mut self.outputs {
            output.position = (output.position.0 + moved.0, output.position.1 + moved.1);
        }
        for desk in self
            .scanout
            .iter_mut()
            .filter_map(|connector| connector.desk.as_mut())
        {
            desk.position = (desk.position.0 + moved.0, desk.position.1 + moved.1);
        }
        let monitors_size = self.size;
        self.size = (
            (monitors_size.0 + moved.0).max(row_left + moved.0 + row.0),
            monitors_size.1 + moved.1,
        );
        let mut next_left = row_left + moved.0;
        for (display, scale, logical) in added {
            let mode = (as_coordinate(display.size.0), as_coordinate(display.size.1));
            // On the monitors' top edge; top-aligned on a desk of its own.
            let top = if on_the_monitors {
                row.1 - as_coordinate(logical.1)
            } else {
                0
            };
            let position = (next_left, top);
            self.scanout.push(Connector {
                id: display.id,
                enabled: true,
                origin: (row_end, 0),
                transform: Transform::Normal,
                scale,
                desk: Some(Desk {
                    position,
                    size: logical,
                }),
                mode: None,
                refresh_mhz: None,
                adaptive_sync: false,
                hdr: false,
                sdr_white: domicile_config::DEFAULT_SDR_WHITE,
            });
            let logical = (as_coordinate(logical.0), as_coordinate(logical.1));
            self.outputs.push(Advertised {
                logical,
                mode,
                name: name_of(display),
                position,
                scale,
                transform: Transform::Normal,
                description: display.description.clone(),
                edid: display.description.clone(),
                connector: display.connector.clone(),
                display: Some(display.id),
                physical_mm: display.physical_mm,
                refresh_mhz: display.refresh_mhz,
                adaptive_sync: display.adaptive_sync,
                hdr: display.hdr,
            });
            row_end += mode.0;
            next_left += logical.0;
            self.size.1 = self.size.1.max(logical.1);
        }
        self
    }

    /// The outputs, in the order the config wrote them.
    pub fn outputs(&self) -> impl Iterator<Item = &Advertised> {
        self.outputs.iter()
    }

    /// The monitors as screen casts see them.
    ///
    /// On a tty each engine display is captured on its own. A nested desktop
    /// is one capture of Domicile's window, which the engine names zero, and
    /// one screen named after the first output.
    pub fn cast_screens(&self) -> Vec<crate::casting::Screen> {
        let engine: Vec<_> = self
            .outputs
            .iter()
            .filter_map(|output| {
                Some(crate::casting::Screen {
                    name: output.name.clone(),
                    display: output.display?,
                    desk: (
                        output.position.0,
                        output.position.1,
                        output.logical.0,
                        output.logical.1,
                    ),
                    scale: output.scale,
                })
            })
            .collect();
        if !engine.is_empty() {
            return engine;
        }
        let first = self
            .outputs
            .first()
            .expect("every desktop advertises an output");
        vec![crate::casting::Screen {
            name: first.name.clone(),
            display: 0,
            desk: (0, 0, self.size.0, self.size.1),
            scale: self
                .outputs
                .iter()
                .map(|output| output.scale)
                .fold(f64::MIN, f64::max),
        }]
    }

    /// The monitors a screen cast may pick, each named by its panel.
    pub fn cast_monitors(&self) -> Vec<crate::casting::Candidate> {
        self.cast_screens()
            .into_iter()
            .map(|screen| crate::casting::Candidate {
                title: self
                    .outputs
                    .iter()
                    .find(|output| output.name == screen.name)
                    .expect("every cast screen is an output")
                    .description
                    .clone(),
                app_id: String::new(),
                process: None,
                part: None,
                bounds: Some(crate::casting::Region {
                    position: (screen.desk.0, screen.desk.1),
                    size: (screen.desk.2, screen.desk.3),
                }),
                source: crate::casting::Source::Monitor(screen.name),
            })
            .collect()
    }

    /// Connector settings for the engine: which to light and where each mode
    /// goes.
    ///
    /// Empty means the hardware decides, not "light nothing". Only a profile's
    /// desktop has connector settings. When a profile that turned a panel off
    /// stops matching (e.g. after an unplug), the empty list relights the
    /// panel. See "Which connectors light" in `docs/DISPLAYS.md`.
    pub fn scanout(&self) -> &[Connector] {
        &self.scanout
    }

    /// Where desktop point `point` is on the engine's desk, in its pixels,
    /// by the [`Screens::scanout`] connector whose desk holds it. A point on
    /// no connector's desk is at scale 1, as on a desktop with no connector
    /// settings.
    pub fn engine_pixel_of(&self, point: (f64, f64)) -> (f64, f64) {
        self.scanout
            .iter()
            .find_map(|connector| engine_pixel_on(connector, point))
            .unwrap_or(point)
    }

    /// The desktop a reloaded config makes, or `None` to keep this one.
    ///
    /// - With `output.displays`, the config defines the desktop.
    /// - With none and monitors read, the profiles are re-matched against
    ///   `displays`, so an edited profile applies on save. `displays` is the
    ///   engine's last reading, empty when nested or before the first display
    ///   event.
    /// - With none and no monitors read, the window defines it, through
    ///   `adopt_window_scale`. Rebuilding from the config would reset it to the
    ///   scale-1 placeholder. This matters because the watcher watches the
    ///   config's directory, so unrelated files trigger reloads.
    /// - A desktop that stops being described falls back to
    ///   [`UNDESCRIBED_DESKTOP`].
    pub fn reloaded_into(
        &self,
        output: &OutputConfig,
        displays: &[Display],
        vendors: &Vendors,
        virtuals: &[VirtualDisplay],
    ) -> Result<Option<Screens>, ConfigError> {
        match output.desktop() {
            Some(desktop) => Ok(Some(Screens::described(&desktop))),
            // Not described, so the profile match or the engine's reading
            // decides.
            None if !displays.is_empty() => {
                self.replugged_into(displays, output, vendors, virtuals)
            }
            None if self.follows_the_window() => Ok(None),
            None => Ok(Some(Screens::nested())),
        }
    }

    /// How to become `next` while keeping each display's `wl_output`.
    ///
    /// A display whose name is in both desktops keeps its global, whatever else
    /// changed. Recreating it would tell clients their monitor was unplugged.
    pub fn rearranged_into(&self, next: &Screens) -> Rearrangement {
        let slots: Vec<Slot> = next
            .outputs
            .iter()
            .map(|wanted| {
                self.outputs
                    .iter()
                    .position(|had| had.name == wanted.name)
                    .map_or(Slot::New, Slot::Kept)
            })
            .collect();
        let retired = (0..self.outputs.len())
            .filter(|index| !slots.contains(&Slot::Kept(*index)))
            .collect();
        Rearrangement { slots, retired }
    }

    /// The desktop the engine's displays make, or `None` to keep this one.
    ///
    /// `output.displays` wins over DRM. Otherwise the engine decides, because
    /// on a tty it holds DRM master and the compositor has no card node. A
    /// nested engine reports no displays, since its screens are the host's
    /// monitors.
    ///
    /// The check is on the config, not on whether the desktop follows the
    /// window: the first DRM reading stops it following, and later hotplugs
    /// must still apply.
    ///
    /// - `Err`: a profile matched but cannot apply, for example the monitor's
    ///   mode differs from the profile's. The caller keeps the current desktop
    ///   and reports the error, as `ConfigStore` does for a config that fails
    ///   to parse.
    /// - `Ok(None)`: keep this desktop. Either the config describes it, or no
    ///   profile matches and the engine is mid-update: its displays overlap,
    ///   and with no profile in force it reports again once laid out. Leaving a
    ///   profile is always taken, since only that sends the engine the empty
    ///   layout.
    /// - `Ok(Some(_))`: the first matching profile's layout, or the engine's
    ///   reading when none matches.
    pub fn replugged_into(
        &self,
        displays: &[Display],
        output: &OutputConfig,
        vendors: &Vendors,
        virtuals: &[VirtualDisplay],
    ) -> Result<Option<Screens>, ConfigError> {
        if output.desktop().is_some() {
            Ok(None)
        } else {
            Ok(match output.layout(&connected(displays, vendors))? {
                Some(layout) => Some(Screens::from_the_layout(
                    &layout, displays, vendors, virtuals,
                )),
                None => {
                    let read = Screens::from_the_engine(displays, vendors, virtuals);
                    (!self.scanout.is_empty() || read.is_laid_out()).then_some(read)
                }
            })
        }
    }

    /// Whether no two outputs overlap.
    ///
    /// An engine laying out its own row never overlaps displays in a finished
    /// update. See "Where the display list comes from" in `docs/DISPLAYS.md`.
    fn is_laid_out(&self) -> bool {
        self.outputs.iter().enumerate().all(|(index, output)| {
            self.outputs[..index]
                .iter()
                .all(|earlier| !earlier.bounds().overlaps(&output.bounds()))
        })
    }

    /// Which outputs a window with these bounds is on, in [`outputs`] order.
    ///
    /// [`outputs`]: Screens::outputs
    ///
    /// Two cases report every output:
    ///
    /// - `None`: a surface with no portal (unmounted, hidden or a popup). The
    ///   shell hides windows instead of unmounting them, so this keys on having
    ///   no portal now.
    /// - No overlap: a portal in a gap between displays or off the edge. A
    ///   toolkit that scales blocks until it is told an output, so "none" would
    ///   leave the window blank.
    ///
    /// One entry per output, because the caller sends enter or leave for each.
    pub fn entered_by(&self, bounds: Option<Bounds>) -> Vec<bool> {
        let everywhere = || vec![true; self.outputs.len()];
        match bounds {
            None => everywhere(),
            Some(bounds) => {
                let touched: Vec<bool> = self
                    .outputs
                    .iter()
                    .map(|output| output.bounds().overlaps(&bounds))
                    .collect();
                if touched.contains(&true) {
                    touched
                } else {
                    everywhere()
                }
            }
        }
    }

    /// The scale a window in `bounds` should draw at, for
    /// `wp_fractional_scale_v1`.
    ///
    /// The scale of the display holding the most of the window, as sway picks
    /// it. With no bounds or no overlap the window is on every display
    /// ([`entered_by`](Screens::entered_by)), so it draws for the densest.
    pub fn scale_for(&self, bounds: Option<Bounds>) -> f64 {
        let densest = || {
            self.outputs
                .iter()
                .map(|output| output.scale)
                .reduce(f64::max)
                // A desktop of no displays has no density to match.
                .unwrap_or(1.0)
        };
        bounds
            .and_then(|bounds| self.holding_most_of(bounds))
            .map_or_else(densest, |output| output.scale)
    }

    /// The area of the display holding the most of a window in `bounds`,
    /// which its menus are kept on. `None` when it is on no display.
    pub fn screen_of(&self, bounds: Bounds) -> Option<Bounds> {
        self.holding_most_of(bounds).map(Advertised::bounds)
    }

    /// Whether the display holding the most of a window in `bounds` is
    /// driven in HDR. A window on no display is in SDR.
    pub fn hdr_for(&self, bounds: Option<Bounds>) -> Hdr {
        bounds
            .and_then(|bounds| self.holding_most_of(bounds))
            .map_or_else(Hdr::default, |output| output.hdr)
    }

    /// Whether the display named `name` is driven in HDR. One there is no
    /// longer is in SDR.
    pub fn hdr_of(&self, name: &str) -> Hdr {
        self.outputs
            .iter()
            .find(|output| output.name == name)
            .map_or_else(Hdr::default, |output| output.hdr)
    }

    /// The display holding the most of `bounds`, as sway picks it.
    fn holding_most_of(&self, bounds: Bounds) -> Option<&Advertised> {
        self.outputs
            .iter()
            .map(|output| (overlap_area(&output.bounds(), &bounds), output))
            .filter(|(area, _)| *area > 0.0)
            .max_by(|(a, _), (b, _)| a.total_cmp(b))
            .map(|(_, output)| output)
    }

    /// The desktop's size in logical units — the bounding box of the outputs.
    pub fn size(&self) -> (i32, i32) {
        self.size
    }

    /// Whether resizing Domicile's window redefines the desktop. True only when
    /// nothing describes it.
    pub fn follows_the_window(&self) -> bool {
        self.follows_the_window
    }
}

/// The `wl_output` description for a display: the maker spelled out where
/// `pnp.ids` names it, otherwise the EDID's three-letter code.
///
/// This matches what sway prints. `Connected` carries both spellings so
/// profiles written with either still match.
fn advertised_description(display: &Display, vendors: &Vendors) -> String {
    vendors
        .spelled_out(&display.description)
        .unwrap_or_else(|| display.description.clone())
}

/// The area two boxes share, or zero when they do not overlap.
fn overlap_area(a: &Bounds, b: &Bounds) -> f64 {
    let width = a.max.x.min(b.max.x) - a.min.x.max(b.min.x);
    let height = a.max.y.min(b.max.y) - a.min.y.max(b.min.y);
    width.max(0.0) * height.max(0.0)
}

/// The `wl_output` name for an engine display.
///
/// `drm-<id>` for a monitor with an EDID name: ozone derives the id from the
/// EDID, so it survives a replug, and profiles already name it. A monitor with
/// none is named after its connector, as sway names it. `drm-<id>` again from
/// an engine that reports no connector. A virtual display is named after its
/// connector, `virtual-<n>`, since its description is a TV's name.
pub fn name_of(display: &Display) -> String {
    if display.is_virtual() || (display.description.is_empty() && !display.connector.is_empty()) {
        display.connector.clone()
    } else {
        format!("drm-{}", display.id)
    }
}

/// The engine's displays under the names a config matches. A virtual display
/// is none of them: it lives only as long as its cast.
pub(crate) fn connected(displays: &[Display], vendors: &Vendors) -> Vec<Connected> {
    displays
        .iter()
        .filter(|display| !display.is_virtual())
        .map(|display| Connected {
            name: name_of(display),
            description: display.description.clone(),
            spelled_out: vendors
                .spelled_out(&display.description)
                .unwrap_or_default(),
            connector: display.connector.clone(),
            mode: display.size,
            modes: display.modes.iter().fold(Vec::new(), |mut sizes, mode| {
                // One entry per size: a profile picks the size, and the
                // engine the rate.
                if !sizes.contains(&mode.size) {
                    sizes.push(mode.size);
                }
                sizes
            }),
        })
        .collect()
}

/// Each bound tablet or touchscreen whose display the engine reported, with
/// that display's engine id.
pub fn pointer_targets(
    displays: &[Display],
    input: &InputConfig,
    vendors: &Vendors,
) -> Vec<Pointer> {
    input
        .pointer_targets(&connected(displays, vendors))
        .into_iter()
        .map(|target| Pointer {
            display: id_of(&target.display, displays),
            device: target.device,
        })
        .collect()
}

/// The engine's id for the display named `name`. The inverse of [`name_of`],
/// looked up in `displays` rather than parsed.
fn id_of(name: &str, displays: &[Display]) -> i64 {
    displays
        .iter()
        .find(|display| name_of(display) == name)
        .expect("a name is only looked up for a display the engine reported")
        .id
}

/// A logical size times an integer scale, in physical pixels.
///
/// Panics on overflow instead of wrapping to a wrong mode. Callers keep it in
/// range: `DisplayConfig::validate` bounds described displays,
/// [`UNDESCRIBED_DESKTOP`] is at scale 1, and `adopt_window_scale` divides the
/// window size by the scale first.
fn multiplied(logical: (i32, i32), scale: i32) -> (i32, i32) {
    let times = |measure: i32| {
        measure
            .checked_mul(scale)
            .expect("a display's mode fits a coordinate")
    };
    (times(logical.0), times(logical.1))
}

/// A config `u32` as an `i32` coordinate.
///
/// `domicile_config` bounds the desktop extent and `size × scale <= i32::MAX`,
/// so this never fails for a `Desktop`. Asserting beats a cast that would
/// silently go negative.
/// A virtual monitor's logical size: `pixels` divided by `scale`, from one
/// pixel to the largest coordinate. Clamped rather than refused, as a
/// profile's is, since the page asking has no config to fix.
fn logical_of(pixels: (u32, u32), scale: f64) -> (u32, u32) {
    let largest = f64::from(i32::MAX);
    // In range before the cast, so it neither saturates nor truncates.
    let divide = |measure: u32| (f64::from(measure) / scale).round().clamp(1.0, largest) as u32;
    (divide(pixels.0), divide(pixels.1))
}

fn as_coordinate(measure: u32) -> i32 {
    i32::try_from(measure).expect("a validated desktop measures within an i32")
}

/// A coordinate as the protocol's `u32` size or scale. The inverse of
/// [`as_coordinate`]; a negative value is a bug.
fn as_measure(coordinate: i32) -> u32 {
    u32::try_from(coordinate).expect("a size or a scale is never negative")
}

/// Where desktop point `(x, y)` is in the engine's pixels on `connector`, or
/// `None` off its desk. Scaled, then turned onto the panel as the engine's
/// DRM `ToPanel` does, since the engine places a pointer in panel pixels.
fn engine_pixel_on(connector: &Connector, (x, y): (f64, f64)) -> Option<(f64, f64)> {
    let desk = connector.desk?;
    let (left, top) = (f64::from(desk.position.0), f64::from(desk.position.1));
    let (wide, high) = (f64::from(desk.size.0), f64::from(desk.size.1));
    if !(left..left + wide).contains(&x) || !(top..top + high).contains(&y) {
        return None;
    }
    let scale = connector.scale;
    let (u, v) = ((x - left) * scale, (y - top) * scale);
    let (upright_wide, upright_high) = (wide * scale, high * scale);
    // The engine's `RotationOf`: a content turn is the panel's opposite one.
    let (px, py) = match connector.transform {
        Transform::Normal => (u, v),
        Transform::Rotate90 => (v, upright_wide - u),
        Transform::Rotate180 => (upright_wide - u, upright_high - v),
        Transform::Rotate270 => (upright_high - v, u),
    };
    Some((
        f64::from(connector.origin.0) + px,
        f64::from(connector.origin.1) + py,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::engine::Mode;
    use domicile_config::{Config, Desk};

    fn desktop(text: &str) -> Desktop {
        Config::parse(text)
            .expect("the config should parse")
            .output
            .desktop()
            .expect("the config should describe a desktop")
    }

    #[test]
    fn a_described_desktop_advertises_one_output_per_display() {
        let screens = Screens::described(&desktop(
            r#"
{
  "output": {
    "displays": [
      { "name": "left", "size": [1920, 1080] },
      {
        "name": "right",
        "position": [1920, 0],
        "size": [2560, 1440],
        "scale": 2
      }
    ]
  }
}
"#,
        ));
        assert_eq!(
            screens.outputs().cloned().collect::<Vec<_>>(),
            vec![
                Advertised {
                    logical: (1920, 1080),
                    mode: (1920, 1080),
                    name: "left".into(),
                    position: (0, 0),
                    scale: 1.0,
                    transform: Transform::Normal,
                    description: String::new(),
                    edid: String::new(),
                    connector: String::new(),
                    display: None,
                    // A described display is not a panel, so neither value is
                    // known.
                    physical_mm: UNKNOWN_PHYSICAL_MM,
                    refresh_mhz: UNKNOWN_REFRESH_MHZ,
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
                Advertised {
                    logical: (2560, 1440),
                    mode: (5120, 2880),
                    name: "right".into(),
                    position: (1920, 0),
                    scale: 2.0,
                    transform: Transform::Normal,
                    description: String::new(),
                    edid: String::new(),
                    connector: String::new(),
                    display: None,
                    physical_mm: UNKNOWN_PHYSICAL_MM,
                    refresh_mhz: UNKNOWN_REFRESH_MHZ,
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
            ]
        );
        assert_eq!(screens.size(), (4480, 1440));
    }

    #[test]
    fn a_mode_is_the_logical_size_in_physical_pixels() {
        // The mode is what the client draws, so it is the logical size times
        // the scale on both axes.
        let screens = Screens::described(&desktop(
            r#"
{
  "output": {
    "displays": [{ "name": "retina", "size": [2560, 1440], "scale": 2 }]
  }
}
"#,
        ));
        let retina = screens.outputs().next().expect("the one display");
        assert_eq!(retina.mode, (5120, 2880));
    }

    #[test]
    fn a_mode_too_big_to_describe_says_so_rather_than_wrapping() {
        // The window-following path is unvalidated, so overflow must panic
        // instead of wrapping to a negative size.
        let panicked =
            std::panic::catch_unwind(|| Screens::following_the_window((2_000_000_000, 1080), 2))
                .expect_err("a mode past a coordinate must not be advertised");
        assert_eq!(
            panicked.downcast_ref::<String>().map(String::as_str),
            Some("a display's mode fits a coordinate"),
            "the panic should name the invariant rather than be an incidental overflow"
        );
    }

    #[test]
    fn an_output_is_described_to_the_chrome_field_for_field() {
        // Each field is something the shell lays out against. Two displays,
        // because a lone display's position normalizes to `[0, 0]`.
        let screens = Screens::described(&desktop(
            r#"
{
  "output": {
    "displays": [
      { "name": "left", "size": [1920, 1080] },
      {
        "name": "right",
        "position": [1920, 120],
        "size": [2560, 1440],
        "scale": 2
      }
    ]
  }
}
"#,
        ));
        assert_eq!(
            screens
                .outputs()
                .nth(1)
                .expect("the second display")
                .described(),
            DisplayInfo {
                name: "right".into(),
                position: [1920, 120],
                scale: 2,
                size: [2560, 1440],
                // The advertised mode: 2560x1440 at density 2 is 5120x2880,
                // though no panel scans it out.
                mode: [5120, 2880],
                refresh_mhz: 0,
                adaptive_sync: WireAdaptiveSync::Unsupported,
                hdr: DisplayHdr::Unsupported,
                peak_luminance: 0,
                sdr_white: 0,
                transform: DisplayTransform::Normal,
            }
        );
    }

    #[test]
    fn a_negative_measure_says_so_rather_than_becoming_a_big_one() {
        // Folding a negative to its magnitude would send the chrome a plausible
        // but wrong screen.
        let bogus = Advertised {
            logical: (-1920, 1080),
            mode: (-1920, 1080),
            name: "impossible".into(),
            position: (0, 0),
            scale: 1.0,
            transform: Transform::Normal,
            description: String::new(),
            edid: String::new(),
            connector: String::new(),
            display: None,
            physical_mm: UNKNOWN_PHYSICAL_MM,
            refresh_mhz: UNKNOWN_REFRESH_MHZ,
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        };
        let panicked = std::panic::catch_unwind({
            let bogus = bogus.clone();
            move || bogus.described()
        })
        .expect_err("a negative size must not be described to the chrome");
        // `starts_with`, because `expect` on a `Result` appends the error.
        assert!(
            panicked
                .downcast_ref::<String>()
                .is_some_and(|said| said.starts_with("a size or a scale is never negative")),
            "the panic should name the invariant rather than be an incidental \
             conversion, and it said {:?}",
            panicked.downcast_ref::<String>()
        );

        // A separate fixture for the height: with both negative, the width
        // panics first.
        let squashed = Advertised {
            logical: (1920, -1080),
            mode: (1920, -1080),
            name: "impossible".into(),
            position: (0, 0),
            scale: 1.0,
            transform: Transform::Normal,
            description: String::new(),
            edid: String::new(),
            connector: String::new(),
            display: None,
            physical_mm: UNKNOWN_PHYSICAL_MM,
            refresh_mhz: UNKNOWN_REFRESH_MHZ,
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        };
        let panicked = std::panic::catch_unwind(move || squashed.described())
            .expect_err("a negative height must not be described to the chrome");
        assert!(
            panicked
                .downcast_ref::<String>()
                .is_some_and(|said| said.starts_with("a size or a scale is never negative")),
            "the height half asserts the same invariant, and it said {:?}",
            panicked.downcast_ref::<String>()
        );

        // The density panics in `wl_output_scale`, before `as_measure`.
        let inverted = Advertised {
            logical: (1920, 1080),
            mode: (1920, 1080),
            name: "impossible".into(),
            position: (0, 0),
            scale: -2.0,
            transform: Transform::Normal,
            description: String::new(),
            edid: String::new(),
            connector: String::new(),
            display: None,
            physical_mm: UNKNOWN_PHYSICAL_MM,
            refresh_mhz: UNKNOWN_REFRESH_MHZ,
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        };
        let panicked = std::panic::catch_unwind(move || inverted.described())
            .expect_err("a negative density must not be described to the chrome");
        assert!(
            panicked.downcast_ref::<String>().is_some_and(|said| said
                .starts_with("a display's density is a positive number a coordinate can hold")),
            "the density asserts before the sizes do, and it said {:?}",
            panicked.downcast_ref::<String>()
        );
    }

    /// The two-display desktop the entered-output tests use.
    fn side_by_side() -> Screens {
        Screens::described(&desktop(
            r#"
{
  "output": {
    "displays": [
      { "name": "left", "size": [1920, 1080] },
      { "name": "right", "position": [1920, 0], "size": [1280, 1024] }
    ]
  }
}
"#,
        ))
    }

    /// A window of `size` with its top-left corner at `at`.
    fn window_at(at: (f64, f64), size: (f64, f64)) -> Bounds {
        Bounds {
            min: Point::new(at.0, at.1),
            max: Point::new(at.0 + size.0, at.1 + size.1),
        }
    }

    #[test]
    fn a_window_is_on_the_display_it_is_over() {
        let screens = side_by_side();

        assert_eq!(
            screens.entered_by(Some(window_at((100.0, 100.0), (800.0, 600.0)))),
            vec![true, false]
        );
        assert_eq!(
            screens.entered_by(Some(window_at((2000.0, 100.0), (800.0, 600.0)))),
            vec![false, true]
        );
    }

    #[test]
    fn a_window_straddling_two_displays_is_on_both() {
        // A window across the seam is shown on both outputs, so its client must
        // know both densities.
        let screens = side_by_side();

        assert_eq!(
            screens.entered_by(Some(window_at((1800.0, 0.0), (400.0, 400.0)))),
            vec![true, true]
        );
    }

    #[test]
    fn a_window_ending_on_the_seam_is_on_one_of_them() {
        // Displays abut, so an edge on the boundary must not count as an
        // overlap, or every maximized window would be on both.
        let screens = side_by_side();

        assert_eq!(
            screens.entered_by(Some(window_at((1120.0, 0.0), (800.0, 600.0)))),
            vec![true, false]
        );
    }

    #[test]
    fn a_window_with_no_portal_is_on_every_display() {
        // Unmounted, hidden or a popup: no portal, so every output.
        let screens = side_by_side();

        assert_eq!(screens.entered_by(None), vec![true, true]);
    }

    #[test]
    fn a_window_over_no_display_at_all_is_on_every_display() {
        // A portal in a gap or off the edge. A toolkit that scales blocks until
        // told an output, so "none" would leave the window blank.
        let screens = side_by_side();

        assert_eq!(
            screens.entered_by(Some(window_at((-4000.0, -4000.0), (100.0, 100.0)))),
            vec![true, true]
        );
    }

    /// `HOME_OFFICE`: a 1.2x monitor (900x1600 at the origin) above a 1.5x
    /// laptop (1920x1280 at `0,1920`).
    fn monitor_over_laptop() -> Screens {
        Screens::nested()
            .replugged_into(&two_plugged_in(), &output(HOME_OFFICE), &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop")
    }

    #[test]
    fn a_window_draws_at_the_scale_of_the_display_it_is_on() {
        let screens = monitor_over_laptop();

        assert_eq!(
            screens.scale_for(Some(window_at((100.0, 100.0), (600.0, 800.0)))),
            1.2
        );
        assert_eq!(
            screens.scale_for(Some(window_at((100.0, 2000.0), (800.0, 600.0)))),
            1.5
        );
    }

    #[test]
    fn a_window_across_two_displays_draws_for_the_one_holding_more_of_it() {
        // As sway: one buffer cannot match both densities, so the larger
        // overlap wins.
        let screens = monitor_over_laptop();

        assert_eq!(
            screens.scale_for(Some(window_at((0.0, 1000.0), (800.0, 980.0)))),
            1.2,
            "600 rows on the monitor, 60 on the laptop"
        );
        assert_eq!(
            screens.scale_for(Some(window_at((0.0, 1500.0), (800.0, 600.0)))),
            1.5,
            "100 rows on the monitor, 180 on the laptop"
        );
    }

    #[test]
    fn a_window_on_no_known_display_draws_for_the_densest() {
        // It enters every display (`entered_by`), and a client on several
        // draws for the densest.
        let screens = monitor_over_laptop();

        assert_eq!(screens.scale_for(None), 1.5);
        assert_eq!(
            screens.scale_for(Some(window_at((-4000.0, -4000.0), (100.0, 100.0)))),
            1.5
        );
    }

    #[test]
    fn a_windows_screen_is_the_display_holding_the_most_of_it() {
        // Where its menus are kept.
        let screens = monitor_over_laptop();

        assert_eq!(
            screens.screen_of(window_at((0.0, 1500.0), (800.0, 600.0))),
            Some(window_at((0.0, 1920.0), (1920.0, 1280.0))),
            "100 rows on the monitor, 180 on the laptop"
        );
        assert_eq!(
            screens.screen_of(window_at((-4000.0, -4000.0), (100.0, 100.0))),
            None
        );
    }

    #[test]
    fn a_display_whose_far_edge_does_not_fit_says_so_rather_than_wrapping() {
        // A wrapped far edge would put `max` below `min` and overlap nothing,
        // putting every window on every output.
        let past_the_end = Advertised {
            logical: (1920, 1080),
            mode: (1920, 1080),
            name: "impossible".into(),
            position: (i32::MAX - 1, 0),
            scale: 1.0,
            transform: Transform::Normal,
            description: String::new(),
            edid: String::new(),
            connector: String::new(),
            display: None,
            physical_mm: UNKNOWN_PHYSICAL_MM,
            refresh_mhz: UNKNOWN_REFRESH_MHZ,
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        };

        let panicked = std::panic::catch_unwind(move || past_the_end.bounds())
            .expect_err("a far edge past i32::MAX must not wrap");

        assert!(
            panicked
                .downcast_ref::<String>()
                .is_some_and(|said| said.starts_with("a display's far edge")),
            "it said {:?}",
            panicked.downcast_ref::<String>()
        );
    }

    #[test]
    fn the_placeholder_is_the_desktop_when_nothing_described_one() {
        let screens = Screens::nested();
        assert_eq!(screens.size(), (1280, 800));
        assert!(screens.follows_the_window());
        let only = screens.outputs().next().expect("the one output");
        // Scale 1, so the mode is the size, until the window reports a density.
        assert_eq!(only.scale, 1.0);
        assert_eq!(only.mode, (1280, 800));
    }

    #[test]
    fn a_described_desktop_is_not_the_window() {
        // A described desktop does not follow the window.
        let screens = Screens::described(&desktop(
            r#"
{ "output": { "displays": [{ "name": "only", "size": [800, 600] }] } }
"#,
        ));
        assert!(!screens.follows_the_window());
    }

    #[test]
    fn a_tty_casts_each_monitor_from_its_own_capture() {
        let screens = Screens::from_the_engine(&two_plugged_in(), &unspelled(), &[]);

        let cast = screens.cast_screens();

        assert_eq!(cast.len(), 2);
        assert_eq!(cast[0].name, screens.outputs[0].name);
        assert_eq!(cast[0].display, two_plugged_in()[0].id);
        assert_eq!(
            cast[0].desk,
            (
                screens.outputs[0].position.0,
                screens.outputs[0].position.1,
                screens.outputs[0].logical.0,
                screens.outputs[0].logical.1
            )
        );
    }

    #[test]
    fn each_cast_screen_is_offered_by_name_and_panel() {
        let screens = Screens::from_the_engine(&two_plugged_in(), &unspelled(), &[]);
        let desk = screens.outputs[1].position;

        let offered = screens.cast_monitors();

        assert_eq!(offered.len(), 2);
        assert_eq!(
            offered[1],
            crate::casting::Candidate {
                source: crate::casting::Source::Monitor("drm-2".into()),
                title: DESK_MONITOR.into(),
                app_id: String::new(),
                process: None,
                part: None,
                bounds: Some(crate::casting::Region {
                    position: desk,
                    size: screens.outputs[1].logical,
                }),
            }
        );
    }

    #[test]
    fn a_nested_desktop_casts_from_the_window() {
        let cast = Screens::following_the_window((1280, 800), 2).cast_screens();

        assert_eq!(
            cast,
            [crate::casting::Screen {
                name: "domicile-0".into(),
                display: 0,
                desk: (0, 0, 1280, 800),
                scale: 2.0,
            }]
        );
    }

    #[test]
    fn a_tty_desktop_is_the_displays_the_engine_reported() {
        // On a tty the engine holds DRM, so its reading defines the desktop.
        let screens = Screens::from_the_engine(
            &[
                Display {
                    id: 1,
                    description: "BOE NE135A1M-NY1".into(),
                    connector: String::new(),
                    position: (0, 0),
                    size: (2880, 1920),
                    physical_mm: (597, 336),
                    refresh_mhz: 59_997,
                    modes: Vec::new(),
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
                Display {
                    id: 2,
                    description: String::new(),
                    connector: String::new(),
                    position: (2880, 0),
                    size: (1920, 1080),
                    physical_mm: (0, 0),
                    refresh_mhz: 0,
                    modes: Vec::new(),
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
            ],
            &unspelled(),
            &[],
        );
        assert_eq!(
            screens.outputs().cloned().collect::<Vec<_>>(),
            vec![
                Advertised {
                    logical: (2880, 1920),
                    mode: (2880, 1920),
                    name: "drm-1".into(),
                    position: (0, 0),
                    scale: 1.0,
                    transform: Transform::Normal,
                    // A laptop panel has an EDID name; a projector has none.
                    description: "BOE NE135A1M-NY1".into(),
                    edid: "BOE NE135A1M-NY1".into(),
                    connector: String::new(),
                    display: Some(1),
                    // The panel's values pass through, and so do the second
                    // display's zeros.
                    physical_mm: (597, 336),
                    refresh_mhz: 59_997,
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
                Advertised {
                    logical: (1920, 1080),
                    mode: (1920, 1080),
                    name: "drm-2".into(),
                    position: (2880, 0),
                    scale: 1.0,
                    transform: Transform::Normal,
                    description: String::new(),
                    edid: String::new(),
                    connector: String::new(),
                    display: Some(2),
                    physical_mm: UNKNOWN_PHYSICAL_MM,
                    refresh_mhz: UNKNOWN_REFRESH_MHZ,
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
            ]
        );
        assert_eq!(screens.size(), (4800, 1920));
        // There is no window on a tty, so these do not follow it.
        assert!(!screens.follows_the_window());
    }

    /// The laptop on its own, named from its EDID.
    ///
    /// A function because a non-empty `String` cannot be a `const`.
    fn plugged_in() -> Vec<Display> {
        vec![Display {
            id: 1,
            description: LAPTOP_PANEL.into(),
            connector: String::new(),
            position: (0, 0),
            size: (2880, 1920),
            physical_mm: (597, 336),
            refresh_mhz: 59_997,
            modes: Vec::new(),
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        }]
    }

    /// The laptop's EDID description, which a profile can match.
    const LAPTOP_PANEL: &str = "BOE NE135A1M-NY1";

    #[test]
    fn a_monitor_with_no_edid_name_is_named_after_its_connector() {
        // The laptop panel has an EDID name, so it keeps `drm-<id>` and the
        // profiles that name it.
        let screens = Screens::from_the_engine(&panel_and_projector(), &unspelled(), &[]);

        assert_eq!(
            screens
                .outputs()
                .map(|output| output.name.as_str())
                .collect::<Vec<_>>(),
            vec!["drm-1", PROJECTOR_CONNECTOR]
        );
    }

    #[test]
    fn a_monitor_named_after_its_connector_is_cast_as_its_display() {
        let screens = Screens::from_the_engine(&panel_and_projector(), &unspelled(), &[]);

        let cast = screens.cast_screens();

        assert_eq!(
            cast.iter()
                .map(|screen| (screen.name.as_str(), screen.display))
                .collect::<Vec<_>>(),
            vec![("drm-1", 1), (PROJECTOR_CONNECTOR, 2)]
        );
    }

    #[test]
    fn a_profile_can_name_a_monitor_by_its_connector() {
        let placed = Screens::nested()
            .replugged_into(
                &panel_and_projector(),
                &output(&format!(
                    r#"
{{
  "output": {{
    "profiles": [
      {{
        "name": "presenting",
        "displays": [
          {{ "display": "{PROJECTOR_CONNECTOR}", "position": [0, 0] }},
          {{ "display": "eDP-1", "enabled": false }}
        ]
      }}
    ]
  }}
}}
"#
                )),
                &unspelled(),
                &[],
            )
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");

        assert_eq!(
            placed
                .outputs()
                .map(|output| output.name.as_str())
                .collect::<Vec<_>>(),
            vec![PROJECTOR_CONNECTOR]
        );
        assert_eq!(
            placed
                .scanout()
                .iter()
                .map(|connector| (connector.id, connector.enabled))
                .collect::<Vec<_>>(),
            vec![(2, true), (1, false)]
        );
    }

    /// The laptop, named from its EDID, and a projector with no EDID name.
    fn panel_and_projector() -> Vec<Display> {
        vec![
            Display {
                connector: "eDP-1".into(),
                ..plugged_in()[0].clone()
            },
            Display {
                id: 2,
                description: String::new(),
                connector: PROJECTOR_CONNECTOR.into(),
                position: (2880, 0),
                size: (1920, 1080),
                physical_mm: (0, 0),
                refresh_mhz: 0,
                modes: Vec::new(),
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            },
        ]
    }

    /// The projector's connector, which names it.
    const PROJECTOR_CONNECTOR: &str = "HDMI-A-1";

    /// The output settings `text` configures.
    fn output(text: &str) -> OutputConfig {
        Config::parse(text).expect("the config should parse").output
    }

    #[test]
    fn a_pointer_covers_the_display_its_config_names_by_engine_id() {
        let input = Config::parse(&format!(
            r#"
{{ "input": {{ "pointers": [
  {{ "device": "tablet-0", "display": "{PROJECTOR_CONNECTOR}" }},
  {{ "device": "tablet-1", "display": "{LAPTOP_PANEL}" }}
] }} }}
"#
        ))
        .expect("the config should parse")
        .input;

        assert_eq!(
            pointer_targets(&panel_and_projector(), &input, &unspelled()),
            vec![
                Pointer {
                    device: "tablet-0".into(),
                    display: 2,
                },
                Pointer {
                    device: "tablet-1".into(),
                    display: 1,
                },
            ]
        );
    }

    /// A config with no described desktop and no profiles, so the engine's
    /// reading decides.
    fn unconfigured() -> OutputConfig {
        output("{}")
    }

    #[test]
    fn a_described_desktop_is_not_overruled_by_what_the_engine_sees() {
        // `output.displays` wins over DRM.
        let described_in_the_config = output(&displays(&[LEFT]));
        assert_eq!(
            described(&[LEFT])
                .replugged_into(&plugged_in(), &described_in_the_config, &unspelled(), &[])
                .expect("a described desktop is not a layout that failed"),
            None
        );
    }

    #[test]
    fn a_desktop_nothing_described_is_the_engines_to_define() {
        let taken = Screens::nested()
            .replugged_into(&plugged_in(), &unconfigured(), &unspelled(), &[])
            .expect("nothing here can fail to be applied")
            .expect("an undescribed desktop takes the engine's displays");
        assert_eq!(taken.size(), (2880, 1920));
        assert!(!taken.follows_the_window());
    }

    #[test]
    fn every_hotplug_is_applied_and_not_only_the_first() {
        // Hotplugs after the first DRM reading still apply, even though the
        // desktop no longer follows the window.
        let one_monitor = Screens::nested()
            .replugged_into(&plugged_in(), &unconfigured(), &unspelled(), &[])
            .expect("nothing here can fail to be applied")
            .expect("an undescribed desktop takes the engine's displays");
        let both = one_monitor
            .replugged_into(&two_plugged_in(), &unconfigured(), &unspelled(), &[])
            .expect("nothing here can fail to be applied")
            .expect("a desktop the engine defined is still the engine's");
        assert_eq!(both.size(), (4800, 1920));
    }

    /// `panel_and_projector`, with the projector where ozone puts a connector
    /// it has not placed yet: on top of the panel.
    fn projector_not_yet_placed() -> Vec<Display> {
        let mut displays = panel_and_projector();
        displays[1].position = (0, 0);
        displays
    }

    #[test]
    fn a_reading_the_engine_has_not_laid_out_keeps_the_desktop() {
        // The engine lays out its own row, so its finished reading follows.
        let one_monitor = Screens::from_the_engine(&plugged_in(), &unspelled(), &[]);
        assert_eq!(
            one_monitor
                .replugged_into(
                    &projector_not_yet_placed(),
                    &unconfigured(),
                    &unspelled(),
                    &[]
                )
                .expect("nothing here can fail to be applied"),
            None
        );
    }

    #[test]
    fn a_reading_not_laid_out_is_taken_to_drop_a_profile() {
        // The engine lays out by the profile's connectors until it hears the
        // empty list, so keeping the profile's desktop would never send it.
        let placed = Screens::nested()
            .replugged_into(&two_plugged_in(), &output(HOME_OFFICE), &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        let unplaced = placed
            .replugged_into(
                &projector_not_yet_placed(),
                &output(HOME_OFFICE),
                &unspelled(),
                &[],
            )
            .expect("nothing here can fail to be applied")
            .expect("leaving a profile is always taken");
        assert!(unplaced.scanout().is_empty());
    }

    #[test]
    fn a_profile_places_the_monitors_it_matched() {
        // The panel at 1.5, the monitor at 1.2 rotated, the panel centered
        // below it. The mode, millimeters and refresh rate come from the
        // engine.
        let placed = Screens::nested()
            .replugged_into(&two_plugged_in(), &output(HOME_OFFICE), &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert_eq!(
            placed.outputs().cloned().collect::<Vec<_>>(),
            vec![
                Advertised {
                    // 1920x1080 rotated is 1080x1920; divided by 1.2 it is
                    // 900x1600. The mode itself does not rotate.
                    logical: (900, 1600),
                    mode: (1920, 1080),
                    name: "drm-2".into(),
                    position: (0, 0),
                    // The fractional density. `wl_output.scale` rounds it up to
                    // 2.
                    scale: 1.2,
                    transform: Transform::Rotate270,
                    // From the engine's reading; a profile does not rename a
                    // display.
                    description: DESK_MONITOR.into(),
                    edid: DESK_MONITOR.into(),
                    connector: String::new(),
                    display: Some(2),
                    physical_mm: UNKNOWN_PHYSICAL_MM,
                    refresh_mhz: UNKNOWN_REFRESH_MHZ,
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
                Advertised {
                    logical: (1920, 1280),
                    mode: (2880, 1920),
                    name: "drm-1".into(),
                    position: (0, 1920),
                    scale: 1.5,
                    transform: Transform::Normal,
                    description: LAPTOP_PANEL.into(),
                    edid: LAPTOP_PANEL.into(),
                    connector: String::new(),
                    display: Some(1),
                    physical_mm: (597, 336),
                    refresh_mhz: 59_997,
                    adaptive_sync: AdaptiveSync::Unsupported,
                    hdr: Default::default(),
                },
            ]
        );
        assert_eq!(placed.size(), (1920, 3200));
        assert!(!placed.follows_the_window());
    }

    #[test]
    fn a_profile_says_which_connectors_to_light_and_where() {
        // The connector settings the engine needs. Unlike `outputs`, these
        // include disabled displays and the CRTC positions.
        let placed = Screens::nested()
            .replugged_into(&two_plugged_in(), &output(HOME_OFFICE), &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert_eq!(
            placed.scanout(),
            vec![
                Connector {
                    id: 2,
                    enabled: true,
                    origin: (0, 0),
                    // The engine draws with the rotation and scale, so the page
                    // lays out logical and upright.
                    transform: Transform::Rotate270,
                    scale: 1.2,
                    // The profile position, which the engine uses to move the
                    // pointer between monitors.
                    desk: Some(Desk {
                        position: (0, 0),
                        size: (900, 1600),
                    }),
                    mode: None,
                    refresh_mhz: None,
                    adaptive_sync: false,
                    hdr: false,
                    sdr_white: domicile_config::DEFAULT_SDR_WHITE,
                },
                Connector {
                    id: 1,
                    enabled: true,
                    // Where the monitor's mode ends. The desktop stacks the
                    // displays vertically but the connectors are side by side.
                    origin: (1920, 0),
                    transform: Transform::Normal,
                    scale: 1.5,
                    desk: Some(Desk {
                        position: (0, 1920),
                        size: (1920, 1280),
                    }),
                    mode: None,
                    refresh_mhz: None,
                    adaptive_sync: false,
                    hdr: false,
                    sdr_white: domicile_config::DEFAULT_SDR_WHITE,
                },
            ]
        );
    }

    /// The laptop, offering a smaller mode at a faster rate than its native
    /// one.
    fn offering_two_modes() -> Vec<Display> {
        plugged_in()
            .into_iter()
            .map(|display| Display {
                modes: vec![
                    Mode {
                        size: (2880, 1920),
                        refresh_mhz: 59_997,
                    },
                    Mode {
                        size: (1920, 1280),
                        refresh_mhz: 120_000,
                    },
                ],
                ..display
            })
            .collect()
    }

    #[test]
    fn a_profile_asks_the_engine_for_a_mode_and_advertises_what_it_lit() {
        let fast = output(
            r#"{ "output": { "profiles": [{ "name": "fast",
                  "displays": [{ "display": "drm-1", "mode": [1920, 1280], "refresh": 120 }] }] } }"#,
        );
        let asked = Screens::nested()
            .replugged_into(&offering_two_modes(), &fast, &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert_eq!(
            asked
                .scanout()
                .iter()
                .map(|connector| (connector.mode, connector.refresh_mhz))
                .collect::<Vec<_>>(),
            vec![(Some((1920, 1280)), Some(120_000))],
            "the engine is asked for the mode and the rate"
        );
        assert_eq!(
            asked
                .outputs()
                .map(|output| output.mode)
                .collect::<Vec<_>>(),
            vec![(1920, 1280)],
            "the desktop is laid out at the mode asked for"
        );

        // The engine reports the same monitor at the new mode and rate.
        let lit: Vec<Display> = offering_two_modes()
            .into_iter()
            .map(|display| Display {
                size: (1920, 1280),
                refresh_mhz: 120_000,
                ..display
            })
            .collect();
        let after = asked
            .replugged_into(&lit, &fast, &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert_eq!(
            after
                .outputs()
                .map(|output| (output.mode, output.refresh_mhz, output.logical))
                .collect::<Vec<_>>(),
            vec![((1920, 1280), 120_000, (1920, 1280))],
            "wl_output and xdg_output state the mode and rate the engine lit"
        );
        assert_eq!(
            Screens::nested()
                .replugged_into(&plugged_in(), &output("{}"), &unspelled(), &[])
                .expect("no profile cannot fail to apply")
                .expect("the engine defines an undescribed desktop")
                .rearranged_into(&after)
                .slots,
            vec![Slot::Kept(0)],
            "a monitor that changed mode keeps its wl_output"
        );
    }

    #[test]
    fn a_profile_asks_for_adaptive_sync_and_the_desktop_says_whether_it_took() {
        let smooth = output(
            r#"{ "output": { "profiles": [{ "name": "smooth",
                  "displays": [{ "display": "drm-1", "adaptive_sync": true }] }] } }"#,
        );
        let asked = Screens::nested()
            .replugged_into(&plugged_in(), &smooth, &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert!(
            asked.scanout()[0].adaptive_sync,
            "the engine is asked for it"
        );

        // The engine reports whether the hardware took it.
        let lit: Vec<Display> = plugged_in()
            .into_iter()
            .map(|display| Display {
                adaptive_sync: AdaptiveSync::On,
                ..display
            })
            .collect();
        let after = asked
            .replugged_into(&lit, &smooth, &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        let output = after.outputs().next().expect("the laptop's output");
        assert_eq!(output.adaptive_sync, AdaptiveSync::On);
        assert_eq!(output.described().adaptive_sync, WireAdaptiveSync::On);
        assert_ne!(
            asked.outputs().next().map(|output| output.adaptive_sync),
            Some(AdaptiveSync::On),
            "the desktop changed, so the chrome is told"
        );
    }

    #[test]
    fn a_profile_asks_for_hdr_and_the_desktop_says_whether_it_took() {
        let bright = output(
            r#"{ "output": { "profiles": [{ "name": "bright",
                  "displays": [{ "display": "drm-1", "hdr": true, "sdr_white": 240 }] }] } }"#,
        );
        let asked = Screens::nested()
            .replugged_into(&plugged_in(), &bright, &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert!(asked.scanout()[0].hdr, "the engine is asked for it");
        assert_eq!(asked.scanout()[0].sdr_white, 240);

        // The engine reports whether the panel took it.
        let on = Hdr {
            state: HdrState::On,
            max_luminance: 600,
            max_average_luminance: 350,
            min_luminance: 500,
            sdr_white: 240,
        };
        let lit: Vec<Display> = plugged_in()
            .into_iter()
            .map(|display| Display { hdr: on, ..display })
            .collect();
        let after = asked
            .replugged_into(&lit, &bright, &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert_eq!(after.outputs().next().map(|output| output.hdr), Some(on));
        let lit_output = after.outputs().next().expect("one display");
        assert_eq!(after.hdr_of(&lit_output.name), on);
        assert_eq!(
            after.hdr_for(Some(lit_output.bounds())),
            on,
            "a window on it is in HDR"
        );
        assert_eq!(
            after.hdr_for(None),
            Hdr::default(),
            "a window on no display yet is in SDR"
        );
        let told = after
            .outputs()
            .next()
            .expect("the laptop's output")
            .described();
        assert_eq!(
            (told.hdr, told.peak_luminance, told.sdr_white),
            (DisplayHdr::On, 600, 240),
            "the shell sees it too"
        );
        assert_ne!(
            asked.outputs().next().map(|output| output.hdr),
            Some(on),
            "the desktop changed, so clients are told"
        );
    }

    #[test]
    fn a_desktop_no_profile_placed_leaves_the_connectors_to_the_engine() {
        // Empty means the hardware decides. When a profile that turned a panel
        // off stops matching, the empty list relights the panel.
        let unplanned = Screens::nested()
            .replugged_into(&plugged_in(), &output(HOME_OFFICE), &unspelled(), &[])
            .expect("a profile that does not match cannot fail to apply")
            .expect("an undescribed desktop is still the engine's to define");
        assert!(unplanned.scanout().is_empty());
    }

    #[test]
    fn a_profile_can_name_a_monitor_by_its_panel() {
        // The profile names the monitors by EDID description, not `drm-<id>`.
        let placed = Screens::nested()
            .replugged_into(
                &two_plugged_in(),
                &output(&format!(
                    r#"
{{
  "output": {{
    "profiles": [
      {{
        "name": "by-panel",
        "displays": [
          {{ "display": "{DESK_MONITOR}", "position": [0, 0], "scale": 1.2 }},
          {{ "display": "{LAPTOP_PANEL}", "position": [0, 1080], "scale": 1.5 }}
        ]
      }}
    ]
  }}
}}
"#
                )),
                &unspelled(),
                &[],
            )
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");

        // The outputs keep their `drm-<id>` names.
        assert_eq!(
            placed
                .outputs()
                .map(|o| o.name.as_str())
                .collect::<Vec<_>>(),
            vec!["drm-2", "drm-1"]
        );
        assert_eq!(
            placed.outputs().map(|o| o.logical).collect::<Vec<_>>(),
            vec![(1600, 900), (1920, 1280)]
        );
    }

    #[test]
    fn a_monitors_maker_is_spelled_out_where_this_machine_has_a_table() {
        // `DEL` is in the table and `BOE` is not. An unknown code keeps its
        // three letters. This matches sway.
        let spelled = Screens::from_the_engine(&two_plugged_in(), &desk_vendors(), &[]);
        assert_eq!(
            spelled
                .outputs()
                .map(|output| output.description.as_str())
                .collect::<Vec<_>>(),
            vec![LAPTOP_PANEL, "Dell Inc. DELL U3219Q G3MS413"]
        );
    }

    #[test]
    fn a_profile_can_name_a_monitor_by_the_vendor_spelled_out() {
        // A profile copied from sway's output names `Dell Inc.`. The
        // three-letter spelling also matches; `domicile-config` tries both.
        let placed = Screens::nested()
            .replugged_into(
                &two_plugged_in(),
                &output(
                    r#"
{
  "output": {
    "profiles": [
      {
        "name": "by-vendor",
        "displays": [
          {
            "display": "Dell Inc. DELL U3219Q G3MS413",
            "position": [0, 0]
          },
          { "display": "BOE NE135A1M-NY1", "position": [0, 1080] }
        ]
      }
    ]
  }
}
"#,
                ),
                &desk_vendors(),
                &[],
            )
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert_eq!(
            placed
                .outputs()
                .map(|output| output.name.as_str())
                .collect::<Vec<_>>(),
            vec!["drm-2", "drm-1"]
        );
    }

    #[test]
    fn a_monitor_answers_to_its_connector() {
        let screens = Screens::from_the_engine(&panel_and_projector(), &unspelled(), &[]);

        assert_eq!(
            screens
                .outputs()
                .map(|output| output.monitor().names)
                .collect::<Vec<_>>(),
            vec![
                vec![
                    "drm-1".to_string(),
                    "eDP-1".to_string(),
                    LAPTOP_PANEL.to_string()
                ],
                vec![PROJECTOR_CONNECTOR.to_string()],
            ]
        );
    }

    /// A table that names the desk monitor's maker but not the laptop panel's.
    fn desk_vendors() -> Vendors {
        Vendors::listed_in("DEL\tDell Inc.\n")
    }

    #[test]
    fn settings_hears_every_name_a_profile_can_call_a_monitor_by() {
        // Settings matches a profile's `display` against these, so either
        // spelling of the maker finds the monitor.
        let screens = Screens::from_the_engine(&two_plugged_in(), &desk_vendors(), &[]);
        let monitors: Vec<MonitorInfo> = screens.outputs().map(Advertised::monitor).collect();
        assert_eq!(
            monitors
                .iter()
                .map(|monitor| monitor.names.clone())
                .collect::<Vec<_>>(),
            vec![
                vec!["drm-1".to_string(), LAPTOP_PANEL.to_string(),],
                vec![
                    "drm-2".to_string(),
                    DESK_MONITOR.to_string(),
                    format!("Dell Inc.{}", &DESK_MONITOR[3..]),
                ],
            ]
        );
        assert!(monitors
            .iter()
            .all(|monitor| monitor.hdr == DisplayHdr::Unsupported));
    }

    /// No `pnp.ids` table, as in every test except the two above.
    fn unspelled() -> Vendors {
        Vendors::none()
    }

    #[test]
    fn monitors_no_profile_names_are_left_where_the_engine_put_them() {
        // No profile matches this desk, so the engine's reading is used.
        let unplanned = Screens::nested()
            .replugged_into(&plugged_in(), &output(HOME_OFFICE), &unspelled(), &[])
            .expect("a profile that does not match cannot fail to apply")
            .expect("an undescribed desktop is still the engine's to define");
        assert_eq!(
            unplanned,
            Screens::from_the_engine(&plugged_in(), &unspelled(), &[])
        );
    }

    #[test]
    fn a_profile_that_cannot_be_applied_leaves_the_desktop_alone() {
        // Modes come from the hardware, so a profile can only fail once a
        // monitor is plugged in. The caller keeps the current desktop and
        // reports the error.
        let err = Screens::nested()
            .replugged_into(
                &plugged_in(),
                &output(
                    r#"
{
  "output": {
    "profiles": [
      {
        "name": "too-small",
        "displays": [{ "display": "drm-1", "scale": 4000 }]
      }
    ]
  }
}
"#,
                ),
                &unspelled(),
                &[],
            )
            .expect_err("a profile that cannot be applied says so");
        assert!(
            err.to_string().contains("too-small"),
            "the complaint should name the profile: {err}"
        );
    }

    /// The laptop and one monitor, both with EDID descriptions.
    fn two_plugged_in() -> Vec<Display> {
        vec![
            Display {
                id: 1,
                description: LAPTOP_PANEL.into(),
                connector: String::new(),
                position: (0, 0),
                size: (2880, 1920),
                physical_mm: (597, 336),
                refresh_mhz: 59_997,
                modes: Vec::new(),
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            },
            Display {
                id: 2,
                description: DESK_MONITOR.into(),
                connector: String::new(),
                position: (2880, 0),
                size: (1920, 1080),
                physical_mm: (0, 0),
                refresh_mhz: 0,
                modes: Vec::new(),
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            },
        ]
    }

    /// The monitor's EDID description.
    const DESK_MONITOR: &str = "DEL DELL U3219Q G3MS413";

    /// A profile for `two_plugged_in`: the monitor rotated above, the laptop
    /// panel centered below.
    ///
    /// Lists the monitor first, so the output order is the profile's, not the
    /// engine's.
    const HOME_OFFICE: &str = r#"
{
  "output": {
    "profiles": [
      {
        "name": "desk",
        "displays": [
          {
            "display": "drm-2",
            "position": [0, 0],
            "scale": 1.2,
            "transform": "rotate-270"
          },
          { "display": "drm-1", "position": [0, 1920], "scale": 1.5 }
        ]
      }
    ]
  }
}
"#;

    /// A TV the desk extends onto, as the engine reports it: past the right
    /// edge of `two_plugged_in`'s connectors.
    fn a_tv() -> Display {
        Display {
            id: VirtualDisplay::id_of(1),
            description: "Living Room TV".into(),
            connector: "virtual-1".into(),
            position: (4800, 0),
            size: (1920, 1080),
            physical_mm: UNKNOWN_PHYSICAL_MM,
            refresh_mhz: 60_000,
            modes: Vec::new(),
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        }
    }

    #[test]
    fn a_virtual_monitor_is_named_after_its_connector() {
        // Its description is the TV's name, which is no EDID to name it by.
        let mut displays = plugged_in();
        displays.push(a_tv());

        let screens = Screens::from_the_engine(&displays, &unspelled(), &[]);

        let tv = screens.outputs().last().expect("the TV is advertised");
        assert_eq!(tv.name, "virtual-1");
        assert_eq!(tv.description, "Living Room TV");
    }

    #[test]
    fn a_profile_extends_the_desk_onto_a_virtual_monitor() {
        // The profile still matches with the TV there, and the TV goes above
        // the desk the profile laid out, centered, at its mode.
        let mut displays = two_plugged_in();
        displays.push(a_tv());

        let placed = Screens::nested()
            .replugged_into(&displays, &output(HOME_OFFICE), &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");

        assert_eq!(
            placed.outputs().last(),
            Some(&Advertised {
                logical: (1920, 1080),
                mode: (1920, 1080),
                name: "virtual-1".into(),
                position: (0, 0),
                scale: 1.0,
                transform: Transform::Normal,
                description: "Living Room TV".into(),
                edid: "Living Room TV".into(),
                connector: "virtual-1".into(),
                display: Some(VirtualDisplay::id_of(1)),
                physical_mm: UNKNOWN_PHYSICAL_MM,
                refresh_mhz: 60_000,
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            })
        );
        assert_eq!(
            placed.outputs().next().map(|monitor| monitor.position),
            Some((0, 1080)),
            "the monitors move down to make room"
        );
        assert_eq!(placed.size(), (1920, 4280));
        assert_eq!(
            placed.scanout().last(),
            Some(&Connector {
                id: VirtualDisplay::id_of(1),
                enabled: true,
                // Past the connectors' row, which ends at 1920 + 2880.
                origin: (4800, 0),
                transform: Transform::Normal,
                scale: 1.0,
                desk: Some(Desk {
                    position: (0, 0),
                    size: (1920, 1080),
                }),
                mode: None,
                refresh_mhz: None,
                adaptive_sync: false,
                hdr: false,
                sdr_white: domicile_config::DEFAULT_SDR_WHITE,
            })
        );
    }

    #[test]
    fn a_tv_goes_above_the_monitors_centered() {
        // So the pointer reaches it by going up from the monitors.
        let mut displays = plugged_in();
        let laptop = displays[0].clone();
        displays.push(a_tv());

        let screens =
            Screens::from_the_engine(&displays, &unspelled(), &[pane_at(1, (1920, 1080), 1.0)]);

        assert_eq!(
            screens
                .outputs()
                .map(|output| (output.name.as_str(), output.position))
                .collect::<Vec<_>>(),
            vec![("drm-1", (0, 1080)), ("virtual-1", (480, 0))]
        );
        assert_eq!(screens.size(), (2880, 3000));
        assert_eq!(
            screens.scanout(),
            vec![
                Connector {
                    id: laptop.id,
                    enabled: true,
                    origin: (0, 0),
                    transform: Transform::Normal,
                    scale: 1.0,
                    desk: Some(Desk {
                        position: (0, 1080),
                        size: (2880, 1920),
                    }),
                    mode: None,
                    refresh_mhz: None,
                    adaptive_sync: false,
                    hdr: false,
                    sdr_white: domicile_config::DEFAULT_SDR_WHITE,
                },
                Connector {
                    id: VirtualDisplay::id_of(1),
                    enabled: true,
                    // Past the laptop panel in the engine's row.
                    origin: (2880, 0),
                    transform: Transform::Normal,
                    scale: 1.0,
                    desk: Some(Desk {
                        position: (480, 0),
                        size: (1920, 1080),
                    }),
                    mode: None,
                    refresh_mhz: None,
                    adaptive_sync: false,
                    hdr: false,
                    sdr_white: domicile_config::DEFAULT_SDR_WHITE,
                },
            ]
        );
    }

    #[test]
    fn a_tv_wider_than_the_monitors_moves_them_right_to_stay_centered() {
        let mut displays = plugged_in();
        displays.push(a_pane(1, (2880, 0), (3840, 2160)));

        let screens =
            Screens::from_the_engine(&displays, &unspelled(), &[pane_at(1, (3840, 2160), 1.0)]);

        assert_eq!(
            screens
                .outputs()
                .map(|output| output.position)
                .collect::<Vec<_>>(),
            vec![(480, 2160), (0, 0)]
        );
        assert_eq!(screens.size(), (3840, 4080));
    }

    /// A pane of another desktop, as a headless engine reports it: at
    /// `position` in the engine's row of pixels.
    fn a_pane(number: u32, position: (i32, i32), size: (u32, u32)) -> Display {
        Display {
            id: VirtualDisplay::id_of(number),
            description: "Pane".into(),
            connector: format!("virtual-{number}"),
            position,
            size,
            physical_mm: UNKNOWN_PHYSICAL_MM,
            refresh_mhz: 60_000,
            modes: Vec::new(),
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        }
    }

    /// The compositor's own record of the pane, at `scale`.
    fn pane_at(number: u32, size: (u32, u32), scale: f64) -> VirtualDisplay {
        VirtualDisplay {
            id: VirtualDisplay::id_of(number),
            mode: size,
            refresh_mhz: 60_000,
            scale: Scale::try_from(scale).unwrap(),
            name: "Pane".into(),
        }
    }

    #[test]
    fn a_virtual_monitor_takes_its_own_scale() {
        // A headless desk of two panes, the second of a Windows window at
        // 150%. The engine lays out pixels only, so the compositor lays the
        // desk out instead, with each pane at its own scale.
        let displays = [
            a_pane(1, (0, 0), (1920, 1080)),
            a_pane(2, (1920, 0), (1500, 900)),
        ];
        let virtuals = [pane_at(1, (1920, 1080), 1.0), pane_at(2, (1500, 900), 1.5)];

        let screens = Screens::from_the_engine(&displays, &unspelled(), &virtuals);

        assert_eq!(
            screens.outputs().last(),
            Some(&Advertised {
                logical: (1000, 600),
                mode: (1500, 900),
                name: "virtual-2".into(),
                position: (1920, 0),
                scale: 1.5,
                transform: Transform::Normal,
                description: "Pane".into(),
                edid: "Pane".into(),
                connector: "virtual-2".into(),
                display: Some(VirtualDisplay::id_of(2)),
                physical_mm: UNKNOWN_PHYSICAL_MM,
                refresh_mhz: 60_000,
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            })
        );
        assert_eq!(screens.size(), (2920, 1080));
        assert_eq!(
            screens.scanout(),
            vec![
                Connector {
                    id: VirtualDisplay::id_of(1),
                    enabled: true,
                    origin: (0, 0),
                    transform: Transform::Normal,
                    scale: 1.0,
                    desk: Some(Desk {
                        position: (0, 0),
                        size: (1920, 1080),
                    }),
                    mode: None,
                    refresh_mhz: None,
                    adaptive_sync: false,
                    hdr: false,
                    sdr_white: domicile_config::DEFAULT_SDR_WHITE,
                },
                Connector {
                    id: VirtualDisplay::id_of(2),
                    enabled: true,
                    origin: (1920, 0),
                    transform: Transform::Normal,
                    scale: 1.5,
                    desk: Some(Desk {
                        position: (1920, 0),
                        size: (1000, 600),
                    }),
                    mode: None,
                    refresh_mhz: None,
                    adaptive_sync: false,
                    hdr: false,
                    sdr_white: domicile_config::DEFAULT_SDR_WHITE,
                },
            ]
        );
    }

    #[test]
    fn a_desktop_point_lands_on_the_engine_pixel_its_monitor_draws() {
        let displays = [
            a_pane(1, (0, 0), (1920, 1080)),
            a_pane(2, (1920, 0), (1500, 900)),
        ];
        let virtuals = [pane_at(1, (1920, 1080), 1.0), pane_at(2, (1500, 900), 1.5)];
        let screens = Screens::from_the_engine(&displays, &unspelled(), &virtuals);

        assert_eq!(screens.engine_pixel_of((100.0, 50.0)), (100.0, 50.0));
        assert_eq!(
            screens.engine_pixel_of((1920.0 + 100.0, 50.0)),
            (1920.0 + 150.0, 75.0),
            "the 150% pane draws a point 1.5 pixels across"
        );
    }

    #[test]
    fn a_point_on_a_turned_monitor_lands_on_its_panel_pixel() {
        // A 1080x1920 panel turned to stand 1920 wide, at 2x, right of a
        // 1000-pixel monitor.
        let turned = |transform| Connector {
            id: 1,
            enabled: true,
            origin: (1000, 0),
            transform,
            scale: 2.0,
            desk: Some(Desk {
                position: (500, 0),
                size: (960, 540),
            }),
            mode: None,
            refresh_mhz: None,
            adaptive_sync: false,
            hdr: false,
            sdr_white: domicile_config::DEFAULT_SDR_WHITE,
        };
        let near_the_top_left = (500.0 + 10.0, 20.0);
        assert_eq!(
            engine_pixel_on(&turned(Transform::Normal), near_the_top_left),
            Some((1000.0 + 20.0, 40.0))
        );
        // Panel 1080 wide, 1920 high; the engine's ROTATE_270.
        assert_eq!(
            engine_pixel_on(&turned(Transform::Rotate90), near_the_top_left),
            Some((1000.0 + 40.0, 1920.0 - 20.0))
        );
        assert_eq!(
            engine_pixel_on(&turned(Transform::Rotate180), near_the_top_left),
            Some((1000.0 + 1920.0 - 20.0, 1080.0 - 40.0))
        );
        // The engine's ROTATE_90.
        assert_eq!(
            engine_pixel_on(&turned(Transform::Rotate270), near_the_top_left),
            Some((1000.0 + 1080.0 - 40.0, 20.0))
        );
        assert_eq!(
            engine_pixel_on(&turned(Transform::Normal), (10.0, 20.0)),
            None
        );
    }

    #[test]
    fn a_point_on_no_monitor_or_a_desk_with_no_connectors_is_at_scale_1() {
        let displays = [a_pane(2, (0, 0), (1500, 900))];
        let screens =
            Screens::from_the_engine(&displays, &unspelled(), &[pane_at(2, (1500, 900), 1.5)]);
        assert_eq!(screens.engine_pixel_of((5000.0, 5.0)), (5000.0, 5.0));

        assert_eq!(
            Screens::following_the_window((1280, 800), 2).engine_pixel_of((10.0, 20.0)),
            (10.0, 20.0)
        );
    }

    #[test]
    fn a_scaled_virtual_monitor_keeps_the_monitors_in_the_engines_row() {
        // A layout darkens each connector it leaves out, so it names the
        // plugged-in monitor too, where the engine had it.
        let mut displays = plugged_in();
        let monitor = displays[0].clone();
        // Past the panel's 2880 pixels, as the engine places it.
        displays.push(a_pane(1, (2880, 0), (1500, 900)));

        let screens =
            Screens::from_the_engine(&displays, &unspelled(), &[pane_at(1, (1500, 900), 1.5)]);

        assert_eq!(
            screens.scanout().first(),
            Some(&Connector {
                id: monitor.id,
                enabled: true,
                origin: monitor.position,
                transform: Transform::Normal,
                scale: 1.0,
                desk: Some(Desk {
                    // Below the pane's 600 logical pixels.
                    position: (monitor.position.0, monitor.position.1 + 600),
                    size: monitor.size,
                }),
                mode: None,
                refresh_mhz: None,
                adaptive_sync: false,
                hdr: false,
                sdr_white: domicile_config::DEFAULT_SDR_WHITE,
            })
        );
        assert_eq!(
            screens
                .outputs()
                .map(|output| output.scale)
                .collect::<Vec<_>>(),
            vec![1.0, 1.5]
        );
    }

    #[test]
    fn a_desk_of_unscaled_virtual_monitors_alone_is_the_engines_to_lay_out() {
        let displays = [
            a_pane(1, (0, 0), (1920, 1080)),
            a_pane(2, (1920, 0), (1500, 900)),
        ];

        let screens = Screens::from_the_engine(
            &displays,
            &unspelled(),
            &[pane_at(1, (1920, 1080), 1.0), pane_at(2, (1500, 900), 1.0)],
        );

        assert!(screens.scanout().is_empty());
        assert_eq!(screens.size(), (3420, 1080));
    }

    #[test]
    fn a_profile_extends_the_desk_onto_a_scaled_virtual_monitor() {
        let mut displays = two_plugged_in();
        displays.push(a_tv());
        let tv = VirtualDisplay {
            scale: Scale::try_from(2.0).unwrap(),
            ..pane_at(1, (1920, 1080), 1.0)
        };

        let placed = Screens::nested()
            .replugged_into(&displays, &output(HOME_OFFICE), &unspelled(), &[tv])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");

        let advertised = placed.outputs().last().expect("the TV is advertised");
        assert_eq!(
            (advertised.logical, advertised.mode, advertised.scale),
            ((960, 540), (1920, 1080), 2.0)
        );
        assert_eq!(advertised.position, (480, 0));
        assert_eq!(placed.size(), (1920, 3740));
    }

    #[test]
    fn a_profile_cannot_name_a_virtual_monitor() {
        // Profiles describe the monitors on the desk. A TV comes and goes
        // with its cast, so naming one would make the profile match only
        // while casting.
        let mut displays = plugged_in();
        displays.push(a_tv());

        assert!(connected(&displays, &unspelled())
            .iter()
            .all(|connected| connected.name != "virtual-1"));
    }

    #[test]
    #[should_panic(expected = "the engine reports at least one display")]
    fn a_desktop_of_no_displays_is_refused_rather_than_sized_zero() {
        // `DrmScreen` reports `kDisplaylessBounds` rather than an empty list,
        // so an empty list is an engine bug.
        let _ = Screens::from_the_engine(&[], &unspelled(), &[]);
    }

    #[test]
    fn an_undescribed_desktop_is_whatever_window_domicile_got() {
        // A nested run: one output, sized and scaled by the window.
        let screens = Screens::following_the_window((1280, 800), 2);
        assert_eq!(
            screens.outputs().cloned().collect::<Vec<_>>(),
            vec![Advertised {
                logical: (1280, 800),
                mode: (2560, 1600),
                // The name clients already use.
                name: "domicile-0".into(),
                position: (0, 0),
                scale: 2.0,
                transform: Transform::Normal,
                description: String::new(),
                edid: String::new(),
                connector: String::new(),
                display: None,
                // A window has no physical size or refresh rate.
                physical_mm: UNKNOWN_PHYSICAL_MM,
                refresh_mhz: UNKNOWN_REFRESH_MHZ,
                adaptive_sync: AdaptiveSync::Unsupported,
                hdr: Default::default(),
            }]
        );
        assert_eq!(screens.size(), (1280, 800));
        assert!(screens.follows_the_window());
    }

    /// The screens a desktop made of `entries` describes, in that order.
    fn described(entries: &[&str]) -> Screens {
        Screens::described(&desktop(&displays(entries)))
    }

    /// A config whose `output.displays` is `entries`, in that order.
    fn displays(entries: &[&str]) -> String {
        format!(
            r#"{{ "output": {{ "displays": [{}] }} }}"#,
            entries.join(", ")
        )
    }

    const LEFT: &str = r#"{ "name": "left", "size": [1920, 1080] }"#;
    const RIGHT: &str = r#"{ "name": "right", "position": [1920, 0], "size": [2560, 1440] }"#;

    #[test]
    fn a_desktop_that_did_not_change_rearranges_into_nothing() {
        let before = described(&[LEFT, RIGHT]);
        let after = described(&[LEFT, RIGHT]);
        assert_eq!(
            before.rearranged_into(&after),
            Rearrangement {
                slots: vec![Slot::Kept(0), Slot::Kept(1)],
                retired: vec![],
            }
        );
    }

    #[test]
    fn a_display_that_was_added_is_a_new_slot() {
        let before = described(&[LEFT]);
        let after = described(&[LEFT, RIGHT]);
        assert_eq!(
            before.rearranged_into(&after),
            Rearrangement {
                slots: vec![Slot::Kept(0), Slot::New],
                retired: vec![],
            }
        );
    }

    #[test]
    fn a_display_that_went_away_is_retired() {
        let before = described(&[LEFT, RIGHT]);
        let after = described(&[LEFT]);
        assert_eq!(
            before.rearranged_into(&after),
            Rearrangement {
                slots: vec![Slot::Kept(0)],
                retired: vec![1],
            }
        );
    }

    #[test]
    fn a_display_that_only_changed_shape_keeps_its_output() {
        // A display that stays keeps its `wl_output`. Replacing it looks to
        // clients like an unplug.
        let before = described(&[LEFT]);
        let after = described(&[r#"{ "name": "left", "size": [3840, 2160], "scale": 2 }"#]);
        assert_eq!(
            before.rearranged_into(&after),
            Rearrangement {
                slots: vec![Slot::Kept(0)],
                retired: vec![],
            }
        );
    }

    #[test]
    fn a_renamed_display_is_a_different_display() {
        // A renamed display is a different display: the shell addresses
        // `<Screen>` by name.
        let before = described(&[LEFT]);
        let after = described(&[r#"{ "name": "main", "size": [1920, 1080] }"#]);
        assert_eq!(
            before.rearranged_into(&after),
            Rearrangement {
                slots: vec![Slot::New],
                retired: vec![0],
            }
        );
    }

    #[test]
    fn displays_that_swapped_places_keep_the_outputs_they_had() {
        // Matched by name, not index, so reordering moves each `wl_output` with
        // its display.
        let before = described(&[LEFT, RIGHT]);
        let after = described(&[RIGHT, LEFT]);
        assert_eq!(
            before.rearranged_into(&after),
            Rearrangement {
                slots: vec![Slot::Kept(1), Slot::Kept(0)],
                retired: vec![],
            }
        );
    }

    #[test]
    fn a_desktop_that_stopped_being_described_retires_every_display() {
        // With no `output.displays`, the desktop follows the window, under a
        // different output name.
        let before = described(&[LEFT, RIGHT]);
        let after = Screens::nested();
        assert_eq!(
            before.rearranged_into(&after),
            Rearrangement {
                slots: vec![Slot::New],
                retired: vec![0, 1],
            }
        );
    }

    #[test]
    fn a_reload_that_describes_displays_replaces_the_window_desktop() {
        let now = Screens::following_the_window((1280, 800), 2);
        let config = output(&displays(&[LEFT]));
        let described = desktop(&displays(&[LEFT]));
        assert_eq!(
            now.reloaded_into(&config, NOTHING_PLUGGED_IN, &unspelled(), &[])
                .expect("a described desktop cannot fail to be applied"),
            Some(Screens::described(&described))
        );
    }

    #[test]
    fn a_reload_re_matches_the_monitors_the_engine_last_read() {
        // Saving a profile applies it at once, matched against the engine's
        // last reading.
        let placed = Screens::from_the_engine(&two_plugged_in(), &unspelled(), &[])
            .reloaded_into(&output(HOME_OFFICE), &two_plugged_in(), &unspelled(), &[])
            .expect("the profile should be applicable")
            .expect("a matched profile defines the desktop");
        assert_eq!(placed.size(), (1920, 3200));
    }

    #[test]
    fn a_reload_that_describes_no_displays_leaves_the_window_desktop_alone() {
        // With no `output.displays` the window defines the desktop, with a size
        // and density the config does not know. Rebuilding from the config
        // would drop it to the scale-1 placeholder. Any save in the config's
        // directory triggers a reload, so this happens often.
        let now = Screens::following_the_window((1920, 1200), 2);
        assert_eq!(
            now.reloaded_into(&unconfigured(), NOTHING_PLUGGED_IN, &unspelled(), &[])
                .expect("an undescribed config cannot fail to be applied"),
            None
        );
    }

    #[test]
    fn a_reload_that_stopped_describing_displays_hands_the_desktop_back() {
        // A desktop the config stops describing falls back to the placeholder,
        // which the window then corrects.
        let now = described(&[LEFT, RIGHT]);
        assert_eq!(
            now.reloaded_into(&unconfigured(), NOTHING_PLUGGED_IN, &unspelled(), &[])
                .expect("an undescribed config cannot fail to be applied"),
            Some(Screens::nested())
        );
    }

    /// No display reading yet: a nested run, or a tty before the first display
    /// event.
    const NOTHING_PLUGGED_IN: &[Display] = &[];
}
