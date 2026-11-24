//! Whether the screens are asleep because somebody asked, as
//! `domicile sleep-displays` does. See `docs/IDLE.md#sleeping-on-demand`.

use std::time::{Duration, Instant};

use domicile_config::{Desk, Transform};

use crate::engine::{Connector, Display};

/// How long input after sleeping is ignored.
///
/// Whoever asked is still letting go: of the chord a keybinding ran it from,
/// or of a terminal's Enter. That release must not light the screens again.
pub const GRACE: Duration = Duration::from_secs(1);

/// Whether the screens sleep, and since when, and which monitors sleep by
/// name.
#[derive(Debug, Default)]
pub struct DisplaySleep {
    since: Option<Instant>,
    /// `wl_output` names. These sleep through input, so one monitor can stay
    /// off while the others are in use.
    named: Vec<String>,
}

impl DisplaySleep {
    /// Whether the screens are asleep.
    pub fn asleep(&self) -> bool {
        self.since.is_some()
    }

    /// Put the screens to sleep at `now`. Returns whether they were awake.
    /// Asking again restarts the [`GRACE`].
    pub fn sleep(&mut self, now: Instant) -> bool {
        self.since.replace(now).is_none()
    }

    /// Wake every screen, those slept by name too. Returns whether any slept.
    pub fn wake(&mut self) -> bool {
        let named = !self.named.is_empty();
        self.named.clear();
        self.since.take().is_some() || named
    }

    /// The monitors slept by name.
    pub fn sleeping(&self) -> &[String] {
        &self.named
    }

    /// Put the monitor named `name` to sleep until it is woken by name or
    /// with every other. Returns whether it was awake.
    pub fn sleep_one(&mut self, name: &str) -> bool {
        let awake = !self.named.iter().any(|named| named == name);
        if awake {
            self.named.push(name.to_owned());
        }
        awake
    }

    /// Wake the monitor named `name`. Returns whether it slept by name.
    pub fn wake_one(&mut self, name: &str) -> bool {
        let before = self.named.len();
        self.named.retain(|named| named != name);
        self.named.len() != before
    }

    /// Input arrived at `now`. Returns whether it woke the screens: it does
    /// once the [`GRACE`] is over. Monitors slept by name stay asleep.
    pub fn stirred(&mut self, now: Instant) -> bool {
        match self.since {
            Some(since) if now.duration_since(since) >= GRACE => self.since.take().is_some(),
            Some(_) | None => false,
        }
    }
}

