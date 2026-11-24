//! `domicile configure-display`: a monitor's mode, scale, position, rotation
//! and more, changed until the desktop restarts, like `swaymsg output`.
//!
//! The changes are kept as [`DisplayOverride`]s and laid over the config's
//! profiles ([`OutputConfig::overridden`]) whenever the desktop is laid out,
//! so a hotplug or a config reload keeps them. A config that describes the
//! desktop with `output.displays` sets its monitors there, so it refuses them.

use std::sync::mpsc;

use domicile_config::{ConfigError, DisplayOverride, OutputConfig, Transform};
use domicile_protocol::{DisplayChange, DisplayTransform};

use crate::screens::connected;
use crate::DomicileCompositor;

/// Where the Wayland thread tells a chrome connection thread whether a
/// [`ClientRequest::ConfigureDisplay`](crate::client_requests::ClientRequest::ConfigureDisplay)
/// was done.
pub struct Answer(mpsc::SyncSender<Result<(), String>>);

impl Answer {
    /// An answer, and where to wait for it.
    pub fn new() -> (Answer, mpsc::Receiver<Result<(), String>>) {
        let (answer, answered) = mpsc::sync_channel(1);
        (Answer(answer), answered)
    }

    /// Tell the waiting thread. It may have stopped waiting.
    pub fn give(self, answer: Result<(), String>) {
        let _ = self.0.send(answer);
    }
}

impl std::fmt::Debug for Answer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Answer")
    }
}

/// Requests are compared by what they ask, so any two answers are equal.
impl PartialEq for Answer {
    fn eq(&self, _: &Answer) -> bool {
        true
    }
}

/// `change` as an override of the monitor `display`, or `None` when it
/// changes nothing.
pub fn override_of(display: &str, change: &DisplayChange) -> Option<DisplayOverride> {
    let changed = DisplayOverride {
        display: display.to_string(),
        enabled: change.enabled,
        mode: change.mode,
        refresh: change.refresh,
        adaptive_sync: change.adaptive_sync,
        hdr: change.hdr,
        sdr_white: change.sdr_white,
        position: change.position,
        scale: change.scale,
        transform: change.transform.map(|transform| match transform {
            DisplayTransform::Normal => Transform::Normal,
            DisplayTransform::Rotate90 => Transform::Rotate90,
            DisplayTransform::Rotate180 => Transform::Rotate180,
            DisplayTransform::Rotate270 => Transform::Rotate270,
        }),
    };
    (changed
        != DisplayOverride {
            display: display.to_string(),
            ..DisplayOverride::default()
        })
    .then_some(changed)
}

/// `overrides` with `change` to `display` laid over them: a reset drops
/// that monitor's earlier ones, and a change merges into them.
pub fn changed(
    mut overrides: Vec<DisplayOverride>,
    display: &str,
    change: &DisplayChange,
) -> Vec<DisplayOverride> {
    if change.reset {
        overrides.retain(|earlier| earlier.display != display);
    }
    if let Some(later) = override_of(display, change) {
        match overrides
            .iter()
            .position(|earlier| earlier.display == display)
        {
            Some(index) => {
                let earlier = std::mem::take(&mut overrides[index]);
                overrides[index] = earlier.and_then(later);
            }
            None => overrides.push(later),
        }
    }
    overrides
}

impl DomicileCompositor {
    /// The output settings the desktop is laid out by: the config's, with
    /// `domicile configure-display`'s changes over them.
    pub fn output_settings(&self) -> Result<OutputConfig, ConfigError> {
        let output = &self.config.current().output;
        output.overridden(
            &connected(&self.engine_displays, &self.vendors),
            &self.display_overrides,
        )
    }

    /// Change how the monitor `display` is set up, and lay the desktop out
    /// again. Errs, changing nothing, when there is no such monitor or the
    /// change cannot be laid out.
    pub fn configure_display(
        &mut self,
        display: &str,
        change: &DisplayChange,
    ) -> Result<(), String> {
        if self.config.current().output.desktop().is_some() {
            return Err(
                "the config describes the desktop with output.displays, so its monitors are \
                 set there"
                    .to_string(),
            );
        }
        let monitors = connected(&self.engine_displays, &self.vendors);
        if monitors.is_empty() {
            return Err(
                "no monitors have been read: a desktop in a window takes the window's size"
                    .to_string(),
            );
        }
        let monitor = monitors
            .iter()
            .find(|monitor| monitor.is_named(display))
            .ok_or_else(|| {
                format!("no monitor {display} is plugged in; domicile list-displays lists them")
            })?;
        let before = self.display_overrides.clone();
        self.display_overrides = changed(before.clone(), &monitor.name, change);
        let laid_out = self.output_settings().and_then(|output| {
            self.screens.replugged_into(
                &self.engine_displays,
                &output,
                &self.vendors,
                &self.virtual_displays,
            )
        });
        match laid_out {
            Ok(Some(screens)) => {
                let dh = self.display_handle.clone();
                self.adopt_the_desktop(&dh, screens);
                Ok(())
            }
            // The engine lays out monitors no profile names, and nothing
            // overrides any now.
            Ok(None) => Ok(()),
            Err(err) => {
                self.display_overrides = before;
                Err(err.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scaled(scale: f64) -> DisplayChange {
        DisplayChange {
            scale: Some(scale),
            ..DisplayChange::default()
        }
    }

    #[test]
    fn a_change_that_changes_nothing_is_no_override() {
        assert_eq!(override_of("DP-1", &DisplayChange::default()), None);
    }

    #[test]
    fn a_later_change_merges_into_the_earlier_one() {
        let turned = DisplayChange {
            transform: Some(DisplayTransform::Rotate90),
            ..DisplayChange::default()
        };
        let overrides = changed(changed(Vec::new(), "DP-1", &scaled(2.0)), "DP-1", &turned);

        assert_eq!(
            overrides,
            vec![DisplayOverride {
                display: "DP-1".to_string(),
                scale: Some(2.0),
                transform: Some(Transform::Rotate90),
                ..DisplayOverride::default()
            }]
        );
    }

    #[test]
    fn a_reset_drops_only_that_monitors_changes() {
        let overrides = changed(Vec::new(), "DP-1", &scaled(2.0));
        let overrides = changed(overrides, "eDP-1", &scaled(1.5));
        let reset = DisplayChange {
            reset: true,
            ..DisplayChange::default()
        };

        let overrides = changed(overrides, "DP-1", &reset);

        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides[0].display, "eDP-1");
    }

    #[test]
    fn a_reset_with_a_change_starts_over_from_it() {
        let overrides = changed(Vec::new(), "DP-1", &scaled(2.0));
        let over = DisplayChange {
            reset: true,
            hdr: Some(true),
            ..DisplayChange::default()
        };

        let overrides = changed(overrides, "DP-1", &over);

        assert_eq!(overrides[0].scale, None);
        assert_eq!(overrides[0].hdr, Some(true));
    }
}
