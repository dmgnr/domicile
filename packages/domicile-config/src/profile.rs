//! Output profiles: where to place real monitors, chosen by which are
//! connected.
//!
//! A [`Desktop`](crate::Desktop) states its own sizes. A profile states a
//! placement (scale, rotation, position) and takes each size from the
//! monitor's mode, so the same config gives a different desktop as monitors
//! come and go. Matching reruns on every hotplug, with no reload or restart.
//!
//! Modeled on kanshi without its file format: the first profile whose display
//! set is exactly the connected set wins. See `docs/DISPLAYS.md#profiles`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ConfigError;

/// One arrangement of monitors, and where each goes.
///
/// Applies when the displays it names are exactly the connected ones.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    /// The profile's name, unique in the config. The log prints it when the
    /// profile applies.
    pub name: String,
    /// Every display this arrangement is for, including the ones it turns off.
    pub displays: Vec<DisplayPlacement>,
}

impl Profile {
    /// Pairs each entry with a connected monitor, or `None` if the profile
    /// does not match.
    ///
    /// Matches only when the sets are equal. If a subset matched, a third
    /// monitor would stay dark; if an overlap matched, windows could land on a
    /// missing screen.
    ///
    /// An entry can name a monitor by output (`drm-3`) or by panel
    /// (`DEL DELL U3219Q G3MS413`), so two entries can resolve to the same
    /// monitor. Comparing counts is not enough; each entry must find a
    /// different monitor.
    fn resolve<'a>(&self, connected: &'a [Connected]) -> Option<Vec<&'a Connected>> {
        if self.displays.len() != connected.len() {
            return None;
        }
        let mut resolved: Vec<&Connected> = Vec::with_capacity(self.displays.len());
        for placement in &self.displays {
            let display = placement.connected_in(connected)?;
            // Compare by name: two identical monitors without serials have
            // equal descriptions.
            if resolved.iter().any(|taken| taken.name == display.name) {
                return None;
            }
            resolved.push(display);
        }
        Some(resolved)
    }

    fn validate(&self, index: usize, earlier: &[Profile]) -> Result<(), ConfigError> {
        let at = format!("output.profiles[{index}]");
        if self.name.trim().is_empty() {
            return Err(ConfigError::Validation(format!(
                "{at} must have a name; it is what names the profile that applied"
            )));
        }
        if earlier.iter().any(|profile| profile.name == self.name) {
            return Err(ConfigError::Validation(format!(
                "two output.profiles are both named {}",
                self.name
            )));
        }
        if self.displays.is_empty() {
            return Err(ConfigError::Validation(format!(
                "{at} ({}) names no displays, so it matches only a machine \
                 with no monitors at all",
                self.name
            )));
        }
        // A profile that disables every display leaves no desktop, and
        // windows would land nowhere.
        if !self.displays.iter().any(|placement| placement.enabled) {
            return Err(ConfigError::Validation(format!(
                "{at} ({}) disables every display it names, which leaves no \
                 desktop to put a window on",
                self.name
            )));
        }
        for (index, placement) in self.displays.iter().enumerate() {
            placement.validate(&at, &self.name, index, &self.displays[..index])?;
        }
        Ok(())
    }
}

