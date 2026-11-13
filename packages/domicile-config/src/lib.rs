//! Domicile compositor configuration.
//!
//! - [`Config`] is the schema. [`Config::parse`] applies defaults, expands `~`
//!   against `HOME` and validates.
//! - [`ConfigStore`] holds the live config. A failed reload keeps the last
//!   good config and records the error.
//! - Each type derives `schemars::JsonSchema`. `examples/schema.rs` prints the
//!   schema the SDK ships as `config.schema.json`. Doc comments on config
//!   types become its descriptions, which config authors read, so notes about
//!   this crate's code are `//` comments.
//!
//! The shell generates this JSON file; people do not edit it. See
//! `docs/SHELL-CONFIG.md`.

mod desktop;
mod files;
mod input_devices;
mod pointers;
mod profile;
mod startup;

pub use desktop::{Desktop, Display};
pub use files::{FilesConfig, Omit};
pub use input_devices::{
    AccelProfile, ButtonMap, ClickMethod, DisableWhileTyping, MouseConfig, ScrollMethod,
    TouchpadConfig,
};
pub use pointers::{PointerConfig, PointerTarget};
pub use profile::{Connected, Desk, DisplayPlacement, Layout, Placed, Profile, Scanout, Transform};
pub use startup::StartupConfig;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// An error loading a config.
///
/// Holds rendered messages, so it is `Clone + PartialEq` and can be stored on
/// [`ConfigStore`] and compared in tests.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("could not read config file {path}: {message}")]
    Io { path: String, message: String },

    /// An error in a config file, with the file's path.
    ///
    /// A machine can have several configs, so the path says which one failed.
    #[error("the config at {path} could not be loaded:\n{why}")]
    At { path: String, why: Box<ConfigError> },

    #[error("invalid config syntax: {0}")]
    Parse(String),

    #[error("invalid config: {0}")]
    Validation(String),
}

/// Keyboard settings, named after SwayWM's `xkb_*` options.
///
/// The string fields go to xkb verbatim, so sway's multi-layout form
/// (`xkb_layout = "us,de"`) works. Empty `xkb_rules` and `xkb_model` use the
/// libxkbcommon defaults. The default layout is `us`.
///
/// To switch between layouts, list them in `keymaps` instead.
// `PartialEq` lets a reload detect a change; see the compositor's
// `Restatement`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct KeyboardConfig {
    pub xkb_rules: String,
    pub xkb_model: String,
    pub xkb_layout: String,
    pub xkb_variant: String,
    pub xkb_options: Vec<String>,
    /// Keymaps to switch between, the first the one the desktop starts on.
    ///
    /// Each is a whole keymap: an entry's unset fields take the defaults, not
    /// the fields above, which must stay unset. The shell switches with
    /// `keymap next` or `keymap <name>`. See `docs/SHELL-CONFIG.md`.
    pub keymaps: Vec<Keymap>,
    /// How a held key repeats, in native windows and in pages.
    pub repeat: KeyRepeat,
}

/// How a held key repeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct KeyRepeat {
    /// Milliseconds a key is held before it repeats.
    pub delay_ms: u16,
    /// Repeats a second. 0 turns repeat off.
    pub rate: u16,
}

impl Default for KeyRepeat {
    fn default() -> Self {
        KeyRepeat {
            delay_ms: 500,
            rate: 25,
        }
    }
}

impl Default for KeyboardConfig {
    fn default() -> Self {
        let Keymap {
            xkb_rules,
            xkb_model,
            xkb_layout,
            xkb_variant,
            xkb_options,
            ..
        } = Keymap::default();
        KeyboardConfig {
            xkb_rules,
            xkb_model,
            xkb_layout,
            xkb_variant,
            xkb_options,
            keymaps: Vec::new(),
            repeat: KeyRepeat::default(),
        }
    }
}

impl KeyboardConfig {
    /// The keymaps the desktop switches between, the first its default.
    ///
    /// A keyboard without `keymaps` is one keymap, named for its variant, or
    /// its layout when it has none.
    pub fn keymaps(&self) -> Vec<Keymap> {
        match self.keymaps.is_empty() {
            false => self.keymaps.clone(),
            true => vec![Keymap {
                name: match self.xkb_variant.is_empty() {
                    true => self.xkb_layout.clone(),
                    false => self.xkb_variant.clone(),
                },
                xkb_rules: self.xkb_rules.clone(),
                xkb_model: self.xkb_model.clone(),
                xkb_layout: self.xkb_layout.clone(),
                xkb_variant: self.xkb_variant.clone(),
                xkb_options: self.xkb_options.clone(),
            }],
        }
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.keymaps.is_empty() {
            return self.keymaps()[0].validate("input.keyboard");
        }
        if *self
            != (KeyboardConfig {
                keymaps: self.keymaps.clone(),
                ..KeyboardConfig::default()
            })
        {
            return Err(ConfigError::Validation(
                "input.keyboard sets xkb_* fields beside input.keyboard.keymaps; \
                 put them in a keymap"
                    .into(),
            ));
        }
        for (index, keymap) in self.keymaps.iter().enumerate() {
            let at = format!("input.keyboard.keymaps[{index}]");
            keymap.validate(&at)?;
            if keymap.name.trim().is_empty() || keymap.name.trim() != keymap.name {
                return Err(ConfigError::Validation(format!(
                    "{at} needs a name with no padding, got {:?}",
                    keymap.name
                )));
            }
            if keymap.name == "next" {
                return Err(ConfigError::Validation(format!(
                    "{at} is named \"next\", which `keymap next` takes to mean the next keymap"
                )));
            }
            if self.keymaps[..index]
                .iter()
                .any(|earlier| earlier.name == keymap.name)
            {
                return Err(ConfigError::Validation(format!(
                    "{at} is named {:?}, like an earlier keymap; `keymap <name>` needs one each",
                    keymap.name
                )));
            }
        }
        Ok(())
    }
}

