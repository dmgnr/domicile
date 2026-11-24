//! The screen lock's state and the list of requests it refuses.
//!
//! Everything here decides over values passed in; `locking.rs` applies the
//! decisions to the seat. That keeps the lock testable without a screen or a
//! client.
//!
//! The compositor enforces the lock because it injects all input into the
//! Wayland seat. A lock held by the page would open on a reload or an engine
//! restart. The page keeps receiving keys while locked so the shell can draw a
//! lock screen and read the passphrase; [`refused`] drops what it forwards to
//! clients.
//!
//! The idle timeout ([`crate::idle`]) or `ChromeMessage::Lock` locks the
//! desktop. See `docs/LOCK.md`.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use domicile_host::system::Reach;
use domicile_host::unlock_refusals::Refused;
use domicile_protocol::{HostMessage, Passphrase, UnlockRefusal};

use crate::chrome_connection::ConnectionRequest;
use crate::client_requests::ClientRequest;
use crate::unlock_backoff::Backoff;

/// How long the shell gets to draw its lock screen before the screens go dark
/// or the machine sleeps. Otherwise the unlocked desktop shows on waking until
/// it does. Under logind's default `InhibitDelayMaxSec`, 5 seconds.
pub const LOCK_SCREEN_DRAWS_WITHIN: Duration = Duration::from_secs(1);

/// Checks whether a passphrase unlocks the desktop: [`crate::pam::Pam`] on a
/// real desk.
///
/// May block (PAM delays on a wrong password), so [`Lock::offered`] calls it on
/// its own thread. It takes a [`Passphrase`] rather than a `&str` so the value
/// never passes through a type that prints itself.
pub trait Verifier: Send + Sync {
    fn opens_the_desk(&self, passphrase: &Passphrase) -> Verdict;

    /// Whether this verifier can check a passphrase at all. `false` when the
    /// machine lacks what it checks against, such as the PAM service. The desk
    /// does not lock then: nothing could open it.
    fn checks_passphrases(&self) -> bool;
}

/// A verifier's answer: whether the passphrase matches, or why it could not
/// check.
pub type Verdict = Result<bool, CouldNotCheck>;

/// A verifier that could not check the passphrase.
///
/// Distinct from a wrong passphrase: the machine is broken (a PAM module is
/// missing, a helper will not run), so nobody can unlock. Both keep the desktop
/// locked; only this one logs an error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CouldNotCheck(pub String);

/// What offering a passphrase started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Offer {
    /// The check is running on another thread; [`Lock::answered`] takes the
    /// verdict.
    Checking,
    /// Another check is running, so this passphrase is dropped, not queued.
    /// See [`Lock::offered`].
    StillChecking,
    /// The desktop is not locked. The page's state is out of date.
    NothingToOpen,
    /// Offered during the wait after refused passphrases, so not checked. See
    /// [`crate::unlock_backoff`].
    TooSoon(Refused),
}

/// The outcome of a checked passphrase.
///
/// None of the variants carries the passphrase, so logging one cannot leak it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unlocking {
    /// Correct. The desktop unlocks and every chrome is told.
    Opened,
    /// Wrong, or checked by a verifier a reload replaced. The desktop stays
    /// locked and every chrome is sent `locked: true` again, which the waiting
    /// page reads as the answer.
    Refused(Refused),
    /// The verifier could not check. Handled like [`Unlocking::Refused`], but
    /// logged as an error. Counted as a guess, since some PAM stacks fail a
    /// wrong passphrase with an error. See [`CouldNotCheck`].
    Unverifiable(CouldNotCheck, Refused),
}

/// The lock's state.
#[derive(Debug)]
enum State {
    Open,
    Shut,
    /// Locked, with a passphrase being checked.
    ///
    /// `overtaken` when a reload replaced the verifier doing the check, so
    /// its verdict cannot unlock.
    Checking {
        overtaken: bool,
    },
}

impl State {
    /// Whether input is refused. A pending check counts as locked.
    fn locked(&self) -> bool {
        match self {
            State::Open => false,
            State::Shut | State::Checking { .. } => true,
        }
    }
}

/// The screen lock and the verifier that opens it.
///
/// `state` is shared with every [`Seen`]; only `Lock` changes it.
pub struct Lock {
    verifier: Arc<dyn Verifier>,
    answer: Arc<dyn Fn(Verdict) + Send + Sync>,
    state: Arc<Mutex<State>>,
    backoff: Backoff,
}

impl Lock {
    /// Creates an unlocked lock.
    ///
    /// `answer` receives each verdict on the verifier's thread. The compositor
    /// sends it to its event loop, which passes it to [`Lock::answered`].
    pub fn held_by(
        verifier: Box<dyn Verifier>,
        answer: impl Fn(Verdict) + Send + Sync + 'static,
    ) -> Lock {
        Lock {
            verifier: Arc::from(verifier),
            answer: Arc::new(answer),
            state: Arc::new(Mutex::new(State::Open)),
            backoff: Backoff::default(),
        }
    }