/// One display of a profile: which monitor, and what to do with it.
///
/// Every field but `display` defaults to leaving the monitor as it is.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DisplayPlacement {
    /// The connected display this entry places, matched by exact name.
    ///
    /// On a tty the output name is `drm-<id>`, or the connector (`HDMI-A-1`)
    /// for a monitor with no EDID name. Ozone derives the id from the EDID, so
    /// it survives a replug. A panel name also matches.
    pub display: String,
    /// Whether the display is part of the desktop.
    ///
    /// A disabled display must still be connected for the profile to match.
    /// This lets a profile match a docked laptop and keep windows off its
    /// closed lid.
    #[serde(default = "enabled")]
    pub enabled: bool,
    /// The mode to scan out, in physical pixels. Absent means the monitor's
    /// native mode.
    ///
    /// Applying the profile fails when the monitor offers no mode of this
    /// size. An engine that reports no modes (an older one, or a desktop in a
    /// window) cannot set one, so there it is a check: the profile applies
    /// only while the monitor is at this mode.
    #[serde(default)]
    pub mode: Option<(u32, u32)>,
    /// The refresh rate to scan out, in Hz, such as `59.94` or `120`. The
    /// monitor's advertised rate nearest it is used, at `mode` or else the
    /// native size.
    ///
    /// Absent means the native mode's rate when `mode` is absent or the
    /// native size, and otherwise the highest rate the monitor offers at
    /// `mode`, as sway picks.
    #[serde(default)]
    #[schemars(extend("exclusiveMinimum" = 0.0))]
    pub refresh: Option<f64>,
    /// Whether to scan out with a variable refresh rate (adaptive sync,
    /// FreeSync, G-Sync Compatible), so a frame that runs late is shown as
    /// soon as it is ready instead of at the next fixed refresh.
    ///
    /// Off by default. Asked for only where the monitor, its connector and
    /// its driver report they can; a driver that refuses it gets the same
    /// mode without it. Each display reports whether it took.
    #[serde(default)]
    pub adaptive_sync: bool,
    /// The top-left corner in the profile's coordinate space. May be negative.
    ///
    /// Absent puts the display in a row right of the positioned ones, in
    /// profile order and level with their top. The row uses logical widths
    /// and follows each monitor's current mode.
    // [`Layout`] normalizes it; these values do not leave this crate.
    #[serde(default)]
    pub position: Option<(i32, i32)>,
    /// Device pixels per logical pixel.
    ///
    /// Fractional, because real scales are: 1.5 on a 2880x1920 panel gives a
    /// 1920x1280 desktop. This differs from the integer `wl_output.scale`; the
    /// compositor's `Screens` advertises that, and `xdg_output` carries the
    /// logical size.
    #[serde(default = "unscaled")]
    #[schemars(extend("exclusiveMinimum" = 0.0))]
    pub scale: f64,
    /// Which way up the monitor is.
    #[serde(default)]
    pub transform: Transform,
}

impl DisplayPlacement {
    /// The connected display this entry names, or `None` if it is not
    /// connected.
    ///
    /// Any of the display's names match, as in kanshi: the output name is
    /// always present, and the panel name is what a person can read off a
    /// running desktop. The vendor may be spelled as in the EDID or as in
    /// hwdata; see [`Connected::spelled_out`]. `validate` refuses an empty
    /// `display`, which [`Connected::is_named`] never matches.
    fn connected_in<'a>(&self, connected: &'a [Connected]) -> Option<&'a Connected> {
        connected
            .iter()
            .find(|display| display.is_named(&self.display))
    }

    fn validate(
        &self,
        profile_at: &str,
        profile: &str,
        index: usize,
        earlier: &[DisplayPlacement],
    ) -> Result<(), ConfigError> {
        let at = format!("{profile_at}.displays[{index}]");
        if self.display.trim().is_empty() {
            return Err(ConfigError::Validation(format!(
                "{at} must name a display; an entry naming none matches nothing, \
                 so {profile} would never apply"
            )));
        }
        if earlier
            .iter()
            .any(|placement| placement.display == self.display)
        {
            return Err(ConfigError::Validation(format!(
                "{profile} places {} twice, and only one of the two can be where it goes",
                self.display
            )));
        }
        // A zero-size mode is the only mode error visible without the monitor.
        // [`Layout::of`] checks the monitor's actual mode.
        if let Some((width, height)) = self.mode {
            if width == 0 || height == 0 {
                return Err(ConfigError::Validation(format!(
                    "{at} states {} at {width}x{height}, and no connector \
                     scans out a mode with no pixels on an axis",
                    self.display
                )));
            }
        }
        // Zero or less is no rate, and NaN passes every comparison.
        if let Some(refresh) = self.refresh {
            if !refresh.is_finite() || refresh <= 0.0 || refresh * 1000.0 > f64::from(i32::MAX) {
                return Err(ConfigError::Validation(format!(
                    "{at} refresh for {} is {refresh}, which is not a rate a \
                     monitor scans out at",
                    self.display
                )));
            }
        }
        // Zero gives no desktop, a negative scale inverts it, and NaN passes
        // every later comparison. A scale too large for a given monitor needs
        // its mode; [`Layout::of`] refuses that.
        if !self.scale.is_finite() || self.scale <= 0.0 {
            return Err(ConfigError::Validation(format!(
                "{at} scale for {} is {}, which is not a number of device \
                 pixels per logical one",
                self.display, self.scale
            )));
        }
        Ok(())
    }
}

