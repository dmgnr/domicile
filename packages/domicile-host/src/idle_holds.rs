//! What holds the desktop awake, and the pages listening for it across every
//! chrome connection. The compositor lists the holders; a page listens with
//! `SystemRequest::IdleHolds`. See `docs/IDLE.md`.

use std::sync::{Arc, Mutex};

use domicile_protocol::SystemEvent;

use crate::fanout::{Fanout, Hear, Listener};

/// The current holders and every page listening. Clones share both, so every
/// connection's [`crate::system::System`] holds a clone of one.
#[derive(Clone, Default)]
pub struct IdleHolds {
    holders: Arc<Mutex<Vec<String>>>,
    hearing: Fanout<Vec<String>>,
}

impl IdleHolds {
    /// Sets the holders, one name per idle inhibitor, and tells every listener
    /// if they changed. Returns whether they did.
    pub fn hold(&self, holders: Vec<String>) -> bool {
        {
            let mut current = self.holders.lock().unwrap();
            if *current == holders {
                return false;
            }
            *current = holders.clone();
        }
        self.hearing.send(&holders);
        true
    }

    /// The current holders.
    pub fn holders(&self) -> Vec<String> {
        self.holders.lock().unwrap().clone()
    }

    /// Calls `hear` with every change until the [`Listener`] drops.
    pub(crate) fn listen(&self, hear: Hear<Vec<String>>) -> Listener {
        self.hearing.listen(hear)
    }
}

/// The event a listening page is told.
pub(crate) fn event(holders: &[String]) -> SystemEvent {
    SystemEvent::IdleHolds {
        holders: holders.to_vec(),
    }
}
