//! Frame callbacks held for windows the page does not draw.
//!
//! A window on another workspace or behind a tab has no box in the page, and
//! the page reports it with an empty one (`ChromeMessage::SetAppBounds`). Its
//! client would otherwise draw at full rate for nobody, so its
//! `wl_surface.frame` callbacks wait here until the page shows it again. Its
//! popups' and subsurfaces' callbacks wait under the window's id.
//!
//! Held is not stopped. A client that blocks in `eglSwapBuffers` until its
//! callback arrives reads nothing else meanwhile: not a close, and not its
//! other windows' events. So the compositor sends what is held once every
//! [`TRICKLE`] ([`HeldFrames::trickle`]), and before closing a hidden window
//! ([`HeldFrames::take`]). The trickle runs only while a window is hidden
//! ([`HeldFrames::start_trickling`]), so a desk with none never wakes for it.
//!
//! A hidden window a cast shows holds nothing ([`HeldFrames::cast`]), so the
//! cast keeps its frame rate.

use std::time::Duration;

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

/// How often a hidden window's held callbacks are sent anyway.
pub const TRICKLE: Duration = Duration::from_secs(1);

/// The most callbacks held for one window. A client that commits without
/// waiting for its callbacks gets the oldest back at once.
pub const HELD_AT_MOST: usize = 16;

/// What a change in the windows cast does to hidden ones.
#[derive(Debug)]
pub struct Recast<C> {
    /// Hidden windows a cast started showing, with the callbacks they held.
    /// They draw again and are no longer suspended.
    pub released: Vec<(String, Vec<C>)>,
    /// Hidden windows no cast shows any more. They are suspended again.
    pub held: Vec<String>,
}

/// The callbacks held for each hidden window, by app id.
#[derive(Debug)]
pub struct HeldFrames<C> {
    hidden: HashMap<String, Vec<C>>,
    /// The windows a cast shows. Hidden, they hold nothing.
    cast: HashSet<String>,
    /// Whether the trickle timer is armed.
    trickling: bool,
}

impl<C> HeldFrames<C> {
    pub fn new() -> Self {
        Self {
            hidden: HashMap::new(),
            cast: HashSet::new(),
            trickling: false,
        }
    }

    /// The page stopped drawing `window`. True when it starts holding its
    /// callbacks: it was shown, and no cast shows it.
    pub fn hide(&mut self, window: &str) -> bool {
        match self.hidden.entry(window.to_string()) {
            Entry::Occupied(_) => false,
            Entry::Vacant(vacant) => {
                vacant.insert(Vec::new());
                !self.cast.contains(window)
            }
        }
    }

    /// The page draws `window` again: the callbacks held for it, or `None`
    /// when it held none: it was not hidden, or a cast shows it.
    pub fn show(&mut self, window: &str) -> Option<Vec<C>> {
        self.hidden
            .remove(window)
            .filter(|_| !self.cast.contains(window))
    }

    pub fn is_hidden(&self, window: &str) -> bool {
        self.hidden.contains_key(window)
    }

