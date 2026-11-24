//! The desktop's `org.freedesktop.Notifications` server.
//!
//! Linux applications send notifications over this D-Bus interface, and so
//! does Chromium for a page's Web Notifications. The shell is a page with no
//! bus access, so this process owns the name and sends the notifications to
//! every chrome as
//! [`HostMessage::Notifications`](domicile_protocol::HostMessage::Notifications).
//! Presses, replies and clears come back as `invoke_notification_action`,
//! `reply_to_notification` and `dismiss_notifications`, and the application
//! gets `ActionInvoked`, `NotificationReplied` and `NotificationClosed`. A
//! press comes with an `xdg-activation` token (`ActivationToken`), which the
//! application raises its window with. A press on a notification whose
//! application has quit starts it instead, from its `desktop-entry` hint, and
//! one whose application runs with no window starts it again as well. See
//! `docs/architecture/NOTIFICATIONS.md`.
//!
//! The notification model is in `domicile_host::notifications`; this module
//! is only the bus. The notification portal (`crate::portals`) adds to the same
//! history through [`NotificationServer::add_from_portal`].
//!
//! `Notify` runs on the bus executor because it must return the id, and it
//! waits only on the store lock and at most one icon read. Dismissals and
//! presses go to a worker thread, which emits the signals.
//!
//! Failure is not fatal, as with [`crate::tray`]: with no session bus, or
//! another daemon holding the name, the desktop has no notifications and logs
//! why once.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use domicile_host::app_names::{app, application_dirs};
use domicile_host::mime_apps::launch_command;
use domicile_host::notifications::{Application, Hints, Image, Notifications, Notified, Notify};
use domicile_host::portal_notifications::{
    Action, Button, Invoked, PortalNotification, PortalNotifications, Priority,
};
use domicile_host::tray::TrayIcons;
use domicile_protocol::Notification;
use tracing::{debug, warn};
use zbus::blocking::object_server::InterfaceRef;
use zbus::blocking::Connection;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::OwnedValue;

/// The name a notification server answers on.
const SERVER_NAME: &str = "org.freedesktop.Notifications";

/// Where it answers.
const SERVER_PATH: &str = "/org/freedesktop/Notifications";

/// The capabilities `GetCapabilities` reports.
///
/// - No `body-markup`: bodies are drawn as plain text, and senders such as
///   Chromium then send no markup.
/// - `inline-reply`: an `inline-reply` action is a reply field.
/// - `persistence`: a notification stays until it is cleared.
/// - `x-kde-origin-name`: Chromium then sends a Web Notification's site as a
///   hint instead of prepending it to the body.
const CAPABILITIES: &[&str] = &[
    "actions",
    "body",
    "icon-static",
    "inline-reply",
    "persistence",
    "x-kde-origin-name",
];

/// The version of the spec this server answers to.
const SPEC_VERSION: &str = "1.2";

/// Why a notification closed, as `NotificationClosed` numbers the reasons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reason {
    /// Evicted to make room in the history.
    Expired = 1,
    /// The user cleared it, or took one of its actions.
    Dismissed = 2,
    /// Its application closed it.
    Closed = 3,
}

/// Something the worker has to do.
enum Event {
    /// The user cleared these.
    Dismiss { ids: Vec<u32> },
    /// The user pressed `action` on `id`. `token` lets its application raise
    /// its window; see [`crate::activation`].
    /// `windowed` says whether the process that sent it has a window.
    Invoke {
        id: u32,
        action: String,
        token: String,
        windowed: bool,
    },
    /// The user replied `text` to `id`.
    Reply { id: u32, text: String },
    /// A portal notification pushed this one out of the history.
    Expired { id: u32 },
}

/// A handle for passing user actions on to the applications, and portal
/// notifications into the history.
///
/// As with [`crate::tray::Tray`], user actions do nothing if the server never
/// started.
#[derive(Clone)]
pub struct NotificationServer {
    told: Sender<Event>,
    store: Arc<Store>,
}

impl NotificationServer {
    /// A server with no bus, for unit tests.
    #[cfg(test)]
    pub fn unserved(data_dirs: Vec<PathBuf>) -> Self {
        let (told, _) = channel();
        NotificationServer {
            told,
            store: Arc::new(Store::new(data_dirs, None)),
        }
    }

    /// Look up icons in the icon theme `theme` from now on. Notifications
    /// already held keep their pictures.
    pub fn retheme(&self, theme: Option<String>) {
        self.store.held.lock().unwrap().notifications.retheme(theme);
    }

    /// Call `publish` with the notifications now and whenever they change.
    pub fn listen(&self, publish: impl Fn(Vec<Notification>) + Send + Sync + 'static) {
        let held = self.store.held.lock().unwrap();
        publish(held.notifications.items());
        if self.store.publish.set(Box::new(publish)).is_err() {
            panic!("the notifications have one listener");
        }
    }

    /// The user cleared `ids`.
    pub fn dismiss(&self, ids: Vec<u32>) {
        // Fails only once the worker has stopped and logged why.
        let _ = self.told.send(Event::Dismiss { ids });
    }

    /// The user looked at a window that process `pid` drew for `app_id`, so
    /// its application's notifications are read. Most applications never
    /// close their own; Slack on Linux does not.
    pub fn seen(&self, pid: Option<u32>, app_id: &str) {
        let ids = self.store.seen_by(pid, app_id);
        if !ids.is_empty() {
            self.dismiss(ids);
        }
    }

    /// The user pressed `action` on `id`. Its application gets `token` to
    /// raise its window with. `windowed` says whether the process that sent
    /// it has a window; one with none is started again to show one.
    ///
    /// The press reads the rest of its application's notifications too, as
    /// GNOME's does, so they clear.
    pub fn invoke(&self, id: u32, action: String, token: String, windowed: bool) {
        let others = self.store.alongside(id);
        let _ = self.told.send(Event::Invoke {
            id,
            action,
            token,
            windowed,
        });
        if !others.is_empty() {
            self.dismiss(others);
        }
    }

    /// The process that sent `id`, if it came over the bus.
    pub fn pid(&self, id: u32) -> Option<u32> {
        self.store.held.lock().unwrap().notifications.pid(id)
    }