/// One keymap the desktop can switch to, in `input.keyboard.keymaps`.
///
/// The `xkb_*` fields are as in `input.keyboard`, with the same defaults.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Keymap {
    /// What the shell shows and `keymap <name>` selects, such as `dvp`.
    ///
    /// Unique, and not `next`.
    pub name: String,
    pub xkb_rules: String,
    pub xkb_model: String,
    pub xkb_layout: String,
    pub xkb_variant: String,
    pub xkb_options: Vec<String>,
}

impl Default for Keymap {
    fn default() -> Self {
        Keymap {
            name: String::new(),
            xkb_rules: String::new(),
            xkb_model: String::new(),
            // `validate` refuses an empty layout: xkb would fall back to a
            // build-time default this crate cannot name.
            xkb_layout: "us".into(),
            xkb_variant: String::new(),
            xkb_options: Vec::new(),
        }
    }
}

impl Keymap {
    /// The options joined with commas, as xkb expects.
    ///
    /// An empty list yields `""`, which xkb reads as "no options".
    pub fn xkb_options_string(&self) -> String {
        self.xkb_options.join(",")
    }

    /// Checks the `xkb_*` fields of the keymap at config path `at`.
    fn validate(&self, at: &str) -> Result<(), ConfigError> {
        if self.xkb_layout.trim().is_empty() {
            return Err(ConfigError::Validation(format!(
                "{at}.xkb_layout must not be empty"
            )));
        }
        if self.xkb_options.iter().any(|o| o.trim().is_empty()) {
            return Err(ConfigError::Validation(format!(
                "{at}.xkb_options must not contain an empty option"
            )));
        }
        Ok(())
    }
}

/// Input-device settings.
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct InputConfig {
    pub keyboard: KeyboardConfig,
    pub touchpad: TouchpadConfig,
    pub mouse: MouseConfig,
    /// Tablets and touchscreens, each bound to the display it covers.
    ///
    /// Read on a tty only, on every hotplug. An unbound one covers no
    /// display. See `docs/DISPLAYS.md#tablets-and-touchscreens`.
    pub pointers: Vec<PointerConfig>,
}

impl InputConfig {
    /// Each pointer whose display is in `connected`, with that display's
    /// output name.
    pub fn pointer_targets(&self, connected: &[Connected]) -> Vec<PointerTarget> {
        pointers::targets(&self.pointers, connected)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        self.keyboard.validate()?;
        self.touchpad.validate()?;
        self.mouse.validate()?;
        pointers::validate(&self.pointers)
    }
}

/// One display, described in the config rather than discovered.
///
/// A nested compositor has no monitors to enumerate. Each display becomes a
/// `wl_output` and a region of the chrome page, which the shell addresses by
/// `name`. `position` and `size` are logical units.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DisplayConfig {
    /// The name the chrome and the compositor use for this display.
    ///
    /// Matched exactly, so a name padded with whitespace is rejected.
    pub name: String,
    /// The top-left corner in the config's coordinate space.
    ///
    /// May be negative.
    // [`Desktop`] normalizes it; these values do not leave this crate.
    #[serde(default)]
    pub position: (i32, i32),
    /// The `wl_output` scale for clients on this display.
    ///
    /// `output.max_scale` does not apply to described displays.
    #[serde(default = "one")]
    #[schemars(range(min = 1))]
    pub scale: u32,
    /// Width and height in logical units. The `wl_output` mode is this times
    /// `scale`.
    pub size: (u32, u32),
}

fn one() -> u32 {
    1
}

impl DisplayConfig {
    /// Whether this display and `other` overlap.
    fn overlaps(&self, other: &DisplayConfig) -> bool {
        overlap(
            span(self.position.0, self.size.0),
            span(other.position.0, other.size.0),
        ) && overlap(
            span(self.position.1, self.size.1),
            span(other.position.1, other.size.1),
        )
    }

