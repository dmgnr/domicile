//! The dialogs waiting on the shell, as the backend interfaces see them.
//!
//! An interface's method calls [`ask`] and awaits the shell's answer. The
//! queue itself is `domicile_host::portals`; this adds the bus's `Request`
//! object and who hears each change.
//!
//! A session that controls or captures input is listed with [`Queue::begin`]
//! until it ends, and the shell stops it with [`PortalAnswer::Stop`]. A screen
//! recording, listed with [`Queue::begin_controlled`], also takes
//! [`PortalAnswer::Pause`], [`PortalAnswer::Resume`] and
//! [`PortalAnswer::Discard`], and an agent's [`PortalAnswer::Change`].

use std::sync::{Arc, Mutex, OnceLock};

use domicile_host::portals::{Portals, Unknown};
use domicile_protocol::{Capturing, CapturingKind, PortalAnswer, PortalKind, PortalRequest};
use tracing::{debug, warn};
use zbus::object_server::ObjectServer;
use zbus::zvariant::OwnedObjectPath;

use super::request::Request;
use crate::reply::{reply, Replier};

/// Who hears the queue change, whether anybody can answer, and which
/// `<app>` a `parent_window` names.
struct Listener {
    publish: Box<Publish>,
    listening: Box<dyn Fn() -> bool + Send + Sync>,
    parent: Box<Resolve>,
}

/// Hears the dialogs and the sessions on each change.
type Publish = dyn Fn(Vec<PortalRequest>, Vec<Capturing>) + Send + Sync;

/// Takes the shell's stop, a recording's pause, resume or discard, or an
/// agent's change.
type Controller = Arc<dyn Fn(&PortalAnswer) + Send + Sync>;

/// Resolves a `parent_window` to an app id.
type Resolve = dyn Fn(&str) -> Option<String> + Send + Sync;

/// The pending requests and their listener.
#[derive(Default)]
pub struct Queue {
    held: Mutex<Portals<Replier<PortalAnswer>, Controller>>,
    listener: OnceLock<Listener>,
}

impl Queue {
    /// Publish every change through `publish`. `listening` says whether a
    /// chrome is connected; a request made while none is, or before this is
    /// called, is refused at once. `parent` resolves a `parent_window` to the
    /// app id the dialog is modal over.
    pub fn listen(
        &self,
        publish: impl Fn(Vec<PortalRequest>, Vec<Capturing>) + Send + Sync + 'static,
        listening: impl Fn() -> bool + Send + Sync + 'static,
        parent: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) {
        let listener = Listener {
            publish: Box::new(publish),
            listening: Box::new(listening),
            parent: Box::new(parent),
        };
        if self.listener.set(listener).is_err() {
            panic!("the portal queue has one listener");
        }
    }

    /// The shell's answer to `id`. An answer for a request already answered
    /// or closed is dropped, and so is one that does not fit the request. A
    /// stop ends a running session; one for a session already ended is
    /// dropped.
    pub fn answer(&self, id: u32, answer: PortalAnswer) {
        if matches!(
            answer,
            PortalAnswer::Stop
                | PortalAnswer::Change
                | PortalAnswer::Pause
                | PortalAnswer::Resume
                | PortalAnswer::Discard
        ) {
            // Outside the lock: controlling a session changes the queue
            // again.
            match self.change(|held| held.control(id, &answer)) {
                Ok(control) => control(&answer),
                Err(why) => debug!(%id, %why, ?answer, "a session control was dropped"),
            }
        } else {
            match self.change(|held| held.answer(id, &answer)) {
                Ok(replier) => replier.send(answer),
                Err(why) => debug!(%id, %why, "a portal answer was dropped"),
            }
        }
    }

    /// Change `id`'s body while it waits. `Unknown` once it is answered.
    pub fn revise(&self, id: u32, revise: impl FnOnce(&mut PortalKind)) -> Result<(), Unknown> {
        self.change(|held| held.revise(id, revise))
    }

    /// The application closed `id`'s `Request`: the dialog goes, and the call
    /// ends with response `2`.
    pub fn withdraw(&self, id: u32) {
        if let Some(replier) = self.change(|held| held.withdraw(id)) {
            replier.send(PortalAnswer::Refused);
        }
    }

    /// List an inhibitor until [`Self::withdraw`], whether or not a chrome
    /// listens. Returns its id.
    pub fn hold(&self, app_id: String, parent_window: &str, kind: PortalKind) -> u32 {
        // An inhibitor takes no answer, so nothing awaits this one.
        let (replier, _) = reply();
        let parent = self
            .listener
            .get()
            .and_then(|listener| (listener.parent)(parent_window));
        self.change(|held| held.hold(app_id, parent, kind, replier))
    }

    /// List a running session until [`Queue::end`]. `stop` runs if the shell
    /// stops it first.
    pub fn begin(
        &self,
        app_id: String,
        kind: CapturingKind,
        stop: impl FnOnce() + Send + 'static,
    ) -> u32 {
        // Only a stop reaches a session that is not a recording, and it
        // takes the session off the list, so it comes once.
        let stop = Mutex::new(Some(stop));
        self.begin_controlled(app_id, kind, move |_| {
            if let Some(stop) = stop.lock().unwrap().take() {
                stop();
            }
        })
    }

    /// List a running session until [`Queue::end`]. `control` takes each
    /// stop, pause, resume or discard the shell sends it.
    pub fn begin_controlled(
        &self,
        app_id: String,
        kind: CapturingKind,
        control: impl Fn(&PortalAnswer) + Send + Sync + 'static,
    ) -> u32 {
        self.change(|held| held.begin(app_id, kind, Arc::new(control)))
    }

