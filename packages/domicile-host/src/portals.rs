//! The portal dialogs waiting on the shell.
//!
//! The compositor's `portals` module takes each backend call off D-Bus,
//! submits it here with whatever answers the application (`W`), and pushes
//! [`Portals::items`] to every chrome. The first answer takes the request off
//! the queue; later ones are refused. Inhibitors ([`Portals::hold`]) are
//! listed too, take no answer, and stay until withdrawn. See
//! `docs/PORTALS.md`.
//!
//! It also lists the sessions that control or capture input
//! ([`Portals::capturing`]), each with what stops it (`S`), so the shell can
//! show and end them.

use domicile_protocol::{Capturing, CapturingKind, PortalAnswer, PortalKind, PortalRequest};

/// A request that was answered or withdrawn already, or never existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("no portal dialog is waiting under this id")]
pub struct Unknown;

/// Why an answer was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// See [`Unknown`].
    #[error("no portal request is waiting under this id")]
    Unknown,
    /// Of another kind than its request, or a choice it did not offer. The
    /// request keeps waiting.
    #[error("the answer does not fit its portal request")]
    Mismatched,
}

/// A request and what answers it.
#[derive(Debug)]
struct Pending<W> {
    request: PortalRequest,
    waiter: W,
}

/// The unanswered requests, oldest first, and the running sessions.
#[derive(Debug)]
pub struct Portals<W, S> {
    next_id: u32,
    listening: bool,
    pending: Vec<Pending<W>>,
    sessions: Vec<(Capturing, S)>,
}

impl<W, S> Default for Portals<W, S> {
    fn default() -> Self {
        Portals {
            next_id: 0,
            listening: false,
            pending: Vec::new(),
            sessions: Vec::new(),
        }
    }
}

impl<W, S> Portals<W, S> {
    pub fn new() -> Self {
        Portals::default()
    }

    /// Whether any chrome is connected to answer.
    ///
    /// Requests stay queued while nobody listens, so a reloading page picks
    /// them up again.
    pub fn set_listening(&mut self, listening: bool) {
        self.listening = listening;
    }

    /// Queue a request and return its id, or hand `waiter` back when no chrome
    /// listens. The caller then answers the application with response `2`.
    pub fn submit(
        &mut self,
        app_id: String,
        parent_app_id: Option<String>,
        kind: PortalKind,
        waiter: W,
    ) -> Result<u32, W> {
        if self.listening {
            Ok(self.push(app_id, parent_app_id, kind, waiter))
        } else {
            Err(waiter)
        }
    }

    /// List `kind`, an inhibitor, until it is withdrawn, whether or not a
    /// chrome listens.
    pub fn hold(
        &mut self,
        app_id: String,
        parent_app_id: Option<String>,
        kind: PortalKind,
        waiter: W,
    ) -> u32 {
        self.push(app_id, parent_app_id, kind, waiter)
    }

    /// Take the request `id` off the queue to answer it with `answer`,
    /// returning its waiter.
    pub fn answer(&mut self, id: u32, answer: &PortalAnswer) -> Result<W, Refusal> {
        match self.position(id) {
            Some(index) if self.pending[index].request.kind.accepts(answer) => {
                Ok(self.pending.remove(index).waiter)
            }
            Some(_) => Err(Refusal::Mismatched),
            None => Err(Refusal::Unknown),
        }
    }

    /// Change the request `id`'s body while it waits, as `UpdateChoices`
    /// does.
    pub fn revise(&mut self, id: u32, revise: impl FnOnce(&mut PortalKind)) -> Result<(), Unknown> {
        let index = self.position(id).ok_or(Unknown)?;
        revise(&mut self.pending[index].request.kind);
        Ok(())
    }

    /// Take the request `id` off the queue unanswered, as when the application
    /// closes it. `None` when it was already answered.
    pub fn withdraw(&mut self, id: u32) -> Option<W> {
        self.position(id)
            .map(|index| self.pending.remove(index).waiter)
    }

    fn position(&self, id: u32) -> Option<usize> {
        self.pending
            .iter()
            .position(|pending| pending.request.id == id)
    }