/// Which way up a monitor is, named for the matching `wl_output.transform`.
///
/// Rotations only; nothing needs flips.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
pub enum Transform {
    /// The connector's native orientation.
    #[default]
    #[serde(rename = "normal")]
    Normal,
    /// Content turned a quarter counterclockwise.
    #[serde(rename = "rotate-90")]
    Rotate90,
    /// Content turned upside down.
    #[serde(rename = "rotate-180")]
    Rotate180,
    /// Content turned a quarter clockwise, for a panel standing on its left
    /// side.
    #[serde(rename = "rotate-270")]
    Rotate270,
}

impl Transform {
    /// Whether the display's logical width and height swap relative to its
    /// mode.
    pub fn swaps_axes(self) -> bool {
        match self {
            Transform::Normal | Transform::Rotate180 => false,
            Transform::Rotate90 | Transform::Rotate270 => true,
        }
    }
}

/// One monitor as the compositor found it: the names a profile matches and
/// its mode.
///
/// A separate type from the compositor's, so this crate stays independent of
/// the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connected {
    /// The advertised output name: on a tty, `drm-<id>` with ozone's id from
    /// the EDID, or the connector for a monitor with no EDID name. Always
    /// present.
    pub name: String,
    /// The panel's `"<MAKE> <MODEL> <SERIAL>"` from its EDID, or empty if it
    /// has none.
    ///
    /// The name a person usually writes in a profile.
    pub description: String,
    /// The panel name with the maker spelled out from hwdata's `pnp.ids`
    /// (`Dell Inc. DELL U3219Q 2ZLS413` for `DEL DELL U3219Q 2ZLS413`). Empty
    /// when the table is missing or lacks the id.
    ///
    /// sway and kanshi print this form. Both forms match, so either spelling
    /// works in a config.
    pub spelled_out: String,
    /// The mode the connector is scanning out, in physical pixels.
    pub mode: (u32, u32),
    /// Every mode size the monitor offers, in physical pixels. Empty when the
    /// engine reports none, which also means it cannot set one.
    pub modes: Vec<(u32, u32)>,
}

impl Connected {
    /// Whether any of this display's names is `name`.
    ///
    /// An empty name never matches: every monitor with no EDID name shares
    /// the empty description.
    pub(crate) fn is_named(&self, name: &str) -> bool {
        [&self.name, &self.description, &self.spelled_out]
            .into_iter()
            .any(|own| !own.is_empty() && own == name)
    }
}

/// A profile applied to the connected monitors.
///
/// Shifted so its top-left corner is the origin, with disabled displays
/// dropped. Each display carries its mode and its logical size.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    profile: String,
    placed: Vec<Placed>,
    size: (u32, u32),
    scanout: Vec<Scanout>,
}

impl Layout {
    /// Which profile this is, for the log line that says one applied.
    pub fn profile(&self) -> &str {
        &self.profile
    }

    /// The displays the desktop is made of, in the order the profile wrote
    /// them, disabled ones already dropped.
    pub fn placed(&self) -> impl Iterator<Item = &Placed> {
        self.placed.iter()
    }

    /// The bounding box of every placed display, including gaps between them,
    /// as for [`Desktop::size`](crate::Desktop::size).
    pub fn size(&self) -> (u32, u32) {
        self.size
    }

    /// Every display the profile named, as connectors, in profile order.
    ///
    /// [`Layout::placed`] is the logical desktop the compositor advertises.
    /// This is what the engine does with each connector, including turning
    /// off the disabled ones.
    pub fn scanout(&self) -> &[Scanout] {
        &self.scanout
    }