    /// The user replied `text` to `id`.
    pub fn reply(&self, id: u32, text: String) {
        let _ = self.told.send(Event::Reply { id, text });
    }

    /// Add or replace `app_id`'s notification `id`, from the notification
    /// portal.
    pub fn add_from_portal(
        &self,
        app_id: String,
        id: String,
        notification: PortalNotification<OwnedValue>,
    ) {
        let app = app(&app_id, &self.store.applications);
        let notified = self.store.change(|held| {
            let notified = held.portal.add(
                &mut held.notifications,
                app,
                app_id,
                id,
                notification,
                now(),
            );
            (
                notified,
                notified
                    .evicted
                    .is_some_and(|evicted| held.portal.forget(evicted)),
            )
        });
        if let (
            Notified {
                evicted: Some(id), ..
            },
            false,
        ) = notified
        {
            let _ = self.told.send(Event::Expired { id });
        }
    }

    /// Warn that the desk does not lock: the machine lacks the lock's PAM
    /// service, as in a `nix run` trial, so nothing could unlock it. Urgent, so
    /// the shell keeps it up until it is read.
    pub fn warn_that_the_desk_does_not_lock(&self) {
        self.add_from_portal(
            OWN_APP.into(),
            "does-not-lock".into(),
            PortalNotification {
                title: "This screen won't lock".into(),
                body: "Domicile's password check isn't set up on this computer, so the screen \
                       won't lock, even when the computer sleeps. Install Domicile to turn the \
                       lock on."
                    .into(),
                icon: None,
                priority: Priority::Urgent,
                default_action: None,
                buttons: Vec::new(),
                display_hint: Vec::new(),
            },
        );
    }

    /// Warn that the engine is a checked build, as on `main` between an engine
    /// change and the next official build. Once per desk: a page that says
    /// hello again does not bring back a warning the person read.
    pub fn warn_that_the_engine_is_checked(&self) {
        if self.store.warned_of_a_checked_engine.set(()).is_ok() {
            self.add_from_portal(
                OWN_APP.into(),
                "checked-engine".into(),
                PortalNotification {
                    title: "This is a development build".into(),
                    body: "It runs slower and uses more memory. For everyday use, switch to \
                           stable or a release."
                        .into(),
                    icon: None,
                    priority: Priority::Urgent,
                    default_action: None,
                    buttons: vec![Button {
                        label: "How to switch".into(),
                        action: Action {
                            name: HOW_TO_SWITCH.into(),
                            target: None,
                        },
                    }],
                    display_hint: Vec::new(),
                },
            );
        }
    }

    /// Warn that the engine draws on the CPU although the desktop started on
    /// the GPU: its GPU process gave up, or never could. That is a bug (in Domicile, Chromium or the graphics driver),
    /// so it is loud: urgent, with a button to report it. Windows that were
    /// drawing on the GPU stay blank.
    pub fn warn_that_graphics_failed(&self) {
        self.add_from_portal(
            OWN_APP.into(),
            "graphics-failed".into(),
            PortalNotification {
                title: "Graphics aren't working".into(),
                body: "Domicile is drawing without the graphics card, so it's slower, and some \
                       open windows may stay blank until you restart them. This is a bug; \
                       please report it."
                    .into(),
                icon: None,
                priority: Priority::Urgent,
                default_action: None,
                buttons: vec![Button {
                    label: "Report it".into(),
                    action: Action {
                        name: REPORT_A_BUG.into(),
                        target: None,
                    },
                }],
                display_hint: Vec::new(),
            },
        );
    }

    /// Warn that the compositor has no EGL renderer, so it can show no app's
    /// window: EGL or the graphics driver failed to load. A bug, so it is loud,
    /// as for [`Self::warn_that_graphics_failed`].
    pub fn warn_that_the_renderer_failed(&self) {
        self.add_from_portal(
            OWN_APP.into(),
            "renderer-failed".into(),
            PortalNotification {
                title: "Graphics aren't working".into(),
                body: "Domicile couldn't start its graphics, so app windows can't be shown. \
                       This is a bug; please report it."
                    .into(),
                icon: None,
                priority: Priority::Urgent,
                default_action: None,
                buttons: vec![Button {
                    label: "Report it".into(),
                    action: Action {
                        name: REPORT_A_BUG.into(),
                        target: None,
                    },
                }],
                display_hint: Vec::new(),
            },
        );
    }

    /// Warn that the engine caught itself in a bug, such as a page it took out
    /// of fullscreen that stayed in. A bug, so it is loud, as for
    /// [`Self::warn_that_graphics_failed`]: urgent, with a button to report it.
    /// `what` says what went wrong. A later fault replaces an earlier one.
    pub fn warn_of_an_engine_fault(&self, what: &str) {
        self.add_from_portal(
            OWN_APP.into(),
            "engine-fault".into(),
            PortalNotification {
                title: "Something went wrong".into(),
                body: format!("{what} This is a bug; please report it."),
                icon: None,
                priority: Priority::Urgent,
                default_action: None,
                buttons: vec![Button {
                    label: "Report it".into(),
                    action: Action {
                        name: REPORT_A_BUG.into(),
                        target: None,
                    },
                }],
                display_hint: Vec::new(),
            },
        );
    }

    /// Tell the person a program a key, the launcher or the config named did
    /// not start, and `why`. Not a bug in Domicile, so not urgent and with no
    /// report button. A later failure replaces an earlier one.
    pub fn warn_that_a_program_did_not_start(&self, why: &str) {
        self.add_from_portal(
            OWN_APP.into(),
            "program-did-not-start".into(),
            PortalNotification {
                title: "A program didn't start".into(),
                body: format!("{why}."),
                icon: None,
                priority: Priority::Normal,
                default_action: None,
                buttons: Vec::new(),
                display_hint: Vec::new(),
            },
        );
    }

    /// Remove `app_id`'s notification `id`, if held.
    pub fn remove_from_portal(&self, app_id: &str, id: &str) {
        self.store
            .change(|held| held.portal.remove(&mut held.notifications, app_id, id));
    }

