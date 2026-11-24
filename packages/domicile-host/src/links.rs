//! The pages that open links for the desktop, by scheme, across every chrome
//! connection. A page claims schemes with `SystemRequest::ClaimLinks`;
//! `domicile open` and the Email portal hand it links with
//! `SystemRequest::OpenLink` or [`Links::open`].

use std::sync::{Arc, Mutex};

use crate::fanout::{Hear, Listener};

/// A link and the desktop file id of the application that asked, if known.
pub(crate) type Link = (String, Option<String>);

/// Every page claiming schemes. Clones share them, so every connection's
/// [`crate::system::System`] holds a clone of one.
#[derive(Clone, Default)]
pub struct Links(Arc<Mutex<Claims>>);

#[derive(Default)]
struct Claims {
    next: u64,
    /// Oldest first, so the last that claims a scheme is found first from the
    /// end.
    pages: Vec<Page>,
}

struct Page {
    key: u64,
    /// Lowercase.
    schemes: Vec<String>,
    hear: Hear<Link>,
}

impl Links {
    /// Calls `hear` with each link of `schemes` handed over until the
    /// [`Listener`] drops, unless a page claims the scheme later.
    pub(crate) fn listen(&self, schemes: Vec<String>, hear: Hear<Link>) -> Listener {
        let mut claims = self.0.lock().unwrap();
        let key = claims.next;
        claims.next += 1;
        claims.pages.push(Page {
            key,
            schemes: schemes
                .iter()
                .map(|scheme| scheme.to_ascii_lowercase())
                .collect(),
            hear,
        });
        let links = self.clone();
        Listener::stopping(move || {
            links.0.lock().unwrap().pages.retain(|page| page.key != key);
        })
    }

    /// Whether a page claims `url`'s scheme.
    pub fn claims(&self, url: &str) -> bool {
        self.claimant(url).is_some()
    }

    /// Hands `url`, asked for by `app_id`, to the page that claimed its
    /// scheme last. Returns false when none claims it.
    pub fn open(&self, url: &str, app_id: Option<&str>) -> bool {
        match self.claimant(url) {
            Some(hear) => {
                // Outside the lock, since hearing takes its connection's lock,
                // which a page starting to claim holds while it takes this one.
                hear(&(url.to_string(), app_id.map(str::to_string)));
                true
            }
            None => false,
        }
    }

    fn claimant(&self, url: &str) -> Option<Hear<Link>> {
        let scheme = url.split_once(':')?.0.to_ascii_lowercase();
        self.0
            .lock()
            .unwrap()
            .pages
            .iter()
            .rev()
            .find(|page| page.schemes.contains(&scheme))
            .map(|page| Arc::clone(&page.hear))
    }
}