    /// Apply `profile` to the monitors it matched.
    ///
    /// Only called with a `connected` list that [`Profile::resolve`] accepted,
    /// so every entry's lookup succeeds.
    ///
    /// Returns `Err` for failures parsing cannot catch, because sizes come
    /// from the hardware. An error, not a panic, keeps the compositor running
    /// so the user can fix the config. A mode mismatch is checked first, so
    /// the error names the mode rather than a position it threw off.
    pub(crate) fn of(profile: &Profile, connected: &[Connected]) -> Result<Layout, ConfigError> {
        if let Some((placement, display)) = misstated(profile, connected) {
            return Err(unavailable(profile, placement, display));
        }
        let enabled = profile
            .displays
            .iter()
            .filter(|placement| placement.enabled)
            .collect::<Vec<_>>();
        let placed = enabled
            .iter()
            .map(|placement| placed(profile, placement, connected))
            .collect::<Result<Vec<_>, _>>()?;
        // Parsing refuses a profile that enables no display.
        assert!(!placed.is_empty(), "a profile enables at least one display");
        let placed = beside(profile, &enabled, placed)?;
        let near = (
            nearest(&placed, |display| display.position.0),
            nearest(&placed, |display| display.position.1),
        );
        let size = (
            extent(profile, &placed, near.0, |display| {
                (display.position.0, display.logical.0)
            })?,
            extent(profile, &placed, near.1, |display| {
                (display.position.1, display.logical.1)
            })?,
        );
        let placed: Vec<Placed> = placed
            .into_iter()
            .map(|display| Placed {
                // Non-negative because `near` is the minimum, and fits `i32`
                // because `extent` checked the span.
                position: (
                    normalized(display.position.0, near.0),
                    normalized(display.position.1, near.1),
                ),
                ..display
            })
            .collect();
        let scanout = scanout(profile, &placed, connected)?;
        Ok(Layout {
            profile: profile.name.clone(),
            placed,
            size,
            scanout,
        })
    }
}

/// One display of an applied profile, as the engine lights it.
///
/// [`Placed`] is the compositor's view: logical and rotated. This is the
/// engine's: the physical mode a CRTC scans out. It also carries the rotation
/// and scale, which the engine uses to draw this connector's window so the
/// page inside is logical and upright.
#[derive(Debug, Clone, PartialEq)]
pub struct Scanout {
    /// The output name (`drm-<id>` or a connector on a tty) the engine knows
    /// the monitor by.
    ///
    /// May differ from what the profile wrote, which can be a panel name.
    pub name: String,
    /// Whether to light this connector at all.
    pub enabled: bool,
    /// This connector's position on the engine's own desktop, in physical
    /// pixels.
    ///
    /// Set for dark displays too. The engine lists every connector, and a
    /// dark one left where the card put it can overlap a lit one. The first
    /// overlapping display wins every lookup, including the one that sizes
    /// the desktop window.
    pub origin: (i32, i32),
    /// Which way up the monitor is. The engine rotates this connector's window
    /// so the page lays out upright.
    pub transform: Transform,
    /// Device pixels per logical pixel. The engine draws this connector's
    /// window at this scale so the page lays out in logical pixels.
    pub scale: f64,
    /// The mode the profile asks for, in physical pixels, or `None` for the
    /// native one.
    pub mode: Option<(u32, u32)>,
    /// The refresh rate the profile asks for, in mHz, or `None` for the
    /// default described at [`DisplayPlacement::refresh`].
    pub refresh_mhz: Option<u32>,
    /// Whether the profile asks for a variable refresh rate.
    pub adaptive_sync: bool,
    /// Where the profile put this display on the desktop, or `None` if it is
    /// dark.
    ///
    /// [`origin`](Self::origin) does not say which monitor is beside which;
    /// the engine moves the pointer between monitors by this.
    pub desk: Option<Desk>,
}

/// Where a display is on the desktop a shell lays out in, in logical pixels:
/// [`Placed`]'s position and size, for the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Desk {
    pub position: (i32, i32),
    pub size: (u32, u32),
}