    fn validate(&self, index: usize) -> Result<(), ConfigError> {
        let at = format!("output.displays[{index}]");
        if self.name.trim().is_empty() {
            return Err(ConfigError::Validation(format!("{at} must have a name")));
        }
        if self.name.trim() != self.name {
            return Err(ConfigError::Validation(format!(
                "{at} name {:?} is padded with whitespace; \
                 the name is matched exactly, so the padding would have to be typed everywhere",
                self.name
            )));
        }
        let (width, height) = self.size;
        if width == 0 || height == 0 {
            return Err(ConfigError::Validation(format!(
                "{at} size for {} must be non-zero, got {width}x{height}",
                self.name
            )));
        }
        if self.scale == 0 {
            return Err(ConfigError::Validation(format!(
                "{at} scale for {} must be at least 1",
                self.name
            )));
        }
        // Width times scale can exceed `i32` even when each fits. Check it
        // here: the Smithay backend builds the mode unchecked and would wrap
        // in release.
        //
        // Multiply in `u64`: two `u32`s can overflow `i64`, and a panic here
        // would let a bad config crash the compositor.
        //
        // Scale is at least 1, so this also bounds the logical size, which
        // `Desktop` asserts when it normalizes.
        let mode = (
            u64::from(width) * u64::from(self.scale),
            u64::from(height) * u64::from(self.scale),
        );
        let reach = u64::try_from(i32::MAX).expect("`i32::MAX` is positive");
        if mode.0 > reach || mode.1 > reach {
            return Err(ConfigError::Validation(format!(
                "{at} size for {} is {width}x{height} at scale {}, a mode of \
                 {}x{} — more pixels across or down than a coordinate can \
                 describe",
                self.name, self.scale, mode.0, mode.1
            )));
        }
        let (_, right) = span(self.position.0, width);
        let (_, bottom) = span(self.position.1, height);
        if right > i64::from(i32::MAX) || bottom > i64::from(i32::MAX) {
            return Err(ConfigError::Validation(format!(
                "{at} puts {}'s far corner at ({right}, {bottom}), off the edge of the \
                 coordinate space the desktop is measured in",
                self.name
            )));
        }
        Ok(())
    }
}

/// One display's half-open extent along one axis, in the config's space.
///
/// Widened to `i64` so a far end past `i32` does not wrap;
/// [`DisplayConfig::validate`] rejects it.
fn span(start: i32, length: u32) -> (i64, i64) {
    (i64::from(start), i64::from(start) + i64::from(length))
}

/// Whether two half-open spans intersect.
///
/// Spans that share an endpoint are adjacent, not overlapping.
fn overlap((start, end): (i64, i64), (other_start, other_end): (i64, i64)) -> bool {
    start < other_end && other_start < end
}

/// Output settings.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct OutputConfig {
    /// The displays that make up the desktop.
    ///
    /// Empty means one output sized to Domicile's own window.
    pub displays: Vec<DisplayConfig>,
    /// The highest `wl_output` scale to advertise.
    ///
    /// Limits cost: a client at scale N renders N² times the pixels. `1` turns
    /// scaling off. Applies only while `displays` is empty.
    #[schemars(range(min = 1))]
    pub max_scale: u32,
    /// Placements for real monitors, matched against what is connected.
    ///
    /// Re-read on every hotplug. Empty leaves the monitors where the engine
    /// placed them. See `docs/DISPLAYS.md#profiles`.
    // Matched by [`OutputConfig::layout`].
    pub profiles: Vec<Profile>,
}

impl Default for OutputConfig {
    fn default() -> Self {
        // 2 covers a typical HiDPI laptop. Higher scales cost more than they
        // improve.
        OutputConfig {
            displays: Vec::new(),
            max_scale: 2,
            profiles: Vec::new(),
        }
    }
}

impl OutputConfig {
    /// The desktop these displays make up, shifted so its top-left corner is
    /// the origin.
    ///
    /// `None` when no displays are configured. The compositor then uses one
    /// output, `domicile-0`, that follows its window. An empty desktop would
    /// give the chrome nothing to lay out against.
    ///
    /// Rebuilt on each call; keep it off frame paths.
    pub fn desktop(&self) -> Option<Desktop> {
        Desktop::of(&self.displays)
    }

    /// The first profile matching `connected`, applied to those monitors.
    ///
    /// `Ok(None)` means no profile matches, and the monitors stay where the
    /// engine placed them. `Err` means the matched profile cannot apply: a
    /// mode mismatch, a scale that leaves no logical pixels, or a placement
    /// too large for a desktop. These depend on the monitor's mode, so parsing
    /// cannot catch them.
    ///
    /// Called on each hotplug.
    pub fn layout(&self, connected: &[Connected]) -> Result<Option<Layout>, ConfigError> {
        profile::layout(&self.profiles, connected)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.max_scale == 0 {
            return Err(ConfigError::Validation(
                "output.max_scale must be at least 1".into(),
            ));
        }
        for (index, display) in self.displays.iter().enumerate() {
            display.validate(index)?;
            for earlier in &self.displays[..index] {
                if earlier.name == display.name {
                    return Err(ConfigError::Validation(format!(
                        "two output.displays are both named {}",
                        display.name
                    )));
                }
                if earlier.overlaps(display) {
                    return Err(ConfigError::Validation(format!(
                        "output.displays {} and {} cover the same ground",
                        earlier.name, display.name
                    )));
                }
            }
        }
        // Run last: a per-display error names the faulty display, while this
        // check can only name a pair.
        self.validate_extent()?;
        profile::validate(&self.profiles)
    }