    /// Call `invoked` with each action the user takes on a portal
    /// notification, and the token its application raises its window with.
    pub fn on_portal_action(
        &self,
        invoked: impl Fn(Invoked<OwnedValue>, String) + Send + Sync + 'static,
    ) {
        if self.store.portal_actions.set(Box::new(invoked)).is_err() {
            panic!("portal notifications have one listener");
        }
    }
}

/// Starts a command with an `xdg-activation` token; see
/// [`crate::spawning::spawn_client`].
pub type Launch = Box<dyn Fn(&[String], &str) + Send>;

/// Start the notification server. Icons and applications are looked up under
/// `data_dirs`, icons in the icon theme `theme`. `launch` starts an
/// application that quit before its notification was pressed. A desk
/// `in_a_window` queues behind its host's server; see [`crate::bus_names`].
///
/// Returns once the thread is spawned, like [`crate::tray::serve`].
/// [`NotificationServer::listen`] says where the notifications go.
pub fn serve(
    data_dirs: Vec<PathBuf>,
    theme: Option<String>,
    launch: Launch,
    in_a_window: bool,
) -> NotificationServer {
    let (told, events) = channel();
    let applications = application_dirs(&data_dirs);
    let store = Arc::new(Store::new(data_dirs, theme));
    let serving = Arc::clone(&store);
    thread::spawn(move || {
        let starting = Starting {
            applications,
            launch,
            in_a_window,
        };
        if let Err(why) = answer(serving, &events, &starting) {
            tracing::error!(
                %why,
                "this desktop is not the notification server; its applications' \
                 notifications will not be shown"
            );
        }
    });
    NotificationServer { told, store }
}

/// Passes a press on a portal notification, and its token, to the portal.
type PortalAction = Box<dyn Fn(Invoked<OwnedValue>, String) + Send + Sync>;

/// The notifications, and who is told when they change.
struct Store {
    /// Where the applications' desktop entries are.
    applications: Vec<PathBuf>,
    held: Mutex<Held>,
    publish: OnceLock<Box<dyn Fn(Vec<Notification>) + Send + Sync>>,
    portal_actions: OnceLock<PortalAction>,
    /// Set once the checked engine's warning was posted.
    warned_of_a_checked_engine: OnceLock<()>,
}

/// The history, and which of it the portal added.
struct Held {
    notifications: Notifications,
    portal: PortalNotifications<OwnedValue>,
}

/// What a press on a notification did.
enum Pressed {
    /// `ActionInvoked` goes to the bus, and `NotificationClosed` if it closes.
    /// Or, if `application` has quit, it is started.
    Bus {
        closes: bool,
        application: Option<Application>,
    },
    /// `ActionInvoked` goes to the portal.
    Portal(Invoked<OwnedValue>),
    /// One of Domicile's own notifications runs this command.
    Launches(Vec<String>),
    NotOffered,
}

impl Store {
    fn new(data_dirs: Vec<PathBuf>, theme: Option<String>) -> Self {
        Store {
            applications: application_dirs(&data_dirs),
            held: Mutex::new(Held {
                notifications: Notifications::new(TrayIcons::new(data_dirs, theme)),
                portal: PortalNotifications::default(),
            }),
            publish: OnceLock::new(),
            portal_actions: OnceLock::new(),
            warned_of_a_checked_engine: OnceLock::new(),
        }
    }

    /// Apply `change` and publish the result. Publishing under the lock keeps
    /// changes in order.
    fn change<T>(&self, change: impl FnOnce(&mut Held) -> T) -> T {
        let mut held = self.held.lock().unwrap();
        let changed = change(&mut held);
        if let Some(publish) = self.publish.get() {
            publish(held.notifications.items());
        }
        changed
    }

    /// Clear `ids`. Returns the held ones the bus sent, in the order given.
    fn dismiss(&self, ids: &[u32]) -> Vec<u32> {
        self.change(|held| {
            let dismissed = held.notifications.dismiss(ids);
            dismissed
                .into_iter()
                .filter(|id| !held.portal.forget(*id))
                .collect()
        })
    }

    /// The notifications of the window that process `pid` drew for `app_id`:
    /// those `pid` sent over the bus and those the portal holds for `app_id`.
    fn seen_by(&self, pid: Option<u32>, app_id: &str) -> Vec<u32> {
        let held = self.held.lock().unwrap();
        pid.map(|pid| held.notifications.sent_by(pid))
            .unwrap_or_default()
            .into_iter()
            .chain(held.portal.of(app_id))
            .collect()
    }

    /// The other notifications from `id`'s application.
    fn alongside(&self, id: u32) -> Vec<u32> {
        let held = self.held.lock().unwrap();
        if held.portal.owns(id) {
            held.portal.alongside(id)
        } else {
            held.notifications.alongside(id)
        }
    }

    /// Reply to `id`. Returns whether it closes, or `None` if it has no
    /// reply field. Portal notifications never have one.
    fn reply(&self, id: u32) -> Option<bool> {
        self.change(|held| held.notifications.reply(id))
    }

    /// Press `action` on `id`.
    fn press(&self, id: u32, action: &str) -> Pressed {
        self.change(|held| {
            if held.portal.owns(id) {
                held.portal
                    .invoke(&mut held.notifications, id, action)
                    .map_or(Pressed::NotOffered, |invoked| {
                        if invoked.app_id == OWN_APP {
                            Pressed::Launches(own_command(&invoked.action))
                        } else {
                            Pressed::Portal(invoked)
                        }
                    })
            } else {
                let application = held.notifications.application(id).cloned();
                held.notifications
                    .invoke(id, action)
                    .map_or(Pressed::NotOffered, |closes| Pressed::Bus {
                        closes,
                        application,
                    })
            }
        })
    }
}