    /// Change session `id`'s listing while it runs. `Unknown` once it ended.
    pub fn revise_session(
        &self,
        id: u32,
        revise: impl FnOnce(&mut CapturingKind),
    ) -> Result<(), Unknown> {
        self.change(|held| held.revise_session(id, revise))
    }

    /// Take session `id` off the list. Its stopper does not run.
    pub fn end(&self, id: u32) {
        self.change(|held| held.end(id));
    }

    /// Queue a request unpublished, or hand the replier back when nobody
    /// listens. [`ask`] publishes it once its `Request` is exported.
    fn submit(
        &self,
        app_id: String,
        parent_window: &str,
        kind: PortalKind,
        replier: Replier<PortalAnswer>,
    ) -> Result<u32, Replier<PortalAnswer>> {
        match self.listener.get() {
            Some(listener) => {
                let mut held = self.held.lock().unwrap();
                held.set_listening((listener.listening)());
                held.submit(app_id, (listener.parent)(parent_window), kind, replier)
            }
            None => Err(replier),
        }
    }

    /// Publish the queue as it is.
    fn publish(&self) {
        self.change(|_| ());
    }

    /// Apply `change` and publish the result. Publishing under the lock keeps
    /// changes in order.
    fn change<T>(
        &self,
        change: impl FnOnce(&mut Portals<Replier<PortalAnswer>, Controller>) -> T,
    ) -> T {
        let mut held = self.held.lock().unwrap();
        let changed = change(&mut held);
        if let Some(listener) = self.listener.get() {
            (listener.publish)(held.items(), held.capturing());
        }
        changed
    }
}

/// A session's entry in the shell's list. Dropping it takes it off.
pub struct Listed {
    id: u32,
    queue: Arc<Queue>,
}

impl Listed {
    /// Session `id`, which [`Queue::begin`] listed.
    pub fn new(id: u32, queue: &Arc<Queue>) -> Listed {
        Listed {
            id,
            queue: Arc::clone(queue),
        }
    }
}

impl Drop for Listed {
    fn drop(&mut self) {
        self.queue.end(self.id);
    }
}

/// Put a dialog of `kind` to the shell and wait for its answer.
///
/// Exports the frontend's `handle` as a `Request` while the dialog is up, so
/// the application can close it. [`PortalAnswer::Refused`] when nobody
/// listens.
pub async fn ask(
    queue: &Arc<Queue>,
    server: &ObjectServer,
    handle: OwnedObjectPath,
    app_id: String,
    parent_window: &str,
    kind: PortalKind,
) -> PortalAnswer {
    let (replier, answered) = reply();
    match queue.submit(app_id, parent_window, kind, replier) {
        Ok(id) => {
            let request = Request {
                id,
                queue: Arc::clone(queue),
            };
            if let Err(why) = server.at(&handle, request).await {
                warn!(%why, %handle, "a portal request cannot be closed by its application");
            }
            // Not before: a dialog the shell shows must have a `Request` for
            // `Close` and `UpdateChoices` to find.
            queue.publish();
            let answer = answered.await.unwrap_or(PortalAnswer::Refused);
            // Gone already when a `Close` raced the answer.
            let _ = server.remove::<Request, _>(&handle).await;
            answer
        }
        Err(_) => {
            debug!(%handle, "no shell is listening for portal dialogs; refused");
            PortalAnswer::Refused
        }
    }
}

/// Put a dialog of `kind` to the shell for a call that has no `Request`
/// object, such as `ConfigureShortcuts`, and wait for its answer.
/// [`PortalAnswer::Refused`] when nobody listens.
pub async fn ask_unbidden(
    queue: &Queue,
    app_id: String,
    parent_window: &str,
    kind: PortalKind,
) -> PortalAnswer {
    ask_noting(queue, app_id, parent_window, kind, |_| ()).await
}

/// [`ask_unbidden`], handing `noted` the dialog's id once it is queued, so
/// the caller can [`Queue::withdraw`] it.
pub async fn ask_noting(
    queue: &Queue,
    app_id: String,
    parent_window: &str,
    kind: PortalKind,
    noted: impl FnOnce(u32),
) -> PortalAnswer {
    let (replier, answered) = reply();
    match queue.submit(app_id, parent_window, kind, replier) {
        Ok(id) => {
            noted(id);
            queue.publish();
            answered.await.unwrap_or(PortalAnswer::Refused)
        }
        Err(_) => {
            debug!("no shell is listening for portal dialogs; refused");
            PortalAnswer::Refused
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    use domicile_protocol::{CapturingKind, Devices};

    fn input_capture() -> CapturingKind {
        CapturingKind::InputCapture {
            devices: Devices::default(),
        }
    }

    #[test]
    fn the_shell_stops_a_session_and_it_leaves_the_list() {
        let queue = Queue::default();
        let (publish, published) = channel();
        queue.listen(
            move |_, capturing| {
                let _ = publish.send(capturing);
            },
            || true,
            |_| None,
        );
        let (stop, stopped) = channel();
        let id = queue.begin("org.example.App".into(), input_capture(), move || {
            stop.send(()).expect("the test listens");
        });
        assert_eq!(published.try_recv().map(|listed| listed.len()), Ok(1));

        queue.answer(id, PortalAnswer::Stop);

        assert_eq!(stopped.try_recv(), Ok(()));
        assert_eq!(published.try_recv(), Ok(Vec::new()));
    }

    #[test]
    fn a_session_that_ends_itself_is_not_stopped() {
        let queue = Queue::default();
        let (stop, stopped) = channel();
        let id = queue.begin("org.example.App".into(), input_capture(), move || {
            stop.send(()).expect("the test listens");
        });

        queue.end(id);
        queue.answer(id, PortalAnswer::Stop);

        assert!(stopped.try_recv().is_err());
    }
}
