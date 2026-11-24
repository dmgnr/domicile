//! The clipboard and the primary selection: copies from Wayland clients, the
//! browser and portals, served back to all of them, and the clipboard history.
//! Transfers are `crate::clipboard`'s.

use std::os::fd::OwnedFd;
use std::thread;

use smithay::input::Seat;
use smithay::wayland::{
    selection::data_device::{
        clear_data_device_selection, current_data_device_selection_userdata,
        request_data_device_client_selection, set_data_device_selection, ClientDndGrabHandler,
        DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
    },
    selection::ext_data_control::{
        DataControlHandler as ExtDataControlHandler, DataControlState as ExtDataControlState,
    },
    selection::primary_selection::{
        request_primary_client_selection, PrimarySelectionHandler, PrimarySelectionState,
    },
    selection::wlr_data_control::{
        DataControlHandler as WlrDataControlHandler, DataControlState as WlrDataControlState,
    },
    selection::{SelectionHandler, SelectionSource, SelectionTarget},
};
use smithay::{
    delegate_data_control, delegate_data_device, delegate_ext_data_control,
    delegate_primary_selection,
};
use tracing::{debug, warn};
use zbus::zvariant::OwnedObjectPath;

use domicile_host::clipboard::{image_mime, text_mime, Contents, LONGEST_COPY, LONGEST_IMAGE};
use domicile_protocol::HostMessage;

use crate::client_requests::ClientRequest;
use crate::clipboard;
use crate::engine::Clipboard;
use crate::portals::Selection;
use crate::DomicileCompositor;

/// Both clipboards, in slot order.
const BOTH: [Clipboard; 2] = [Clipboard::Copy, Clipboard::Primary];

/// Who serves a selection the compositor set.
#[derive(Debug, Clone)]
pub enum Holder {
    /// A restored history entry, or anything copied in the browser (not our
    /// Wayland client), on this clipboard. Served from
    /// [`DomicileCompositor::holding`].
    Desk(Clipboard),
    /// A RemoteDesktop session's offer, which its application writes. See
    /// `crate::portals`.
    Portal(OwnedObjectPath),
}

impl SelectionHandler for DomicileCompositor {
    type SelectionUserData = Holder;

    /// A client set a selection. Only records the mime type to read; see
    /// [`DomicileCompositor::copying`].
    ///
    /// Both clipboards are read; the primary only so the browser can paste it.
    /// It gets no history.
    fn new_selection(
        &mut self,
        target: SelectionTarget,
        source: Option<SelectionSource>,
        _seat: Seat<Self>,
    ) {
        // A cleared selection (`None`) or one with no text or image (a file)
        // is not read; the previous copy stays.
        self.copying[at(clipboard_of(target))] = source
            .as_ref()
            .map(|offered| {
                let offered = offered.mime_types();
                text_mime(&offered)
                    .into_iter()
                    .chain(image_mime(&offered))
                    .collect()
            })
            .unwrap_or_default();
        if target == SelectionTarget::Clipboard {
            let offered = source
                .as_ref()
                .map(SelectionSource::mime_types)
                .unwrap_or_default();
            self.hub.portals.selection_changed(offered, None);
        }
    }

    /// A client is pasting a compositor-owned selection. See
    /// [`DomicileCompositor::serve_a_selection`].
    fn send_selection(
        &mut self,
        _target: SelectionTarget,
        mime_type: String,
        fd: OwnedFd,
        _seat: Seat<Self>,
        held: &Holder,
    ) {
        self.serve_a_selection(held, mime_type, fd);
    }
}

impl PrimarySelectionHandler for DomicileCompositor {
    fn primary_selection_state(&self) -> &PrimarySelectionState {
        &self.primary_selection_state
    }
}

delegate_primary_selection!(DomicileCompositor);

impl ExtDataControlHandler for DomicileCompositor {
    fn data_control_state(&self) -> &ExtDataControlState {
        &self.ext_data_control_state
    }
}

delegate_ext_data_control!(DomicileCompositor);

impl WlrDataControlHandler for DomicileCompositor {
    fn data_control_state(&self) -> &WlrDataControlState {
        &self.wlr_data_control_state
    }
}

delegate_data_control!(DomicileCompositor);

impl ClientDndGrabHandler for DomicileCompositor {}

impl ServerDndGrabHandler for DomicileCompositor {}