/// Serve the name and handle user events in order. Returns on failure or
/// when the compositor exits.
fn answer(store: Arc<Store>, events: &Receiver<Event>, starting: &Starting) -> zbus::Result<()> {
    let connection = Connection::session()?;
    connection.object_server().at(
        SERVER_PATH,
        Server {
            store: Arc::clone(&store),
        },
    )?;
    crate::bus_names::take(&connection, SERVER_NAME, starting.in_a_window)?;
    debug!("this desktop is the notification server");

    let server = connection
        .object_server()
        .interface::<_, Server>(SERVER_PATH)?;
    // Ends when the compositor exits and drops every sender.
    for event in events {
        match event {
            Event::Dismiss { ids } => {
                for id in store.dismiss(&ids) {
                    closed(&server, id, Reason::Dismissed);
                }
            }
            Event::Invoke {
                id,
                action,
                token,
                windowed,
            } => match store.press(id, &action) {
                Pressed::Bus {
                    closes,
                    application,
                } => match reach(application.as_ref(), windowed, |name| {
                    owned(&connection, name)
                }) {
                    Reached::Heard => pressed_on_the_bus(&server, id, &action, &token, closes),
                    Reached::Started(desktop_entry) => starting.start(desktop_entry, &token),
                    Reached::HeardAndStarted(desktop_entry) => {
                        pressed_on_the_bus(&server, id, &action, &token, closes);
                        starting.start(desktop_entry, &token);
                    }
                },
                Pressed::Portal(pressed) => match store.portal_actions.get() {
                    Some(portal) => portal(pressed, token),
                    None => warn!(%id, "a portal notification's action has no portal to go to"),
                },
                Pressed::Launches(command) => (starting.launch)(&command, &token),
                Pressed::NotOffered => {
                    debug!(%id, %action, "an action on a notification that does not offer it")
                }
            },
            Event::Reply { id, text } => match store.reply(id) {
                Some(closes) => {
                    replied(&server, id, &text);
                    if closes {
                        closed(&server, id, Reason::Dismissed);
                    }
                }
                None => debug!(%id, "a reply to a notification with no reply field"),
            },
            Event::Expired { id } => closed(&server, id, Reason::Expired),
        }
    }
    Ok(())
}

/// Starting applications that quit before their notification was pressed.
struct Starting {
    /// Where their desktop entries are.
    applications: Vec<PathBuf>,
    launch: Launch,
    in_a_window: bool,
}

impl Starting {
    /// Start the application `desktop_entry` names, handing it `token`.
    fn start(&self, desktop_entry: &str, token: &str) {
        let terminal = domicile_host::desk_terminal::current();
        match launch_command(desktop_entry, &self.applications, terminal.as_deref()) {
            Some(command) => (self.launch)(&command, token),
            None => warn!(
                %desktop_entry,
                "a notification's application quit, and has no desktop entry to start it with"
            ),
        }
    }
}

/// The app id Domicile's own notifications go by. Their actions run here,
/// not through the portal.
const OWN_APP: &str = "domicile";

/// The checked engine's warning's button.
const HOW_TO_SWITCH: &str = "how-to-switch";

/// The failed graphics warning's button.
const REPORT_A_BUG: &str = "report-a-bug";

/// What pressing `action` on one of Domicile's own notifications runs.
/// Domicile offers only the actions listed here, so any other is a bug.
fn own_command(action: &str) -> Vec<String> {
    match action {
        HOW_TO_SWITCH => [
            "domicile",
            "open",
            "https://domicile-desktop.com/docs/install",
        ]
        .map(String::from)
        .to_vec(),
        REPORT_A_BUG => [
            "domicile",
            "open",
            "https://github.com/cprussin/domicile/issues",
        ]
        .map(String::from)
        .to_vec(),
        other => panic!("Domicile's own notifications offer no action {other:?}"),
    }
}

/// How a press on a bus notification reaches its application.
#[derive(Debug, PartialEq, Eq)]
enum Reached<'a> {
    /// It hears the press and raises its own window.
    Heard,
    /// It has quit, so the desktop entry starts it.
    Started(&'a str),
    /// It hears the press but has no window to raise, as Slack closed to its
    /// tray. Starting the desktop entry again shows one, as the launcher
    /// would.
    HeardAndStarted(&'a str),
}

/// How a press on a notification from `application` reaches it. `windowed`
/// says whether its process has a window, `owned` whether a bus name is on
/// the bus. One that names no desktop entry can only hear it.
fn reach(
    application: Option<&Application>,
    windowed: bool,
    owned: impl Fn(&str) -> bool,
) -> Reached<'_> {
    match application {
        None => Reached::Heard,
        Some(application) => match (owned(&application.bus_name), windowed) {
            (false, _) => Reached::Started(&application.desktop_entry),
            (true, false) => Reached::HeardAndStarted(&application.desktop_entry),
            (true, true) => Reached::Heard,
        },
    }
}

/// Whether `name` is on the bus. A failed question counts as on: the press
/// then goes to the bus as it did before applications were started.
fn owned(connection: &Connection, name: &str) -> bool {
    let asked = zbus::blocking::fdo::DBusProxy::new(connection).and_then(|bus| {
        let name = zbus::names::BusName::try_from(name).map_err(zbus::Error::from)?;
        bus.name_has_owner(name).map_err(zbus::Error::from)
    });
    asked.unwrap_or_else(|why| {
        warn!(%why, %name, "could not ask whether a notification's application is running");
        true
    })
}

/// The process `sender` belongs to, as the bus knows it. `None` if the bus
/// will not say, which is logged: a press then cannot let that process raise
/// its window with a token of its own (see [`crate::activation::invites`]).
async fn pid(connection: &zbus::Connection, sender: &zbus::names::UniqueName<'_>) -> Option<u32> {
    let asked = match zbus::fdo::DBusProxy::new(connection).await {
        Ok(bus) => {
            bus.get_connection_unix_process_id(sender.clone().into())
                .await
        }
        Err(why) => Err(why.into()),
    };
    asked
        .inspect_err(|why| warn!(%why, %sender, "a notification's process could not be asked"))
        .ok()
}

/// Emit `NotificationClosed`. A failure is logged and ignored, as in
/// `crate::tray::listed`.
fn closed(server: &InterfaceRef<Server>, id: u32, reason: Reason) {
    let said = zbus::block_on(Server::notification_closed(
        server.signal_emitter(),
        id,
        reason as u32,
    ));
    if let Err(why) = said {
        tracing::error!(%why, %id, "a notification's closing could not be said");
    }
}

/// Tell `id`'s application the user pressed `action`: `ActivationToken`
/// first, as the spec orders it, then `ActionInvoked`, and
/// `NotificationClosed` if it `closes`.
fn pressed_on_the_bus(
    server: &InterfaceRef<Server>,
    id: u32,
    action: &str,
    token: &str,
    closes: bool,
) {
    let said = zbus::block_on(Server::activation_token(server.signal_emitter(), id, token));
    if let Err(why) = said {
        tracing::error!(%why, %id, "a notification's activation token could not be said");
    }
    invoked(server, id, action);
    if closes {
        closed(server, id, Reason::Dismissed);
    }
}