    /// Whether the displays together fit in `i32` coordinates.
    ///
    /// Each display fitting is not enough: two can be four billion apart.
    /// `Desktop::of` subtracts corners to normalize positions and would
    /// overflow. A single display is already bounded by
    /// `DisplayConfig::validate`, so the error always names two displays.
    fn validate_extent(&self) -> Result<(), ConfigError> {
        for axis in [Axis::Horizontal, Axis::Vertical] {
            let furthest = self.displays.iter().max_by_key(|d| axis.reach(d));
            let nearest = self.displays.iter().min_by_key(|d| axis.near(d));
            let (Some(furthest), Some(nearest)) = (furthest, nearest) else {
                continue;
            };
            let extent = axis.reach(furthest) - i64::from(axis.near(nearest));
            if extent > i64::from(i32::MAX) {
                return Err(ConfigError::Validation(format!(
                    "output.displays span {extent} {axis}, from {} to {} — \
                     further than a position on one desktop can describe",
                    nearest.name, furthest.name
                )));
            }
        }
        Ok(())
    }
}

/// One axis of the desktop, for the extent check.
#[derive(Debug, Clone, Copy)]
enum Axis {
    Horizontal,
    Vertical,
}

impl Axis {
    /// The display's near edge along the axis, in the config's space.
    fn near(self, display: &DisplayConfig) -> i32 {
        match self {
            Axis::Horizontal => display.position.0,
            Axis::Vertical => display.position.1,
        }
    }

    /// The display's far edge along the axis, widened because it can exceed
    /// `i32`.
    fn reach(self, display: &DisplayConfig) -> i64 {
        let length = match self {
            Axis::Horizontal => display.size.0,
            Axis::Vertical => display.size.1,
        };
        i64::from(self.near(display)) + i64::from(length)
    }
}

impl std::fmt::Display for Axis {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Axis::Horizontal => "across",
            Axis::Vertical => "down",
        })
    }
}

/// When an idle desktop turns its screens off, and when it locks.
///
/// Absent means neither, and that is the default: a blank screen looks like a
/// crash, so a shell must opt in. The two timeouts run on separate clocks
/// from the same input and inhibitors, so either may be the shorter. See
/// `docs/IDLE.md`.
///
/// The unit is in the key name because a generator writes this file.
// `PartialEq` lets a reload detect a change; see the compositor's
// `Restatement`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct IdleConfig {
    /// Seconds without input before the screens go dark.
    ///
    /// Absent means never. Zero is refused.
    #[schemars(range(min = 1))]
    pub blank_after_seconds: Option<u64>,
    /// Seconds without input before the desktop locks.
    ///
    /// Absent means the desktop locks only when its shell asks. Zero is
    /// refused.
    #[schemars(range(min = 1))]
    pub lock_after_seconds: Option<u64>,
}

impl IdleConfig {
    /// How long the desktop goes without input before it blanks, or `None`
    /// for never.
    pub fn blank_after(&self) -> Option<Duration> {
        self.blank_after_seconds.map(Duration::from_secs)
    }

    /// How long the desktop goes without input before it locks, or `None`
    /// for only when the shell asks.
    pub fn lock_after(&self) -> Option<Duration> {
        self.lock_after_seconds.map(Duration::from_secs)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.lock_after_seconds == Some(0) {
            return Err(ConfigError::Validation(
                "idle.lock_after_seconds must be at least 1 second; leave the key out \
                 for a desktop that locks only when its shell asks"
                    .into(),
            ));
        }
        if self.blank_after_seconds == Some(0) {
            return Err(ConfigError::Validation(
                "idle.blank_after_seconds must be at least 1 second; leave the key out \
                 for a desktop whose screens never blank"
                    .into(),
            ));
        }
        Ok(())
    }
}

/// What unlocks this desk: the user's password, checked by PAM.
///
/// If `/etc/pam.d` lacks the service, the desk does not lock, since nothing
/// could unlock it, until the file is added. See `docs/LOCK.md#verifiers`.
// `PartialEq` lets a reload detect a change; see the compositor's
// `Restatement`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct LockConfig {
    /// The PAM service the desk's user authenticates against.
    ///
    /// Absent means `"domicile"`, which the NixOS module and the distribution
    /// packages declare.
    // `pub` so `packages/distro/tests/test-the-home-manager-module-agrees.sh` can check that
    // this struct accepts every key the home-manager module writes.
    pub pam_service: Option<String>,
}

impl LockConfig {
    /// The PAM service that unlocks this desk.
    pub fn service(&self) -> &str {
        self.pam_service.as_deref().unwrap_or("domicile")
    }

    fn validate(&self) -> Result<(), ConfigError> {
        // PAM reads a service from the file of that name in `/etc/pam.d`.
        match self.pam_service.as_deref().filter(|name| {
            matches!(*name, "" | "." | "..") || name.contains('/') || name.contains('\0')
        }) {
            Some(name) => Err(ConfigError::Validation(format!(
                "lock.pam_service {name:?} is not a file name in /etc/pam.d; name the PAM \
                 service this desk authenticates against, or leave the key out for \
                 `domicile`"
            ))),
            None => Ok(()),
        }
    }
}

/// Whether the desktop is drawn dark or light.
///
/// There is no "follow the system" option: the chrome is the system, so there
/// is nothing to follow. Clients follow this value through the settings
/// portal; see the compositor's `portals::settings`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeMode {
    /// Light text on a dark background, which the chrome is designed for.
    #[default]
    Dark,
    /// Dark text on a light background.
    Light,
}

