//! The D-Bus side of the system tray: the compositor is the
//! StatusNotifierItem watcher and host, and sends the items to the shell as
//! [`HostMessage::Tray`](domicile_protocol::HostMessage::Tray).
//!
//! Item parsing and the [`Registry`] live in `domicile_host::tray`. Design:
//! `docs/architecture/SYSTEM-TRAY.md`.
//!
//! - Watcher methods, item signals and clicks are events on one channel,
//!   handled by one worker thread. Watcher methods must not block zbus's
//!   executor.
//! - Each item read runs on its own thread, because a call waits until its
//!   application answers or [`ANSWER_WITHIN`] passes, and one slow
//!   application must not stall the others. An item has at most one read in
//!   flight (see [`Reads`]).
//! - Clicks arrive through the Wayland thread, which refuses them while
//!   locked (see [`crate::lock::refused`]). Each carries an `xdg-activation`
//!   token, given to the item with `ProvideXdgActivationToken`, which also
//!   lets the item's process raise its window with a token of its own (see
//!   [`crate::activation::invites`]). A window in a hidden tab or on another
//!   workspace is then shown.
//! - Failure leaves the tray empty and logs once. A bare tty may have no
//!   session bus, and a nested desktop may find the watcher name taken.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use domicile_host::tray::{
    address, item, method, Landed, Pixmap, Properties, Reads, Registry, Status, TrayIcons,
};
use domicile_protocol::{TrayAction, TrayItem};
use tracing::{debug, warn};
use zbus::blocking::connection::Builder;
use zbus::blocking::object_server::InterfaceRef;
use zbus::blocking::{Connection, MessageIterator, Proxy};
use zbus::message::{Header, Type};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};
use zbus::MatchRule;

/// The watcher's bus name. Items look for KDE's name; the freedesktop one was
/// never adopted.
const WATCHER_NAME: &str = "org.kde.StatusNotifierWatcher";

/// The watcher's object path.
const WATCHER_PATH: &str = "/StatusNotifierWatcher";

/// The interface every item implements.
const ITEM_INTERFACE: &str = "org.kde.StatusNotifierItem";

/// How long a call on the tray's connection waits for a reply. Without it, a
/// hung item would hold its read, and its thread, forever.
const ANSWER_WITHIN: Duration = Duration::from_secs(3);

/// The longest wait before reading an item that timed out again. The waits
/// double from [`ANSWER_WITHIN`] up to this.
const RETRY_AT_MOST: Duration = Duration::from_secs(60);

/// Work for the worker thread.
enum Event {
    /// `RegisterStatusNotifierItem(service)`, from `sender`.
    Registered { service: String, sender: String },
    /// An item's `New*` signal: its appearance changed.
    Changed { sender: String, path: String },
    /// A connection or a well-known name went away (`owner` empty), or a
    /// well-known name changed hands.
    Owner { name: String, owner: String },
    /// The result of the `sequence`-th read of `id`.
    Read {
        id: String,
        sequence: u64,
        properties: zbus::Result<HashMap<String, OwnedValue>>,
    },
    /// A shell clicked an entry of the menu on `bus`, with a `token` to raise
    /// a window with. The click itself is the shell's own D-Bus call.
    Provide { bus: String, token: String },
    /// A shell clicked an icon, with a `token` to raise a window with.
    Activate {
        id: String,
        action: TrayAction,
        token: String,
    },
    /// The config's icon theme changed.
    Rethemed { theme: Option<String> },
    /// Time to read item `id` again, after a read that timed out.
    Retry { id: String },
}

/// A handle that forwards clicks to tray items.
///
/// Works the same when the watcher failed to start; clicks then go nowhere,
/// like [`crate::portals::Portals`].
#[derive(Debug, Clone)]
pub struct Tray {
    told: Sender<Event>,
    /// The process behind each item, by its name for shells and by its bus.
    pids: Arc<Mutex<Pids>>,
}

/// The process behind each item, as [`Registry::pids`] and
/// [`Registry::pids_on_buses`] give them.
#[derive(Debug, Default)]
struct Pids {
    by_name: HashMap<String, u32>,
    by_bus: HashMap<String, u32>,
}