impl DataDeviceHandler for DomicileCompositor {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

delegate_data_device!(DomicileCompositor);

/// Map a Smithay selection target to the engine's clipboard type. A function so
/// it can be tested; swapped, Ctrl-C would land on the primary selection.
fn clipboard_of(target: SelectionTarget) -> Clipboard {
    match target {
        SelectionTarget::Clipboard => Clipboard::Copy,
        SelectionTarget::Primary => Clipboard::Primary,
    }
}

/// The slot index for `clipboard` in per-clipboard arrays.
pub fn at(clipboard: Clipboard) -> usize {
    match clipboard {
        Clipboard::Copy => 0,
        Clipboard::Primary => 1,
    }
}

impl DomicileCompositor {
    /// Do what the Clipboard portal asked of the seat's clipboard.
    pub fn select_for_a_portal(&mut self, selection: Selection) {
        match selection {
            Selection::Offer {
                session,
                mime_types,
            } => {
                set_data_device_selection(
                    &self.display_handle,
                    &self.seat,
                    mime_types.clone(),
                    Holder::Portal(session.clone()),
                );
                self.hub
                    .portals
                    .selection_changed(mime_types, Some(session));
            }
            // A copied screenshot is a copy like any other, so it is a row.
            Selection::Hold { contents } => {
                if self.clipboard.record(contents.clone()) {
                    self.tell_the_chromes_the_clipboard();
                }
                self.hold_on_the_clipboard(contents);
            }
            Selection::Read { mime_type, into } => {
                let held =
                    current_data_device_selection_userdata(&self.seat).map(|held| held.clone());
                match held {
                    Some(held) => self.serve_a_selection(&held, mime_type, into),
                    None => {
                        if let Err(err) =
                            request_data_device_client_selection(&self.seat, mime_type, into)
                        {
                            debug!(%err, "a portal session read a clipboard nobody holds");
                        }
                    }
                }
            }
        }
    }

    /// Write a selection the compositor set into `fd`.
    ///
    /// Written on a thread, since a client that stops reading would otherwise
    /// block the Wayland thread. The deadline in `crate::clipboard` bounds the
    /// thread. A portal session's offer is written by its application.
    ///
    /// If nothing is held, the fd is dropped and the client reads EOF.
    fn serve_a_selection(&self, held: &Holder, mime_type: String, fd: OwnedFd) {
        match held {
            Holder::Desk(clipboard) => match self.holding[at(*clipboard)]
                .as_ref()
                .and_then(|held| held.bytes(&mime_type))
            {
                Some(bytes) => {
                    let copy = bytes.to_vec();
                    thread::spawn(move || {
                        if let Err(err) = clipboard::write_copy(fd, &copy, clipboard::PATIENCE) {
                            warn!(%err, "a client asked for the clipboard and did not take it");
                        }
                    });
                }
                None => warn!(
                    ?clipboard,
                    %mime_type,
                    "a client is pasting something this desktop does not hold, so it gets nothing"
                ),
            },
            Holder::Portal(session) => self.hub.portals.transfer(session.clone(), mime_type, fd),
        }
    }

    /// Record a copy from a Wayland client or the browser.
    ///
    /// Callers handle the difference: a browser copy must be put on the seat, a
    /// client's is already there.
    ///
    /// Only the regular clipboard has history. The primary selection changes on
    /// every text selection.
    pub fn took_a_copy(&mut self, clipboard: Clipboard, contents: Contents) {
        if clipboard == Clipboard::Copy && self.clipboard.record(contents.clone()) {
            self.tell_the_chromes_the_clipboard();
        }
        self.holding[at(clipboard)] = Some(contents);
    }

    /// Send every chrome the clipboard history.
    ///
    /// The whole list each time, since copies reorder it and a page applying
    /// deltas could drift. Also used to catch up a new chrome; an empty history
    /// is a valid answer.
    pub fn tell_the_chromes_the_clipboard(&self) {
        self.hub.broadcast(HostMessage::Clipboard {
            entries: self.clipboard.entries(),
        });
    }

    /// Put `contents` on the clipboard, served by the compositor: a restored
    /// history row or a copied screenshot. Wayland clients, portal sessions
    /// and the browser all paste it. The history is the caller's.
    pub fn hold_on_the_clipboard(&mut self, contents: Contents) {
        let mimes = contents.mimes();
        self.holding[at(Clipboard::Copy)] = Some(contents);
        set_data_device_selection(
            &self.display_handle,
            &self.seat,
            mimes.clone(),
            Holder::Desk(Clipboard::Copy),
        );
        self.hub.portals.selection_changed(mimes, None);
        self.tell_the_engine_a_clipboard(Clipboard::Copy);
    }

    /// Empty the clipboard, after the shell removed the copy on it, so nothing
    /// pastes it again: not Wayland clients, portal sessions or the browser.
    pub fn empty_the_clipboard(&mut self) {
        self.holding[at(Clipboard::Copy)] = None;
        clear_data_device_selection(&self.display_handle, &self.seat);
        self.hub.portals.selection_changed(Vec::new(), None);
        self.tell_the_engine_a_clipboard(Clipboard::Copy);
    }

    /// Tell a newly connected browser what is on both clipboards, so earlier
    /// copies can be pasted into it.
    pub fn tell_the_engine_the_copies(&self) {
        for clipboard in BOTH {
            self.tell_the_engine_a_clipboard(clipboard);
        }
    }