/// How the desktop is themed.
///
/// Clients read every field but `mode` through the settings portal; see the
/// compositor's `portals::settings`.
// `PartialEq` lets a reload detect a change; see the compositor's
// `Restatement`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct ThemeConfig {
    pub mode: ThemeMode,
    /// The color clients highlight with, or their own when unset.
    pub accent_color: Option<AccentColor>,
    pub contrast: Contrast,
    /// Asks clients to keep animation to a minimum.
    pub reduced_motion: bool,
    /// The freedesktop icon theme's directory name, such as `Papirus-Dark`.
    /// Unset leaves shells with `hicolor`.
    pub icon_theme: Option<String>,
    /// The XCursor theme for clients and the engine's pointer, in both modes
    /// or one per mode. Unset leaves clients their own.
    pub cursor_theme: Option<CursorThemeName>,
    /// The cursor size in logical pixels, for clients and the engine's
    /// pointer. Unset leaves clients their own. Zero is refused.
    #[schemars(range(min = 1))]
    pub cursor_size: Option<u16>,
    /// Hides the engine's pointer after this many milliseconds without
    /// pointer input. Unset never hides it. Zero is refused.
    #[schemars(range(min = 1))]
    pub cursor_hide_after_ms: Option<u32>,
    /// Hides the engine's pointer on a typing key press, until the pointer is
    /// next used.
    pub cursor_hide_when_typing: bool,
    /// The interface font as a Pango description, such as `Inter 11`. Unset
    /// leaves clients their own.
    pub font_name: Option<String>,
    /// The fixed-width font as a Pango description, such as `Iosevka 12`.
    /// Unset leaves clients their own.
    pub monospace_font_name: Option<String>,
    /// Host names of sites the browser draws dark while the theme is dark,
    /// for sites with no dark theme of their own. A host covers its
    /// subdomains.
    pub force_dark: Vec<String>,
}

impl ThemeConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        // Icon and cursor themes are each a directory under each `icons`
        // directory.
        let cursor_themes = self
            .cursor_theme
            .iter()
            .flat_map(|name| [ThemeMode::Dark, ThemeMode::Light].map(|mode| name.in_mode(mode)));
        let not_a_directory = self
            .icon_theme
            .as_deref()
            .map(|name| ("icon_theme", name))
            .into_iter()
            .chain(cursor_themes.map(|name| ("cursor_theme", name)))
            .find(|(_, name)| matches!(*name, "" | "." | "..") || name.contains('/'));
        // A URL or a port here would never match a page's host.
        if let Some(site) = self
            .force_dark
            .iter()
            .find(|site| site.is_empty() || site.contains(['/', ':']))
        {
            return Err(ConfigError::Validation(format!(
                "theme.force_dark {site:?} is not a host name, such as \"mail.google.com\""
            )));
        }
        match (not_a_directory, self.cursor_size) {
            (Some((key, name)), _) => Err(ConfigError::Validation(format!(
                "theme.{key} {name:?} is not a theme's directory name"
            ))),
            (None, Some(0)) => Err(ConfigError::Validation(
                "theme.cursor_size must be at least 1; leave the key out for the clients' own"
                    .into(),
            )),
            (None, _) if self.cursor_hide_after_ms == Some(0) => Err(ConfigError::Validation(
                "theme.cursor_hide_after_ms must be at least 1; leave the key out to never hide \
                 the pointer"
                    .into(),
            )),
            (None, _) => Ok(()),
        }
    }
}

/// An XCursor theme's directory name, such as `Adwaita`, for both modes or
/// for each.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum CursorThemeName {
    /// The same theme in both modes.
    Both(String),
    /// A theme for each mode, such as a dark pointer on the light desktop.
    PerMode(PerModeCursorThemes),
}

/// A cursor theme's directory name for each mode.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PerModeCursorThemes {
    pub dark: String,
    pub light: String,
}

impl CursorThemeName {
    /// The theme's directory name in `mode`.
    pub fn in_mode(&self, mode: ThemeMode) -> &str {
        match (self, mode) {
            (CursorThemeName::Both(name), _) => name,
            (CursorThemeName::PerMode(names), ThemeMode::Dark) => &names.dark,
            (CursorThemeName::PerMode(names), ThemeMode::Light) => &names.light,
        }
    }
}

/// An sRGB color, written `"#rrggbb"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(try_from = "String", into = "String")]
#[schemars(schema_with = "accent_color_schema")]
pub struct AccentColor(pub [u8; 3]);

impl TryFrom<String> for AccentColor {
    type Error = String;

    fn try_from(written: String) -> Result<Self, String> {
        let not_a_color = || format!("{written:?} is not a color written \"#rrggbb\"");
        let digits = written
            .strip_prefix('#')
            .filter(|digits| digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(not_a_color)?;
        let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).expect("hex digits");
        Ok(AccentColor([channel(0), channel(2), channel(4)]))
    }
}

impl From<AccentColor> for String {
    fn from(AccentColor([red, green, blue]): AccentColor) -> Self {
        format!("#{red:02x}{green:02x}{blue:02x}")
    }
}

/// The written form `AccentColor::try_from` accepts.
fn accent_color_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "string",
        "pattern": "^#[0-9a-fA-F]{6}$",
    })
}

/// How strongly clients set text and edges apart from their background.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Contrast {
    #[default]
    Normal,
    High,
}