impl Tray {
    /// The process behind item `id`, if known.
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.pids.lock().unwrap().by_name.get(id).copied()
    }

    /// The process behind the item answering on `bus`, if known.
    pub fn pid_on(&self, bus: &str) -> Option<u32> {
        self.pids.lock().unwrap().by_bus.get(bus).copied()
    }

    /// Hands the item on `bus`, whose menu was clicked, `token`.
    pub fn provide(&self, bus: String, token: String) {
        // A closed channel means the worker stopped and already logged why.
        let _ = self.told.send(Event::Provide { bus, token });
    }

    /// Sends a click with `action` to the item `id`, with `token` to raise a
    /// window with.
    pub fn activate(&self, id: String, action: TrayAction, token: String) {
        // A closed channel means the worker stopped and already logged why.
        let _ = self.told.send(Event::Activate { id, action, token });
    }

    /// Redraws every icon in the icon theme `theme`.
    pub fn retheme(&self, theme: Option<String>) {
        let _ = self.told.send(Event::Rethemed { theme });
    }
}

/// Starts the watcher and host, calling `publish` whenever the tray changes.
/// Icons are looked up under `data_dirs`, in the icon theme `theme`. A desk
/// `in_a_window` queues behind its host's watcher; see [`crate::bus_names`].
///
/// Returns once the thread is spawned, so startup does not wait on the bus.
pub fn serve(
    data_dirs: Vec<PathBuf>,
    theme: Option<String>,
    in_a_window: bool,
    publish: impl Fn(Vec<TrayItem>) + Send + 'static,
) -> Tray {
    let (told, events) = channel();
    let heard = told.clone();
    let pids = Arc::default();
    let traced = Arc::clone(&pids);
    thread::spawn(move || {
        let icons = TrayIcons::new(data_dirs, theme);
        if let Err(why) = answer(heard, &events, icons, in_a_window, &traced, &publish) {
            tracing::error!(
                %why,
                "the system tray is not being hosted; this desktop's applications \
                 will show no tray icons"
            );
        }
    });
    Tray { told, pids }
}