    /// Queue a request under a new id.
    fn push(
        &mut self,
        app_id: String,
        parent_app_id: Option<String>,
        kind: PortalKind,
        waiter: W,
    ) -> u32 {
        self.next_id += 1;
        self.pending.push(Pending {
            request: PortalRequest {
                id: self.next_id,
                app_id,
                parent_app_id,
                kind,
            },
            waiter,
        });
        self.next_id
    }

    /// List a running session, and return the id that stops it. Shares the
    /// requests' ids, so an answer never reaches the wrong one.
    pub fn begin(&mut self, app_id: String, kind: CapturingKind, stopper: S) -> u32 {
        self.next_id += 1;
        let id = self.next_id;
        self.sessions
            .push((Capturing { id, app_id, kind }, stopper));
        id
    }

    /// Take session `id` off the list, returning what stops it. `None` when
    /// it already ended.
    pub fn end(&mut self, id: u32) -> Option<S> {
        self.sessions
            .iter()
            .position(|(session, _)| session.id == id)
            .map(|index| self.sessions.remove(index).1)
    }

    /// What session `id` takes `answer` with. A stop fits any session; a
    /// pause, resume or discard fits a recording, and a change an agent. A
    /// stop or a discard takes the session off the list.
    pub fn control(&mut self, id: u32, answer: &PortalAnswer) -> Result<S, Refusal>
    where
        S: Clone,
    {
        let index = self
            .sessions
            .iter()
            .position(|(session, _)| session.id == id)
            .ok_or(Refusal::Unknown)?;
        let recording = matches!(self.sessions[index].0.kind, CapturingKind::Recording { .. });
        let agent = matches!(self.sessions[index].0.kind, CapturingKind::Agent(_));
        match answer {
            PortalAnswer::Stop => Ok(self.sessions.remove(index).1),
            PortalAnswer::Change if agent => Ok(self.sessions[index].1.clone()),
            PortalAnswer::Discard if recording => Ok(self.sessions.remove(index).1),
            PortalAnswer::Pause | PortalAnswer::Resume if recording => {
                Ok(self.sessions[index].1.clone())
            }
            _ => Err(Refusal::Mismatched),
        }
    }

    /// Change session `id`'s listing while it runs, as a recording's pause
    /// does.
    pub fn revise_session(
        &mut self,
        id: u32,
        revise: impl FnOnce(&mut CapturingKind),
    ) -> Result<(), Unknown> {
        let (session, _) = self
            .sessions
            .iter_mut()
            .find(|(session, _)| session.id == id)
            .ok_or(Unknown)?;
        revise(&mut session.kind);
        Ok(())
    }

    /// Every running session, oldest first, for the chromes.
    pub fn capturing(&self) -> Vec<Capturing> {
        self.sessions
            .iter()
            .map(|(session, _)| session.clone())
            .collect()
    }