    /// The windows in `boxes` the page draws, with their boxes.
    ///
    /// A hidden window keeps its last box, for its displays and scale, but is
    /// not there: a hidden tab's box is the shown tab's. Input and casts look
    /// here.
    pub fn shown<'a, B>(
        &'a self,
        boxes: &'a HashMap<String, B>,
    ) -> impl Iterator<Item = (&'a String, &'a B)> {
        boxes.iter().filter(|(window, _)| !self.is_hidden(window))
    }

    /// `window`'s box in `boxes`, unless the page hides it. See
    /// [`shown`](Self::shown).
    pub fn shown_box<'a, B>(&self, boxes: &'a HashMap<String, B>, window: &str) -> Option<&'a B> {
        if self.is_hidden(window) {
            None
        } else {
            boxes.get(window)
        }
    }

    /// The page draws every window again, as after a new page's hello: each
    /// hidden window and its held callbacks.
    pub fn show_all(&mut self) -> Vec<(String, Vec<C>)> {
        self.hidden.drain().collect()
    }

    /// The callbacks a commit by `window`, or by a popup or subsurface of it, may
    /// send now. While it is hidden only those over [`HELD_AT_MOST`], oldest
    /// first: the rest wait for [`show`](Self::show).
    pub fn pass(&mut self, window: &str, callbacks: Vec<C>) -> Vec<C> {
        match self.hidden.get_mut(window) {
            Some(held) if !self.cast.contains(window) => {
                held.extend(callbacks);
                let over = held.len().saturating_sub(HELD_AT_MOST);
                held.drain(..over).collect()
            }
            _ => callbacks,
        }
    }

    /// Whether to arm the trickle timer: a window is hidden and none is armed.
    pub fn start_trickling(&mut self) -> bool {
        let start = !self.trickling && !self.hidden.is_empty();
        self.trickling |= start;
        start
    }

    /// Every callback held, to send now. The windows stay hidden. `None` once
    /// no window is hidden: the timer stops, until
    /// [`start_trickling`](Self::start_trickling) arms it again.
    pub fn trickle(&mut self) -> Option<Vec<C>> {
        self.trickling = !self.hidden.is_empty();
        self.trickling
            .then(|| self.hidden.values_mut().flat_map(std::mem::take).collect())
    }

    /// The callbacks held for `window`, to send before it is closed. It stays
    /// hidden.
    pub fn take(&mut self, window: &str) -> Vec<C> {
        self.hidden
            .get_mut(window)
            .map(std::mem::take)
            .unwrap_or_default()
    }

    /// The windows a cast shows: hidden, they draw on. What changes for the
    /// hidden ones among them, and those no cast shows any more.
    pub fn cast(&mut self, windows: HashSet<String>) -> Recast<C> {
        let released = windows
            .difference(&self.cast)
            .filter_map(|window| {
                let held = self.hidden.get_mut(window)?;
                Some((window.clone(), std::mem::take(held)))
            })
            .collect();
        let held = self
            .cast
            .difference(&windows)
            .filter(|window| self.hidden.contains_key(*window))
            .cloned()
            .collect();
        self.cast = windows;
        Recast { released, held }
    }

    /// `window` closed. Its held callbacks go with its client's surface.
    pub fn forget(&mut self, window: &str) {
        self.hidden.remove(window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_shown_all_along_sends_its_callbacks_at_once() {
        let mut held = HeldFrames::new();
        assert_eq!(held.pass("term", vec![1, 2]), vec![1, 2]);
    }

    #[test]
    fn a_hidden_window_holds_its_callbacks_until_it_is_shown() {
        let mut held = HeldFrames::new();
        assert!(held.hide("term"));
        assert_eq!(held.pass("term", vec![1]), Vec::<u32>::new());
        assert_eq!(held.pass("term", vec![2]), Vec::<u32>::new());
        // Other windows still draw.
        assert_eq!(held.pass("editor", vec![3]), vec![3]);
        assert_eq!(held.show("term"), Some(vec![1, 2]));
        assert_eq!(held.pass("term", vec![4]), vec![4]);
    }

    #[test]
    fn showing_a_window_that_was_not_hidden_releases_nothing() {
        let mut held = HeldFrames::<u32>::new();
        assert_eq!(held.show("term"), None);
    }

    #[test]
    fn hiding_a_hidden_window_again_keeps_what_it_held() {
        let mut held = HeldFrames::new();
        assert!(held.hide("term"));
        held.pass("term", vec![1]);
        assert!(!held.hide("term"));
        assert_eq!(held.show("term"), Some(vec![1]));
    }

    #[test]
    fn a_hidden_window_keeps_only_the_newest_callbacks() {
        let mut held = HeldFrames::new();
        held.hide("term");
        let flood: Vec<u32> = (0..HELD_AT_MOST as u32 + 3).collect();
        // A client that commits without waiting gets the oldest back now.
        assert_eq!(held.pass("term", flood), vec![0, 1, 2]);
        assert_eq!(
            held.show("term"),
            Some((3..HELD_AT_MOST as u32 + 3).collect())
        );
    }

    #[test]
    fn a_trickle_sends_what_hidden_windows_hold_and_keeps_them_hidden() {
        let mut held = HeldFrames::new();
        held.hide("term");
        held.hide("editor");
        held.pass("term", vec![1]);
        held.pass("editor", vec![2]);
        let mut trickled = held.trickle().expect("windows are hidden");
        trickled.sort();
        assert_eq!(trickled, vec![1, 2]);
        assert!(held.is_hidden("term"));
        assert_eq!(held.pass("term", vec![3]), Vec::<u32>::new());
    }

    #[test]
    fn the_trickle_starts_when_a_window_is_first_hidden() {
        let mut held = HeldFrames::<u32>::new();
        assert!(!held.start_trickling());
        held.hide("term");
        assert!(held.start_trickling());
        // One timer, however many windows hide.
        held.hide("editor");
        assert!(!held.start_trickling());
    }

    #[test]
    fn the_trickle_stops_once_no_window_is_hidden_and_starts_again() {
        let mut held = HeldFrames::<u32>::new();
        held.hide("term");
        held.start_trickling();
        held.show("term");
        assert_eq!(held.trickle(), None);
        assert!(!held.start_trickling());
        held.hide("term");
        assert!(held.start_trickling());
        assert_eq!(held.trickle(), Some(vec![]));
    }

    #[test]
    fn a_window_about_to_close_gets_its_callbacks_and_stays_hidden() {
        let mut held = HeldFrames::new();
        held.hide("term");
        held.pass("term", vec![1]);
        assert_eq!(held.take("term"), vec![1]);
        assert!(held.is_hidden("term"));
        assert_eq!(held.take("editor"), Vec::<u32>::new());
    }

    #[test]
    fn showing_everything_names_each_hidden_window_once() {
        let mut held = HeldFrames::new();
        held.hide("term");
        held.pass("term", vec![1]);
        held.hide("editor");
        let mut shown = held.show_all();
        shown.sort();
        assert_eq!(
            shown,
            vec![
                ("editor".to_string(), vec![]),
                ("term".to_string(), vec![1])
            ]
        );
        assert!(!held.is_hidden("term"));
        assert!(held.show_all().is_empty());
    }

    /// A hidden tab keeps the box of the tab over it, so input and casts must
    /// not find it there.
    #[test]
    fn a_hidden_window_has_no_box_on_screen() {
        let mut held = HeldFrames::<u32>::new();
        let boxes = HashMap::from([("term".to_string(), 1), ("editor".to_string(), 1)]);
        held.hide("editor");
        assert_eq!(
            held.shown(&boxes).collect::<Vec<_>>(),
            vec![(&"term".to_string(), &1)]
        );
        assert_eq!(held.shown_box(&boxes, "editor"), None);
        assert_eq!(held.shown_box(&boxes, "term"), Some(&1));
        held.show("editor");
        assert_eq!(held.shown_box(&boxes, "editor"), Some(&1));
    }

    #[test]
    fn a_closed_window_is_no_longer_hidden() {
        let mut held = HeldFrames::new();
        held.hide("term");
        held.pass("term", vec![1]);
        held.forget("term");
        assert!(!held.is_hidden("term"));
        assert_eq!(held.show("term"), None);
    }

    #[test]
    fn a_hidden_window_draws_while_a_cast_shows_it() {
        let mut held = HeldFrames::new();
        held.hide("term");
        held.pass("term", vec![1]);

        let recast = held.cast(HashSet::from(["term".to_string()]));
        assert_eq!(recast.released, vec![("term".to_string(), vec![1])]);
        assert!(recast.held.is_empty());
        assert_eq!(held.pass("term", vec![2]), vec![2]);
        // Input still finds no box for it.
        assert!(held.is_hidden("term"));

        let recast = held.cast(HashSet::new());
        assert!(recast.released.is_empty());
        assert_eq!(recast.held, vec!["term".to_string()]);
        assert_eq!(held.pass("term", vec![3]), Vec::<u32>::new());
    }

    #[test]
    fn a_cast_window_hidden_and_shown_holds_nothing() {
        let mut held = HeldFrames::new();
        held.cast(HashSet::from(["term".to_string()]));

        assert!(!held.hide("term"), "a cast window is not suspended");
        assert!(held.is_hidden("term"));
        assert_eq!(held.pass("term", vec![1]), vec![1]);
        assert_eq!(held.show("term"), None);
        assert!(!held.is_hidden("term"));
        // A cast that ends on a shown window holds nothing.
        assert!(held.cast(HashSet::new()).held.is_empty());
    }
}