/// Chrome extensions the engine installs into the browser windows' profile.
/// See `docs/architecture/EXTENSIONS.md`.
///
/// Listing an extension is consent: there is no install prompt. Removing one
/// from the list uninstalls it.
// `PartialEq` lets a reload detect a change; see the compositor's
// `Restatement`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct ExtensionsConfig {
    /// Chrome Web Store ids, installed from the Store and updated from it.
    pub web_store: Vec<String>,
    /// Directories holding an unpacked extension, loaded as they are.
    pub unpacked: Vec<PathBuf>,
    /// Each extension's settings, by id, as chrome://extensions has them. A
    /// setting left out is the user's to change in the Settings app; one
    /// removed from here goes back to Chrome's default.
    pub settings: BTreeMap<String, ExtensionSettings>,
}

/// One extension's settings. See [`ExtensionsConfig::settings`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct ExtensionSettings {
    /// Runs in private windows. Chrome's default is no.
    #[serde(rename = "private")]
    pub in_private: Option<bool>,
    /// Runs on local files (`file://` pages). Chrome's default is no.
    pub file_access: Option<bool>,
    /// May run the user scripts you add to it (`chrome.userScripts`), as
    /// userscript managers do. Chrome's default is no.
    pub user_scripts: Option<bool>,
    /// Which of the sites it asks for it runs on. Chrome's default is all.
    pub site_access: Option<SiteAccess>,
}

/// Which sites an extension runs on: `"on_click"`, `"all_sites"`, or a list
/// of hosts, each also as `*.host` for its subdomains.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum SiteAccess {
    Mode(SiteAccessMode),
    /// Only these hosts, on http and https.
    Sites(Vec<String>),
}

/// [`SiteAccess`] other than a list of hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SiteAccessMode {
    /// Only on a page where you click its button.
    OnClick,
    /// On every site it asks for.
    AllSites,
}

/// Whether `id` is a Chrome extension id: 32 letters from `a` to `p`.
fn is_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// Whether `site` is a host, or `*.host` for its subdomains, as the engine
/// grants one: dot-separated labels of letters, digits and inner hyphens, the
/// last with a letter and not a hex number such as `0x1f`, or a dotted IPv4
/// address (without `*.`). The engine's
/// `SitePattern` checks the same rule.
fn is_site(site: &str) -> bool {
    match site.strip_prefix("*.") {
        Some(host) => is_host_name(host),
        None => is_host_name(site) || site.parse::<std::net::Ipv4Addr>().is_ok(),
    }
}

/// Whether `host` is labels, the last with a letter and not a hex number: a
/// name rather than a number, which Chrome would read as an address.
fn is_host_name(host: &str) -> bool {
    let is_label = |label: &str| {
        (1..=63).contains(&label.len())
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    host.split('.').all(is_label)
        && host.rsplit('.').next().is_some_and(|last| {
            let hex = last
                .get(..2)
                .is_some_and(|start| start.eq_ignore_ascii_case("0x"))
                && last[2..].bytes().all(|b| b.is_ascii_hexdigit());
            last.bytes().any(|b| b.is_ascii_alphabetic()) && !hex
        })
}

impl ExtensionsConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        // Store ids are 32 letters from `a` to `p`. Checking here names the
        // config file; the Store would fail later, in a log.
        if let Some(id) = self.web_store.iter().find(|id| !is_extension_id(id)) {
            return Err(ConfigError::Validation(format!(
                "extensions.web_store {id:?} is not a Chrome Web Store id, which is \
                 32 letters from `a` to `p`"
            )));
        }
        if let Some(id) = self.settings.keys().find(|id| !is_extension_id(id)) {
            return Err(ConfigError::Validation(format!(
                "extensions.settings {id:?} is not an extension id, which is 32 \
                 letters from `a` to `p`"
            )));
        }
        let site = self
            .settings
            .values()
            .filter_map(|settings| match &settings.site_access {
                Some(SiteAccess::Sites(sites)) => Some(sites),
                _ => None,
            })
            .flatten()
            .find(|site| !is_site(site));
        if let Some(site) = site {
            return Err(ConfigError::Validation(format!(
                "extensions.settings' site {site:?} is not a host such as \
                 `github.com`, or `*.github.com` for its subdomains"
            )));
        }
        // A relative path would depend on the compositor's working directory.
        match self.unpacked.iter().find(|path| !path.is_absolute()) {
            Some(path) => Err(ConfigError::Validation(format!(
                "extensions.unpacked {:?} is not an absolute path, or one under `~`",
                path.display().to_string()
            ))),
            None => Ok(()),
        }
    }

    /// These extensions, with a leading `~` in `unpacked` expanded to `home`.
    ///
    /// The browser does not expand `~`. Only `~` and `~/` expand, as in
    /// `domicile`'s own argument; `~alice` is refused.
    fn at_home(self, home: Option<&Path>) -> Result<ExtensionsConfig, ConfigError> {
        self.unpacked
            .into_iter()
            .map(|path| under_home(path, home))
            .collect::<Result<_, _>>()
            .map(|unpacked| ExtensionsConfig { unpacked, ..self })
    }
}

