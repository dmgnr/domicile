//! `ext-foreign-toplevel-list-v1`: the windows, for capture tools to pick
//! one as a source (see [`crate::screencopy`]). Hidden from sandboxed
//! clients, as the capture globals are.
//!
//! The native windows are listed as their clients map them, and the browser's
//! windows as the engine reports them ([`crate::engine::Event::BrowserWindows`]).

use std::collections::{BTreeMap, HashMap};

use smithay::delegate_foreign_toplevel_list;
use smithay::reexports::wayland_server::DisplayHandle;
use smithay::wayland::foreign_toplevel_list::{
    ForeignToplevelHandle, ForeignToplevelListHandler, ForeignToplevelListState,
};

use crate::casting::Source;
use crate::engine::BrowserWindow;
use crate::DomicileCompositor;

/// Each window's handle, by its host app id, and each browser window's, by
/// its id.
pub struct ForeignToplevels {
    state: ForeignToplevelListState,
    handles: HashMap<String, ForeignToplevelHandle>,
    browser_handles: HashMap<String, ForeignToplevelHandle>,
    browser_windows: BrowserListing,
}

/// The window a handle lists, in its user data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listed {
    /// A native window, by its host app id.
    Window(String),
    /// A browser window, by the engine's id.
    BrowserWindow(String),
}

impl Listed {
    /// What capturing the listed window shows: a native window as the desktop
    /// draws it, or a browser window's page alone.
    pub fn source(&self) -> Source {
        match self {
            Self::Window(app_id) => Source::Window(app_id.clone()),
            Self::BrowserWindow(id) => Source::BrowserWindow(id.clone()),
        }
    }
}

/// What changed in the browser windows since the engine last reported them.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Change {
    Opened {
        id: String,
        title: String,
        app_id: String,
    },
    Retitled {
        id: String,
        title: String,
    },
    Closed {
        id: String,
    },
}

/// The browser windows as last listed, by id, with their titles.
#[derive(Default)]
struct BrowserListing {
    titles: HashMap<String, String>,
}

impl BrowserListing {
    /// Takes the engine's whole list, and says what changed: the windows gone
    /// first, then each new or retitled one in the engine's order.
    fn listed(&mut self, windows: &[BrowserWindow]) -> Vec<Change> {
        let mut gone: Vec<String> = self
            .titles
            .keys()
            .filter(|id| !windows.iter().any(|window| &window.id == *id))
            .cloned()
            .collect();
        gone.sort();
        let mut changes = Vec::new();
        for id in gone {
            self.titles.remove(&id);
            changes.push(Change::Closed { id });
        }
        for window in windows {
            match self.titles.get_mut(&window.id) {
                None => {
                    self.titles.insert(window.id.clone(), window.title.clone());
                    changes.push(Change::Opened {
                        id: window.id.clone(),
                        title: window.title.clone(),
                        app_id: window.app_id.clone(),
                    });
                }
                Some(title) if *title != window.title => {
                    title.clone_from(&window.title);
                    changes.push(Change::Retitled {
                        id: window.id.clone(),
                        title: window.title.clone(),
                    });
                }
                Some(_) => {}
            }
        }
        changes
    }
}

impl ForeignToplevels {
    /// Advertises the list.
    pub fn new(display: &DisplayHandle) -> Self {
        Self {
            state: ForeignToplevelListState::new_with_filter::<DomicileCompositor>(
                display,
                crate::clients::sees_privileged_globals,
            ),
            handles: HashMap::new(),
            browser_handles: HashMap::new(),
            browser_windows: BrowserListing::default(),
        }
    }

    /// A handle for a window with no title or desktop id yet. [`Self::opened`]
    /// names the window, once the host has given it an id; the handle's
    /// identifier is what the host tells the chromes.
    pub fn listing(&mut self) -> ForeignToplevelHandle {
        self.state.new_toplevel::<DomicileCompositor>("", "")
    }

    /// Window `app_id` is listed as `handle`, from [`Self::listing`].
    pub fn opened(&mut self, app_id: &str, handle: ForeignToplevelHandle) {
        handle
            .user_data()
            .insert_if_missing_threadsafe(|| Listed::Window(app_id.to_string()));
        self.handles.insert(app_id.to_string(), handle);
    }

    /// Window `app_id` took `title`.
    pub fn titled(&self, app_id: &str, title: &str) {
        if let Some(handle) = self.handles.get(app_id) {
            handle.send_title(title);
            handle.send_done();
        }
    }

    /// Window `app_id` took `desktop_id`, its client's app id.
    pub fn named(&self, app_id: &str, desktop_id: &str) {
        if let Some(handle) = self.handles.get(app_id) {
            handle.send_app_id(desktop_id);
            handle.send_done();
        }
    }

