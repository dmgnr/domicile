//! The queue from the Wayland thread to the chrome writer.
//!
//! The Wayland thread must never wait on a chrome. It also injects input,
//! answers frame callbacks and flushes clients, so a stall on a socket freezes
//! input for every client, long enough for a held key to start repeating.
//!
//! The queue is unbounded. It carries only lifecycle messages, clients'
//! window requests and bells, which cannot be dropped. They are small and arrive at the
//! rate windows open, close and change state.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use domicile_host::AppId;
use domicile_protocol::{HostMessage, WindowRequest};

/// Something on its way to the chrome.
pub enum Outbound {
    Message(HostMessage),
    /// For the pages listening for window requests. Sent here because each
    /// page is written to under its connection's lock, which may wait on a
    /// chrome that is not reading.
    WindowRequest(AppId, WindowRequest),
    /// For the pages listening for bells, for the same reason: the window
    /// that rang, if any.
    Bell(Option<AppId>),
    /// Something `domicile subscribe` watches may have changed without a
    /// message to the chromes, so the writer asks its watchers again. See
    /// [`crate::watchers`].
    Watched,
}

/// The sending half, held by the Wayland thread.
pub struct OutboundSender {
    sender: Sender<Outbound>,
}

/// The receiving half, held by the writer thread.
pub struct OutboundReceiver {
    receiver: Receiver<Outbound>,
}

/// Create the queue.
pub fn outbound() -> (OutboundSender, OutboundReceiver) {
    let (sender, receiver) = channel();
    (OutboundSender { sender }, OutboundReceiver { receiver })
}

impl OutboundSender {
    /// Queue a lifecycle message. Never waits and never drops.
    pub fn message(&self, message: HostMessage) {
        let _ = self.sender.send(Outbound::Message(message));
    }

    /// Queue a client's window request. Never waits and never drops.
    pub fn window_request(&self, app_id: AppId, request: WindowRequest) {
        let _ = self.sender.send(Outbound::WindowRequest(app_id, request));
    }

    /// Have the writer tell the watchers what changed. Never waits.
    pub fn watched(&self) {
        let _ = self.sender.send(Outbound::Watched);
    }

    /// Queue a bell. Never waits and never drops.
    pub fn bell(&self, app_id: Option<AppId>) {
        let _ = self.sender.send(Outbound::Bell(app_id));
    }
}

impl OutboundReceiver {
    /// Block until the next item, returning `Some(None)` after `timeout`.
    ///
    /// The caller also reports on a schedule, which must keep running when
    /// nothing is sent. `None` means the sender is gone.
    pub fn recv_until(&self, timeout: Duration) -> Option<Option<Outbound>> {
        match self.receiver.recv_timeout(timeout) {
            Ok(item) => Some(Some(item)),
            Err(RecvTimeoutError::Timeout) => Some(None),
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }
}