/// `path` with a leading `~` component replaced by `home`.
fn under_home(path: PathBuf, home: Option<&Path>) -> Result<PathBuf, ConfigError> {
    match (path.strip_prefix("~"), home) {
        // Collecting the components drops the trailing `/` from a bare `~`.
        (Ok(rest), Some(home)) => Ok(home.join(rest).components().collect()),
        (Ok(_), None) => Err(ConfigError::Validation(format!(
            "extensions.unpacked {:?} starts at a home directory and HOME is not \
             set, so there is nowhere for it to start",
            path.display().to_string()
        ))),
        (Err(_), _) if path.to_string_lossy().starts_with('~') => {
            Err(ConfigError::Validation(format!(
                "extensions.unpacked {:?} is under another user's home, which is not \
                 expanded; only `~` and `~/` are, so write that home out",
                path.display().to_string()
            )))
        }
        (Err(_), _) => Ok(path),
    }
}

/// What applications are told not to do, through the
/// `org.freedesktop.impl.portal.Lockdown` portal. Every switch defaults to
/// off.
///
/// Applications enforce these themselves; the compositor only reports them.
/// See `docs/SHELL-CONFIG.md#lockdown`.
// `PartialEq` lets a reload detect a change; see the compositor's
// `Restatement`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct LockdownConfig {
    pub disable_printing: bool,
    pub disable_save_to_disk: bool,
    pub disable_application_handlers: bool,
    pub disable_location: bool,
    pub disable_camera: bool,
    pub disable_microphone: bool,
    pub disable_sound_output: bool,
}

/// The full compositor configuration.
#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub extensions: ExtensionsConfig,
    pub files: FilesConfig,
    pub idle: IdleConfig,
    pub input: InputConfig,
    pub lock: LockConfig,
    pub lockdown: LockdownConfig,
    pub output: OutputConfig,
    pub startup: StartupConfig,
    /// The terminal applications such as htop and vim run in
    /// (`Terminal=true` in their desktop entries): its argv, which the
    /// application's own follows, as `["kitty", "--"]` or `["foot"]`. The
    /// launcher and `domicile open` offer such applications only when it is
    /// set, and a shell's terminal key opens it. Unset, there is no terminal.
    pub terminal: Option<Vec<String>>,
    pub theme: ThemeConfig,
    /// The shell `domicile` runs when given none: a path or a package, as
    /// `domicile load-shell` takes. The compositor ignores it.
    pub shell: Option<String>,
    /// The values of the options the shell declares, by key. The compositor
    /// sends them to the shell without reading them. See
    /// `docs/WRITING-A-SHELL.md#options`.
    pub shell_options: serde_json::Map<String, serde_json::Value>,
    /// Where editors find this file's JSON Schema. Domicile ignores it.
    #[serde(rename = "$schema")]
    pub schema: Option<String>,
}

impl Config {
    /// Parse a config from JSON text, applying defaults and validating it.
    pub fn parse(text: &str) -> Result<Config, ConfigError> {
        Config::parse_at_home(text, home_directory().as_deref())
    }

    /// [`Config::parse`], with the home directory given rather than read.
    fn parse_at_home(text: &str, home: Option<&Path>) -> Result<Config, ConfigError> {
        // `to_string` keeps serde_json's line, column and key name.
        let parsed: Config =
            serde_json::from_str(text).map_err(|e| ConfigError::Parse(e.to_string()))?;
        Config::settled(parsed, home)
    }

    /// A config as it was written, with its paths taken from `home` and
    /// validated.
    fn settled(parsed: Config, home: Option<&Path>) -> Result<Config, ConfigError> {
        parsed.extensions.at_home(home).and_then(|extensions| {
            let config = Config {
                extensions,
                ..parsed
            };
            config.validate().map(|()| config)
        })
    }

    /// Read and parse a config from a file.
    pub fn load(path: impl AsRef<Path>) -> Result<Config, ConfigError> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path).map_err(|e| ConfigError::Io {
            path: path.display().to_string(),
            message: e.to_string(),
        })?;
        // Add the path to parse errors; the read error above already has it.
        Config::parse(&text).map_err(|why| ConfigError::At {
            path: path.display().to_string(),
            why: Box::new(why),
        })
    }

    /// Validation the deserializer cannot express.
    fn validate(&self) -> Result<(), ConfigError> {
        self.extensions.validate()?;
        self.idle.validate()?;
        self.input.validate()?;
        self.lock.validate()?;
        self.startup.validate()?;
        if self.terminal.as_ref().is_some_and(Vec::is_empty) {
            return Err(ConfigError::Validation(
                "terminal is empty, which names no program to run; leave it out for no terminal"
                    .to_string(),
            ));
        }
        self.theme.validate()?;
        self.output.validate()
    }
}

/// The home directory `~` expands to: `HOME`, which the compositor also
/// indexes for the launcher.
fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Holds the live configuration and applies hot-reloads.
///
/// A reload replaces the live config only when the new one is valid.
/// Otherwise the previous config stays and the error is kept in
/// [`last_error`](ConfigStore::last_error), so a bad write cannot crash the
/// compositor.
#[derive(Debug, Clone)]
pub struct ConfigStore {
    current: Config,
    last_error: Option<ConfigError>,
}

impl ConfigStore {
    pub fn new(initial: Config) -> Self {
        ConfigStore {
            current: initial,
            last_error: None,
        }
    }

    /// The live configuration.
    pub fn current(&self) -> &Config {
        &self.current
    }