    /// Window `app_id` closed.
    pub fn closed(&mut self, app_id: &str) {
        if let Some(handle) = self.handles.remove(app_id) {
            self.state.remove_toplevel(&handle);
        }
    }

    /// The browser's windows are `windows`, in the order they opened. Lists
    /// the new ones, retitles the rest, and takes away the ones gone. An app
    /// window's handle carries the app's id; any other has none, since every
    /// browser window is the same browser's.
    ///
    /// Returns each listed window's identifier, by its id.
    pub fn browser_windows(&mut self, windows: &[BrowserWindow]) -> BTreeMap<String, String> {
        for change in self.browser_windows.listed(windows) {
            match change {
                Change::Opened { id, title, app_id } => {
                    let handle = self
                        .state
                        .new_toplevel::<DomicileCompositor>(&title, &app_id);
                    handle
                        .user_data()
                        .insert_if_missing_threadsafe(|| Listed::BrowserWindow(id.clone()));
                    self.browser_handles.insert(id, handle);
                }
                Change::Retitled { id, title } => {
                    if let Some(handle) = self.browser_handles.get(&id) {
                        handle.send_title(&title);
                        handle.send_done();
                    }
                }
                Change::Closed { id } => {
                    if let Some(handle) = self.browser_handles.remove(&id) {
                        self.state.remove_toplevel(&handle);
                    }
                }
            }
        }
        self.browser_handles
            .iter()
            .map(|(id, handle)| (id.clone(), handle.identifier()))
            .collect()
    }
}

impl ForeignToplevelListHandler for DomicileCompositor {
    fn foreign_toplevel_list_state(&mut self) -> &mut ForeignToplevelListState {
        &mut self.foreign_toplevels.state
    }
}

delegate_foreign_toplevel_list!(DomicileCompositor);

#[cfg(test)]
mod tests {
    use smithay::reexports::wayland_server::Display;

    use super::*;

    fn window(id: &str, title: &str) -> BrowserWindow {
        BrowserWindow {
            id: id.into(),
            title: title.into(),
            app_id: String::new(),
            url: String::new(),
            private: false,
            views: Vec::new(),
        }
    }

    #[test]
    fn a_browser_window_is_listed_with_its_title_and_taken_away_when_it_closes() {
        let mut listing = BrowserListing::default();
        let mail = BrowserWindow {
            app_id: "mail".into(),
            ..window("3", "Inbox")
        };

        assert_eq!(
            listing.listed(std::slice::from_ref(&mail)),
            vec![Change::Opened {
                id: "3".into(),
                title: "Inbox".into(),
                app_id: "mail".into(),
            }]
        );
        assert_eq!(
            listing.listed(&[window("3", "Inbox (2)")]),
            vec![Change::Retitled {
                id: "3".into(),
                title: "Inbox (2)".into(),
            }]
        );
        assert_eq!(listing.listed(&[]), vec![Change::Closed { id: "3".into() }]);
    }

    #[test]
    fn each_browser_window_keeps_its_identifier_while_it_is_listed() {
        // A shell hands a capture tool the identifier, so a retitle must not
        // change it.
        let display = Display::<DomicileCompositor>::new().expect("a display");
        let mut toplevels = ForeignToplevels::new(&display.handle());

        let first = toplevels.browser_windows(&[window("3", "Inbox")]);
        let again = toplevels.browser_windows(&[window("3", "Inbox (2)"), window("5", "News")]);

        assert_eq!(first.keys().collect::<Vec<_>>(), ["3"]);
        assert_eq!(again["3"], first["3"]);
        assert_ne!(again["5"], again["3"]);
        assert_eq!(toplevels.browser_windows(&[]), BTreeMap::new());
    }

    #[test]
    fn a_list_that_changed_nothing_changes_nothing() {
        let mut listing = BrowserListing::default();
        listing.listed(&[window("3", "Inbox"), window("5", "News")]);

        assert_eq!(
            listing.listed(&[window("3", "Inbox"), window("5", "News")]),
            Vec::new()
        );
    }

    #[test]
    fn the_closed_go_before_the_opened() {
        let mut listing = BrowserListing::default();
        listing.listed(&[window("3", "Inbox")]);

        assert_eq!(
            listing.listed(&[window("5", "News")]),
            vec![
                Change::Closed { id: "3".into() },
                Change::Opened {
                    id: "5".into(),
                    title: "News".into(),
                    app_id: String::new(),
                },
            ]
        );
    }

    #[test]
    fn a_browser_window_handle_captures_the_page_alone() {
        assert_eq!(
            Listed::BrowserWindow("3".into()).source(),
            Source::BrowserWindow("3".into())
        );
        assert_eq!(
            Listed::Window("app-1".into()).source(),
            Source::Window("app-1".into())
        );
    }
}