    /// Every unanswered request, oldest first, for the chromes.
    pub fn items(&self) -> Vec<PortalRequest> {
        self.pending
            .iter()
            .map(|pending| pending.request.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domicile_protocol::{
        AccessDialog, AppChooserDialog, Capturing, Devices, Inhibited, Inhibition, PortalAnswer,
        SHELL_APP_ID,
    };

    fn access() -> PortalKind {
        PortalKind::Access(AccessDialog {
            title: "Use the camera?".into(),
            subtitle: String::new(),
            body: String::new(),
            grant_label: None,
            deny_label: None,
            destructive: false,
        })
    }

    fn chooser(choices: &[&str]) -> PortalKind {
        PortalKind::AppChooser(AppChooserDialog {
            choices: choices.iter().map(|choice| choice.to_string()).collect(),
            last_choice: None,
            content_type: None,
            uri: None,
            filename: None,
        })
    }

    fn chose(choice: &str) -> PortalAnswer {
        PortalAnswer::AppChooser {
            choice: choice.into(),
        }
    }

    fn logout() -> PortalKind {
        PortalKind::Inhibit(Inhibition {
            what: vec![Inhibited::Logout],
            reason: None,
        })
    }

    fn listening() -> Portals<&'static str, &'static str> {
        let mut portals = Portals::new();
        portals.set_listening(true);
        portals
    }

    #[test]
    fn a_request_nobody_listens_for_is_handed_back() {
        let mut portals = Portals::<_, ()>::new();

        assert_eq!(
            portals.submit("org.example.App".into(), None, access(), "camera"),
            Err("camera")
        );
        assert_eq!(portals.items(), []);
    }

    #[test]
    fn requests_are_listed_oldest_first_under_their_own_ids() {
        let mut portals = listening();
        let first = portals.submit("one".into(), None, access(), "first");
        let second = portals.submit("two".into(), Some("app-3".into()), access(), "second");

        assert_eq!((first, second), (Ok(1), Ok(2)));
        assert_eq!(
            portals.items(),
            [
                PortalRequest {
                    id: 1,
                    app_id: "one".into(),
                    parent_app_id: None,
                    kind: access(),
                },
                PortalRequest {
                    id: 2,
                    app_id: "two".into(),
                    parent_app_id: Some("app-3".into()),
                    kind: access(),
                },
            ]
        );
    }

    #[test]
    fn the_first_answer_wins() {
        let mut portals = listening();
        let id = portals
            .submit("one".into(), None, access(), "camera")
            .expect("queued");

        assert_eq!(portals.answer(id, &PortalAnswer::Access), Ok("camera"));
        assert_eq!(
            portals.answer(id, &PortalAnswer::Access),
            Err(Refusal::Unknown)
        );
        assert_eq!(portals.items(), []);
    }

    #[test]
    fn an_answer_for_an_id_never_given_out_is_refused() {
        assert_eq!(
            listening().answer(7, &PortalAnswer::Canceled),
            Err(Refusal::Unknown)
        );
    }

    #[test]
    fn a_withdrawn_request_takes_no_answer() {
        let mut portals = listening();
        let id = portals
            .submit("one".into(), None, access(), "camera")
            .expect("queued");

        assert_eq!(portals.withdraw(id), Some("camera"));
        assert_eq!(portals.withdraw(id), None);
        assert_eq!(
            portals.answer(id, &PortalAnswer::Access),
            Err(Refusal::Unknown)
        );
    }

    #[test]
    fn requests_outlive_the_listener_that_saw_them() {
        let mut portals = listening();
        let id = portals
            .submit("one".into(), None, access(), "camera")
            .expect("queued");
        portals.set_listening(false);

        assert_eq!(portals.items().len(), 1);
        assert_eq!(portals.answer(id, &PortalAnswer::Access), Ok("camera"));
    }

    #[test]
    fn ids_are_never_reused() {
        let mut portals = listening();
        let first = portals
            .submit("one".into(), None, access(), "first")
            .expect("queued");
        portals.answer(first, &PortalAnswer::Access).expect("taken");

        assert_eq!(
            portals.submit("one".into(), None, access(), "second"),
            Ok(first + 1)
        );
    }

    #[test]
    fn an_answer_the_request_cannot_take_leaves_it_waiting() {
        let mut portals = listening();
        let id = portals
            .submit("one".into(), None, chooser(&["firefox"]), "open")
            .expect("queued");

        assert_eq!(portals.answer(id, &chose("evil")), Err(Refusal::Mismatched));
        assert_eq!(
            portals.answer(id, &PortalAnswer::Access),
            Err(Refusal::Mismatched)
        );
        assert_eq!(portals.answer(id, &chose("firefox")), Ok("open"));
    }

    #[test]
    fn a_revised_request_takes_answers_by_its_new_body() {
        let mut portals = listening();
        let id = portals
            .submit("one".into(), None, chooser(&["firefox"]), "open")
            .expect("queued");

        assert_eq!(
            portals.revise(id, |kind| *kind = chooser(&["firefox", "chromium"])),
            Ok(())
        );
        assert_eq!(portals.items()[0].kind, chooser(&["firefox", "chromium"]));
        assert_eq!(portals.answer(id, &chose("chromium")), Ok("open"));
    }

    #[test]
    fn a_request_already_answered_cannot_be_revised() {
        assert_eq!(listening().revise(3, |_| ()), Err(Unknown));
    }

    #[test]
    fn an_inhibitor_is_held_while_nobody_listens() {
        // A shell that connects later still shows who holds off logout.
        let mut portals = Portals::<_, ()>::new();

        assert_eq!(portals.hold("one".into(), None, logout(), "editor"), 1);
        assert_eq!(portals.items().len(), 1);
    }

    #[test]
    fn an_inhibitor_takes_no_answer_and_goes_when_withdrawn() {
        // A shell that refuses every request must not end an inhibitor.
        let mut portals = listening();
        let id = portals.hold("one".into(), None, logout(), "editor");

        assert_eq!(
            portals.answer(id, &PortalAnswer::Refused),
            Err(Refusal::Mismatched)
        );
        assert_eq!(portals.withdraw(id), Some("editor"));
        assert_eq!(portals.items(), []);
    }

    fn remote_desktop() -> CapturingKind {
        CapturingKind::RemoteDesktop {
            devices: Devices {
                keyboard: true,
                pointer: true,
                touchscreen: false,
            },
            clipboard: false,
        }
    }

    #[test]
    fn a_session_is_listed_until_it_ends() {
        let mut portals = listening();
        let id = portals.begin("one".into(), remote_desktop(), "stop it");

        assert_eq!(
            portals.capturing(),
            [Capturing {
                id,
                app_id: "one".into(),
                kind: remote_desktop(),
            }]
        );
        assert_eq!(portals.end(id), Some("stop it"));
        assert_eq!(portals.end(id), None);
        assert_eq!(portals.capturing(), []);
    }

    fn recording() -> CapturingKind {
        CapturingKind::Recording {
            sources: Vec::new(),
            file: "/a.webm".into(),
            recorded_ms: 0,
            running_since_ms: Some(1),
        }
    }

    #[test]
    fn a_recording_takes_pauses_and_a_discard_ends_it() {
        let mut portals = listening();
        let id = portals.begin(SHELL_APP_ID.into(), recording(), "record");

        assert_eq!(portals.control(id, &PortalAnswer::Pause), Ok("record"));
        assert_eq!(portals.control(id, &PortalAnswer::Resume), Ok("record"));
        assert_eq!(portals.capturing().len(), 1, "a pause leaves it listed");
        assert_eq!(portals.control(id, &PortalAnswer::Discard), Ok("record"));
        assert_eq!(portals.capturing(), [], "a discard ends it");
        assert_eq!(
            portals.control(id, &PortalAnswer::Pause),
            Err(Refusal::Unknown)
        );
    }

    #[test]
    fn a_stop_ends_any_session_and_only_a_recording_pauses() {
        let mut portals = listening();
        let id = portals.begin("one".into(), remote_desktop(), "stop it");

        assert_eq!(
            portals.control(id, &PortalAnswer::Pause),
            Err(Refusal::Mismatched)
        );
        assert_eq!(
            portals.control(id, &PortalAnswer::Canceled),
            Err(Refusal::Mismatched)
        );
        assert_eq!(portals.control(id, &PortalAnswer::Stop), Ok("stop it"));
        assert_eq!(portals.capturing(), []);
    }

    #[test]
    fn a_running_session_is_revised_in_place() {
        let mut portals = listening();
        let id = portals.begin(SHELL_APP_ID.into(), recording(), "record");

        portals
            .revise_session(id, |kind| {
                if let CapturingKind::Recording {
                    running_since_ms, ..
                } = kind
                {
                    *running_since_ms = None;
                }
            })
            .expect("it runs");

        assert!(matches!(
            portals.capturing()[0].kind,
            CapturingKind::Recording {
                running_since_ms: None,
                ..
            }
        ));
        portals.end(id);
        assert_eq!(portals.revise_session(id, |_| ()), Err(Unknown));
    }

    #[test]
    fn sessions_and_requests_never_share_an_id() {
        let mut portals = listening();
        let session = portals.begin("one".into(), remote_desktop(), "session");
        let request = portals
            .submit("one".into(), None, access(), "request")
            .expect("queued");

        assert_ne!(session, request);
        assert_eq!(
            portals.answer(session, &PortalAnswer::Canceled),
            Err(Refusal::Unknown),
            "a session is no dialog"
        );
        assert_eq!(portals.end(request), None, "a dialog is no session");
    }
}