/// Takes the bus names, serves the watcher and handles events in turn.
/// Returns only on failure or when the compositor exits.
fn answer(
    told: Sender<Event>,
    events: &Receiver<Event>,
    mut icons: TrayIcons,
    in_a_window: bool,
    pids: &Mutex<Pids>,
    publish: &dyn Fn(Vec<TrayItem>),
) -> zbus::Result<()> {
    let connection = answering_within(Builder::session()?).build()?;
    connection.object_server().at(
        WATCHER_PATH,
        Watcher {
            told: told.clone(),
            items: Vec::new(),
        },
    )?;
    // Listen before taking the name, so an item that registers and changes
    // immediately is not missed.
    listen(
        &connection,
        MatchRule::builder()
            .msg_type(Type::Signal)
            .interface(ITEM_INTERFACE)?
            .build(),
        told.clone(),
        changed,
    )?;
    listen(
        &connection,
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender("org.freedesktop.DBus")?
            .interface("org.freedesktop.DBus")?
            .member("NameOwnerChanged")?
            .build(),
        told.clone(),
        owner,
    )?;
    crate::bus_names::take(&connection, WATCHER_NAME, in_a_window)?;
    // Some items check for a host name before registering.
    connection.request_name(format!("org.kde.StatusNotifierHost-{}", std::process::id()))?;
    debug!("this desktop hosts the system tray");

    let watcher = connection
        .object_server()
        .interface::<_, Watcher>(WATCHER_PATH)?;
    let mut registry = Registry::default();
    let mut reads = Reads::default();
    // Reads in a row that timed out, by item, for the wait before the next.
    let mut timeouts: HashMap<String, u32> = HashMap::new();
    // Ends when every sender is dropped, when the compositor exits.
    for event in events {
        match event {
            Event::Registered { service, sender } => {
                // Signals come from the registering connection. A
                // well-known name that later changes hands is tracked by
                // `Owner`.
                let (bus, path) = address(&service, &sender);
                let pid = pid(&connection, &sender);
                if let Some(id) = registry.register(&bus, &sender, &path, pid) {
                    debug!(%id, "a tray icon registered");
                    listed(&watcher, &registry, Some(&id), None);
                    read(&connection, &told, &mut reads, &registry, &id);
                }
            }
            Event::Changed { sender, path } => {
                for id in registry.sent_by(&sender, &path) {
                    read(&connection, &told, &mut reads, &registry, &id);
                }
            }
            Event::Owner { name, owner } if owner.is_empty() => {
                for id in registry.vanished(&name) {
                    debug!(%id, "a tray icon went away");
                    reads.forget(&id);
                    timeouts.remove(&id);
                    listed(&watcher, &registry, None, Some(&id));
                }
            }
            Event::Owner { name, owner } => {
                let pid = pid(&connection, &owner);
                registry.moved(&name, &owner, pid);
            }
            Event::Read {
                id,
                sequence,
                properties,
            } => {
                if let Landed::Current { again } = reads.landed(&id, sequence) {
                    match properties {
                        Ok(properties) => {
                            timeouts.remove(&id);
                            let properties = parse(properties);
                            let name = registry.named(&id, &properties.id);
                            let (bus, _) = registry
                                .address(&id)
                                .expect("an item read is one registered");
                            registry.show(&id, item(&name, &bus, properties, &mut icons));
                        }
                        // Kept registered but hidden: there is nothing to
                        // draw. Its next signal reads it again, and so does
                        // a wait after a timeout: an application busy
                        // starting up, as many are at login, answers late
                        // and may never signal.
                        Err(why) => {
                            if timed_out(&why) {
                                let wait = retry_after(timeouts.entry(id.clone()).or_default());
                                if reads.hung(&id) {
                                    warn!(
                                        %id,
                                        "a tray icon did not answer within {ANSWER_WITHIN:?}; \
                                         it is hidden until it answers, asked again in {wait:?}"
                                    );
                                } else {
                                    debug!(%id, ?wait, "a tray icon timed out again");
                                }
                                if again.is_none() {
                                    retry(&told, &id, wait);
                                }
                            } else {
                                debug!(%id, %why, "a tray icon could not be read");
                            }
                            registry.show(&id, None);
                        }
                    }
                    if let Some(sequence) = again {
                        start(&connection, &told, &registry, &id, sequence);
                    }
                }
            }
            Event::Provide { bus, token } => {
                for path in registry.paths_on(&bus) {
                    provide(&connection, &bus, &path, &token);
                }
            }
            Event::Activate { id, action, token } => {
                activate(&connection, &registry, &id, action, &token);
            }
            Event::Retry { id } => {
                // Unless it went away meanwhile.
                if registry.address(&id).is_some() {
                    read(&connection, &told, &mut reads, &registry, &id);
                }
            }
            // Read every item again: the registry keeps what it drew, not the
            // names it drew from.
            Event::Rethemed { theme } => {
                icons.retheme(theme);
                for id in registry.ids() {
                    read(&connection, &told, &mut reads, &registry, &id);
                }
            }
        }
        *pids.lock().unwrap() = Pids {
            by_name: registry.pids(),
            by_bus: registry.pids_on_buses(),
        };
        publish(registry.items());
    }
    Ok(())
}

/// Emits the watcher's item-list change signals.
///
/// Logs failure instead of stopping the worker, which would drop every later
/// click.
fn listed(
    watcher: &InterfaceRef<Watcher>,
    registry: &Registry,
    arrived: Option<&str>,
    left: Option<&str>,
) {
    watcher.get_mut().items = registry.ids();
    let emitter = watcher.signal_emitter();
    let said = zbus::block_on(async {
        watcher
            .get()
            .registered_status_notifier_items_changed(emitter)
            .await?;
        if let Some(id) = arrived {
            Watcher::status_notifier_item_registered(emitter, id).await?;
        }
        if let Some(id) = left {
            Watcher::status_notifier_item_unregistered(emitter, id).await?;
        }
        zbus::Result::Ok(())
    });
    if let Err(why) = said {
        tracing::error!(%why, "the tray could not say its items changed");
    }
}

/// Reads item `id`'s properties, unless a read is in flight: then it is read
/// again when that one lands.
fn read(
    connection: &Connection,
    told: &Sender<Event>,
    reads: &mut Reads,
    registry: &Registry,
    id: &str,
) {
    if let Some(sequence) = reads.wanted(id) {
        start(connection, told, registry, id, sequence);
    }
}

