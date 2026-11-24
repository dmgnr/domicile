//! `org.freedesktop.impl.portal.GlobalShortcuts`: chords an application
//! holds while it is not focused.
//!
//! Binding asks the shell to review the chords, unless the user chose them for
//! this app id before. The bound chords ride on every
//! [`HostMessage::PortalRequests`](domicile_protocol::HostMessage::PortalRequests);
//! the shell grabs them as it grabs its own keys and answers
//! [`PortalAnswer::Pressed`] when one fires and [`PortalAnswer::Released`]
//! when it is let go. A locked desk refuses both answers, so nothing fires
//! while locked; locking ends every chord still held. The session state is `domicile_host::global_shortcuts`. See
//! `docs/PORTALS.md`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use domicile_host::global_shortcuts::{self as held, Asked, Listed, NoSession, Saved};
use domicile_protocol::{BoundShortcut, PortalAnswer, PortalKind, ShortcutsDialog};
use tracing::{debug, warn};
use zbus::object_server::{ObjectServer, SignalEmitter};
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

use super::queue::{ask, ask_unbidden, Queue};
use super::session;
use super::OBJECT_PATH;

/// The `org.freedesktop.impl.portal.GlobalShortcuts` version implemented.
const INTERFACE_VERSION: u32 = 2;

/// A shortcut as the portal writes it: its id and its properties.
type Shortcut = (String, HashMap<String, OwnedValue>);

/// The `GlobalShortcuts` backend object.
pub struct GlobalShortcuts {
    pub queue: Arc<Queue>,
    pub shortcuts: Arc<Shortcuts>,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.GlobalShortcuts")]
impl GlobalShortcuts {
    /// A session with nothing bound. Closing it lets go of its chords.
    async fn create_session(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        _handle: OwnedObjectPath,
        session_handle: OwnedObjectPath,
        app_id: String,
        _options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let session = session_handle.to_string();
        let closing = Arc::clone(&self.shortcuts);
        let closed = session.clone();
        let opened = session::open(server, &session_handle, move || {
            closing.change(|held| held.close(&closed));
        })
        .await;
        match opened {
            Ok(true) => {
                self.shortcuts.change(|held| held.create(session, app_id));
                (0, HashMap::new())
            }
            Ok(false) => {
                warn!(%session_handle, "a GlobalShortcuts session reused a handle; refused");
                (2, HashMap::new())
            }
            Err(why) => {
                warn!(%why, %session_handle, "a GlobalShortcuts session cannot be closed by its application; refused");
                (2, HashMap::new())
            }
        }
    }

    /// Bind the chords the user chose for this app id before, or ask the
    /// shell to review them.
    async fn bind_shortcuts(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        session_handle: OwnedObjectPath,
        shortcuts: Vec<Shortcut>,
        parent_window: String,
        _options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let session = session_handle.as_str();
        let asked = asks(shortcuts);
        match self.shortcuts.binding(session, &asked) {
            Ok(Binding::Restored(listed)) => (0, results(&listed)),
            Ok(Binding::Review { app_id, review }) => {
                let kind = PortalKind::GlobalShortcuts(review);
                let answer = ask(&self.queue, server, handle, app_id, &parent_window, kind).await;
                match self.shortcuts.chose(session, &asked, answer) {
                    Ok(listed) => (0, results(&listed)),
                    Err(response) => (response, HashMap::new()),
                }
            }
            Err(NoSession) => (2, HashMap::new()),
        }
    }

    async fn list_shortcuts(
        &self,
        _handle: OwnedObjectPath,
        session_handle: OwnedObjectPath,
    ) -> (u32, HashMap<String, OwnedValue>) {
        match self
            .shortcuts
            .read(|held| held.list(session_handle.as_str()))
        {
            Ok(listed) => (0, results(&listed)),
            Err(NoSession) => (2, HashMap::new()),
        }
    }