/// Emit `ActionInvoked`.
fn invoked(server: &InterfaceRef<Server>, id: u32, action: &str) {
    let said = zbus::block_on(Server::action_invoked(server.signal_emitter(), id, action));
    if let Err(why) = said {
        tracing::error!(%why, %id, "a notification's action could not be said");
    }
}

/// Emit `NotificationReplied`.
fn replied(server: &InterfaceRef<Server>, id: u32, text: &str) {
    let said = zbus::block_on(Server::notification_replied(
        server.signal_emitter(),
        id,
        text,
    ));
    if let Err(why) = said {
        tracing::error!(%why, %id, "a reply to a notification could not be said");
    }
}

/// Milliseconds since the epoch, which shells use for relative times.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is after 1970")
        .as_millis() as u64
}

/// Parse a `Notify`'s hints. A missing or mistyped hint reads as absent;
/// hints the shell does not use are dropped.
fn hints(mut sent: HashMap<String, OwnedValue>) -> Hints {
    let mut first = |names: &[&str]| names.iter().find_map(|name| sent.remove(*name));
    let urgency = first(&["urgency"]).and_then(|value| u8::try_from(value).ok());
    // `image-data` since 1.2, `image_data` in 1.1, `icon_data` before that.
    let image_data = first(&["image-data", "image_data", "icon_data"])
        .and_then(|value| <(i32, i32, i32, bool, i32, i32, Vec<u8>)>::try_from(value).ok())
        .map(
            |(width, height, rowstride, has_alpha, bits_per_sample, channels, data)| Image {
                width,
                height,
                rowstride,
                has_alpha,
                bits_per_sample,
                channels,
                data,
            },
        );
    let image_path =
        first(&["image-path", "image_path"]).and_then(|value| String::try_from(value).ok());
    let resident = first(&["resident"])
        .and_then(|value| bool::try_from(value).ok())
        .unwrap_or(false);
    let origin_name = first(&["x-kde-origin-name"]).and_then(|value| String::try_from(value).ok());
    let desktop_entry = first(&["desktop-entry"]).and_then(|value| String::try_from(value).ok());
    let browser_window =
        first(&["x-domicile-browser-window"]).and_then(|value| String::try_from(value).ok());
    Hints {
        urgency,
        image_data,
        image_path,
        resident,
        origin_name,
        desktop_entry,
        browser_window,
    }
}

/// `app_icon`, else the icon of the sender's desktop entry: the one the
/// `desktop-entry` hint names, else the one `app_name` names. Many
/// applications send no icon and leave the server to find theirs.
fn icon_of(app_icon: String, hints: &Hints, app_name: &str, applications: &[PathBuf]) -> String {
    let entry = hints
        .desktop_entry
        .as_deref()
        .filter(|entry| !entry.is_empty())
        .unwrap_or(app_name);
    if app_icon.is_empty() && !entry.is_empty() {
        app(entry, applications).icon
    } else {
        app_icon
    }
}