/// One display of an applied profile, placed in the desktop's own coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    /// The output name (`drm-<id>` or a connector on a tty): the
    /// `wl_output`'s name and how the chrome addresses the screen.
    ///
    /// May differ from what the profile wrote, which can be a panel name.
    pub name: String,
    /// Top-left corner, logical, relative to the desktop's own top-left.
    pub position: (i32, i32),
    /// The mode the connector scans out, in physical pixels. Not rotated by
    /// `transform`.
    pub mode: (u32, u32),
    /// The size the desktop is laid out in: the mode, turned, over the scale.
    pub logical: (u32, u32),
    /// Device pixels per logical pixel, as the profile stated it.
    pub scale: f64,
    /// Which way up the monitor is.
    pub transform: Transform,
}

/// One display of the profile, at the matched monitor's mode.
///
/// Positions are still the profile's, and the origin for an entry without
/// one; [`beside`] places those and [`Layout::of`] normalizes them all.
fn placed(
    profile: &Profile,
    placement: &DisplayPlacement,
    connected: &[Connected],
) -> Result<Placed, ConfigError> {
    let display = placement
        .connected_in(connected)
        .expect("a profile is only applied to the displays it matched");
    let mode = mode_of(placement, display);
    Ok(Placed {
        // The output name, not what the config wrote: clients already have a
        // `wl_output` under this name.
        name: display.name.clone(),
        position: placement.position.unwrap_or_default(),
        mode,
        logical: logical(mode, placement.transform, placement.scale)
            .ok_or_else(|| vanished(profile, placement, mode))?,
        scale: placement.scale,
        transform: placement.transform,
    })
}

/// `placed`, with each display the profile gives no position put in a row
/// right of the positioned ones.
///
/// The row starts at the positioned displays' right edge, level with their
/// top, as the engine puts unnamed connectors past the named ones. With none
/// positioned it starts at the origin. `enabled` and `placed` are in the same
/// order.
fn beside(
    profile: &Profile,
    enabled: &[&DisplayPlacement],
    placed: Vec<Placed>,
) -> Result<Vec<Placed>, ConfigError> {
    let positioned = || {
        enabled
            .iter()
            .zip(&placed)
            .filter(|(placement, _)| placement.position.is_some())
            .map(|(_, display)| display)
    };
    // Widened like `extent`: a right edge can exceed `i32`.
    let mut edge = positioned()
        .map(|display| i64::from(display.position.0) + i64::from(display.logical.0))
        .max()
        .unwrap_or(0);
    let top = positioned()
        .map(|display| display.position.1)
        .min()
        .unwrap_or(0);

    let mut arranged = Vec::with_capacity(enabled.len());
    for (placement, display) in enabled.iter().zip(placed) {
        if placement.position.is_some() {
            arranged.push(display);
        } else {
            let start = i32::try_from(edge).map_err(|_| crowded(profile, &display))?;
            edge += i64::from(display.logical.0);
            arranged.push(Placed {
                position: (start, top),
                ..display
            });
        }
    }
    Ok(arranged)
}

/// Each connector's origin on the engine's own desktop, in physical pixels.
///
/// The engine orders connectors by card enumeration, which says nothing about
/// the desk. So lit connectors go in one row, sorted by desktop position,
/// each starting where the previous mode ended. The row only has to avoid
/// overlaps: nothing is drawn across connectors, and the pointer follows
/// [`Scanout::desk`]. Dark connectors go after the lit ones so they never
/// overlap one.
///
/// Returns entries in the profile's written order.
fn scanout(
    profile: &Profile,
    placed: &[Placed],
    connected: &[Connected],
) -> Result<Vec<Scanout>, ConfigError> {
    let mut across = placed.iter().collect::<Vec<_>>();
    across.sort_by_key(|display| (display.position.0, display.position.1));
    let lit = across
        .into_iter()
        .map(|display| (display.name.as_str(), display.mode.0));
    let dark = profile
        .displays
        .iter()
        .filter(|placement| !placement.enabled)
        .map(|placement| {
            let display = found(placement, connected);
            (display.name.as_str(), mode_of(placement, display).0)
        });

    let mut origins: Vec<(&str, (i32, i32))> = Vec::with_capacity(profile.displays.len());
    let mut edge: i64 = 0;
    for (name, width) in lit.chain(dark) {
        // Widened like `extent`: a row of modes can exceed `i32`. Refused
        // rather than saturated, which would stack two connectors.
        if edge > i64::from(i32::MAX) {
            return Err(unlightable(profile, name));
        }
        let start = i32::try_from(edge).expect("the row is bounded above just here");
        origins.push((name, (start, 0)));
        edge += i64::from(width);
    }

    Ok(profile
        .displays
        .iter()
        .map(|placement| {
            let display = found(placement, connected);
            Scanout {
                name: display.name.clone(),
                enabled: placement.enabled,
                origin: origins
                    .iter()
                    .find(|(name, _)| *name == display.name)
                    .map(|(_, origin)| *origin)
                    .expect("every display the profile names is in the row"),
                transform: placement.transform,
                scale: placement.scale,
                mode: placement.mode,
                refresh_mhz: placement
                    .refresh
                    .map(|hertz| (hertz * 1000.0).round() as u32),
                adaptive_sync: placement.adaptive_sync,
                desk: placed
                    .iter()
                    .find(|placed| placed.name == display.name)
                    .map(|placed| Desk {
                        position: placed.position,
                        size: placed.logical,
                    }),
            }
        })
        .collect())
}