    /// Tell the browser what is on one clipboard.
    ///
    /// Without an engine, nothing to do: a new one gets both clipboards via
    /// [`DomicileCompositor::tell_the_engine_the_copies`]. An empty clipboard
    /// is sent as empty contents, so the browser does not keep offering an old
    /// value.
    pub fn tell_the_engine_a_clipboard(&self, clipboard: Clipboard) {
        if let Some(session) = self.engine.as_ref() {
            session.set_clipboard(
                clipboard,
                &self.holding[at(clipboard)].clone().unwrap_or_default(),
            );
        }
    }

    /// Read what a client copied, now that the seat holds the selection.
    ///
    /// Runs at the end of the dispatch: after, because Smithay calls
    /// `new_selection` before storing the selection; before the flush, because
    /// the client cannot write until it receives `wl_data_source.send`.
    ///
    /// Reading happens on a thread, since a client may write slowly. The result
    /// arrives as [`ClientRequest::ClipboardCopied`].
    pub fn read_what_was_copied(&mut self) {
        for clipboard in BOTH {
            let mimes = std::mem::take(&mut self.copying[at(clipboard)]);
            if !mimes.is_empty() {
                self.read_one_clipboard(clipboard, mimes);
            }
        }
    }

    /// Ask the client holding one clipboard for its contents, as each of
    /// `mimes`.
    ///
    /// Every type is asked for before any is read: the client writes once it
    /// receives `wl_data_source.send`, which goes out at the flush.
    fn read_one_clipboard(&mut self, clipboard: Clipboard, mimes: Vec<String>) {
        let mut asked = Vec::new();
        for mime in mimes {
            match self.ask_for_a_copy(clipboard, &mime) {
                Some(ours) => asked.push((mime, ours)),
                // Logged; the copy is not read, since part of it would be
                // missing.
                None => return,
            }
        }
        let hub = self.hub.clone();
        thread::spawn(move || {
            let mut offers = Vec::new();
            for (mime, ours) in asked {
                let text = text_mime(std::slice::from_ref(&mime)).is_some();
                let longest = if text { LONGEST_COPY } else { LONGEST_IMAGE };
                match clipboard::read_copy(ours, longest, clipboard::PATIENCE) {
                    // The client offered UTF-8 text and sent something else.
                    // Logged, not repaired: a repaired copy would differ from
                    // what was copied.
                    Ok(copied) if text && std::str::from_utf8(&copied).is_err() => {
                        warn!("a client offered text that is not UTF-8, so it is not a row");
                        return;
                    }
                    Ok(copied) => offers.push((mime, copied)),
                    Err(err) => {
                        warn!(%err, %mime, "a client offered the clipboard and did not hand it over");
                        return;
                    }
                }
            }
            hub.send_request(ClientRequest::ClipboardCopied {
                clipboard,
                contents: Contents::from_offers(offers),
            });
        });
    }

    /// Ask the client holding one clipboard to write it as `mime`, returning
    /// the end to read, or `None` if nothing can be read.
    fn ask_for_a_copy(&mut self, clipboard: Clipboard, mime: &str) -> Option<OwnedFd> {
        let (ours, theirs) = match clipboard::pipe() {
            Ok(ends) => ends,
            Err(err) => {
                tracing::error!(%err, "no pipe to read a copy over, so nothing is told what was copied");
                return None;
            }
        };
        // `ServerSideSelection` is expected when the compositor owns the
        // selection; this process already has the contents.
        //
        // The two Smithay modules have separate error types with the same
        // cases, so both are converted to strings.
        let asked = match clipboard {
            Clipboard::Copy => {
                request_data_device_client_selection(&self.seat, mime.to_string(), theirs)
                    .map_err(|err| err.to_string())
            }
            Clipboard::Primary => {
                request_primary_client_selection(&self.seat, mime.to_string(), theirs)
                    .map_err(|err| err.to_string())
            }
        };
        match asked {
            Ok(()) => Some(ours),
            Err(err) => {
                debug!(%err, %mime, "nothing to read this copy from");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{at, clipboard_of, Clipboard, SelectionTarget, BOTH};

    /// Smithay's selection targets map to the matching engine clipboards. A
    /// swap would be silent: Ctrl-C would land on the primary selection.
    #[test]
    fn each_clipboard_is_the_same_clipboard_in_both_vocabularies() {
        assert_eq!(clipboard_of(SelectionTarget::Clipboard), Clipboard::Copy);
        assert_eq!(clipboard_of(SelectionTarget::Primary), Clipboard::Primary);
    }

    /// Each clipboard has its own slot; a shared slot would read the wrong
    /// clipboard.
    #[test]
    fn the_two_clipboards_have_a_slot_each() {
        assert_ne!(at(Clipboard::Copy), at(Clipboard::Primary));
        assert!(at(Clipboard::Copy) < BOTH.len());
        assert!(at(Clipboard::Primary) < BOTH.len());
        assert_eq!(BOTH[at(Clipboard::Copy)], Clipboard::Copy);
        assert_eq!(BOTH[at(Clipboard::Primary)], Clipboard::Primary);
    }
}
