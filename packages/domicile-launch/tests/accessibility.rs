//! Tests for reading native windows' accessibility trees and acting on them.

use std::collections::HashMap;

use domicile_launch::accessibility::{
    act_on, outline, state, window, Accessible, Act, Described, Element, MOST,
};

/// An accessibility bus held in memory.
#[derive(Default)]
struct Bus {
    applications: Vec<Element>,
    processes: HashMap<String, u32>,
    children: HashMap<Element, Vec<Element>>,
    described: HashMap<Element, Described>,
    acted: Vec<(Element, Act)>,
}

impl Accessible for Bus {
    fn applications(&mut self) -> Result<Vec<Element>, String> {
        Ok(self.applications.clone())
    }
    fn process(&mut self, bus: &str) -> Result<u32, String> {
        self.processes
            .get(bus)
            .copied()
            .ok_or_else(|| format!("no {bus}"))
    }
    fn children(&mut self, element: &Element) -> Result<Vec<Element>, String> {
        Ok(self.children.get(element).cloned().unwrap_or_default())
    }
    fn describe(&mut self, element: &Element) -> Result<Described, String> {
        self.described
            .get(element)
            .cloned()
            .ok_or_else(|| format!("no {}", element.reference()))
    }
    fn act(&mut self, element: &Element, act: &Act) -> Result<(), String> {
        self.acted.push((element.clone(), act.clone()));
        Ok(())
    }
}

fn at(bus: &str, path: &str) -> Element {
    Element {
        bus: bus.to_string(),
        path: path.to_string(),
    }
}

/// State words with each of `states` set.
fn states(states: &[u32]) -> Vec<u32> {
    let mut words = vec![0, 0];
    for state in states {
        words[(state / 32) as usize] |= 1 << (state % 32);
    }
    words
}

impl Bus {
    /// Adds `element` under `parent`, visible with `more` states.
    fn add(
        &mut self,
        parent: Option<&Element>,
        element: &Element,
        role: &str,
        name: &str,
        more: &[u32],
    ) {
        if let Some(parent) = parent {
            self.children
                .entry(parent.clone())
                .or_default()
                .push(element.clone());
        }
        self.described.insert(
            element.clone(),
            Described {
                role: role.to_string(),
                name: name.to_string(),
                states: states(&[&[state::VISIBLE], more].concat()),
                text: None,
            },
        );
    }
}

/// A text editor, process 4242 on bus `:1.7`, with two windows, and another
/// app on `:1.9`.
fn editor() -> Bus {
    let mut bus = Bus::default();
    let app = at(":1.7", "/org/a11y/atspi/accessible/root");
    let other = at(":1.9", "/org/a11y/atspi/accessible/root");
    bus.applications = vec![other.clone(), app.clone()];
    bus.processes.insert(":1.7".to_string(), 4242);
    bus.processes.insert(":1.9".to_string(), 7);
    bus.add(None, &app, "application", "gedit", &[]);
    bus.add(None, &other, "application", "clock", &[]);
    bus.add(Some(&other), &at(":1.9", "/c/1"), "frame", "notes.txt", &[]);
    let notes = at(":1.7", "/w/1");
    bus.add(Some(&app), &notes, "frame", "notes.txt", &[]);
    bus.add(Some(&app), &at(":1.7", "/w/2"), "frame", "todo.txt", &[]);
    let filler = at(":1.7", "/w/1/filler");
    bus.add(Some(&notes), &filler, "filler", "", &[]);
    let save = at(":1.7", "/w/1/save");
    bus.add(Some(&filler), &save, "push button", "Save", &[]);
    bus.add(
        Some(&save),
        &at(":1.7", "/w/1/save/label"),
        "label",
        "Save",
        &[],
    );
    let text = at(":1.7", "/w/1/text");
    bus.add(Some(&filler), &text, "text", "", &[state::FOCUSED]);
    bus.described.get_mut(&text).unwrap().text = Some("hello".to_string());
    let password = at(":1.7", "/w/1/password");
    bus.add(Some(&filler), &password, "password text", "Password", &[]);
    bus.described.get_mut(&password).unwrap().text = Some("hunter2".to_string());
    let hidden = at(":1.7", "/w/1/hidden");
    bus.add(Some(&filler), &hidden, "menu", "File", &[]);
    bus.described.get_mut(&hidden).unwrap().states = states(&[]);
    bus.add(
        Some(&hidden),
        &at(":1.7", "/w/1/hidden/open"),
        "menu item",
        "Open",
        &[],
    );
    bus
}

#[test]
fn a_window_is_its_processs_accessible_window_with_its_title() {
    let mut bus = editor();
    assert_eq!(window(&mut bus, 4242, "todo.txt"), Ok(at(":1.7", "/w/2")));
    assert_eq!(window(&mut bus, 7, "anything"), Ok(at(":1.9", "/c/1")));
}

#[test]
fn a_window_that_is_not_one_accessible_window_says_which_there_are() {
    let mut bus = editor();
    let why = window(&mut bus, 4242, "draft.txt").unwrap_err();
    assert!(why.contains("\"notes.txt\", \"todo.txt\""), "{why}");
    let why = window(&mut bus, 99, "draft.txt").unwrap_err();
    assert!(why.contains("accessibility"), "{why}");
}

#[test]
fn an_outline_lists_what_shows_with_refs_and_hides_passwords() {
    let mut bus = editor();
    assert_eq!(
        outline(&mut bus, &at(":1.7", "/w/1")),
        Ok("\
- frame \"notes.txt\" [ref=:1.7/w/1]
  - push button \"Save\" [ref=:1.7/w/1/save]
  - text [ref=:1.7/w/1/text] text=\"hello\" focused
  - password text \"Password\" [ref=:1.7/w/1/password]
"
        .to_string())
    );
}

#[test]
fn an_outline_of_a_huge_tree_is_cut_and_says_so() {
    let mut bus = Bus::default();
    let root = at(":1.7", "/root");
    bus.add(None, &root, "frame", "big", &[]);
    for index in 0..MOST + 10 {
        bus.add(
            Some(&root),
            &at(":1.7", &format!("/{index}")),
            "push button",
            "b",
            &[],
        );
    }
    let listed = outline(&mut bus, &root).unwrap();
    assert_eq!(listed.lines().count(), MOST + 1);
    assert!(listed.ends_with(&format!("… cut at {MOST} elements\n")));
}

#[test]
fn a_ref_names_its_element() {
    let element = at(":1.7", "/org/a11y/atspi/accessible/7");
    assert_eq!(Element::named(&element.reference()), Some(element));
    assert_eq!(Element::named("no-path"), None);
    assert_eq!(Element::named("/only/a/path"), None);
}

#[test]
fn an_act_goes_only_to_an_element_of_the_windows_process() {
    let mut bus = editor();
    let save = at(":1.7", "/w/1/save");
    assert_eq!(act_on(&mut bus, 4242, &save, &Act::Click), Ok(()));
    assert_eq!(bus.acted, [(save.clone(), Act::Click)]);

    let why = act_on(&mut bus, 7, &save, &Act::Focus).unwrap_err();
    assert!(why.contains("4242"), "{why}");
    assert_eq!(bus.acted.len(), 1);
}