/// The first entry whose mode its monitor cannot scan out, or `None`.
///
/// A monitor that reports its modes must offer the size; one that reports
/// none must already be at it, since the engine then cannot set one. Checks
/// disabled entries too: their modes set where dark connectors land in
/// [`scanout`].
fn misstated<'a>(
    profile: &'a Profile,
    connected: &'a [Connected],
) -> Option<(&'a DisplayPlacement, &'a Connected)> {
    profile
        .displays
        .iter()
        .map(|placement| (placement, found(placement, connected)))
        .find(|(placement, display)| {
            placement.mode.is_some_and(|stated| {
                if display.modes.is_empty() {
                    stated != display.mode
                } else {
                    !display.modes.contains(&stated)
                }
            })
        })
}

/// The mode an entry's monitor scans out once the profile applies: the one
/// it asks for, or the one the monitor is at.
///
/// [`misstated`] has already refused a mode the monitor cannot scan out.
fn mode_of(placement: &DisplayPlacement, display: &Connected) -> (u32, u32) {
    placement.mode.unwrap_or(display.mode)
}

/// The connected display an entry of an applied profile names.
///
/// Panics if absent: a layout is built only from a `connected` list that
/// [`Profile::resolve`] accepted.
fn found<'a>(placement: &DisplayPlacement, connected: &'a [Connected]) -> &'a Connected {
    placement
        .connected_in(connected)
        .expect("a profile is only applied to the displays it matched")
}

/// The logical size of `mode`, rotated and then divided by `scale`.
///
/// `None` if that leaves less than one logical pixel on either axis: the
/// scale is too large for this monitor. [`DisplayPlacement::validate`] cannot
/// check it without the mode. Refused rather than clamped, since a
/// one-pixel display is useless.
///
/// Rotated first, so a 3840x2160 monitor on its side at 1.2 is 1800x3200.
fn logical(mode: (u32, u32), transform: Transform, scale: f64) -> Option<(u32, u32)> {
    let turned = if transform.swaps_axes() {
        (mode.1, mode.0)
    } else {
        mode
    };
    let divide = |pixels: u32| {
        let logical = (f64::from(pixels) / scale).round();
        // Bound before the cast: `as` saturates, so a tiny scale would give
        // `u32::MAX`, a plausible but enormous display.
        (1.0..=f64::from(u32::MAX))
            .contains(&logical)
            .then_some(logical as u32)
    };
    Some((divide(turned.0)?, divide(turned.1)?))
}

/// The smallest of the placed displays' near edges along one axis.
fn nearest(placed: &[Placed], edge: impl Fn(&Placed) -> i32) -> i32 {
    placed
        .iter()
        .map(edge)
        .min()
        .expect("a profile enables at least one display")
}