/// Reads item `id`'s properties on a new thread and sends an
/// [`Event::Read`] back, so a slow application does not block the worker.
fn start(
    connection: &Connection,
    told: &Sender<Event>,
    registry: &Registry,
    id: &str,
    sequence: u64,
) {
    let (bus, path) = registry.address(id).expect("only an item held is read");
    let (connection, told, id) = (connection.clone(), told.clone(), id.to_string());
    thread::spawn(move || {
        let properties = get_all(&connection, &bus, &path);
        // A closed channel means the worker stopped and already logged why.
        let _ = told.send(Event::Read {
            id,
            sequence,
            properties,
        });
    });
}

/// The wait before reading an item again after its `timeouts`-th read in a
/// row timed out, counting this one: [`ANSWER_WITHIN`], doubling up to
/// [`RETRY_AT_MOST`].
fn retry_after(timeouts: &mut u32) -> Duration {
    *timeouts = timeouts.saturating_add(1);
    ANSWER_WITHIN
        .saturating_mul(1 << (*timeouts - 1).min(16))
        .min(RETRY_AT_MOST)
}

/// Sends [`Event::Retry`] for `id` after `wait`.
fn retry(told: &Sender<Event>, id: &str, wait: Duration) {
    let (told, id) = (told.clone(), id.to_string());
    thread::spawn(move || {
        thread::sleep(wait);
        // A closed channel means the worker stopped and already logged why.
        let _ = told.send(Event::Retry { id });
    });
}