    /// Replaces the verifier with the one a reloaded config names.
    ///
    /// Never unlocks. A check already running cannot unlock either: the
    /// passphrase was checked against a verifier the config no longer names.
    /// The wait after refused passphrases stays.
    pub fn rekeyed(&mut self, verifier: Box<dyn Verifier>) {
        let mut state = self.state.lock().unwrap();
        if let State::Checking { overtaken } = &mut *state {
            *overtaken = true;
        }
        self.verifier = Arc::from(verifier);
    }

    /// Whether the desktop is locked. See [`State::locked`].
    pub fn locked(&self) -> bool {
        self.state.lock().unwrap().locked()
    }

    /// A read-only view of the state for another thread.
    pub fn seen(&self) -> Seen {
        Seen(Arc::clone(&self.state))
    }

    /// Locks the desktop. Returns `true` only when it was unlocked.
    ///
    /// A desk whose verifier cannot check a passphrase stays open: locked, it
    /// could never be opened. Asked on each lock, so adding the PAM service
    /// lets the next one lock.
    ///
    /// Blanking can repeat while locked. Sending `locked: true` again would
    /// make the shell redraw its lock screen and could discard a half-typed
    /// passphrase.
    pub fn shut(&mut self) -> bool {
        let mut state = self.state.lock().unwrap();
        match *state {
            State::Open if !self.verifier.checks_passphrases() => false,
            State::Open => {
                *state = State::Shut;
                true
            }
            State::Shut | State::Checking { .. } => false,
        }
    }

    /// Starts checking a passphrase if locked and no check is running.
    ///
    /// Never locks: an offer at an unlocked desktop does nothing, so a page
    /// cannot lock by sending a guess.
    ///
    /// A second offer during a check is dropped. Parallel checks would race,
    /// and each would pay PAM's delay. The shell keeps its input as sent until
    /// the verdict, so there is nothing to queue.
    ///
    /// An offer at `now` during the wait after refused passphrases is refused
    /// unchecked.
    pub fn offered(&mut self, passphrase: &Passphrase, now: Instant) -> Offer {
        let mut state = self.state.lock().unwrap();
        let wait = self.backoff.wait(now);
        match *state {
            State::Open => Offer::NothingToOpen,
            State::Checking { .. } => Offer::StillChecking,
            State::Shut if !wait.is_zero() => Offer::TooSoon(Refused {
                refusal: UnlockRefusal::TooSoon,
                failures: self.backoff.failures(),
                retry_in: wait,
            }),
            State::Shut => {
                *state = State::Checking { overtaken: false };
                let verifier = Arc::clone(&self.verifier);
                let answer = Arc::clone(&self.answer);
                // Moved into the check and dropped when it ends, so no copy
                // outlives the verdict.
                let passphrase = passphrase.clone();
                thread::Builder::new()
                    .name("lock verifier".into())
                    .spawn(move || answer(verifier.opens_the_desk(&passphrase)))
                    .expect("a thread to check a passphrase on");
                Offer::Checking
            }
        }
    }

    /// Applies the verdict for the passphrase [`Lock::offered`] is checking.
    ///
    /// Only one check runs at a time, so a verdict in any other state is a bug.
    /// A refused passphrase starts its wait at `now`.
    pub fn answered(&mut self, verdict: Verdict, now: Instant) -> Unlocking {
        let mut state = self.state.lock().unwrap();
        match *state {
            State::Open | State::Shut => {
                unreachable!("a verdict arrives only for the one passphrase being checked")
            }
            State::Checking { overtaken } => match verdict {
                Ok(true) if !overtaken => {
                    *state = State::Open;
                    self.backoff.opened();
                    Unlocking::Opened
                }
                // The passphrase was right, so it is not counted as a guess.
                Ok(true) => {
                    *state = State::Shut;
                    Unlocking::Refused(Refused {
                        refusal: UnlockRefusal::WrongPassphrase,
                        failures: self.backoff.failures(),
                        retry_in: self.backoff.wait(now),
                    })
                }
                Ok(false) => {
                    *state = State::Shut;
                    let retry_in = self.backoff.failed(now);
                    Unlocking::Refused(Refused {
                        refusal: UnlockRefusal::WrongPassphrase,
                        failures: self.backoff.failures(),
                        retry_in,
                    })
                }
                Err(why) => {
                    *state = State::Shut;
                    let retry_in = self.backoff.failed(now);
                    Unlocking::Unverifiable(
                        why,
                        Refused {
                            refusal: UnlockRefusal::Unverifiable,
                            failures: self.backoff.failures(),
                            retry_in,
                        },
                    )
                }
            },
        }
    }
}

/// A read-only view of the lock state for chrome connection threads.
///
/// Some requests are answered on the connection instead of the Wayland thread
/// (see [`Asked`]). Sharing the lock's state, not a copy, keeps the two in
/// step, including while a check is running.
///
/// Ordering: the Wayland thread updates the state before it queues the
/// `locked` message. A request sent after the page saw `locked: true` is
/// refused, and one sent after `locked: false` is allowed. A request sent
/// during a check is refused.
#[derive(Debug, Clone)]
pub struct Seen(Arc<Mutex<State>>);