/// How far the displays span along one axis, measured from `near`.
///
/// Computed in `i64`, as in `OutputConfig::validate_extent`: positions fit
/// `i32` but the distance between two may not, and a normalized position is
/// that distance.
fn extent(
    profile: &Profile,
    placed: &[Placed],
    near: i32,
    edge: impl Fn(&Placed) -> (i32, u32),
) -> Result<u32, ConfigError> {
    let reach = |display: &Placed| {
        let (start, length) = edge(display);
        i64::from(start) + i64::from(length)
    };
    let furthest = placed
        .iter()
        .max_by_key(|display| reach(display))
        .expect("a profile enables at least one display");
    let span = reach(furthest) - i64::from(near);
    if span > i64::from(i32::MAX) {
        Err(unreachable(profile, furthest))
    } else {
        Ok(u32::try_from(span).expect("a span measured from the nearest edge is non-negative"))
    }
}

/// One coordinate, measured from the desktop's own corner rather than the
/// profile's origin.
fn normalized(coordinate: i32, near: i32) -> i32 {
    coordinate
        .checked_sub(near)
        .expect("a layout's span is checked before its displays are placed")
}

/// The error for a layout that spans further than a desktop can.
fn unreachable(profile: &Profile, furthest: &Placed) -> ConfigError {
    ConfigError::Validation(format!(
        "output profile {} reaches {} at ({}, {}), which puts the desktop's far \
         corner beyond what a position on one desktop can describe",
        profile.name, furthest.name, furthest.position.0, furthest.position.1
    ))
}

/// The error for a display with no position left right of the positioned ones.
fn crowded(profile: &Profile, display: &Placed) -> ConfigError {
    ConfigError::Validation(format!(
        "output profile {} has no position for {}: its positioned displays end \
         beyond what a corner of one desktop can describe",
        profile.name, display.name
    ))
}

/// The error for a connector row longer than a position can describe.
fn unlightable(profile: &Profile, display: &str) -> ConfigError {
    ConfigError::Validation(format!(
        "output profile {} spans so many pixels across that {} starts beyond \
         what a corner of one desktop can describe",
        profile.name, display
    ))
}

/// The error for a mode a monitor cannot scan out.
///
/// Names the modes it can, since either side may be wrong.
fn unavailable(
    profile: &Profile,
    placement: &DisplayPlacement,
    display: &Connected,
) -> ConfigError {
    let (width, height) = placement
        .mode
        .expect("only an entry that states a mode is misstated");
    if display.modes.is_empty() {
        return ConfigError::Validation(format!(
            "output profile {} is written for {} at {}x{} and it is scanning \
             out {}x{}; this engine reports no modes and cannot set one, so the \
             profile cannot be applied as written",
            profile.name, placement.display, width, height, display.mode.0, display.mode.1
        ));
    }
    let offered: Vec<String> = display
        .modes
        .iter()
        .map(|(width, height)| format!("{width}x{height}"))
        .collect();
    ConfigError::Validation(format!(
        "output profile {} asks for {} at {}x{}, which it does not offer; it \
         offers {}",
        profile.name,
        placement.display,
        width,
        height,
        offered.join(", ")
    ))
}

/// The error for a scale that leaves a monitor with no logical pixels.
fn vanished(profile: &Profile, placement: &DisplayPlacement, mode: (u32, u32)) -> ConfigError {
    ConfigError::Validation(format!(
        "output profile {} scales {} by {}, which leaves less than one logical \
         pixel of its {}x{} mode",
        profile.name, placement.display, placement.scale, mode.0, mode.1
    ))
}

/// The first profile that matches these monitors, applied to them.
///
/// `Ok(None)` means no profile matches; the displays stay where the engine
/// put them.
pub(crate) fn layout(
    profiles: &[Profile],
    connected: &[Connected],
) -> Result<Option<Layout>, ConfigError> {
    match profiles
        .iter()
        .find(|profile| profile.resolve(connected).is_some())
    {
        None => Ok(None),
        Some(profile) => Layout::of(profile, connected).map(Some),
    }
}

/// Every profile's own validation, in config order.
pub(crate) fn validate(profiles: &[Profile]) -> Result<(), ConfigError> {
    for (index, profile) in profiles.iter().enumerate() {
        profile.validate(index, &profiles[..index])?;
    }
    Ok(())
}

/// Displays are enabled by default.
fn enabled() -> bool {
    true
}

/// Displays use scale 1 by default.
fn unscaled() -> f64 {
    1.0
}
