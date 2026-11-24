//! The night light the shell sets, and its fade from one to the next.
//!
//! A new night light fades in from the one drawn instead of snapping, on every
//! monitor, whether a ramp or a color matrix warms it ([`crate::gamma`]). The
//! fade takes [`SECONDS_PER_GAIN`] for each whole step of the channel that
//! changes most: about a second and a half to switch it on at 3000 K, and a
//! few frames for each step of a schedule's half-hour ease.
//!
//! See `docs/DISPLAYS.md#night-light-and-gamma-control`.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use domicile_host::white_point::{white_point, WhitePoint, NEUTRAL};

/// How long the fade takes for a channel's gain to move by 1.
const SECONDS_PER_GAIN: f64 = 2.5;

/// The night light of every monitor, and of those the shell set one for.
#[derive(Debug, Clone, PartialEq)]
pub struct Lights {
    /// The night light of every monitor not in `by_output`.
    every: WhitePoint,
    /// Night lights the shell set for one monitor, by `wl_output` name.
    by_output: HashMap<String, WhitePoint>,
}

impl Default for Lights {
    fn default() -> Self {
        Lights {
            every: white_point(NEUTRAL),
            by_output: HashMap::new(),
        }
    }
}

impl Lights {
    /// Sets the night light of `output`, or of every monitor when `None`.
    /// Every monitor's replaces each one's, as the shell's switch for the
    /// whole desk.
    pub fn set(&mut self, output: Option<&str>, white: WhitePoint) {
        match output {
            Some(output) => {
                self.by_output.insert(output.to_owned(), white);
            }
            None => {
                self.every = white;
                self.by_output.clear();
            }
        }
    }

    /// The night light of `output`, or every monitor's.
    pub fn white_of(&self, output: Option<&str>) -> WhitePoint {
        output
            .and_then(|output| self.by_output.get(output))
            .copied()
            .unwrap_or(self.every)
    }

    /// The outputs either of `self` and `other` set a night light for.
    fn outputs_set<'a>(&'a self, other: &'a Lights) -> HashSet<&'a str> {
        self.by_output
            .keys()
            .chain(other.by_output.keys())
            .map(String::as_str)
            .collect()
    }

    /// The lights `by` of the way from `self` to `to`, 0 to 1, on every
    /// monitor.
    fn toward(&self, to: &Lights, by: f64) -> Lights {
        let mix = |output| {
            let (from, to) = (self.white_of(output), to.white_of(output));
            let channel = |from: f64, to: f64| from + (to - from) * by;
            WhitePoint {
                red: channel(from.red, to.red),
                green: channel(from.green, to.green),
                blue: channel(from.blue, to.blue),
            }
        };
        Lights {
            every: mix(None),
            by_output: self
                .outputs_set(to)
                .into_iter()
                .map(|output| (output.to_owned(), mix(Some(output))))
                .collect(),
        }
    }

    /// How far the gain of the channel that changes most moves from `self` to
    /// `to`, on any monitor.
    fn distance(&self, to: &Lights) -> f64 {
        let apart = |output| {
            let (from, to) = (self.white_of(output), to.white_of(output));
            [
                from.red - to.red,
                from.green - to.green,
                from.blue - to.blue,
            ]
            .into_iter()
            .fold(0.0, |most: f64, change| most.max(change.abs()))
        };
        self.outputs_set(to)
            .into_iter()
            .map(Some)
            .chain([None])
            .map(apart)
            .fold(0.0, f64::max)
    }
}

/// The night light the shell set last, and the fade toward it.
#[derive(Default)]
pub struct NightLight {
    to: Lights,
    fade: Option<Fade>,
}

struct Fade {
    from: Lights,
    start: Instant,
    length: Duration,
}

impl NightLight {
    /// Sets the night light of `output`, or of every monitor when `None`,
    /// fading from the one drawn at `now`.
    pub fn set(&mut self, output: Option<&str>, white: WhitePoint, now: Instant) {
        let from = self.at(now);
        self.to.set(output, white);
        let length = Duration::from_secs_f64(from.distance(&self.to) * SECONDS_PER_GAIN);
        self.fade = Some(Fade {
            from,
            start: now,
            length,
        });
    }