impl Seen {
    pub fn locked(&self) -> bool {
        self.0.lock().unwrap().locked()
    }
}

/// Why a request was refused while locked.
///
/// Neither variant carries the request, since a spawn's command line may be
/// private.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Input forwarded to a client. Not worth a warning: input is how someone
    /// wakes the screen to type a passphrase.
    Hand,
    /// A command the shell sent on the user's behalf. Logged as a warning,
    /// since a shell sending one while locked has a panel over its lock screen.
    Command,
}

/// A request the lock checks, by the thread that handles it.
///
/// Most requests go to the Wayland thread as a [`ClientRequest`]. A few, like
/// launcher searches, are answered on the chrome connection so they don't wait
/// on a frame. Both kinds go through [`refused`], so one `match` lists
/// everything the lock refuses.
#[derive(Clone, Copy)]
pub enum Asked<'a> {
    OnTheWaylandThread(&'a ClientRequest),
    OnTheConnection(&'a ConnectionRequest),
    /// A system call from the shell, by what it touches. See
    /// `docs/SHELL-SYSTEM-ACCESS.md`.
    System(Reach),
}

/// Whether a request is refused while locked, and why.
///
/// The `match` has no wildcard arm, so a new request does not compile until
/// someone decides how the lock treats it.
///
/// Non-obvious cases:
///
/// - **`PointerLeave`** is refused. It changes what a client thinks the
///   pointer is over, even though `somebody_is_here` ignores it.
/// - **`KeyboardFocus`** is allowed. The page moves focus before this check
///   (`FocusApp` in `read_chrome_messages`) and the seat follows. Refusing it
///   would leave them out of step after unlock, and no key reaches the window
///   while locked anyway.
/// - **`ChromeHello`** is allowed. Answering it is how a reloaded page learns
///   it is locked.
/// - **`ClipboardCopied`** is allowed. It reports a client's copy; refusing it
///   would make the history disagree with what a paste produces.
/// - **Launcher searches** are refused on the connection (see
///   [`Asked::OnTheConnection`]) with no answer, so they reveal nothing about
///   the disk.
/// - **Theme changes** and asking the theme are allowed. They open and read
///   nothing, and keep the lock screen's colors current.
/// - **System calls** are refused, except reads under `/sys`, the calls a lock
///   screen makes to show and adjust the battery, brightness and volume
///   (`Reach::Readout`), calls that stop what the shell already started, and
///   listening for shell commands and window requests (`Reach::Listens`), so
///   a page reloaded while locked hears them after unlock, and setting window
///   states (`Reach::Arranges`), like `SetAppBounds`, switching the keymap
///   (`Reach::Retypes`), so the passphrase is typed on the right one, and the
///   monitors' color temperature (`Reach::Tints`), so a night light follows
///   the clock, and turning the monitors off and on (`Reach::Powers`), since a
///   locked desk is often left with its screens off. Sending a command is
///   refused.
///   Processes and watches started before the lock keep running.
pub fn refused(asked: Asked) -> Option<Refusal> {
    match asked {
        Asked::OnTheWaylandThread(
            ClientRequest::Key { .. }
            | ClientRequest::PointerMotion { .. }
            | ClientRequest::PointerRelative { .. }
            | ClientRequest::PointerConstrained { .. }
            | ClientRequest::PointerLeave
            | ClientRequest::PointerPinch { .. }
            | ClientRequest::PointerSwipe { .. }
            | ClientRequest::PointerHold { .. }
            | ClientRequest::Touch { .. }
            | ClientRequest::PointerButton { .. }
            | ClientRequest::PointerAxis { .. },
        ) => Some(Refusal::Hand),
        Asked::OnTheWaylandThread(
            ClientRequest::CloseApp { .. }
            | ClientRequest::Spawn { .. }
            | ClientRequest::CopyClipboardEntry { .. }
            | ClientRequest::RemoveClipboardEntry { .. }
            | ClientRequest::ActivateTrayItem { .. }
            | ClientRequest::TrayMenuClicked { .. }
            | ClientRequest::DismissNotifications { .. }
            | ClientRequest::InvokeNotificationAction { .. }
            | ClientRequest::ReplyToNotification { .. }
            // Grants an application what its dialog asked for.
            | ClientRequest::AnswerPortalRequest { .. },
        )
        | Asked::OnTheConnection(ConnectionRequest::SearchFiles { .. })
        | Asked::System(Reach::Acts) => Some(Refusal::Command),
        Asked::OnTheWaylandThread(
            ClientRequest::KeyboardFocus { .. }
            | ClientRequest::GestureOwnerGone { .. }
            | ClientRequest::TouchOwnerGone { .. }
            | ClientRequest::SetOutputScale { .. }
            | ClientRequest::SetOutputSize { .. }
            | ClientRequest::SetAppBounds { .. }
            | ClientRequest::SetWindowStates { .. }
            // Changes what the passphrase is typed on, not what is on screen.
            | ClientRequest::SelectKeymap { .. }
            // The host refuses it to a locked desktop.
            | ClientRequest::SwitchShortcutsInhibitor { .. }
            | ClientRequest::SetWhitePoint { .. }
            | ClientRequest::ChromeHello { .. }
            // While locked the browser's keys come straight back and the
            // input method's text is dropped (`chrome_editor`, `text_input`),
            // so the lock page's field can still be typed in.
            | ClientRequest::TextInput { .. }
            | ClientRequest::KeyForInputMethod { .. }
            | ClientRequest::ClipboardCopied { .. }
            | ClientRequest::Unlock { .. }
            | ClientRequest::Lock
            // A lock screen may dim too.
            | ClientRequest::IdleWatched
            // Part of a theme change; allowed like `SetTheme`.
            | ClientRequest::TurnTheWindows { .. }
            | ClientRequest::ThemeCaptured { .. }
            // From an application, like a Wayland idle inhibitor.
            | ClientRequest::HeldAwakeByThePortal { .. }
            | ClientRequest::HeldAwakeByTheScreenSaver { .. }
            // Reaches no client; it only stirs the idle clock.
            | ClientRequest::Activity { .. }
            // Reaches no client; a cast of the lock screen draws it.
            | ClientRequest::DeskPointer { .. }
            | ClientRequest::DeskCursor { .. }
            // Queued by a `SystemRequest::VirtualMonitor` the lock already
            // judged, or by its end.
            | ClientRequest::AddVirtualMonitor { .. }
            | ClientRequest::RemoveVirtualMonitor { .. }
            | ClientRequest::ResizeVirtualMonitor { .. }
            // Queued by a `SystemRequest::SleepDisplays` or `WakeDisplays`
            // the lock already judged.
            | ClientRequest::PowerDisplays { .. }
            // Like `sleep-displays`: arranging the monitors shows nothing the
            // lock hides, and docking a locked laptop may need it.
            | ClientRequest::ConfigureDisplay { .. },
        )
        | Asked::OnTheConnection(
            ConnectionRequest::SetTheme { .. }
            | ConnectionRequest::WhichTheme
            | ConnectionRequest::WhichMonitors
            | ConnectionRequest::WhichDisplays
            | ConnectionRequest::WhichWindows
            | ConnectionRequest::WhichStatus
            | ConnectionRequest::WhichShellCommands
            | ConnectionRequest::WhichShellBindings
            | ConnectionRequest::WhichInputs
            | ConnectionRequest::WhichIdleTime,
        )
        | Asked::System(
            Reach::ReadsTheKernel
            | Reach::Readout
            | Reach::Stops
            | Reach::Listens
            | Reach::Arranges
            | Reach::Retypes
            | Reach::Tints
            | Reach::Powers,
        ) => None,
    }
}

/// The `locked` message sent to a chrome.
///
/// Carries the state, not the transition, like `crate::idle::announced`. A
/// reloaded page has missed every transition and must still raise its lock
/// screen. See [`HostMessage::Locked`] for what a shell may conclude from it.
pub fn announced(locked: bool) -> HostMessage {
    HostMessage::Locked { locked }
}

#[cfg(test)]
mod tests {
    use domicile_protocol::{HostMessage, Passphrase, PortalAnswer, Theme, TrayAction};

    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use domicile_host::system::Reach;
    use domicile_host::unlock_refusals::Refused;
    use domicile_protocol::UnlockRefusal;

    use super::{
        announced, refused, Asked, CouldNotCheck, Lock, Offer, Refusal, Unlocking, Verdict,
        Verifier,
    };
    use crate::chrome_connection::ConnectionRequest;
    use crate::client_requests::ClientRequest;
    use crate::engine::Clipboard;

    /// A verifier that accepts one word, so the tests focus on the lock.
    struct OnlyTheWord(&'static str);

    impl Verifier for OnlyTheWord {
        fn opens_the_desk(&self, passphrase: &Passphrase) -> Verdict {
            Ok(passphrase.as_str() == self.0)
        }

        fn checks_passphrases(&self) -> bool {
            true
        }
    }

    /// An unlocked lock that opens to `"friend"`, and its verdict channel.
    fn desk() -> (Lock, mpsc::Receiver<Verdict>) {
        held_by(OnlyTheWord("friend"))
    }

    /// A lock behind `verifier`, with verdicts sent to a channel as in the
    /// compositor.
    fn held_by(verifier: impl Verifier + 'static) -> (Lock, mpsc::Receiver<Verdict>) {
        let (told, heard) = mpsc::channel();
        let lock = Lock::held_by(Box::new(verifier), move |verdict| {
            told.send(verdict).expect("the test is listening")
        });
        (lock, heard)
    }

    /// Offers `passphrase` while locked and applies the verdict.
    fn offer(lock: &mut Lock, heard: &mpsc::Receiver<Verdict>, passphrase: &str) -> Unlocking {
        offer_at(lock, heard, passphrase, Instant::now())
    }

    /// [`offer`], with the offer and the verdict both at `now`.
    fn offer_at(
        lock: &mut Lock,
        heard: &mpsc::Receiver<Verdict>,
        passphrase: &str,
        now: Instant,
    ) -> Unlocking {
        assert_eq!(
            lock.offered(&Passphrase::from(passphrase), now),
            Offer::Checking
        );
        let verdict = heard
            .recv_timeout(Duration::from_secs(10))
            .expect("the verifier answers");
        lock.answered(verdict, now)
    }

    /// A refusal for `refusal`, after `failures` refused passphrases, with
    /// `retry_in` seconds to wait.
    fn told(refusal: UnlockRefusal, failures: u32, retry_in: u64) -> Refused {
        Refused {
            refusal,
            failures,
            retry_in: Duration::from_secs(retry_in),
        }
    }

    #[test]
    fn a_passphrase_is_checked_off_the_thread_that_offered_it() {
        // Offers arrive on the compositor's loop, and `pam_unix` sleeps for
        // seconds on a wrong password. A check on the loop would stall every
        // client's frames. The verifier here blocks until released, so the
        // offer must return first.
        struct UntilReleased(Mutex<mpsc::Receiver<()>>);
        impl Verifier for UntilReleased {
            fn opens_the_desk(&self, _: &Passphrase) -> Verdict {
                self.0
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .map(|()| true)
                    .map_err(|_| CouldNotCheck("nobody released it".into()))
            }

            fn checks_passphrases(&self) -> bool {
                true
            }
        }
        let (release, released) = mpsc::channel();
        let (mut lock, heard) = held_by(UntilReleased(Mutex::new(released)));
        lock.shut();

        assert_eq!(
            lock.offered(&Passphrase::from("friend"), Instant::now()),
            Offer::Checking
        );
        release
            .send(())
            .expect("the verifier is still waiting, so the offer did not wait for it");
        let verdict = heard
            .recv_timeout(Duration::from_secs(10))
            .expect("the verifier answers");
        assert_eq!(lock.answered(verdict, Instant::now()), Unlocking::Opened);
    }

    #[test]
    fn a_desk_being_checked_is_shut_and_takes_no_second_passphrase() {
        // Parallel checks would race, and each would pay PAM's delay.
        let (mut lock, heard) = desk();
        lock.shut();

        assert_eq!(
            lock.offered(&Passphrase::from("friend"), Instant::now()),
            Offer::Checking
        );
        assert!(lock.locked(), "a desk being checked is still shut");
        assert!(!lock.shut(), "and shutting it again is no edge");
        assert_eq!(
            lock.offered(&Passphrase::from("friend"), Instant::now()),
            Offer::StillChecking
        );

        let verdict = heard
            .recv_timeout(Duration::from_secs(10))
            .expect("the first passphrase is answered");
        assert_eq!(lock.answered(verdict, Instant::now()), Unlocking::Opened);
        assert!(
            heard.recv_timeout(Duration::from_millis(100)).is_err(),
            "and the second was never checked"
        );
    }

    #[test]
    fn a_verifier_that_cannot_check_leaves_the_desk_shut_and_says_why() {
        // Fail closed, and report it as an error rather than a wrong
        // passphrase, so a broken PAM setup is not mistaken for a typo.
        struct Broken;
        impl Verifier for Broken {
            fn opens_the_desk(&self, _: &Passphrase) -> Verdict {
                Err(CouldNotCheck("the module is not there".into()))
            }

            fn checks_passphrases(&self) -> bool {
                true
            }
        }
        let (mut lock, heard) = held_by(Broken);
        lock.shut();

        assert_eq!(
            offer(&mut lock, &heard, "friend"),
            Unlocking::Unverifiable(
                CouldNotCheck("the module is not there".into()),
                told(UnlockRefusal::Unverifiable, 1, 0)
            ),
            "and it counts as a guess: some PAM stacks fail a wrong passphrase with an error"
        );
        assert!(lock.locked());
    }

    #[test]
    fn a_desk_nothing_could_open_does_not_shut() {
        // A machine without the lock's PAM service, as in a `nix run` trial.
        // Locking would leave the desk shut for good.
        struct Undeclared;
        impl Verifier for Undeclared {
            fn opens_the_desk(&self, _: &Passphrase) -> Verdict {
                Err(CouldNotCheck("no /etc/pam.d/domicile".into()))
            }
            fn checks_passphrases(&self) -> bool {
                false
            }
        }
        let (mut lock, _) = held_by(Undeclared);

        assert!(!lock.shut());
        assert!(!lock.locked());

        lock.rekeyed(Box::new(OnlyTheWord("friend")));
        assert!(
            lock.shut(),
            "a reload naming a declared service locks again"
        );
    }

    #[test]
    fn a_desk_shuts_once_and_says_so_once() {
        let (mut lock, _) = desk();
        assert!(!lock.locked());

        assert!(lock.shut(), "the turn a desk shuts on is an edge");
        assert!(lock.locked());

        // Blanking repeats while locked. A second `locked: true` would make the
        // shell redraw its lock screen.
        assert!(!lock.shut());
        assert!(lock.locked());
    }

    #[test]
    fn the_passphrase_opens_the_desk_and_nothing_else_does() {
        let (mut lock, heard) = desk();
        lock.shut();

        assert_eq!(
            offer(&mut lock, &heard, "enemy"),
            Unlocking::Refused(told(UnlockRefusal::WrongPassphrase, 1, 0)),
            "a desk that took the wrong passphrase would not be a lock"
        );
        assert!(lock.locked(), "and it stays shut");

        assert_eq!(offer(&mut lock, &heard, "friend"), Unlocking::Opened);
        assert!(!lock.locked());
    }

    #[test]
    fn repeated_wrong_passphrases_make_the_desk_wait_before_it_checks_another() {
        // Enforced here, so a shell cannot guess faster by calling `unlock`.
        let (mut lock, heard) = desk();
        lock.shut();
        let then = Instant::now();
        for _ in 0..2 {
            offer_at(&mut lock, &heard, "enemy", then);
        }
        assert_eq!(
            offer_at(&mut lock, &heard, "enemy", then),
            Unlocking::Refused(told(UnlockRefusal::WrongPassphrase, 3, 5))
        );

        assert_eq!(
            lock.offered(&Passphrase::from("friend"), then + Duration::from_secs(2)),
            Offer::TooSoon(told(UnlockRefusal::TooSoon, 3, 3)),
            "even the right passphrase waits"
        );
        assert!(
            heard.recv_timeout(Duration::from_millis(100)).is_err(),
            "and nothing was asked of the verifier"
        );

        assert_eq!(
            offer_at(&mut lock, &heard, "friend", then + Duration::from_secs(5)),
            Unlocking::Opened
        );
        lock.shut();
        assert_eq!(
            offer_at(&mut lock, &heard, "enemy", then + Duration::from_secs(6)),
            Unlocking::Refused(told(UnlockRefusal::WrongPassphrase, 1, 0)),
            "and opening the desk forgets the wrong ones"
        );
    }

    #[test]
    fn a_chrome_connection_sees_the_desk_shut_and_open_as_the_lock_does() {
        // A copy would need syncing on every transition. Missing one would let
        // a launcher answer while locked, most likely during a check that PAM
        // holds open for seconds.
        let (mut lock, heard) = desk();
        let seen = lock.seen();
        assert!(!seen.locked());

        lock.shut();
        assert!(seen.locked(), "a desk that shut is shut from a connection");

        assert_eq!(
            lock.offered(&Passphrase::from("friend"), Instant::now()),
            Offer::Checking
        );
        assert!(
            seen.locked(),
            "a desk with a passphrase being checked is shut from a connection too"
        );

        let verdict = heard
            .recv_timeout(Duration::from_secs(10))
            .expect("the verifier answers");
        assert_eq!(lock.answered(verdict, Instant::now()), Unlocking::Opened);
        assert!(!seen.locked(), "and the verdict opens it there too");
    }

    #[test]
    fn a_passphrase_offered_at_an_open_desk_opens_nothing() {
        // Not checked and not reported as an unlock: the page's state is out of
        // date.
        let (mut lock, heard) = desk();
        assert_eq!(
            lock.offered(&Passphrase::from("friend"), Instant::now()),
            Offer::NothingToOpen
        );
        assert!(!lock.locked());
        assert!(
            heard.recv_timeout(Duration::from_millis(100)).is_err(),
            "and nothing was asked of the verifier"
        );
    }

    #[test]
    fn a_shut_desk_opens_to_the_reloaded_verifier_only() {
        let (mut lock, heard) = desk();
        lock.shut();

        lock.rekeyed(Box::new(OnlyTheWord("enemy")));
        assert!(lock.locked(), "a reload never opens the desk");
        assert_eq!(
            offer(&mut lock, &heard, "friend"),
            Unlocking::Refused(told(UnlockRefusal::WrongPassphrase, 1, 0))
        );
        assert_eq!(offer(&mut lock, &heard, "enemy"), Unlocking::Opened);
    }

    #[test]
    fn a_check_the_reload_overtook_opens_nothing() {
        // The passphrase was checked against a verifier the config no longer
        // names.
        let (mut lock, heard) = desk();
        lock.shut();
        assert_eq!(
            lock.offered(&Passphrase::from("friend"), Instant::now()),
            Offer::Checking
        );

        lock.rekeyed(Box::new(OnlyTheWord("enemy")));
        let verdict = heard
            .recv_timeout(Duration::from_secs(10))
            .expect("the verifier answers");

        assert_eq!(verdict, Ok(true), "the old verifier took it");
        assert_eq!(
            lock.answered(verdict, Instant::now()),
            Unlocking::Refused(told(UnlockRefusal::WrongPassphrase, 0, 0)),
            "and it is no wrong guess: the passphrase was right"
        );
        assert!(lock.locked());
    }

    #[test]
    fn a_reload_during_the_wait_keeps_it() {
        // Otherwise editing the config would skip the wait.
        let (mut lock, heard) = desk();
        lock.shut();
        let then = Instant::now();
        for _ in 0..3 {
            offer_at(&mut lock, &heard, "enemy", then);
        }

        lock.rekeyed(Box::new(OnlyTheWord("friend")));

        assert_eq!(
            lock.offered(&Passphrase::from("friend"), then + Duration::from_secs(2)),
            Offer::TooSoon(told(UnlockRefusal::TooSoon, 3, 3))
        );
    }

    #[test]
    fn what_a_locked_desk_refuses_is_every_hand() {
        for (what, request) in [
            (
                "a key",
                ClientRequest::Key {
                    keycode: 30,
                    pressed: true,
                },
            ),
            (
                "the pointer moving over a window",
                ClientRequest::PointerMotion {
                    app_id: "app-1".into(),
                    x: 4.0,
                    y: 8.0,
                    moved: true,
                },
            ),
            (
                "the pointer moving a game's camera",
                ClientRequest::PointerRelative {
                    app_id: "app-1".into(),
                    dx: 2.0,
                    dy: 1.0,
                    dx_unaccel: 1.0,
                    dy_unaccel: 0.5,
                },
            ),
            (
                "the page taking the pointer for a game",
                ClientRequest::PointerConstrained {
                    app_id: "app-1".into(),
                    active: true,
                },
            ),
            ("the pointer leaving a window", ClientRequest::PointerLeave),
            (
                "a click",
                ClientRequest::PointerButton {
                    button: 272,
                    pressed: true,
                },
            ),
            (
                "the wheel",
                ClientRequest::PointerAxis {
                    dx: 0.0,
                    dy: 1.0,
                    v120_x: 0,
                    v120_y: 120,
                    source: domicile_protocol::PointerAxisSource::Wheel,
                    stop_x: false,
                    stop_y: false,
                },
            ),
        ] {
            assert_eq!(
                refused(Asked::OnTheWaylandThread(&request)),
                Some(Refusal::Hand),
                "{what} must not reach a client on a locked desk"
            );
        }
    }

    #[test]
    fn what_a_locked_desk_refuses_is_everything_the_shell_asks_done_to_it() {
        for (what, request) in [
            (
                "a window being closed",
                ClientRequest::CloseApp {
                    app_id: "app-1".into(),
                },
            ),
            (
                "a program being started",
                ClientRequest::Spawn {
                    command: vec!["foot".into()],
                    answer: None,
                },
            ),
            (
                "a row of the clipboard put back on the seat",
                ClientRequest::CopyClipboardEntry { entry: 1 },
            ),
            (
                "a row of the clipboard removed",
                ClientRequest::RemoveClipboardEntry { entry: 1 },
            ),
            (
                "a tray icon clicked",
                ClientRequest::ActivateTrayItem {
                    id: ":1.9/StatusNotifierItem".into(),
                    action: TrayAction::Primary,
                },
            ),
            (
                "a tray menu entry clicked",
                ClientRequest::TrayMenuClicked { bus: ":1.9".into() },
            ),
            (
                "notifications cleared",
                ClientRequest::DismissNotifications { ids: vec![7] },
            ),
            (
                "a notification's action taken",
                ClientRequest::InvokeNotificationAction {
                    id: 7,
                    action: "default".into(),
                },
            ),
            (
                "a notification replied to",
                ClientRequest::ReplyToNotification {
                    id: 7,
                    text: "On my way".into(),
                },
            ),
            (
                "an application's dialog answered",
                ClientRequest::AnswerPortalRequest {
                    id: 1,
                    answer: PortalAnswer::Access,
                },
            ),
            (
                "an application's global shortcut fired",
                ClientRequest::AnswerPortalRequest {
                    id: 1,
                    answer: PortalAnswer::Pressed,
                },
            ),
            (
                "an application's global shortcut let go",
                ClientRequest::AnswerPortalRequest {
                    id: 1,
                    answer: PortalAnswer::Released,
                },
            ),
        ] {
            assert_eq!(
                refused(Asked::OnTheWaylandThread(&request)),
                Some(Refusal::Command),
                "{what} is the desktop acting for whoever is at it, and a \
                 locked desk has nobody it acts for"
            );
        }
    }

    #[test]
    fn what_a_locked_desk_refuses_is_reading_the_home_for_a_launcher() {
        assert_eq!(
            refused(Asked::OnTheConnection(&ConnectionRequest::SearchFiles {
                query: "plan".into(),
            })),
            Some(Refusal::Command),
            "a search of the home reads somebody's files for whoever is at the \
             desk, and a locked desk has nobody it reads for"
        );
    }

    /// The lock screen may still read `/sys`, show and adjust the battery,
    /// brightness and volume, and stop what the shell started. See
    /// `domicile_host::system::reach`.
    #[test]
    fn a_locked_desk_lets_the_shell_read_the_kernel_show_readouts_and_stop_things() {
        assert_eq!(refused(Asked::System(Reach::ReadsTheKernel)), None);
        assert_eq!(refused(Asked::System(Reach::Readout)), None);
        assert_eq!(refused(Asked::System(Reach::Stops)), None);
        assert_eq!(refused(Asked::System(Reach::Listens)), None);
        assert_eq!(refused(Asked::System(Reach::Arranges)), None);
        assert_eq!(
            refused(Asked::System(Reach::Retypes)),
            None,
            "the lock screen switches the keymap the passphrase is typed on"
        );
        assert_eq!(
            refused(Asked::System(Reach::Tints)),
            None,
            "a night light turns on at sunset whether or not anybody is at the desk"
        );
        assert_eq!(
            refused(Asked::System(Reach::Powers)),
            None,
            "turning the screens off is how a locked desk is left, and lighting \
             them shows only the lock screen"
        );
        assert_eq!(
            refused(Asked::System(Reach::Acts)),
            Some(Refusal::Command),
            "a file read, a write or a process is the desktop acting for \
             whoever is at it"
        );
    }

    #[test]
    fn what_the_desktop_says_about_itself_is_not_refused() {
        for (what, request) in [
            (
                "the chrome handing a window the keyboard",
                ClientRequest::KeyboardFocus {
                    app_id: Some("app-1".into()),
                },
            ),
            (
                "the chrome reporting its density",
                ClientRequest::SetOutputScale {
                    ratio: 2.0,
                    scale: 2,
                },
            ),
            (
                "the chrome reporting its size",
                ClientRequest::SetOutputSize {
                    logical: (1920, 1080),
                },
            ),
            (
                "the page reporting where a window is",
                ClientRequest::SetAppBounds {
                    app_id: "app-1".into(),
                    bounds: domicile_scene::Bounds {
                        min: domicile_scene::Point::new(0.0, 0.0),
                        max: domicile_scene::Point::new(800.0, 600.0),
                    },
                },
            ),
            (
                "the page setting a window's states",
                ClientRequest::SetWindowStates {
                    app_id: "app-1".into(),
                    states: vec![domicile_protocol::WindowState::TiledLeft],
                },
            ),
            (
                "the lock screen switching the keymap",
                ClientRequest::SelectKeymap {
                    keymap: domicile_protocol::KeymapChoice::Next,
                },
            ),
            (
                "the page warming the monitors",
                ClientRequest::SetWhitePoint {
                    output: None,
                    white_point: domicile_host::white_point::white_point(3400),
                },
            ),
            (
                "the screens being put to sleep, which the lock already judged",
                ClientRequest::PowerDisplays {
                    power: domicile_host::system::DisplayPower::Asleep,
                    display: None,
                },
            ),
            (
                "a page saying hello",
                ClientRequest::ChromeHello { served_by: None },
            ),
            (
                "a client putting something on the clipboard",
                ClientRequest::ClipboardCopied {
                    clipboard: Clipboard::Copy,
                    contents: domicile_host::clipboard::Contents::text("what was copied"),
                },
            ),
            (
                "a theme turning the desk's windows",
                ClientRequest::TurnTheWindows {
                    theme: Theme::Dark,
                    chromes: vec![1],
                },
            ),
            (
                "a shell holding its old frame for a theme",
                ClientRequest::ThemeCaptured {
                    chrome: 1,
                    theme: Theme::Dark,
                },
            ),
            (
                "somebody typing the passphrase",
                ClientRequest::Unlock {
                    passphrase: Passphrase::from("friend"),
                },
            ),
            (
                "the shell locking a desk already locked",
                ClientRequest::Lock,
            ),
            (
                "a key on the lock screen",
                ClientRequest::Activity { input: None },
            ),
            (
                "the pointer moving over the lock screen",
                ClientRequest::DeskPointer {
                    at: Some((4.0, 8.0)),
                    windows: Vec::new(),
                },
            ),
            (
                "the pointer changing shape over the lock screen",
                ClientRequest::DeskCursor { image: None },
            ),
        ] {
            assert_eq!(
                refused(Asked::OnTheWaylandThread(&request)),
                None,
                "{what} opens nothing, and refusing it would wedge a locked desk \
                 rather than protect it"
            );
        }
        // Answered on the connection, but checked by the same `match`.
        for request in [
            ConnectionRequest::SetTheme { theme: Theme::Dark },
            ConnectionRequest::WhichTheme,
            ConnectionRequest::WhichMonitors,
            ConnectionRequest::WhichDisplays,
            ConnectionRequest::WhichWindows,
            ConnectionRequest::WhichStatus,
            ConnectionRequest::WhichShellCommands,
            ConnectionRequest::WhichShellBindings,
            ConnectionRequest::WhichInputs,
            ConnectionRequest::WhichIdleTime,
        ] {
            assert_eq!(refused(Asked::OnTheConnection(&request)), None);
        }
    }

    #[test]
    fn the_shell_is_told_where_the_desk_stands_rather_than_which_way_it_went() {
        // An inversion would clear the lock screen on lock. Test both values,
        // since either alone would pass an inverted mapping.
        assert_eq!(announced(true), HostMessage::Locked { locked: true });
        assert_eq!(announced(false), HostMessage::Locked { locked: false });
    }
}
