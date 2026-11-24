//! Locks the desktop, checks passphrases and tells the chromes. The lock's rules
//! are `crate::lock`'s.

use std::time::Instant;

use tracing::{debug, error, info, warn};

use domicile_host::unlock_refusals::Refused;
use domicile_protocol::Passphrase;

use crate::lock::{Offer, Refusal, Unlocking, Verdict};
use crate::DomicileCompositor;

/// Log a request the lock refused.
///
/// Both are debug: input at a locked desktop wakes the screen, and a shell's
/// timers (night light, wallpaper) keep sending commands while it is locked.
/// Neither line says what was asked.
pub fn say_what_the_lock_refused(refusal: Refusal) {
    match refusal {
        Refusal::Hand => {
            debug!("this desktop is locked; what the shell forwarded reaches no client")
        }
        Refusal::Command => {
            debug!("this desktop is locked; what the shell asked for is not done")
        }
    }
}

impl DomicileCompositor {
    /// Lock the desktop, logging `why`.
    ///
    /// Called when the screens go idle or on `ClientRequest::Lock`. Announces
    /// only on the transition to locked, so a repeat does not reset a lock
    /// screen mid-passphrase.
    pub fn shut_the_desk(&mut self, why: &str) {
        if self.lock.shut() {
            info!("{why}");
            // Release held keys. Input is dropped while locked, including
            // releases, so a key pressed before locking would stay down. With
            // `Caps_Lock`, xkb clears the lock only on that release. Held
            // modifiers are the common case: they do not repeat, so they do not
            // wake the desktop.
            self.release_pressed_keys();
            // The lock refuses the shell's release answers, so an
            // application's held global shortcut would never end.
            self.hub.portals.let_go_of_held_shortcuts();
            self.cancel_pinch();
            self.cancel_swipe();
            self.cancel_touches();
            self.tell_the_chromes_whether_the_desk_is_locked();
            // After the chromes hear `locked`, so a shell does not hand the
            // keyboard straight back to the window.
            self.hand_the_keyboard_to_the_lock_screen();
        } else if !self.lock.locked() {
            error!(
                why,
                "this desktop does not lock: nothing could unlock it until the machine declares \
                 its PAM service (see docs/LOCK.md)"
            );
        }
    }

    /// A passphrase typed at the lock screen.
    ///
    /// Checked off this thread, because PAM deliberately sleeps on a wrong
    /// password. The answer arrives in
    /// [`heard_the_verdict`](DomicileCompositor::heard_the_verdict). See
    /// [`Lock::offered`].
    ///
    /// The result goes to every chrome as [`HostMessage::Locked`], never only
    /// to the page that asked. A page that unlocked itself could be opened from
    /// devtools.
    pub fn offered_the_passphrase(&mut self, passphrase: &Passphrase) {
        match self.lock.offered(passphrase, Instant::now()) {
            Offer::Checking => debug!("checking a passphrase; the desk stays locked meanwhile"),
            Offer::StillChecking => warn!(
                "a chrome offered a passphrase while another was being checked; this one was \
                 dropped unchecked"
            ),
            Offer::NothingToOpen => {
                warn!("a chrome offered a passphrase to a desktop that is not locked")
            }
            Offer::TooSoon(refused) => {
                warn!(
                    "a passphrase offered during the wait after refused ones; it was not checked"
                );
                self.tell_the_chromes_the_desk_refused(&refused);
            }
        }
    }

    /// Handle the verifier's result for a passphrase.
    ///
    /// Every result is broadcast. A refusal re-sends `locked: true`, which is
    /// how the waiting shell learns of it, after saying why. See
    /// [`tell_the_chromes_the_desk_refused`](DomicileCompositor::tell_the_chromes_the_desk_refused).
    ///
    /// Refusals and verifier failures are logged without the passphrase;
    /// [`Unlocking`] does not hold it.
    pub fn heard_the_verdict(&mut self, verdict: Verdict) {
        match self.lock.answered(verdict, Instant::now()) {
            Unlocking::Opened => {
                info!("the passphrase opened this desktop");
                self.tell_the_chromes_whether_the_desk_is_locked();
            }
            Unlocking::Refused(refused) => {
                warn!(
                    failures = refused.failures,
                    "a passphrase this desktop did not take; it stays locked"
                );
                self.tell_the_chromes_the_desk_refused(&refused);
            }
            Unlocking::Unverifiable(why, refused) => {
                error!(
                    %why,
                    "this desktop could not check a passphrase, so it stays locked"
                );
                self.tell_the_chromes_the_desk_refused(&refused);
            }
        }
    }

    /// Tell every page listening why a passphrase did not open the desktop,
    /// then every chrome that it is still locked.
    ///
    /// The `locked` message is the answer a waiting page reads; the refusal
    /// goes first, so the page knows why when it reads it.
    fn tell_the_chromes_the_desk_refused(&self, refused: &Refused) {
        self.hub.unlock_refusals.send(refused);
        self.tell_the_chromes_whether_the_desk_is_locked();
    }

    /// Whether the desktop is locked. Checked by
    /// [`handle_client_request`](DomicileCompositor::handle_client_request)
    /// before input reaches the seat.
    pub fn the_desk_is_locked(&self) -> bool {
        self.lock.locked()
    }

    /// Tell every chrome whether the desktop is locked.
    ///
    /// Sends the current state, read from this compositor. See
    /// [`crate::lock::announced`].
    fn tell_the_chromes_whether_the_desk_is_locked(&self) {
        self.hub
            .broadcast(crate::lock::announced(self.the_desk_is_locked()));
        self.tell_the_portal_about_the_screensaver();
    }

    /// Tell a new chrome whether the desktop is locked.
    ///
    /// Essential: a reloaded page missed the original lock broadcast and would
    /// otherwise show an unlocked desktop.
    pub fn tell_a_new_chrome_whether_the_desk_is_locked(&self) {
        self.tell_the_chromes_whether_the_desk_is_locked();
    }

    /// Tell applications watching the session whether the screens are blanked
    /// or locked. The portal signals only a change.
    pub fn tell_the_portal_about_the_screensaver(&self) {
        self.hub
            .portals
            .screensaver(self.the_screens_are_dark() || self.the_desk_is_locked());
    }
}