    /// The night lights to draw at `now`.
    pub fn at(&self, now: Instant) -> Lights {
        match &self.fade {
            Some(fade) if self.fading(now) => {
                let elapsed = now.saturating_duration_since(fade.start);
                fade.from
                    .toward(&self.to, elapsed.as_secs_f64() / fade.length.as_secs_f64())
            }
            _ => self.to.clone(),
        }
    }

    /// Whether the night light is still fading at `now`, so it must be drawn
    /// again on the next frame.
    pub fn fading(&self, now: Instant) -> bool {
        self.fade
            .as_ref()
            .is_some_and(|fade| now < fade.start + fade.length)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WARM: WhitePoint = WhitePoint {
        red: 1.0,
        green: 0.5,
        blue: 0.5,
    };

    /// Neutral to [`WARM`] moves green and blue by a half.
    const NEUTRAL_TO_WARM: Duration = Duration::from_millis(1250);

    fn lit(output: Option<&str>, white: WhitePoint) -> Lights {
        let mut lights = Lights::default();
        lights.set(output, white);
        lights
    }

    #[test]
    fn every_monitors_night_light_replaces_each_ones() {
        let mut lights = lit(Some("eDP-1"), WARM);

        lights.set(None, white_point(3400));

        assert_eq!(lights.white_of(Some("eDP-1")), white_point(3400));
    }

    #[test]
    fn a_new_night_light_starts_from_the_one_drawn() {
        let (mut light, now) = (NightLight::default(), Instant::now());

        light.set(None, WARM, now);

        assert_eq!(light.at(now), Lights::default());
        assert!(light.fading(now));
    }

    #[test]
    fn halfway_through_its_fade_it_is_halfway_there() {
        let (mut light, now) = (NightLight::default(), Instant::now());
        light.set(None, WARM, now);

        let drawn = light.at(now + NEUTRAL_TO_WARM / 2).white_of(None);

        assert_eq!(
            drawn,
            WhitePoint {
                red: 1.0,
                green: 0.75,
                blue: 0.75,
            }
        );
    }

    #[test]
    fn at_the_end_of_its_fade_it_is_the_night_light_set() {
        let (mut light, now) = (NightLight::default(), Instant::now());
        light.set(None, WARM, now);

        let end = now + NEUTRAL_TO_WARM;

        assert_eq!(light.at(end), lit(None, WARM));
        assert!(!light.fading(end), "no frame to draw after the fade");
    }

    #[test]
    fn a_smaller_change_fades_faster() {
        let (mut light, now) = (NightLight::default(), Instant::now());
        let a_little_warm = WhitePoint {
            red: 1.0,
            green: 0.9,
            blue: 0.95,
        };

        light.set(None, a_little_warm, now);

        assert!(!light.fading(now + Duration::from_millis(250)));
    }

    #[test]
    fn a_change_mid_fade_turns_back_from_where_it_is() {
        let (mut light, now) = (NightLight::default(), Instant::now());
        light.set(None, WARM, now);
        let halfway = now + NEUTRAL_TO_WARM / 2;
        let drawn = light.at(halfway);

        light.set(None, white_point(NEUTRAL), halfway);

        assert_eq!(light.at(halfway), drawn);
        assert!(!light.fading(halfway + NEUTRAL_TO_WARM / 2));
    }

    #[test]
    fn one_monitor_fades_while_the_others_hold() {
        let (mut light, now) = (NightLight::default(), Instant::now());

        light.set(Some("DP-1"), WARM, now);

        let drawn = light.at(now + NEUTRAL_TO_WARM / 2);
        assert_eq!(drawn.white_of(Some("DP-1")).green, 0.75);
        assert_eq!(drawn.white_of(Some("eDP-1")), white_point(NEUTRAL));
    }

    #[test]
    fn a_monitors_own_night_light_fades_into_every_monitors() {
        let (mut light, now) = (NightLight::default(), Instant::now());
        light.set(Some("DP-1"), WARM, now);
        let end = now + NEUTRAL_TO_WARM;

        light.set(None, white_point(NEUTRAL), end);

        let drawn = light.at(end + NEUTRAL_TO_WARM / 2);
        assert_eq!(drawn.white_of(Some("DP-1")).green, 0.75);
        assert_eq!(drawn.white_of(Some("eDP-1")), white_point(NEUTRAL));
    }

    #[test]
    fn the_same_night_light_again_draws_nothing_more() {
        let (mut light, now) = (NightLight::default(), Instant::now());

        light.set(None, white_point(NEUTRAL), now);

        assert!(!light.fading(now));
    }
}