    /// Review the session's chords again. Returns at once: the frontend does
    /// not wait for the dialog. A change is reported as `ShortcutsChanged`.
    async fn configure_shortcuts(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
        session_handle: OwnedObjectPath,
        parent_window: String,
        _options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<()> {
        let session = session_handle.to_string();
        let (app_id, asked, review) = self
            .shortcuts
            .read(|held| {
                let asked = held.current(&session)?;
                let review = held.review(&session, &asked)?;
                Ok((held.app_id(&session)?.to_string(), asked, review))
            })
            .map_err(|NoSession| zbus::fdo::Error::UnknownObject(session.clone()))?;
        let queue = Arc::clone(&self.queue);
        let shortcuts = Arc::clone(&self.shortcuts);
        let signaling = connection.clone();
        connection
            .executor()
            .spawn(
                async move {
                    let kind = PortalKind::GlobalShortcuts(review);
                    let answer = ask_unbidden(&queue, app_id, &parent_window, kind).await;
                    if let Ok(listed) = shortcuts.chose(&session, &asked, answer) {
                        let emitter = SignalEmitter::new(&signaling, OBJECT_PATH)
                            .expect("the portal's own path");
                        if let Err(why) = GlobalShortcuts::shortcuts_changed(
                            &emitter,
                            session_handle.as_ref(),
                            described(&listed),
                        )
                        .await
                        {
                            tracing::error!(%why, "an application was not told its global shortcuts changed");
                        }
                    }
                },
                "configure global shortcuts",
            )
            .detach();
        Ok(())
    }

    #[zbus(signal)]
    async fn activated(
        emitter: &SignalEmitter<'_>,
        session_handle: ObjectPath<'_>,
        shortcut_id: &str,
        timestamp: u64,
        options: HashMap<String, OwnedValue>,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn deactivated(
        emitter: &SignalEmitter<'_>,
        session_handle: ObjectPath<'_>,
        shortcut_id: &str,
        timestamp: u64,
        options: HashMap<String, OwnedValue>,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn shortcuts_changed(
        emitter: &SignalEmitter<'_>,
        session_handle: ObjectPath<'_>,
        shortcuts: Vec<Shortcut>,
    ) -> zbus::Result<()>;

    #[zbus(property(emits_changed_signal = "const"))]
    fn version(&self) -> u32 {
        INTERFACE_VERSION
    }
}

/// The sessions and their chords, shared by the D-Bus object and the shell's
/// presses.
pub struct Shortcuts {
    held: Mutex<held::GlobalShortcuts>,
    file: Option<PathBuf>,
    publish: OnceLock<Box<dyn Fn(Vec<BoundShortcut>) + Send + Sync>>,
    connection: OnceLock<zbus::Connection>,
    started: Instant,
}

impl Shortcuts {
    /// Starts from the choices saved in `file`. An unreadable file is set
    /// aside: applications ask again. `None` keeps choices in memory.
    pub fn new(file: Option<PathBuf>) -> Self {
        let saved = match &file {
            Some(file) => Saved::load(file).unwrap_or_else(|why| {
                tracing::error!(%why, file = %file.display(), "saved global shortcuts are unreadable; applications will ask again");
                Saved::default()
            }),
            None => Saved::default(),
        };
        Shortcuts {
            held: Mutex::new(held::GlobalShortcuts::new(saved)),
            file,
            publish: OnceLock::new(),
            connection: OnceLock::new(),
            started: Instant::now(),
        }
    }

    /// Publish the bound chords through `publish` on every change.
    pub fn listen(&self, publish: impl Fn(Vec<BoundShortcut>) + Send + Sync + 'static) {
        if self.publish.set(Box::new(publish)).is_err() {
            panic!("the global shortcuts have one listener");
        }
    }

    /// Signal on `connection` from here on.
    pub fn signal_on(&self, connection: zbus::Connection) {
        if self.connection.set(connection).is_err() {
            panic!("the global shortcuts signal on one connection");
        }
    }

    /// The shell says the chord bound under `id` fired: `Activated` to the
    /// session holding it.
    pub fn pressed(&self, id: u32) {
        let fired = self.held.lock().unwrap().pressed(id);
        self.signal(id, fired, Signal::Activated);
    }

    /// The shell says the chord bound under `id` was let go: `Deactivated`,
    /// if it was pressed.
    pub fn released(&self, id: u32) {
        let fired = self.held.lock().unwrap().released(id);
        self.signal(id, fired, Signal::Deactivated);
    }

    /// End every chord still held: `Deactivated` for each, once. Its key-up
    /// later ends nothing.
    pub fn let_go_of_everything(&self) {
        let held = self.held.lock().unwrap().let_go_of_everything();
        for (id, fired) in held {
            self.signal(id, Some(fired), Signal::Deactivated);
        }
    }

    /// Send `signal` for `fired`, the session and shortcut id. A chord no
    /// longer bound, or a bus not yet up, sends nothing.
    fn signal(&self, id: u32, fired: Option<(String, String)>, signal: Signal) {
        let Some((session, shortcut)) = fired else {
            debug!(%id, "a global shortcut fired after it was let go");
            return;
        };
        let Some(connection) = self.connection.get() else {
            debug!(%id, "a global shortcut fired before the portal was on the bus");
            return;
        };
        let emitter = SignalEmitter::new(connection, OBJECT_PATH).expect("the portal's own path");
        let session = ObjectPath::try_from(session.as_str()).expect("a session's own handle");
        let timestamp = u64::try_from(self.started.elapsed().as_millis())
            .expect("a desk up for fewer than 584 million years");
        let sent = zbus::block_on(async {
            match signal {
                Signal::Activated => {
                    GlobalShortcuts::activated(
                        &emitter,
                        session,
                        &shortcut,
                        timestamp,
                        HashMap::new(),
                    )
                    .await
                }
                Signal::Deactivated => {
                    GlobalShortcuts::deactivated(
                        &emitter,
                        session,
                        &shortcut,
                        timestamp,
                        HashMap::new(),
                    )
                    .await
                }
            }
        });
        if let Err(why) = sent {
            tracing::error!(%why, %shortcut, "an application did not hear its global shortcut");
        }
    }

    /// Bind `asked` from the saved choices, or the review to put to the shell.
    fn binding(&self, session: &str, asked: &[Asked]) -> Result<Binding, NoSession> {
        match self.change(|held| held.restore(session, asked))? {
            Some(listed) => Ok(Binding::Restored(listed)),
            None => self.read(|held| {
                Ok(Binding::Review {
                    app_id: held.app_id(session)?.to_string(),
                    review: held.review(session, asked)?,
                })
            }),
        }
    }

    /// Bind what the user chose in a review of `asked`, or the response that
    /// ends the call: `1` dismissed, `2` for any other end.
    fn chose(
        &self,
        session: &str,
        asked: &[Asked],
        answer: PortalAnswer,
    ) -> Result<Vec<Listed>, u32> {
        match answer {
            PortalAnswer::GlobalShortcuts { triggers } => self
                .change(|held| held.bind(session, asked, &triggers))
                .map_err(|NoSession| 2),
            PortalAnswer::Canceled => Err(1),
            PortalAnswer::Access
            | PortalAnswer::AppChooser { .. }
            | PortalAnswer::FileChooser(_)
            | PortalAnswer::RemoteDesktop { .. }
            | PortalAnswer::InputCapture
            | PortalAnswer::DynamicLauncher { .. }
            | PortalAnswer::ScreenCast { .. }
            | PortalAnswer::Print { .. }
            | PortalAnswer::SaveToPdf { .. }
            | PortalAnswer::Screenshot { .. }
            | PortalAnswer::ScreenshotWindow { .. }
            | PortalAnswer::ScreenshotBrowserWindow { .. }
            | PortalAnswer::PickColor { .. }
            | PortalAnswer::Agent { .. }
            | PortalAnswer::Change
            | PortalAnswer::Stop
            | PortalAnswer::Pause
            | PortalAnswer::Resume
            | PortalAnswer::Discard
            | PortalAnswer::Refused
            | PortalAnswer::Pressed
            | PortalAnswer::Released => Err(2),
        }
    }

    fn read<T>(&self, read: impl FnOnce(&held::GlobalShortcuts) -> T) -> T {
        read(&self.held.lock().unwrap())
    }

    /// Apply `change`, then save the choices and publish the chords if they
    /// changed. Under the lock, so changes are published in order.
    fn change<T>(&self, change: impl FnOnce(&mut held::GlobalShortcuts) -> T) -> T {
        let mut held = self.held.lock().unwrap();
        let (saved, bound) = (held.saved().clone(), held.bound());
        let changed = change(&mut held);
        if let Some(file) = self.file.as_ref().filter(|_| *held.saved() != saved) {
            if let Err(why) = held.saved().store(file) {
                tracing::error!(%why, file = %file.display(), "global shortcut choices were not saved; applications will ask again next session");
            }
        }
        if let Some(publish) = self.publish.get().filter(|_| held.bound() != bound) {
            publish(held.bound());
        }
        changed
    }
}

/// Which signal a press or a release sends.
enum Signal {
    Activated,
    Deactivated,
}

/// How a `BindShortcuts` call is answered.
enum Binding {
    /// From the choices the user made before.
    Restored(Vec<Listed>),
    /// By the user, in this review.
    Review {
        app_id: String,
        review: ShortcutsDialog,
    },
}

/// The shortcuts a `BindShortcuts` call asks for. A property of the wrong type
/// reads as absent.
fn asks(shortcuts: Vec<Shortcut>) -> Vec<Asked> {
    shortcuts
        .into_iter()
        .map(|(id, mut properties)| {
            let mut text = |name: &str| {
                properties
                    .remove(name)
                    .and_then(|value| String::try_from(value).ok())
            };
            Asked {
                id,
                description: text("description").unwrap_or_default(),
                preferred: text("preferred_trigger"),
            }
        })
        .collect()
}

/// `BindShortcuts` and `ListShortcuts` results: `shortcuts`.
fn results(listed: &[Listed]) -> HashMap<String, OwnedValue> {
    HashMap::from([(
        "shortcuts".to_string(),
        OwnedValue::try_from(Value::from(described(listed))).expect("an ownable list"),
    )])
}

/// Each shortcut with its `description` and `trigger_description`, empty for
/// a cleared one.
fn described(listed: &[Listed]) -> Vec<Shortcut> {
    let text = |text: &str| OwnedValue::try_from(Value::from(text)).expect("an ownable string");
    listed
        .iter()
        .map(|listed| {
            (
                listed.id.clone(),
                HashMap::from([
                    ("description".to_string(), text(&listed.description)),
                    (
                        "trigger_description".to_string(),
                        text(listed.trigger.as_deref().unwrap_or_default()),
                    ),
                ]),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver};
    use std::thread;
    use std::time::Duration;

    use domicile_protocol::{ChosenTrigger, PortalRequest, ProposedShortcut};
    use zbus::blocking::{Connection, MessageIterator};
    use zbus::message::Type;

    use crate::notifications::NotificationServer;
    use crate::portals::restore::Tokens;
    use crate::portals::socket_pair::connected;
    use crate::portals::{Backends, Portals};

    const INTERFACE: &str = "org.freedesktop.impl.portal.GlobalShortcuts";
    const SESSION: &str = "/org/freedesktop/portal/desktop/session/1_7/s";
    const REQUEST: &str = "/org/freedesktop/portal/desktop/request/1_7/r";
    const APP: &str = "org.example.App";

    /// The backend served to a client, and what it publishes.
    struct Served {
        client: Connection,
        queue: Arc<Queue>,
        /// The handle the shell's answers reach.
        portals: Portals,
        dialogs: Receiver<Vec<PortalRequest>>,
        bound: Receiver<Vec<BoundShortcut>>,
        // Held so the client's peer stays up.
        _server: Connection,
    }

    fn served(file: Option<PathBuf>) -> Served {
        let (backends, _) = Backends::new(
            NotificationServer::unserved(Vec::new()),
            Tokens::load(None),
            Shortcuts::new(file),
        );
        let (publish_dialogs, dialogs) = channel();
        backends.queue.listen(
            move |items, _| {
                let _ = publish_dialogs.send(items);
            },
            || true,
            |_| None,
        );
        let (publish_bound, bound) = channel();
        backends.shortcuts.listen(move |items| {
            let _ = publish_bound.send(items);
        });
        let (server, client) = connected(|builder| {
            builder
                .serve_at(
                    OBJECT_PATH,
                    GlobalShortcuts {
                        queue: Arc::clone(&backends.queue),
                        shortcuts: Arc::clone(&backends.shortcuts),
                    },
                )
                .expect("served")
        });
        backends.shortcuts.signal_on(server.inner().clone());
        Served {
            client,
            queue: Arc::clone(&backends.queue),
            portals: Portals {
                links: domicile_host::links::Links::default(),
                agents: crate::portals::agent::Door::new(
                    Arc::clone(&backends.queue),
                    None,
                    Arc::new(|| 0),
                    crate::portals::agent::PATIENCE,
                    crate::portals::agent::Accessibility {
                        enabled: Box::new(|| true),
                        enable: Box::new(|_| {}),
                    },
                ),
                backends,
                shots: crate::portals::Shots::none(),
                shell_dialog: crate::portals::screenshot::ShellDialog::default(),
                recordings: None,
            },
            dialogs,
            bound,
            _server: server,
        }
    }

    fn call<B>(client: &Connection, path: &str, member: &str, body: &B) -> zbus::Message
    where
        B: zbus::export::serde::Serialize + zbus::zvariant::DynamicType,
    {
        client
            .call_method(None::<&str>, path, Some(INTERFACE), member, body)
            .expect("answered")
    }

    fn path(path: &str) -> ObjectPath<'_> {
        ObjectPath::try_from(path).expect("a path")
    }

    fn no_options() -> HashMap<String, OwnedValue> {
        HashMap::new()
    }

    fn create_session(client: &Connection) {
        let (response, _): (u32, HashMap<String, OwnedValue>) = call(
            client,
            OBJECT_PATH,
            "CreateSession",
            &(path(REQUEST), path(SESSION), APP, no_options()),
        )
        .body()
        .deserialize()
        .expect("its reply");
        assert_eq!(response, 0);
    }

    /// Call `BindShortcuts` for one push-to-talk shortcut from another
    /// thread, returning its response and the triggers it reports.
    fn bind(client: &Connection) -> thread::JoinHandle<(u32, Vec<(String, String)>)> {
        let client = client.clone();
        thread::spawn(move || {
            let properties = HashMap::from([
                ("description".to_string(), owned("Push to talk")),
                ("preferred_trigger".to_string(), owned("CTRL+ALT+t")),
            ]);
            let reply = call(
                &client,
                OBJECT_PATH,
                "BindShortcuts",
                &(
                    path(REQUEST),
                    path(SESSION),
                    vec![("talk".to_string(), properties)],
                    "",
                    no_options(),
                ),
            );
            let (response, mut results): (u32, HashMap<String, OwnedValue>) =
                reply.body().deserialize().expect("its reply");
            (
                response,
                results
                    .remove("shortcuts")
                    .map(triggers)
                    .unwrap_or_default(),
            )
        })
    }

    fn owned(text: &str) -> OwnedValue {
        OwnedValue::try_from(Value::from(text)).expect("ownable")
    }

    /// Each shortcut's id and `trigger_description`.
    fn triggers(shortcuts: OwnedValue) -> Vec<(String, String)> {
        Vec::<Shortcut>::try_from(shortcuts)
            .expect("a(sa{sv})")
            .into_iter()
            .map(|(id, mut properties)| {
                let trigger = properties
                    .remove("trigger_description")
                    .map(|value| String::try_from(value).expect("a string"))
                    .expect("a trigger description");
                (id, trigger)
            })
            .collect()
    }

    #[track_caller]
    fn next<T>(published: &Receiver<T>) -> T {
        published
            .recv_timeout(Duration::from_secs(10))
            .expect("published")
    }

    /// The next signal the client hears, and its member.
    fn next_signal(heard: &mut MessageIterator) -> (String, zbus::Message) {
        let message = heard
            .by_ref()
            .map(|message| message.expect("a message"))
            .find(|message| message.message_type() == Type::Signal)
            .expect("a signal");
        let member = message.header().member().expect("a member").to_string();
        (member, message)
    }

    /// Bind through the review dialog, choosing `Ctrl+Alt+t`.
    fn bind_through_the_dialog(served: &Served) -> BoundShortcut {
        let binding = bind(&served.client);
        let [request] = &next(&served.dialogs)[..] else {
            panic!("one dialog");
        };
        assert_eq!(request.app_id, APP);
        assert_eq!(
            request.kind,
            PortalKind::GlobalShortcuts(ShortcutsDialog {
                shortcuts: vec![ProposedShortcut {
                    id: "talk".into(),
                    description: "Push to talk".into(),
                    trigger: Some("CTRL+ALT+t".into()),
                }],
                taken: Vec::new(),
            })
        );
        served.queue.answer(
            request.id,
            PortalAnswer::GlobalShortcuts {
                triggers: vec![ChosenTrigger {
                    id: "talk".into(),
                    trigger: Some("Ctrl+Alt+t".into()),
                }],
            },
        );

        assert_eq!(
            binding.join().expect("bound"),
            (0, vec![("talk".to_string(), "Ctrl+Alt+t".to_string())])
        );
        assert_eq!(next(&served.dialogs), [], "the review is gone");
        let [bound] = &next(&served.bound)[..] else {
            panic!("one chord bound");
        };
        assert_eq!(
            (bound.app_id.as_str(), bound.chord.as_str()),
            (APP, "Ctrl+Alt+t")
        );
        bound.clone()
    }

    /// The member, shortcut id and timestamp of the next signal the client
    /// hears, an `Activated` or `Deactivated`.
    fn fired(heard: &mut MessageIterator) -> (String, String, u64) {
        let (member, message) = next_signal(heard);
        let (session, id, timestamp, _): (
            OwnedObjectPath,
            String,
            u64,
            HashMap<String, OwnedValue>,
        ) = message.body().deserialize().expect("its body");
        assert_eq!(session.as_str(), SESSION);
        (member, id, timestamp)
    }

    #[test]
    fn a_reviewed_chord_is_activated_on_its_press_and_deactivated_on_its_release() {
        let served = served(None);
        let mut heard = MessageIterator::from(served.client.clone());
        create_session(&served.client);
        let bound = bind_through_the_dialog(&served);

        served.portals.answer(bound.id, PortalAnswer::Pressed);
        let (member, id, pressed_at) = fired(&mut heard);
        assert_eq!((member.as_str(), id.as_str()), ("Activated", "talk"));
        thread::sleep(Duration::from_millis(50));
        served.portals.answer(bound.id, PortalAnswer::Released);
        let (member, id, released_at) = fired(&mut heard);

        assert_eq!((member.as_str(), id.as_str()), ("Deactivated", "talk"));
        assert!(
            released_at >= pressed_at + 50,
            "deactivated at {released_at} ms, held from {pressed_at} ms"
        );
    }

    #[test]
    fn letting_go_of_held_chords_deactivates_each_once() {
        let served = served(None);
        let mut heard = MessageIterator::from(served.client.clone());
        create_session(&served.client);
        let bound = bind_through_the_dialog(&served);
        served.portals.answer(bound.id, PortalAnswer::Pressed);
        fired(&mut heard);

        served.portals.let_go_of_held_shortcuts();
        let (member, id, _) = fired(&mut heard);
        assert_eq!((member.as_str(), id.as_str()), ("Deactivated", "talk"));

        served.portals.answer(bound.id, PortalAnswer::Released);
        served.portals.answer(bound.id, PortalAnswer::Pressed);
        let (member, _, _) = fired(&mut heard);
        assert_eq!(member, "Activated", "the late release ended nothing");
    }

    #[test]
    fn an_application_binding_its_chords_again_gets_them_without_a_dialog() {
        let dir = tempfile::tempdir().expect("a directory");
        let file = dir.path().join("global-shortcuts.json");
        {
            let served = served(Some(file.clone()));
            create_session(&served.client);
            bind_through_the_dialog(&served);
        }
        let later = served(Some(file));
        create_session(&later.client);

        assert_eq!(
            bind(&later.client).join().expect("bound"),
            (0, vec![("talk".to_string(), "Ctrl+Alt+t".to_string())])
        );
        assert!(
            later.dialogs.try_iter().all(|items| items.is_empty()),
            "no dialog"
        );
    }

    #[test]
    fn a_dismissed_review_binds_nothing() {
        let served = served(None);
        create_session(&served.client);
        let binding = bind(&served.client);
        let id = next(&served.dialogs)[0].id;

        served.queue.answer(id, PortalAnswer::Canceled);

        assert_eq!(binding.join().expect("answered"), (1, Vec::new()));
        assert!(served.bound.try_iter().all(|items| items.is_empty()));
    }

    #[test]
    fn a_session_lists_its_shortcuts_and_closing_it_lets_go_of_them() {
        let served = served(None);
        create_session(&served.client);
        bind_through_the_dialog(&served);

        let (response, results): (u32, HashMap<String, OwnedValue>) = call(
            &served.client,
            OBJECT_PATH,
            "ListShortcuts",
            &(path(REQUEST), path(SESSION)),
        )
        .body()
        .deserialize()
        .expect("its reply");
        assert_eq!(response, 0);
        assert_eq!(
            triggers(
                results
                    .get("shortcuts")
                    .expect("listed")
                    .try_clone()
                    .expect("cloned")
            ),
            [("talk".to_string(), "Ctrl+Alt+t".to_string())]
        );

        served
            .client
            .call_method(
                None::<&str>,
                SESSION,
                Some("org.freedesktop.impl.portal.Session"),
                "Close",
                &(),
            )
            .expect("closed");
        assert_eq!(next(&served.bound), []);
    }

    #[test]
    fn configuring_reviews_the_chords_again_and_says_what_changed() {
        let served = served(None);
        let mut heard = MessageIterator::from(served.client.clone());
        create_session(&served.client);
        bind_through_the_dialog(&served);

        call(
            &served.client,
            OBJECT_PATH,
            "ConfigureShortcuts",
            &(path(SESSION), "", no_options()),
        );
        let [request] = &next(&served.dialogs)[..] else {
            panic!("one dialog");
        };
        let PortalKind::GlobalShortcuts(review) = &request.kind else {
            panic!("a review");
        };
        assert_eq!(review.shortcuts[0].trigger.as_deref(), Some("Ctrl+Alt+t"));
        served.queue.answer(
            request.id,
            PortalAnswer::GlobalShortcuts {
                triggers: vec![ChosenTrigger {
                    id: "talk".into(),
                    trigger: Some("Ctrl+Alt+y".into()),
                }],
            },
        );

        let (member, message) = next_signal(&mut heard);
        let (session, shortcuts): (OwnedObjectPath, Vec<Shortcut>) =
            message.body().deserialize().expect("its body");
        assert_eq!(
            (member.as_str(), session.as_str(), shortcuts[0].0.as_str()),
            ("ShortcutsChanged", SESSION, "talk")
        );
        assert_eq!(next(&served.bound)[0].chord, "Ctrl+Alt+y");
    }

    #[test]
    fn binding_for_a_session_never_created_is_refused() {
        let served = served(None);

        assert_eq!(
            bind(&served.client).join().expect("answered"),
            (2, Vec::new())
        );
    }
}