/// The object at `/org/freedesktop/Notifications`.
struct Server {
    store: Arc<Store>,
}

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Server {
    fn get_capabilities(&self) -> Vec<String> {
        CAPABILITIES
            .iter()
            .map(|capability| capability.to_string())
            .collect()
    }

    /// Store and publish a notification and return its id. A notification
    /// evicted to make room is reported as expired.
    #[allow(clippy::too_many_arguments)] // The spec's own signature.
    async fn notify(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
        app_name: String,
        replaces_id: u32,
        app_icon: String,
        summary: String,
        body: String,
        actions: Vec<String>,
        hints: HashMap<String, OwnedValue>,
        expire_timeout: i32,
    ) -> u32 {
        let hints = self::hints(hints);
        let app_icon = icon_of(app_icon, &hints, &app_name, &self.store.applications);
        let sent = Notify {
            app_name,
            replaces_id,
            app_icon,
            summary,
            body,
            actions,
            hints,
            expire_timeout,
            icon: None,
            sender: header.sender().map(|sender| sender.to_string()),
            pid: match header.sender() {
                Some(sender) => pid(connection, sender).await,
                None => None,
            },
        };
        let notified = self.store.change(|held| {
            let notified = held.notifications.notify(sent, now());
            Notified {
                evicted: notified
                    .evicted
                    .filter(|evicted| !held.portal.forget(*evicted)),
                ..notified
            }
        });
        if let Some(evicted) = notified.evicted {
            if let Err(why) =
                Self::notification_closed(&emitter, evicted, Reason::Expired as u32).await
            {
                tracing::error!(%why, "a notification's closing could not be said");
            }
        }
        notified.id
    }

    /// The application closing its notification. Closing one already gone
    /// emits nothing.
    async fn close_notification(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
        id: u32,
    ) {
        if self.store.change(|held| held.notifications.close(id)) {
            if let Err(why) = Self::notification_closed(&emitter, id, Reason::Closed as u32).await {
                tracing::error!(%why, "a notification's closing could not be said");
            }
        }
    }

    /// Name, vendor, version and the spec's version.
    fn get_server_information(&self) -> (String, String, String, String) {
        (
            "Domicile".to_string(),
            "Domicile".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
            SPEC_VERSION.to_string(),
        )
    }

    #[zbus(signal)]
    async fn notification_closed(
        emitter: &SignalEmitter<'_>,
        id: u32,
        reason: u32,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn action_invoked(
        emitter: &SignalEmitter<'_>,
        id: u32,
        action_key: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn activation_token(
        emitter: &SignalEmitter<'_>,
        id: u32,
        activation_token: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn notification_replied(
        emitter: &SignalEmitter<'_>,
        id: u32,
        text: &str,
    ) -> zbus::Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portals::socket_pair;
    use domicile_host::portal_notifications::{Action, Priority};
    use domicile_protocol::Urgency;
    use zbus::zvariant::Value;

    #[test]
    fn a_press_starts_an_application_that_has_quit() {
        let chat = Application {
            bus_name: ":1.42".into(),
            desktop_entry: "org.example.Chat".into(),
        };
        assert_eq!(
            reach(Some(&chat), false, |_| false),
            Reached::Started("org.example.Chat")
        );
        // Still running: it hears the press and raises its own window.
        assert_eq!(
            reach(Some(&chat), true, |name| name == ":1.42"),
            Reached::Heard
        );
        // Nothing to start.
        assert_eq!(reach(None, false, |_| false), Reached::Heard);
    }

    #[test]
    fn a_press_starts_a_running_application_with_no_window_again() {
        // Slack closed to its tray hears the press but shows no window.
        // Starting it again does, as launching it from the launcher would.
        let chat = Application {
            bus_name: ":1.42".into(),
            desktop_entry: "org.example.Chat".into(),
        };
        assert_eq!(
            reach(Some(&chat), false, |name| name == ":1.42"),
            Reached::HeardAndStarted("org.example.Chat")
        );
    }

    #[test]
    fn a_press_hands_the_application_a_token_before_the_action() {
        // The spec's order: the application raises its window with the token
        // when it hears the action.
        let (server, client) = socket_pair::connected(|builder| {
            builder
                .serve_at(
                    SERVER_PATH,
                    Server {
                        store: Arc::new(Store::new(Vec::new(), None)),
                    },
                )
                .expect("served")
        });
        let iface = server
            .object_server()
            .interface::<_, Server>(SERVER_PATH)
            .expect("served");
        let mut messages = zbus::blocking::MessageIterator::from(&client);

        pressed_on_the_bus(&iface, 7, "default", "t0k", false);

        let signals: Vec<String> = messages
            .by_ref()
            .map(|message| message.expect("a message"))
            .filter(|message| message.message_type() == zbus::message::Type::Signal)
            .take(2)
            .map(|message| {
                let member = message.header().member().expect("a member").to_string();
                match member.as_str() {
                    "ActivationToken" => {
                        let (id, token): (u32, String) =
                            message.body().deserialize().expect("its arguments");
                        format!("{member} {id} {token}")
                    }
                    _ => {
                        let (id, action): (u32, String) =
                            message.body().deserialize().expect("its arguments");
                        format!("{member} {id} {action}")
                    }
                }
            })
            .collect();
        assert_eq!(
            signals,
            ["ActivationToken 7 t0k", "ActionInvoked 7 default"]
        );
    }

    /// A server with no bus, and what it publishes.
    fn unserved() -> (NotificationServer, Receiver<Vec<Notification>>) {
        let server = NotificationServer::unserved(Vec::new());
        let (publish, published) = channel();
        server.listen(move |items| {
            let _ = publish.send(items);
        });
        (server, published)
    }

    fn from_the_portal(title: &str) -> PortalNotification<OwnedValue> {
        PortalNotification {
            title: title.into(),
            body: String::new(),
            icon: None,
            priority: Priority::Normal,
            default_action: Some(Action {
                name: "app.open".into(),
                target: Some(OwnedValue::from(7u32)),
            }),
            buttons: Vec::new(),
            display_hint: Vec::new(),
        }
    }

    fn bus_notify(summary: &str) -> Notify {
        Notify {
            app_name: "Firefox".into(),
            summary: summary.into(),
            actions: vec!["default".into(), String::new()],
            expire_timeout: -1,
            ..Notify::default()
        }
    }

    #[test]
    fn a_new_icon_theme_draws_the_next_notification() {
        let dir = tempfile::tempdir().unwrap();
        let papirus = dir.path().join("icons/Papirus");
        std::fs::create_dir_all(papirus.join("48x48/apps")).unwrap();
        std::fs::write(
            papirus.join("index.theme"),
            "[Icon Theme]\nDirectories=48x48/apps\n[48x48/apps]\nSize=48\nContext=Applications\n",
        )
        .unwrap();
        std::fs::write(papirus.join("48x48/apps/thunderbird.svg"), "<svg/>").unwrap();
        let server = NotificationServer::unserved(vec![dir.path().to_path_buf()]);

        server.retheme(Some("Papirus".into()));
        let id = server.store.change(|held| {
            held.notifications
                .notify(
                    Notify {
                        app_icon: "thunderbird".into(),
                        ..bus_notify("Mail")
                    },
                    0,
                )
                .id
        });

        let icon = server.store.change(|held| {
            held.notifications
                .items()
                .into_iter()
                .find(|shown| shown.id == id)
                .and_then(|shown| shown.icon)
        });
        assert_eq!(icon, Some("data:image/svg+xml;base64,PHN2Zy8+".into()));
    }

    /// A trial run with no PAM service hears that its screen won't lock. See
    /// `docs/LOCK.md`.
    #[test]
    fn a_desk_that_does_not_lock_says_so_from_the_start() {
        let server = NotificationServer::unserved(Vec::new());

        server.warn_that_the_desk_does_not_lock();

        let shown = server.store.change(|held| {
            held.notifications
                .items()
                .into_iter()
                .map(|shown| (shown.app_name, shown.summary, shown.urgency))
                .collect::<Vec<_>>()
        });
        assert_eq!(
            shown,
            [(
                "Domicile".to_string(),
                "This screen won't lock".to_string(),
                Urgency::Critical
            )],
            "from Domicile, and kept until read"
        );
    }

    /// A checked engine says it is one, from Domicile, and keeps it up until
    /// read. A page that says hello again does not bring a read warning back.
    #[test]
    fn a_checked_engine_warns_once() {
        let server = NotificationServer::unserved(Vec::new());
        let shown = |server: &NotificationServer| {
            server.store.change(|held| {
                held.notifications
                    .items()
                    .into_iter()
                    .map(|shown| (shown.app_name, shown.summary, shown.urgency))
                    .collect::<Vec<_>>()
            })
        };

        server.warn_that_the_engine_is_checked();
        assert_eq!(
            shown(&server),
            [(
                "Domicile".to_string(),
                "This is a development build".to_string(),
                Urgency::Critical
            )],
            "from Domicile, and kept until read"
        );

        server.remove_from_portal("domicile", "checked-engine");
        server.warn_that_the_engine_is_checked();
        assert_eq!(shown(&server), [], "a read warning stays read");
    }

    /// "How to switch" opens the install docs in the desk's browser, rather
    /// than going to a portal no application listens on.
    #[test]
    fn how_to_switch_opens_the_install_docs() {
        let server = NotificationServer::unserved(Vec::new());
        server.warn_that_the_engine_is_checked();
        let (id, buttons) = server.store.change(|held| {
            let shown = held.notifications.items().remove(0);
            (shown.id, shown.actions)
        });
        assert_eq!(
            buttons
                .iter()
                .map(|action| (action.key.as_str(), action.label.as_str()))
                .collect::<Vec<_>>(),
            [("0", "How to switch")]
        );

        match server.store.press(id, "0") {
            Pressed::Launches(command) => assert_eq!(
                command,
                [
                    "domicile",
                    "open",
                    "https://domicile-desktop.com/docs/install"
                ]
            ),
            _ => panic!("Domicile's own button went elsewhere"),
        }
    }

    /// No EGL renderer is a bug too, and it says app windows cannot show.
    #[test]
    fn a_failed_renderer_warns_and_offers_a_report() {
        let server = NotificationServer::unserved(Vec::new());
        server.warn_that_the_renderer_failed();
        let shown = server
            .store
            .change(|held| held.notifications.items().remove(0));
        assert_eq!(
            (
                shown.app_name.as_str(),
                shown.summary.as_str(),
                shown.urgency
            ),
            ("Domicile", "Graphics aren't working", Urgency::Critical),
            "from Domicile, and kept until read"
        );
        assert!(
            shown.body.contains("app windows can't be shown"),
            "the body says what is broken: {}",
            shown.body
        );
        assert_eq!(
            shown
                .actions
                .iter()
                .map(|action| (action.key.as_str(), action.label.as_str()))
                .collect::<Vec<_>>(),
            [("0", "Report it")]
        );
    }

    /// Falling back to software is a bug, so it says so, from Domicile, kept
    /// until read, and "Report it" opens the issue tracker.
    #[test]
    fn failed_graphics_warn_and_offer_a_report() {
        let server = NotificationServer::unserved(Vec::new());
        server.warn_that_graphics_failed();
        let shown = server
            .store
            .change(|held| held.notifications.items().remove(0));
        assert_eq!(
            (
                shown.app_name.as_str(),
                shown.summary.as_str(),
                shown.urgency
            ),
            ("Domicile", "Graphics aren't working", Urgency::Critical),
            "from Domicile, and kept until read"
        );
        assert_eq!(
            shown
                .actions
                .iter()
                .map(|action| (action.key.as_str(), action.label.as_str()))
                .collect::<Vec<_>>(),
            [("0", "Report it")]
        );
        match server.store.press(shown.id, "0") {
            Pressed::Launches(command) => assert_eq!(
                command,
                [
                    "domicile",
                    "open",
                    "https://github.com/cprussin/domicile/issues"
                ]
            ),
            _ => panic!("Domicile's own button went elsewhere"),
        }
    }

    /// An engine fault is a bug, so it says what went wrong, from Domicile,
    /// kept until read, and "Report it" opens the issue tracker.
    #[test]
    fn an_engine_fault_warns_and_offers_a_report() {
        let server = NotificationServer::unserved(Vec::new());
        server.warn_of_an_engine_fault("A page stayed in fullscreen.");
        let shown = server
            .store
            .change(|held| held.notifications.items().remove(0));
        assert_eq!(
            (
                shown.app_name.as_str(),
                shown.summary.as_str(),
                shown.body.as_str(),
                shown.urgency
            ),
            (
                "Domicile",
                "Something went wrong",
                "A page stayed in fullscreen. This is a bug; please report it.",
                Urgency::Critical
            ),
            "from Domicile, saying what, and kept until read"
        );
        match server.store.press(shown.id, "0") {
            Pressed::Launches(command) => assert_eq!(
                command,
                [
                    "domicile",
                    "open",
                    "https://github.com/cprussin/domicile/issues"
                ]
            ),
            _ => panic!("Domicile's own button went elsewhere"),
        }
    }

    #[test]
    fn a_portal_notification_is_named_by_its_applications_entry() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("applications")).unwrap();
        std::fs::write(
            dir.path().join("applications/chromium-browser.desktop"),
            "[Desktop Entry]\nType=Application\nName=Chromium\nExec=chromium\n",
        )
        .unwrap();
        let server = NotificationServer::unserved(vec![dir.path().to_path_buf()]);

        server.add_from_portal(
            "com.chromium.Chromium".into(),
            "update".into(),
            from_the_portal("Update"),
        );

        let names = server.store.change(|held| {
            held.notifications
                .items()
                .into_iter()
                .map(|shown| shown.app_name)
                .collect::<Vec<_>>()
        });
        assert_eq!(names, ["Chromium"]);
    }

    #[test]
    fn a_notification_without_an_icon_is_drawn_with_its_entrys() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("applications")).unwrap();
        std::fs::write(
            dir.path().join("applications/com.slack.Slack.desktop"),
            "[Desktop Entry]\nType=Application\nName=Slack\nExec=slack\nIcon=slack-tray\n",
        )
        .unwrap();
        let applications = application_dirs(&[dir.path().to_path_buf()]);
        let hinted = Hints {
            desktop_entry: Some("com.slack.Slack".into()),
            ..Hints::default()
        };

        assert_eq!(
            icon_of(String::new(), &hinted, "", &applications),
            "slack-tray"
        );
        assert_eq!(
            icon_of(String::new(), &Hints::default(), "Slack", &applications),
            "slack-tray"
        );
        assert_eq!(
            icon_of("mail".into(), &hinted, "Slack", &applications),
            "mail"
        );
        assert_eq!(
            icon_of(String::new(), &Hints::default(), "", &applications),
            ""
        );
    }

    #[test]
    fn a_reply_field_is_offered_to_applications() {
        assert!(CAPABILITIES.contains(&"inline-reply"));
    }

    #[test]
    fn listening_publishes_what_arrived_before() {
        let server = NotificationServer::unserved(Vec::new());
        server.add_from_portal(
            "org.example.App".into(),
            "update".into(),
            from_the_portal("Update"),
        );
        let (publish, published) = channel();

        server.listen(move |items| {
            let _ = publish.send(items);
        });

        assert_eq!(published.try_recv().map(|items| items.len()), Ok(1));
    }

    #[test]
    fn a_portal_notification_is_pressed_through_the_portal() {
        let (server, _published) = unserved();
        let bus = server
            .store
            .change(|held| held.notifications.notify(bus_notify("Mail"), 0).id);
        server.add_from_portal(
            "org.example.App".into(),
            "update".into(),
            from_the_portal("Update"),
        );
        let portal = bus + 1;

        assert!(matches!(
            server.store.press(bus, "default"),
            Pressed::Bus { closes: true, .. }
        ));
        assert!(matches!(
            server.store.press(bus, "default"),
            Pressed::NotOffered
        ));
        match server.store.press(portal, "default") {
            Pressed::Portal(invoked) => {
                assert_eq!(
                    (
                        invoked.app_id.as_str(),
                        invoked.id.as_str(),
                        invoked.action.as_str()
                    ),
                    ("org.example.App", "update", "app.open")
                );
                assert_eq!(invoked.target.map(u32::try_from), Some(Ok(7)));
            }
            _ => panic!("the portal's notification went elsewhere"),
        }
    }

    #[test]
    fn clearing_closes_only_the_buses_own() {
        // A portal notification has no `NotificationClosed` to send.
        let (server, published) = unserved();
        let bus = server
            .store
            .change(|held| held.notifications.notify(bus_notify("Mail"), 0).id);
        server.add_from_portal(
            "org.example.App".into(),
            "update".into(),
            from_the_portal("Update"),
        );

        assert_eq!(server.store.dismiss(&[bus, bus + 1]), [bus]);
        assert_eq!(published.try_iter().last(), Some(Vec::new()));
        assert!(!server.store.held.lock().unwrap().portal.owns(bus + 1));
    }

    #[test]
    fn a_window_names_its_applications_notifications() {
        let (server, _published) = unserved();
        let from = |pid| Notify {
            pid: Some(pid),
            ..bus_notify("Mail")
        };
        let bus = server
            .store
            .change(|held| held.notifications.notify(from(42), 0).id);
        server
            .store
            .change(|held| held.notifications.notify(from(7), 0));
        server.add_from_portal(
            "org.example.App".into(),
            "update".into(),
            from_the_portal("Update"),
        );
        server.add_from_portal(
            "org.example.Other".into(),
            "update".into(),
            from_the_portal("Update"),
        );

        assert_eq!(
            server.store.seen_by(Some(42), "org.example.App"),
            [bus, bus + 2]
        );
        assert_eq!(server.store.seen_by(None, "org.example.Other"), [bus + 3]);
    }

    #[test]
    fn a_notification_names_its_applications_others() {
        let (server, _published) = unserved();
        let from = |pid| Notify {
            pid: Some(pid),
            ..bus_notify("Mail")
        };
        let bus = server
            .store
            .change(|held| held.notifications.notify(from(42), 0).id);
        server
            .store
            .change(|held| held.notifications.notify(from(42), 0));
        server.add_from_portal(
            "org.example.App".into(),
            "update".into(),
            from_the_portal("Update"),
        );
        server.add_from_portal(
            "org.example.App".into(),
            "mail".into(),
            from_the_portal("Mail"),
        );

        assert_eq!(server.store.alongside(bus), [bus + 1]);
        assert_eq!(server.store.alongside(bus + 2), [bus + 3]);
    }

    #[test]
    fn an_application_removes_its_own_portal_notification() {
        let (server, published) = unserved();
        server.add_from_portal(
            "org.example.App".into(),
            "update".into(),
            from_the_portal("Update"),
        );

        server.remove_from_portal("org.example.Other", "update");
        assert_eq!(
            published.try_iter().last().map(|items| items.len()),
            Some(1)
        );
        server.remove_from_portal("org.example.App", "update");
        assert_eq!(published.try_iter().last(), Some(Vec::new()));
    }

    /// `hints` as a `Notify` sends them.
    fn sent(hints: Vec<(&str, Value<'static>)>) -> HashMap<String, OwnedValue> {
        hints
            .into_iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    OwnedValue::try_from(value).expect("an ownable value"),
                )
            })
            .collect()
    }

    fn pixels() -> (i32, i32, i32, bool, i32, i32, Vec<u8>) {
        (1, 1, 4, true, 8, 4, vec![255, 0, 0, 255])
    }

    fn image() -> Image {
        Image {
            width: 1,
            height: 1,
            rowstride: 4,
            has_alpha: true,
            bits_per_sample: 8,
            channels: 4,
            data: vec![255, 0, 0, 255],
        }
    }

    #[test]
    fn what_a_notification_hints_is_read() {
        let read = hints(sent(vec![
            ("urgency", Value::from(2u8)),
            ("image-data", Value::from(pixels())),
            ("image-path", Value::from("/tmp/chrome-icon")),
            ("resident", Value::from(true)),
            ("x-kde-origin-name", Value::from("chat.example.com")),
            ("desktop-entry", Value::from("firefox")),
            ("x-domicile-browser-window", Value::from("7")),
        ]));

        assert_eq!(
            read,
            Hints {
                urgency: Some(2),
                image_data: Some(image()),
                image_path: Some("/tmp/chrome-icon".into()),
                resident: true,
                origin_name: Some("chat.example.com".into()),
                desktop_entry: Some("firefox".into()),
                browser_window: Some("7".into()),
            }
        );
    }

    #[test]
    fn the_older_spellings_of_the_picture_are_read() {
        for name in ["image_data", "icon_data"] {
            let read = hints(sent(vec![(name, Value::from(pixels()))]));
            assert_eq!(read.image_data, Some(image()), "{name}");
        }
        let read = hints(sent(vec![("image_path", Value::from("firefox"))]));
        assert_eq!(read.image_path, Some("firefox".into()));
    }

    #[test]
    fn a_hint_of_the_wrong_type_is_absent() {
        let read = hints(sent(vec![
            ("urgency", Value::from("critical")),
            ("resident", Value::from(1u32)),
            ("image-data", Value::from(7u32)),
        ]));

        assert_eq!(read, Hints::default());
    }
}