/// `builder` with calls that fail after [`ANSWER_WITHIN`].
fn answering_within(builder: Builder<'_>) -> Builder<'_> {
    builder.method_timeout(ANSWER_WITHIN)
}

/// Whether a call failed because nothing answered within [`ANSWER_WITHIN`].
fn timed_out(why: &zbus::Error) -> bool {
    matches!(why, zbus::Error::InputOutput(io) if io.kind() == ErrorKind::TimedOut)
}

/// The properties of the item at `path` on `bus`.
fn get_all(
    connection: &Connection,
    bus: &str,
    path: &str,
) -> zbus::Result<HashMap<String, OwnedValue>> {
    Proxy::new(connection, bus, path, "org.freedesktop.DBus.Properties")
        .and_then(|proxy| proxy.call("GetAll", &(ITEM_INTERFACE,)))
}

/// Calls the method for `action` on item `id`, after handing it `token`.
///
/// Does not wait for a reply: an error (such as `Activate` on a menu-only
/// item, or `ProvideXdgActivationToken` on an item without it) changes
/// nothing, and a slow application must not stall the tray.
fn activate(
    connection: &Connection,
    registry: &Registry,
    id: &str,
    action: TrayAction,
    token: &str,
) {
    let Some((bus, path)) = registry.clicked(id) else {
        debug!(%id, "a click on a tray icon that has gone");
        return;
    };
    let called =
        Proxy::new(connection, bus.as_str(), path.as_str(), ITEM_INTERFACE).and_then(|proxy| {
            proxy.call_noreply("ProvideXdgActivationToken", &(token,))?;
            // Screen coordinates, used only by X11 items to place a window.
            // Wayland clients cannot place windows, so send the origin.
            proxy.call_noreply(method(action), &(0i32, 0i32))
        });
    if let Err(why) = called {
        debug!(%id, %why, "a tray icon could not be clicked");
    }
}

/// Hands the item at `path` on `bus` `token`, for a click on its menu.
fn provide(connection: &Connection, bus: &str, path: &str, token: &str) {
    let called = Proxy::new(connection, bus, path, ITEM_INTERFACE)
        .and_then(|proxy| proxy.call_noreply("ProvideXdgActivationToken", &(token,)));
    if let Err(why) = called {
        debug!(%bus, %why, "a tray icon could not be handed a token");
    }
}

/// The process behind connection `name`, as the bus knows it. `None` if the
/// bus will not say, which is logged: a click on its icon then cannot let it
/// raise its window with a token of its own.
fn pid(connection: &Connection, name: &str) -> Option<u32> {
    zbus::blocking::fdo::DBusProxy::new(connection)
        .and_then(|bus| {
            let name = zbus::names::BusName::try_from(name).map_err(zbus::Error::from)?;
            bus.get_connection_unix_process_id(name)
                .map_err(zbus::Error::from)
        })
        .inspect_err(|why| warn!(%why, %name, "a tray icon's process could not be asked"))
        .ok()
}

/// Converts an item's `GetAll` reply to [`Properties`]. A missing or
/// wrongly typed property reads as empty.
fn parse(mut properties: HashMap<String, OwnedValue>) -> Properties {
    let mut text = |name: &str| {
        properties
            .remove(name)
            .and_then(|value| String::try_from(value).ok())
            .unwrap_or_default()
    };
    let id = text("Id");
    let title = text("Title");
    let status = Status::from_wire(&text("Status"));
    let icon_name = text("IconName");
    let attention_icon_name = text("AttentionIconName");
    let icon_theme_path = text("IconThemePath");
    let menu = properties
        .remove("Menu")
        .and_then(|value| OwnedObjectPath::try_from(value).ok())
        .map(|path| path.to_string())
        .unwrap_or_default();
    let item_is_menu = properties
        .remove("ItemIsMenu")
        .and_then(|value| bool::try_from(value).ok())
        .unwrap_or_default();
    let mut pixmaps = |name: &str| {
        properties
            .remove(name)
            .and_then(|value| Vec::<(i32, i32, Vec<u8>)>::try_from(value).ok())
            .map(|pixmaps| {
                pixmaps
                    .into_iter()
                    .map(|(width, height, argb)| Pixmap {
                        width,
                        height,
                        argb,
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let icon_pixmaps = pixmaps("IconPixmap");
    let attention_pixmaps = pixmaps("AttentionIconPixmap");
    // `(icon name, icon pixmaps, title, description)`; only the title is
    // used.
    let tooltip = properties
        .remove("ToolTip")
        .and_then(|value| {
            <(String, Vec<(i32, i32, Vec<u8>)>, String, String)>::try_from(value).ok()
        })
        .map(|(_, _, title, _)| title)
        .unwrap_or_default();
    Properties {
        id,
        title,
        tooltip,
        status,
        icon_name,
        icon_pixmaps,
        attention_icon_name,
        attention_pixmaps,
        icon_theme_path,
        menu,
        item_is_menu,
    }
}

/// Passes each message matching `rule` through `heard` to the worker, on a
/// new thread.
fn listen(
    connection: &Connection,
    rule: MatchRule<'static>,
    told: Sender<Event>,
    heard: fn(&zbus::Message) -> Option<Event>,
) -> zbus::Result<()> {
    let messages = MessageIterator::for_match_rule(rule, connection, None)?;
    thread::spawn(move || {
        for message in messages {
            match message {
                Ok(message) => {
                    if let Some(event) = heard(&message) {
                        if told.send(event).is_err() {
                            break;
                        }
                    }
                }
                // Skip a message that does not decode; keep reading.
                Err(why) => debug!(%why, "the tray could not read a message"),
            }
        }
    });
    Ok(())
}

/// An item's signal, as its sender and object path.
fn changed(message: &zbus::Message) -> Option<Event> {
    let header = message.header();
    Some(Event::Changed {
        sender: header.sender()?.to_string(),
        path: header.path()?.to_string(),
    })
}

/// `NameOwnerChanged`: a name's new owner, empty when released.
fn owner(message: &zbus::Message) -> Option<Event> {
    let (name, _, owner): (String, String, String) = message.body().deserialize().ok()?;
    Some(Event::Owner { name, owner })
}

/// The object at `/StatusNotifierWatcher`.
struct Watcher {
    told: Sender<Event>,
    /// Registered item ids for `RegisteredStatusNotifierItems`, copied from
    /// the worker's [`Registry`].
    items: Vec<String>,
}

#[zbus::interface(name = "org.kde.StatusNotifierWatcher")]
impl Watcher {
    /// Queues an item registration for the worker, so the bus executor never
    /// blocks.
    fn register_status_notifier_item(&self, service: &str, #[zbus(header)] header: Header<'_>) {
        if let Some(sender) = header.sender() {
            let _ = self.told.send(Event::Registered {
                service: service.to_string(),
                sender: sender.to_string(),
            });
        }
    }

    /// Ignores other hosts: this compositor is the only tray.
    fn register_status_notifier_host(&self, _service: &str) {}

    #[zbus(property)]
    fn registered_status_notifier_items(&self) -> Vec<String> {
        self.items.clone()
    }

    #[zbus(property)]
    fn is_status_notifier_host_registered(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn protocol_version(&self) -> i32 {
        0
    }

    #[zbus(signal)]
    async fn status_notifier_item_registered(
        emitter: &SignalEmitter<'_>,
        service: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn status_notifier_item_unregistered(
        emitter: &SignalEmitter<'_>,
        service: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn status_notifier_host_registered(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::portals::socket_pair::connected_both;
    use std::time::Instant;
    use zbus::zvariant::{ObjectPath, Value};

    #[test]
    fn a_hung_item_is_asked_again_ever_more_slowly() {
        let mut timeouts = 0;
        let waits: Vec<Duration> = (0..7).map(|_| retry_after(&mut timeouts)).collect();
        assert_eq!(
            waits,
            [3, 6, 12, 24, 48, 60, 60].map(Duration::from_secs),
            "doubling from the answer timeout, capped"
        );
    }

    #[test]
    fn a_read_of_an_item_that_never_answers_times_out() {
        // The item's end serves no objects, so it never replies.
        let (_item, host) = connected_both(|item| item, answering_within);
        let asked = Instant::now();

        let read = get_all(&host, "org.example.Hung", "/StatusNotifierItem");

        assert!(timed_out(&read.expect_err("no reply")));
        assert!(asked.elapsed() < ANSWER_WITHIN * 2);
    }

    /// `properties` in the shape of a `GetAll` reply.
    fn answered(properties: Vec<(&str, Value<'static>)>) -> HashMap<String, OwnedValue> {
        properties
            .into_iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    OwnedValue::try_from(value).expect("an ownable value"),
                )
            })
            .collect()
    }

    #[test]
    fn what_an_item_says_is_read_into_its_properties() {
        let pixmaps = vec![(1i32, 1i32, vec![255u8, 255, 0, 0])];
        let read = parse(answered(vec![
            ("Id", Value::from("nm-applet")),
            ("Title", Value::from("Network")),
            ("Status", Value::from("NeedsAttention")),
            ("IconName", Value::from("nm-signal-75")),
            ("AttentionIconName", Value::from("nm-no-connection")),
            ("IconThemePath", Value::from("/opt/nm/icons")),
            (
                "Menu",
                Value::from(ObjectPath::try_from("/MenuBar").expect("a path")),
            ),
            ("ItemIsMenu", Value::from(true)),
            ("IconPixmap", Value::from(pixmaps.clone())),
            ("AttentionIconPixmap", Value::from(pixmaps)),
            (
                "ToolTip",
                Value::from((
                    String::new(),
                    Vec::<(i32, i32, Vec<u8>)>::new(),
                    "Wired connection 1".to_string(),
                    "Connected".to_string(),
                )),
            ),
        ]));

        let pixel = Pixmap {
            width: 1,
            height: 1,
            argb: vec![255, 255, 0, 0],
        };
        assert_eq!(
            read,
            Properties {
                id: "nm-applet".into(),
                title: "Network".into(),
                tooltip: "Wired connection 1".into(),
                status: Status::NeedsAttention,
                icon_name: "nm-signal-75".into(),
                icon_pixmaps: vec![pixel.clone()],
                attention_icon_name: "nm-no-connection".into(),
                attention_pixmaps: vec![pixel],
                icon_theme_path: "/opt/nm/icons".into(),
                menu: "/MenuBar".into(),
                item_is_menu: true,
            }
        );
    }

    #[test]
    fn a_property_left_out_or_of_the_wrong_type_is_empty() {
        // Every property is optional, and a wrongly typed one is ignored.
        let read = parse(answered(vec![
            ("Id", Value::from("sync")),
            ("Title", Value::from(7u32)),
        ]));

        assert_eq!(
            read,
            Properties {
                id: "sync".into(),
                title: String::new(),
                tooltip: String::new(),
                status: Status::Active,
                icon_name: String::new(),
                icon_pixmaps: Vec::new(),
                attention_icon_name: String::new(),
                attention_pixmaps: Vec::new(),
                icon_theme_path: String::new(),
                menu: String::new(),
                item_is_menu: false,
            }
        );
    }
}