/// The connector list that turns the displays `asleep` off and keeps the
/// rest as they are.
///
/// - Each sleeping display keeps its `desk`, so the engine keeps its place on
///   the desk page and its windows stay where they were.
/// - With a profile, that is `scanout` with those connectors dark.
/// - With none (`scanout` empty), it is the engine's own row, unscaled, as
///   the empty list would light it. The list names every display, since the
///   engine turns off any connector a non-empty list leaves out.
pub fn asleep_in(displays: &[Display], scanout: &[Connector], asleep: &[i64]) -> Vec<Connector> {
    let laid_out: Vec<Connector> = if scanout.is_empty() {
        displays
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
            .collect()
    } else {
        scanout.to_vec()
    };
    laid_out
        .into_iter()
        .map(|connector| Connector {
            enabled: connector.enabled && !asleep.contains(&connector.id),
            ..connector
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use domicile_config::{Desk, Transform};

    use super::{asleep_in, DisplaySleep, GRACE};
    use crate::engine::{AdaptiveSync, Connector, Display};

    #[test]
    fn a_desktop_starts_awake() {
        assert!(!DisplaySleep::default().asleep());
    }

    #[test]
    fn sleeping_turns_the_screens_off_once() {
        let mut sleep = DisplaySleep::default();
        let now = Instant::now();
        assert!(sleep.sleep(now));
        assert!(sleep.asleep());
        assert!(!sleep.sleep(now + GRACE * 2));
    }

    #[test]
    fn input_wakes_the_screens() {
        let mut sleep = DisplaySleep::default();
        let now = Instant::now();
        sleep.sleep(now);
        assert!(sleep.stirred(now + GRACE));
        assert!(!sleep.asleep());
    }

    #[test]
    fn input_right_after_sleeping_does_not_wake_the_screens() {
        // Letting go of the key that asked, or of a terminal's Enter.
        let mut sleep = DisplaySleep::default();
        let now = Instant::now();
        sleep.sleep(now);
        assert!(!sleep.stirred(now + GRACE - Duration::from_millis(1)));
        assert!(sleep.asleep());
    }

    #[test]
    fn asking_again_restarts_the_grace() {
        let mut sleep = DisplaySleep::default();
        let now = Instant::now();
        sleep.sleep(now);
        sleep.sleep(now + GRACE);
        assert!(!sleep.stirred(now + GRACE * 3 / 2));
    }

    #[test]
    fn input_while_awake_changes_nothing() {
        assert!(!DisplaySleep::default().stirred(Instant::now()));
    }

    #[test]
    fn a_display_slept_by_name_sleeps_through_input() {
        // An external monitor left off while the laptop is in use.
        let mut sleep = DisplaySleep::default();
        let now = Instant::now();
        assert!(sleep.sleep_one("DP-1"));
        assert!(!sleep.sleep_one("DP-1"));
        assert!(!sleep.stirred(now + GRACE));
        assert!(!sleep.asleep());
        assert_eq!(sleep.sleeping(), ["DP-1"]);
    }

    #[test]
    fn waking_a_display_by_name_wakes_only_it() {
        let mut sleep = DisplaySleep::default();
        sleep.sleep_one("DP-1");
        sleep.sleep_one("eDP-1");
        assert!(sleep.wake_one("DP-1"));
        assert!(!sleep.wake_one("DP-1"));
        assert_eq!(sleep.sleeping(), ["eDP-1"]);
    }

    #[test]
    fn waking_every_display_wakes_those_slept_by_name() {
        let mut sleep = DisplaySleep::default();
        sleep.sleep_one("DP-1");
        assert!(sleep.wake());
        assert!(sleep.sleeping().is_empty());
    }

    #[test]
    fn a_sleeping_display_keeps_its_place_in_a_profile() {
        let laptop = lit(1, (0, 0));
        let external = lit(2, (1920, 0));
        assert_eq!(
            asleep_in(&[], &[laptop, external], &[2]),
            vec![
                laptop,
                Connector {
                    enabled: false,
                    ..external
                }
            ]
        );
    }

    #[test]
    fn a_sleeping_display_keeps_the_place_the_hardware_gave_it() {
        // With no profile the engine lays the monitors out in a row, unscaled.
        // Naming one means naming all of them, or the rest go dark.
        assert_eq!(
            asleep_in(&[monitor(1, (0, 0)), monitor(2, (1920, 0))], &[], &[2]),
            vec![
                lit(1, (0, 0)),
                Connector {
                    enabled: false,
                    ..lit(2, (1920, 0))
                }
            ]
        );
    }

    fn lit(id: i64, position: (i32, i32)) -> Connector {
        Connector {
            id,
            enabled: true,
            origin: position,
            transform: Transform::Normal,
            scale: 1.0,
            desk: Some(Desk {
                position,
                size: (1920, 1080),
            }),
            mode: None,
            refresh_mhz: None,
            adaptive_sync: false,
            hdr: false,
            sdr_white: domicile_config::DEFAULT_SDR_WHITE,
        }
    }

    fn monitor(id: i64, position: (i32, i32)) -> Display {
        Display {
            id,
            description: String::new(),
            connector: String::new(),
            position,
            size: (1920, 1080),
            physical_mm: (600, 340),
            refresh_mhz: 60_000,
            modes: Vec::new(),
            adaptive_sync: AdaptiveSync::Unsupported,
            hdr: Default::default(),
        }
    }

    #[test]
    fn waking_lights_the_screens_at_once() {
        let mut sleep = DisplaySleep::default();
        let now = Instant::now();
        sleep.sleep(now);
        assert!(sleep.wake());
        assert!(!sleep.asleep());
        assert!(!sleep.wake());
    }
}