    /// The error from the most recent failed reload, if the last reload failed.
    pub fn last_error(&self) -> Option<&ConfigError> {
        self.last_error.as_ref()
    }

    /// Attempt to replace the live config from JSON text.
    pub fn reload_from_str(&mut self, text: &str) -> Result<(), ConfigError> {
        self.apply(Config::parse(text))
    }

    /// Attempt to replace the live config from a file on disk.
    pub fn reload_from_path(&mut self, path: impl AsRef<Path>) -> Result<(), ConfigError> {
        self.apply(Config::load(path))
    }

    fn apply(&mut self, result: Result<Config, ConfigError>) -> Result<(), ConfigError> {
        match result {
            Ok(config) => {
                self.current = config;
                self.last_error = None;
                Ok(())
            }
            Err(err) => {
                self.last_error = Some(err.clone());
                Err(err)
            }
        }
    }
}

/// How long a config file must go unchanged before a watcher reloads it.
const SETTLE: Duration = Duration::from_millis(100);

/// Watches a config file and sends a parsed [`Config`] or [`ConfigError`] on
/// `rx` after each burst of changes, once the file has settled. Pass the
/// results to [`ConfigStore::apply_watch`].
///
/// One save is several changes. A save that truncates before writing can send
/// the empty file's parse error before the saved config, so apply the last
/// result of a burst.
///
/// Keep the whole struct alive while reading `rx`. The OS watcher owns the
/// sender, so dropping it closes the channel and `recv` returns `Err` with no
/// other sign. In edition 2021 a `move` closure that names `watcher.rx`
/// captures only that field; write `let watcher = watcher;` inside the closure
/// to move the whole struct.
pub struct ConfigWatcher {
    _watcher: notify::RecommendedWatcher,
    pub rx: std::sync::mpsc::Receiver<Result<Config, ConfigError>>,
}

/// Begin watching `path` for changes.
pub fn watch(path: impl AsRef<Path>) -> Result<ConfigWatcher, ConfigError> {
    use notify::Watcher;

    let path = path.as_ref().to_path_buf();
    // Watch the parent directory: editors often save by atomic rename, which
    // a direct file watch can miss.
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let (tx, rx) = std::sync::mpsc::channel();
    let (changed, heard) = std::sync::mpsc::channel();
    let reload_path = path.clone();
    let name = path.file_name().map(ToOwned::to_owned);
    // Ends when the OS watcher drops `changed` or the caller drops `rx`.
    std::thread::spawn(move || {
        while heard.recv().is_ok() {
            // A save truncates, then writes. Reloading between the two reads an
            // empty file, so wait for the file to settle.
            while heard.recv_timeout(SETTLE).is_ok() {}
            if tx.send(Config::load(&reload_path)).is_err() {
                return;
            }
        }
    });
    // Changes only: a reload's own read is an access event, which would set off
    // the next reload and spin forever.
    let changes = notify::Config::default().with_event_kinds(notify::EventKindMask::CORE);
    let mut watcher = notify::RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            // The directory holds other files, whose writes would hold off a
            // reload until they stop.
            let config_changed = res.is_ok_and(|event| {
                event
                    .paths
                    .iter()
                    .any(|touched| touched.file_name() == name.as_deref())
            });
            if config_changed {
                // Fails only once the caller has dropped `rx`, when there is
                // no one left to reload for.
                let _ = changed.send(());
            }
        },
        changes,
    )
    .map_err(|e| ConfigError::Io {
        path: path.display().to_string(),
        message: e.to_string(),
    })?;

    watcher
        .watch(&dir, notify::RecursiveMode::NonRecursive)
        .map_err(|e| ConfigError::Io {
            path: dir.display().to_string(),
            message: e.to_string(),
        })?;

    Ok(ConfigWatcher {
        _watcher: watcher,
        rx,
    })
}

impl ConfigStore {
    /// Apply a reload result delivered by a [`ConfigWatcher`].
    pub fn apply_watch(&mut self, result: Result<Config, ConfigError>) -> Result<(), ConfigError> {
        self.apply(result)
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{Config, ConfigError};

    const HOME: &str = "/home/you";

    fn unpacked(path: &str, home: Option<&Path>) -> Result<Vec<PathBuf>, ConfigError> {
        Config::parse_at_home(
            &format!(r#"{{ "extensions": {{ "unpacked": [{path:?}] }} }}"#),
            home,
        )
        .map(|config| config.extensions.unpacked)
    }

    #[test]
    fn a_tilde_in_an_unpacked_extension_is_the_home_directory() {
        for (written, meant) in [
            ("~/src/my-extension", "/home/you/src/my-extension"),
            ("~", "/home/you"),
        ] {
            assert_eq!(
                unpacked(written, Some(Path::new(HOME))),
                Ok(vec![PathBuf::from(meant)]),
                "{written}"
            );
        }
    }

    #[test]
    fn refuses_a_tilde_with_no_home_to_stand_for() {
        let err = unpacked("~/src/my-extension", None).unwrap_err();
        let ConfigError::Validation(message) = &err else {
            panic!("got {err:?}");
        };
        assert!(message.contains("~/src/my-extension"), "{message}");
        assert!(message.contains("HOME"), "{message}");
    }
}
