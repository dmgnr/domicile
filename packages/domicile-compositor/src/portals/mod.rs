//! The desktop's `xdg-desktop-portal` backend: one bus name, one object, every
//! interface Domicile implements.
//!
//! Each interface is a file here that registers on [`OBJECT_PATH`] in
//! [`export`]. One that needs the user calls [`queue::ask`], which pushes the
//! dialog to every chrome as
//! [`HostMessage::PortalRequests`](domicile_protocol::HostMessage::PortalRequests)
//! and waits for the shell's answer. See `docs/PORTALS.md`.
//!
//! `xdg-desktop-portal` routes to this backend by `XDG_CURRENT_DESKTOP`. It is
//! activated by D-Bus or systemd, so it reads that from their activation
//! environment, not from this process's clients. [`say_which_desktop`] sets it
//! there, and restarts a frontend that started under another desktop's name.
//!
//! Failures (no session bus, name taken) are logged once and leave clients
//! unthemed and their dialogs unanswered; they never stop the compositor.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use domicile_config::{LockdownConfig, ThemeConfig};
use domicile_host::app_names::application_dirs;
use domicile_host::cast_grants::Grants;
use domicile_host::clipboard::Contents;
use domicile_host::cups::Cups;
use domicile_host::data_dirs::data_dirs;
use domicile_host::links::Links;
use domicile_host::mime_apps::{default_handler, lists};
use domicile_host::portal_notifications::Invoked;
use domicile_host::system::Kept;
use domicile_protocol::{
    BoundShortcut, Capturing, PortalAnswer, PortalRequest, PortalWallpaper, PreviewedWindow,
    SystemError, Theme,
};
use tracing::{debug, warn};
use zbus::blocking::connection::Builder;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use crate::eis::barriers::Zone;
use crate::eis::{Captured, Eis};
use crate::notifications::NotificationServer;

mod access;
mod accessibility;
mod account;
pub mod agent;
mod app_chooser;
mod background;
mod clipboard;
mod dynamic_launcher;
mod email;
mod file_chooser;
#[cfg(test)]
mod fixture;
mod global_shortcuts;
mod inhibit;
mod input_capture;
mod lockdown;
mod notification;
mod print;
mod queue;
mod recording;
mod remote_desktop;
mod request;
mod restore;
mod screencast;
mod screenshot;
mod session;
mod settings;
#[cfg(test)]
pub(crate) mod socket_pair;
mod uri;
mod usb;
mod wallpaper;

use access::Access;
use account::{Account, LookUp};
use app_chooser::AppChooser;
use background::{Background, RunningApps};
pub use clipboard::Selection;
use clipboard::{Clipboard, Transfers};
use dynamic_launcher::DynamicLauncher;
use email::{Email, Open};
use file_chooser::FileChooser;
use global_shortcuts::{GlobalShortcuts, Shortcuts};
use inhibit::{Inhibit, Inhibitors};
use input_capture::{InputCapture, Inputs, Zones};
use lockdown::Lockdown;
use notification::Notification;
use print::Print;
use queue::Queue;
use recording::Recordings;
use remote_desktop::{RemoteDesktop, Remotes};
use restore::Tokens;
use screencast::ScreenCast;
use screenshot::{Screenshot, Shoot, Shots};
use settings::{color_scheme, Appearance, Settings};
use usb::Usb;
use wallpaper::{Pictures, Wallpaper};

use crate::casting::Casting;

/// The object path the frontend calls backends at.
const OBJECT_PATH: &str = "/org/freedesktop/portal/desktop";

/// The bus name this backend owns.
///
/// Owns the backend name, not the frontend's `org.freedesktop.portal.Desktop`,
/// so other portal interfaces still reach their own backends.
const BUS_NAME: &str = "org.freedesktop.impl.portal.desktop.domicile";

/// The Clipboard interface, for its signals.
const CLIPBOARD: &str = "org.freedesktop.impl.portal.Clipboard";

/// The InputCapture interface, for its signals.
const INPUT_CAPTURE: &str = "org.freedesktop.impl.portal.InputCapture";

/// This desktop's `XDG_CURRENT_DESKTOP` value.
///
/// Must match `UseIn=` in the flake's `domicile.portal`. `.desktop` files'
/// `OnlyShowIn`/`NotShowIn` also match on it. [`say_which_desktop`] sets it
/// for activated services and `client_command` for spawned clients.
pub const CURRENT_DESKTOP: &str = "domicile";

/// Handle for the portal thread: the desk's state in, the shell's answers in.
///
/// If the service failed to start, changes are dropped and every dialog is
/// refused, so callers need no separate path for a desk without a portal.
#[derive(Clone)]
pub struct Portals {
    backends: Backends,
    shots: Shots,
    /// The shell's own screenshot dialog, while one is up.
    shell_dialog: screenshot::ShellDialog,
    /// `None` in unit tests that cast nothing.
    recordings: Option<Recordings>,
    agents: Arc<agent::Door>,
    /// The pages that open links, which the Email portal hands `mailto:`
    /// links to before the desk's mail client.
    links: Links,
}

/// What the portal thread is told to do on the bus.
enum Told {
    Theme(Theme),
    Appearance(Appearance),
    Screensaver(bool),
    /// The config's new `lockdown`.
    Lockdown(LockdownConfig),
    /// End the session at this handle, as when the shell stops it.
    End(OwnedObjectPath),
    /// The clipboard now offers `mime_types`, from `owner` if a session set
    /// it.
    SelectionChanged {
        mime_types: Vec<String>,
        owner: Option<OwnedObjectPath>,
    },
    /// A client is pasting `session`'s offer as `mime_type` into `fd`.
    Transfer {
        session: OwnedObjectPath,
        mime_type: String,
        fd: std::os::fd::OwnedFd,
    },
    /// The displays changed to zone set `set`.
    Rezoned {
        set: u32,
    },
    /// An InputCapture session's capture says something.
    Captured {
        session: OwnedObjectPath,
        captured: Captured,
    },
    /// `GetAppState`'s answer changed.
    RunningApps,
}

impl Portals {
    /// The pages that open links, which every chrome connection shares.
    pub fn links(&self) -> Links {
        self.links.clone()
    }

    /// A handle with no service behind it, for unit tests without a session
    /// bus.
    #[cfg(test)]
    pub fn to_nobody() -> Self {
        // Same state as a service thread that has stopped.
        let backends = Backends::new(
            NotificationServer::unserved(Vec::new()),
            Tokens::load(None),
            Shortcuts::new(None),
        )
        .0;
        Portals {
            links: Links::default(),
            agents: agent::Door::new(
                backends.queue.clone(),
                None,
                recording::system_clock(),
                agent::PATIENCE,
                agent::Accessibility {
                    enabled: Box::new(|| true),
                    enable: Box::new(|_| {}),
                },
            ),
            backends,
            shots: Shots::none(),
            shell_dialog: screenshot::ShellDialog::default(),
            recordings: None,
        }
    }

    /// Tells the desk's clients the current theme. Dropped if no service is
    /// running.
    pub fn announce(&self, theme: Theme) {
        self.tell(Told::Theme(theme));
    }

    /// Tells the desk's clients the config's accent color, contrast and
    /// reduced motion.
    pub fn restyle(&self, theme: &ThemeConfig) {
        self.tell(Told::Appearance(Appearance::from(theme)));
    }

    /// Tells applications watching the session whether the screens are
    /// blanked or locked.
    pub fn screensaver(&self, active: bool) {
        self.tell(Told::Screensaver(active));
    }

    /// Tells applications the config's new `lockdown`.
    pub fn lock_down(&self, lockdown: LockdownConfig) {
        self.tell(Told::Lockdown(lockdown));
    }

    /// Publish the pending dialogs through `publish` on every change. See
    /// [`Queue::listen`] for `listening` and `parent`.
    pub fn listen(
        &self,
        publish: impl Fn(Vec<PortalRequest>, Vec<Capturing>) + Send + Sync + 'static,
        listening: impl Fn() -> bool + Send + Sync + 'static,
        parent: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) {
        self.backends.queue.listen(publish, listening, parent);
    }

    /// The windows' applications changed: each window's app id, and whether
    /// it has focus. Tells the frontend when `GetAppState` would answer
    /// differently.
    pub fn running(&self, windows: impl IntoIterator<Item = (String, bool)>) {
        if self.backends.apps.set(windows) {
            self.tell(Told::RunningApps);
        }
    }

    /// Publish the Wallpaper portal's pictures through `publish`, now and on
    /// every change.
    pub fn show_wallpaper(&self, publish: impl Fn(PortalWallpaper) + Send + Sync + 'static) {
        self.backends.pictures.listen(publish);
    }

    /// Call `hold` with the applications holding idle inhibitors, one name
    /// per inhibitor, on each change.
    pub fn hold_idle_through(&self, hold: impl Fn(Vec<String>) + Send + Sync + 'static) {
        self.backends.inhibitors.hold_idle_through(hold);
    }

    /// Publish the chords applications hold through `publish` on every
    /// change.
    pub fn listen_for_shortcuts(
        &self,
        publish: impl Fn(Vec<BoundShortcut>) + Send + Sync + 'static,
    ) {
        self.backends.shortcuts.listen(publish);
    }

    /// The shell's answer to dialog `id`, or a press or release of the
    /// shortcut bound under `id`.
    pub fn answer(&self, id: u32, answer: PortalAnswer) {
        match answer {
            PortalAnswer::Pressed => self.backends.shortcuts.pressed(id),
            PortalAnswer::Released => self.backends.shortcuts.released(id),
            answer => self.backends.queue.answer(id, answer),
        }
    }

    /// Deactivate every global shortcut still held. Called on locking, which
    /// refuses the shell's release answers.
    pub fn let_go_of_held_shortcuts(&self) {
        self.backends.shortcuts.let_go_of_everything();
    }

    /// Serve RemoteDesktop's and InputCapture's input through `eis`, and the
    /// Clipboard through `selections`. Called once, when the Wayland loop
    /// starts.
    pub fn attach(&self, eis: Eis, selections: impl Fn(Selection) + Send + Sync + 'static) {
        self.backends.attach(eis, selections);
    }

    /// The seat's clipboard now offers `mime_types`; `owner` is the session
    /// that set it, if one did.
    pub fn selection_changed(&self, mime_types: Vec<String>, owner: Option<OwnedObjectPath>) {
        self.backends.selection_changed(mime_types, owner);
    }

    /// The displays, as InputCapture zones, in desktop logical units.
    pub fn displays(&self, zones: Vec<Zone>) {
        self.backends.displays(zones);
    }

    /// A client is pasting `session`'s offer into `fd`.
    pub fn transfer(&self, session: OwnedObjectPath, mime_type: String, fd: std::os::fd::OwnedFd) {
        self.backends.transfer(session, mime_type, fd);
    }

    /// Takes a screenshot the shell asked for itself, and returns where it
    /// went. Blocks until then, the dialog included. One asked for while the
    /// shell's dialog is up answers as that dialog does; see
    /// [`screenshot::ShellDialog`] and [`screenshot::for_the_shell`].
    pub fn screenshot(&self, file: Option<PathBuf>) -> Result<Kept, SystemError> {
        let take = || {
            zbus::block_on(screenshot::for_the_shell(
                &self.backends.queue,
                &self.shots,
                file.clone(),
            ))
        };
        match &file {
            Some(_) => take(),
            None => self.shell_dialog.take(take),
        }
    }

    /// Writes a PNG of the desk for an agent. Blocks until then. See
    /// [`screenshot::for_an_agent`].
    pub fn shoot_desk(
        &self,
        file: PathBuf,
        fit: u32,
        area: Option<domicile_protocol::DeskRect>,
    ) -> Result<domicile_protocol::DeskShot, String> {
        zbus::block_on(screenshot::for_an_agent(&self.shots, file, fit, area))
    }

    /// Records what the shell picks until it stops the recording, and
    /// returns the file. Blocks until then. See [`recording::for_the_shell`].
    pub fn screen_record(&self) -> Result<PathBuf, SystemError> {
        let recordings = self.recordings.as_ref().ok_or_else(|| SystemError {
            kind: domicile_protocol::SystemErrorKind::Other,
            message: "this desktop casts nothing to record".into(),
        })?;
        recording::for_the_shell(&self.backends.queue, recordings)
    }

    /// The agents the desk lets in. See [`agent::Door`].
    pub fn agents(&self) -> &Arc<agent::Door> {
        &self.agents
    }

    /// Draws a window for the shell's picker to preview. Blocks until it is
    /// drawn. See [`screenshot::preview`].
    pub fn preview(&self, window: PreviewedWindow) -> Result<String, SystemError> {
        zbus::block_on(screenshot::preview(&self.shots, window))
    }

    fn tell(&self, told: Told) {
        self.backends.tell(told);
    }
}

/// What the interfaces share with [`Portals`] and the rest of the desk: the
/// dialogs, the input server, the sessions, and the way to the portal thread.
#[derive(Clone)]
struct Backends {
    queue: Arc<Queue>,
    inhibitors: Arc<Inhibitors>,
    notifications: NotificationServer,
    told: Sender<Told>,
    /// Set once the Wayland loop serves EIS; see [`Portals::attach`].
    eis: Arc<OnceLock<Eis>>,
    remotes: Arc<Remotes>,
    tokens: Arc<Mutex<Tokens>>,
    /// Where clipboard requests go on the Wayland thread. Set with `eis`.
    selections: Arc<OnceLock<Box<Select>>>,
    transfers: Arc<Mutex<Transfers>>,
    inputs: Arc<Inputs>,
    zones: Arc<Mutex<Zones>>,
    shortcuts: Arc<Shortcuts>,
    apps: Arc<RunningApps>,
    pictures: Arc<Pictures>,
    /// `$XDG_CONFIG_HOME`, for autostart entries.
    config_home: Option<PathBuf>,
}

/// Hands a [`Selection`] to the Wayland thread.
type Select = dyn Fn(Selection) + Send + Sync;

impl Backends {
    /// Backends posting notifications to `notifications`, keeping grants in
    /// `tokens` and global shortcuts in `shortcuts`, and what they tell the
    /// portal thread.
    fn new(
        notifications: NotificationServer,
        tokens: Tokens,
        shortcuts: Shortcuts,
    ) -> (Backends, Receiver<Told>) {
        let (told, telling) = channel();
        let backends = Backends {
            queue: Arc::default(),
            inhibitors: Arc::default(),
            notifications,
            told,
            eis: Arc::default(),
            remotes: Arc::default(),
            tokens: Arc::new(Mutex::new(tokens)),
            selections: Arc::default(),
            transfers: Arc::default(),
            inputs: Arc::default(),
            zones: Arc::default(),
            shortcuts: Arc::new(shortcuts),
            apps: Arc::default(),
            // `serve` loads the user's; this is for tests.
            pictures: Arc::new(Pictures::load(
                std::env::temp_dir().join("domicile-portals-unloaded"),
            )),
            config_home: None,
        };
        (backends, telling)
    }

    fn attach(&self, eis: Eis, selections: impl Fn(Selection) + Send + Sync + 'static) {
        if self.eis.set(eis).is_err() || self.selections.set(Box::new(selections)).is_err() {
            panic!("the portals are attached to one desktop");
        }
    }

    /// The input server, or an error for the application before it is up.
    fn eis(&self) -> zbus::fdo::Result<&Eis> {
        self.eis
            .get()
            .ok_or_else(|| zbus::fdo::Error::Failed("the desktop takes no input yet".into()))
    }

    /// Hand `selection` to the Wayland thread, or fail before it is up.
    fn select(&self, selection: Selection) -> zbus::fdo::Result<()> {
        let select = self
            .selections
            .get()
            .ok_or_else(|| zbus::fdo::Error::Failed("the desktop has no clipboard yet".into()))?;
        select(selection);
        Ok(())
    }

    /// The displays are now `zones`.
    fn displays(&self, zones: Vec<Zone>) {
        let mut held = self.zones.lock().unwrap();
        if held.replace(zones) {
            self.tell(Told::Rezoned { set: held.set });
        }
    }

    fn selection_changed(&self, mime_types: Vec<String>, owner: Option<OwnedObjectPath>) {
        self.tell(Told::SelectionChanged { mime_types, owner });
    }

    fn transfer(&self, session: OwnedObjectPath, mime_type: String, fd: std::os::fd::OwnedFd) {
        self.tell(Told::Transfer {
            session,
            mime_type,
            fd,
        });
    }

    fn tell(&self, told: Told) {
        // A closed channel means the service stopped and already logged why.
        let _ = self.told.send(told);
    }
}

/// What the Account, Email, Lockdown, ScreenCast, Print and Screenshot
/// interfaces start from.
struct Starting {
    lockdown: LockdownConfig,
    screen_cast: ScreenCast,
    /// Takes and saves frames of the desk, for `Screenshot`.
    shots: Shots,
    /// Opens a `mailto:` URL.
    open: Open,
    /// Who the user is, for `Account`.
    user: LookUp,
    /// Where `Print` finds printers.
    cups: Cups,
}

/// What the capture portals need from the rest of the compositor.
pub struct ScreenCasting {
    /// Starts and stops streams on the Wayland thread.
    pub casting: Casting,
    /// Where saved ScreenCast restore tokens are kept; `None` keeps them in
    /// memory.
    pub grants: Option<PathBuf>,
}

/// The config's look besides `mode` in each theme, as the shell is told it.
/// The shell follows it as the settings portal's clients do.
pub fn shell_appearance(theme: &ThemeConfig) -> domicile_host::Appearances {
    (&Appearance::from(theme)).into()
}

/// Starts the portal thread with `theme` as the current theme and the
/// config's `lockdown`, and sets the activation environment. See
/// [`activation_environment`] for `ours` and `in_a_window`. Portal notifications
/// go to `notifications`; `spawn` starts a client, such as the mail client.
/// Restore tokens and global shortcut choices are kept under
/// `$XDG_STATE_HOME/domicile/`. Screenshots are taken through `casting`.
///
/// Returns without waiting for the bus, so startup never blocks on D-Bus.
#[allow(clippy::too_many_arguments)] // Each from a different part of the compositor.
pub fn serve(
    theme: Theme,
    look: &ThemeConfig,
    lockdown: LockdownConfig,
    ours: &str,
    in_a_window: bool,
    notifications: NotificationServer,
    spawn: impl Fn(&[String]) + Send + Sync + 'static,
    casting: ScreenCasting,
) -> Portals {
    let environment = activation_environment(ours, in_a_window);
    let (mut backends, changes) = Backends::new(
        notifications,
        Tokens::load(restore::path(
            std::env::var_os("XDG_STATE_HOME").map(PathBuf::from),
            std::env::var_os("HOME").map(PathBuf::from),
        )),
        Shortcuts::new(domicile_host::global_shortcuts::saved_file(
            std::env::var("XDG_STATE_HOME").ok().as_deref(),
            std::env::var("HOME").ok().as_deref(),
        )),
    );
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let state_home =
        xdg_home("XDG_STATE_HOME", home.as_deref(), ".local/state").unwrap_or_else(|| {
            warn!(
                "neither XDG_STATE_HOME nor HOME is set; a wallpaper set \
                 through the portal lasts until reboot"
            );
            std::env::temp_dir()
        });
    backends.pictures = Arc::new(Pictures::load(state_home.join("domicile/wallpaper")));
    backends.config_home = xdg_home("XDG_CONFIG_HOME", home.as_deref(), ".config");
    let shots = Shots {
        shoot: screenshot::shooting(casting.casting.clone()),
        shoot_window: screenshot::shooting_windows(casting.casting.clone()),
        shoot_browser_window: screenshot::shooting_browser_windows(casting.casting.clone()),
        save: screenshot::in_pictures(),
        copy: {
            let backends = backends.clone();
            Arc::new(move |png| {
                backends
                    .select(Selection::Hold {
                        contents: Contents::image("image/png", png),
                    })
                    .map_err(|why| why.to_string())
            })
        },
    };
    let links = Links::default();
    let portals = Portals {
        links: links.clone(),
        agents: agent::Door::new(
            backends.queue.clone(),
            agent::path(
                std::env::var_os("XDG_STATE_HOME").map(PathBuf::from),
                std::env::var_os("HOME").map(PathBuf::from),
            ),
            recording::system_clock(),
            agent::PATIENCE,
            accessibility::on_the_session_bus(),
        ),
        backends: backends.clone(),
        shots: shots.clone(),
        shell_dialog: screenshot::ShellDialog::default(),
        recordings: Some(Recordings {
            casting: casting.casting.clone(),
            shoot: shots.shoot.clone(),
            file: recording::in_videos(),
            start: recording::beside_the_compositor(),
            clock: recording::system_clock(),
        }),
    };
    let appearance = Appearance::from(look);
    let open = mail_client(spawn, links.clone());
    thread::spawn(move || {
        let starting = Starting {
            lockdown,
            screen_cast: screen_cast(&backends.queue, casting, shots.shoot.clone()),
            shots,
            open,
            user: account::the_user(),
            cups: Cups::at(std::env::var_os("CUPS_SERVER"), account::login_name()),
        };
        // Every failure has the same effect: clients do not follow the theme,
        // and their dialogs go unanswered.
        if let Err(why) = answer(
            theme,
            appearance,
            starting,
            &backends,
            environment,
            in_a_window,
            &changes,
        ) {
            tracing::error!(
                %why,
                "the desktop portal is not being answered; this desktop's \
                 clients will not follow its theme or show its dialogs"
            );
        }
    });
    portals
}

/// An XDG base directory: `variable` when set and absolute, else `fallback`
/// under `home`.
fn xdg_home(variable: &str, home: Option<&std::path::Path>, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| home.map(|home| home.join(fallback)))
}

/// Serves the interfaces, sets the activation environment each time this desk
/// takes the name, and signals each change. Returns on failure or when every
/// handle is dropped.
///
/// The name comes back after a second login session on the bus exits (see
/// [`crate::bus_names`]), and that session left its own display in the
/// activation environment.
fn answer(
    theme: Theme,
    appearance: Appearance,
    starting: Starting,
    backends: &Backends,
    environment: Vec<(&'static str, String)>,
    in_a_window: bool,
    changes: &Receiver<Told>,
) -> Result<(), zbus::Error> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data_dirs = data_dirs(
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("XDG_DATA_DIRS"),
        home.as_deref(),
    );
    let home = home.unwrap_or_else(|| "/".into()).display().to_string();
    let connection = export(
        Builder::session()?,
        theme,
        appearance,
        starting,
        backends,
        data_dirs,
        home,
    )?
    .build()?;
    backends.shortcuts.signal_on(connection.inner().clone());
    let notification = connection
        .object_server()
        .interface::<_, Notification>(OBJECT_PATH)?;
    backends
        .notifications
        .on_portal_action(move |invoked: Invoked<OwnedValue>, token| {
            notification::invoked(&notification, invoked, token)
        });
    let acquired = zbus::blocking::fdo::DBusProxy::new(&connection)?
        .receive_name_acquired_with_args(&[(0, BUS_NAME)])?;
    let saying = connection.clone();
    thread::spawn(move || {
        for _ in acquired {
            say_which_desktop(&saying, &environment);
        }
    });
    crate::bus_names::take(&connection, BUS_NAME, in_a_window)?;
    debug!(
        name = BUS_NAME,
        scheme = color_scheme(theme),
        "this desktop answers the desktop portal, so its clients follow its theme"
    );
    // Ends when every `Portals` is dropped.
    for next in changes {
        heard(&connection, backends, next)?;
    }
    Ok(())
}

/// Do one thing the portal thread was told.
fn heard(
    connection: &zbus::blocking::Connection,
    backends: &Backends,
    told: Told,
) -> zbus::Result<()> {
    match told {
        Told::Theme(theme) => settings::changed(&settings(connection)?, Some(theme), None),
        Told::Appearance(appearance) => {
            settings::changed(&settings(connection)?, None, Some(appearance))
        }
        Told::Screensaver(active) => inhibit::screensaver(
            &connection
                .object_server()
                .interface::<_, Inhibit>(OBJECT_PATH)?,
            active,
        ),
        Told::Lockdown(lockdown) => lockdown::changed(
            &connection
                .object_server()
                .interface::<_, Lockdown>(OBJECT_PATH)?,
            lockdown,
        ),
        Told::RunningApps => {
            background::changed(
                &connection
                    .object_server()
                    .interface::<_, Background>(OBJECT_PATH)?,
            );
            Ok(())
        }
        Told::End(handle) => {
            zbus::block_on(session::end(connection.object_server().inner(), &handle))
        }
        Told::SelectionChanged { mime_types, owner } => {
            for session in backends.remotes.sharing_sessions() {
                let is_owner = owner.as_ref() == Some(&session);
                connection.emit_signal(
                    None::<&str>,
                    OBJECT_PATH,
                    CLIPBOARD,
                    "SelectionOwnerChanged",
                    &(&session, clipboard::owner_changed(&mime_types, is_owner)),
                )?;
            }
            Ok(())
        }
        Told::Transfer {
            session,
            mime_type,
            fd,
        } => match backends.remotes.sharing(&session) {
            Ok(()) => {
                let serial = Transfers::hold(&backends.transfers, session.clone(), fd);
                connection.emit_signal(
                    None::<&str>,
                    OBJECT_PATH,
                    CLIPBOARD,
                    "SelectionTransfer",
                    &(&session, mime_type, serial),
                )
            }
            // The session ended after the client asked: dropping the pipe
            // pastes nothing.
            Err(why) => {
                debug!(%why, "a paste of a portal session's offer found no session");
                Ok(())
            }
        },
        Told::Rezoned { set } => {
            for session in backends.inputs.rezoned() {
                connection.emit_signal(
                    None::<&str>,
                    OBJECT_PATH,
                    INPUT_CAPTURE,
                    "ZonesChanged",
                    &(
                        &session,
                        HashMap::from([("zone_set", zbus::zvariant::Value::from(set))]),
                    ),
                )?;
            }
            Ok(())
        }
        Told::Captured {
            session,
            captured:
                Captured::Activated {
                    activation_id,
                    cursor,
                    barrier_id,
                },
        } => connection.emit_signal(
            None::<&str>,
            OBJECT_PATH,
            INPUT_CAPTURE,
            "Activated",
            &(
                &session,
                input_capture::activated(activation_id, (cursor.x, cursor.y), barrier_id),
            ),
        ),
    }
}

/// The `Settings` interface, to signal a change on.
fn settings(
    connection: &zbus::blocking::Connection,
) -> zbus::Result<zbus::blocking::object_server::InterfaceRef<Settings>> {
    connection
        .object_server()
        .interface::<_, Settings>(OBJECT_PATH)
}

/// Registers every interface at [`OBJECT_PATH`].
///
/// On the builder, so the interfaces are there before the first call can
/// arrive.
///
/// `data_dirs` are where `FileChooser` finds MIME types, and `home` is the
/// user's home directory, where `FileChooser` and Save to PDF start.
fn export<'a>(
    builder: Builder<'a>,
    theme: Theme,
    appearance: Appearance,
    starting: Starting,
    backends: &Backends,
    data_dirs: Vec<PathBuf>,
    home: String,
) -> zbus::Result<Builder<'a>> {
    let applications = application_dirs(&data_dirs);
    builder
        .serve_at(OBJECT_PATH, Settings { theme, appearance })?
        .serve_at(
            OBJECT_PATH,
            Access {
                queue: Arc::clone(&backends.queue),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            AppChooser {
                queue: Arc::clone(&backends.queue),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Notification {
                notifications: backends.notifications.clone(),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Inhibit {
                queue: Arc::clone(&backends.queue),
                inhibitors: Arc::clone(&backends.inhibitors),
                screensaver_active: false,
            },
        )?
        .serve_at(
            OBJECT_PATH,
            FileChooser {
                queue: Arc::clone(&backends.queue),
                data_dirs,
                home: home.clone(),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            RemoteDesktop {
                backends: backends.clone(),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Clipboard {
                backends: backends.clone(),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            InputCapture {
                backends: backends.clone(),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Account {
                queue: Arc::clone(&backends.queue),
                user: starting.user,
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Email {
                open: starting.open,
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Lockdown {
                config: starting.lockdown,
            },
        )?
        .serve_at(
            OBJECT_PATH,
            GlobalShortcuts {
                queue: Arc::clone(&backends.queue),
                shortcuts: Arc::clone(&backends.shortcuts),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Background {
                apps: Arc::clone(&backends.apps),
                config_home: backends.config_home.clone(),
                applications,
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Wallpaper {
                queue: Arc::clone(&backends.queue),
                pictures: Arc::clone(&backends.pictures),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            DynamicLauncher {
                queue: Arc::clone(&backends.queue),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Usb {
                queue: Arc::clone(&backends.queue),
                udev_data: PathBuf::from("/run/udev/data"),
            },
        )?
        .serve_at(OBJECT_PATH, starting.screen_cast.picks())?
        .serve_at(OBJECT_PATH, starting.screen_cast)?
        .serve_at(
            OBJECT_PATH,
            Print {
                queue: Arc::clone(&backends.queue),
                cups: starting.cups,
                home,
                prepared: Mutex::default(),
            },
        )?
        .serve_at(
            OBJECT_PATH,
            Screenshot {
                queue: Arc::clone(&backends.queue),
                shots: starting.shots,
            },
        )
}

/// A ScreenCast backend for tests that cast nothing.
#[cfg(test)]
fn idle_screen_cast(queue: &Arc<Queue>) -> ScreenCast {
    let (requests, _) = smithay::reexports::calloop::channel::channel();
    screen_cast(
        queue,
        ScreenCasting {
            casting: Casting::new(requests),
            grants: None,
        },
        Shots::none().shoot,
    )
}

/// The ScreenCast backend, with the restore tokens saved before, previewing
/// sources on what `shoot` takes. Unreadable tokens are set aside:
/// applications ask again.
fn screen_cast(queue: &Arc<Queue>, casting: ScreenCasting, shoot: Shoot) -> ScreenCast {
    let grants = match casting.grants {
        Some(file) => Grants::load(file.clone()).unwrap_or_else(|why| {
            tracing::error!(%why, file = %file.display(), "saved screen cast grants are unreadable; applications will ask again");
            Grants::default()
        }),
        None => Grants::default(),
    };
    ScreenCast::new(Arc::clone(queue), casting.casting, grants, shoot)
}

/// Opens a `mailto:` URL with the page that claims `mailto` links in `links`,
/// else with the desk's default `x-scheme-handler/mailto` application,
/// started through `spawn`.
///
/// Reads `mimeapps.list` and the desktop entries on each call, as GIO does,
/// so a new default takes effect at once.
fn mail_client(spawn: impl Fn(&[String]) + Send + Sync + 'static, links: Links) -> Open {
    Box::new(move |url, app_id| {
        if links.open(url, Some(app_id).filter(|id| !id.is_empty())) {
            return Ok(());
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let applications = application_dirs(&data_dirs(
            std::env::var_os("XDG_DATA_HOME"),
            std::env::var_os("XDG_DATA_DIRS"),
            home.as_deref(),
        ));
        let lists = lists(
            std::env::var_os("XDG_CONFIG_HOME"),
            std::env::var_os("XDG_CONFIG_DIRS"),
            &applications,
            home.as_deref(),
            CURRENT_DESKTOP,
        );
        let terminal = domicile_host::desk_terminal::current();
        let handler = default_handler(
            &["x-scheme-handler/mailto"],
            &lists,
            &applications,
            terminal.as_deref(),
        )
        .ok_or("no installed application opens mailto: links")?;
        let command = handler
            .command(url)
            .ok_or_else(|| format!("{} has an Exec line that cannot be read", handler.id))?;
        spawn(&command);
        Ok(())
    })
}

/// The variables [`say_which_desktop`] sets for activated services.
///
/// Sets `XDG_CURRENT_DESKTOP` and `WAYLAND_DISPLAY` (`ours`) only when this
/// desk is the session. A desk `in_a_window` of another session sets nothing:
/// that session owns its activated apps and portal routing. The activation
/// environment is per user, so the last session to take the name wins, as with
/// `dbus-update-activation-environment`. The supervisor sets the same values
/// in `domicile_launch::graphical_session`.
fn activation_environment(ours: &str, in_a_window: bool) -> Vec<(&'static str, String)> {
    if in_a_window {
        Vec::new()
    } else {
        vec![
            ("XDG_CURRENT_DESKTOP", CURRENT_DESKTOP.to_string()),
            ("WAYLAND_DISPLAY", ours.to_string()),
        ]
    }
}

/// Sets [`activation_environment`] in the D-Bus and systemd user activation
/// environments, like `dbus-update-activation-environment --systemd`, then
/// has a frontend already running read it ([`reroute_frontend`]).
///
/// Without this `xdg-desktop-portal` never routes to this backend. Every call
/// is best effort and logs at `debug`: a desk without a systemd user manager
/// is normal.
fn say_which_desktop(connection: &zbus::blocking::Connection, environment: &[(&str, String)]) {
    // For services D-Bus starts directly.
    let bus = zbus::blocking::Proxy::new(
        connection,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    );
    let told_the_bus = match &bus {
        Ok(bus) => bus.call::<_, _, ()>(
            "UpdateActivationEnvironment",
            &(environment
                .iter()
                .map(|(key, value)| (*key, value.as_str()))
                .collect::<HashMap<_, _>>(),),
        ),
        Err(why) => Err(zbus::Error::Failure(why.to_string())),
    };
    if let Err(why) = told_the_bus {
        tracing::debug!(%why, "the session bus would not take this desktop's name");
    }

    // For services started as systemd user units, which is how most
    // distributions start the portal frontend.
    let systemd = zbus::blocking::Proxy::new(
        connection,
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
    );
    let told_systemd = match &systemd {
        Ok(systemd) => systemd.call::<_, _, ()>(
            "SetEnvironment",
            &(environment
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>(),),
        ),
        Err(why) => Err(zbus::Error::Failure(why.to_string())),
    };
    if let Err(why) = told_systemd {
        tracing::debug!(%why, "no systemd user manager to tell this desktop's name to");
    }

    // A desk in another session's window names nothing, so leaves that
    // session's frontend alone too.
    if let (false, Ok(systemd)) = (environment.is_empty(), &systemd) {
        reroute_frontend(connection, systemd);
    }
}

/// The portal frontend's systemd user unit.
const FRONTEND_UNIT: &str = "xdg-desktop-portal.service";

/// Restarts a portal frontend that started under another desktop's name.
///
/// The frontend reads `XDG_CURRENT_DESKTOP` once, at startup, and routes by it
/// until it exits. One started before this desk named itself (by an app or
/// service at login) routes elsewhere, and every interface only this backend
/// implements is missing from it. See [`must_reroute`] for which is restarted.
/// A frontend D-Bus started directly, not as a unit, is left running.
fn reroute_frontend(connection: &zbus::blocking::Connection, systemd: &zbus::blocking::Proxy<'_>) {
    let main_pid = systemd
        .call::<_, _, OwnedObjectPath>("GetUnit", &(FRONTEND_UNIT,))
        .and_then(|unit| {
            zbus::blocking::Proxy::new(
                connection,
                "org.freedesktop.systemd1",
                unit,
                "org.freedesktop.systemd1.Service",
            )?
            .get_property::<u32>("MainPID")
        });
    let main_pid = match main_pid {
        Ok(main_pid) => main_pid,
        // Not loaded: it reads the new environment when it starts.
        Err(why) => {
            tracing::debug!(%why, "the portal frontend's unit is not loaded");
            return;
        }
    };
    let rerouting = must_reroute(main_pid, |pid| {
        std::fs::read(format!("/proc/{pid}/environ"))
    });
    match rerouting {
        Ok(false) => {}
        Ok(true) => match systemd
            .call::<_, _, OwnedObjectPath>("TryRestartUnit", &(FRONTEND_UNIT, "replace"))
        {
            Ok(_) => tracing::debug!(
                "restarted the portal frontend, which had started under another desktop's name"
            ),
            Err(why) => tracing::debug!(
                %why,
                "the portal frontend started under another desktop's name and could not be \
                 restarted"
            ),
        },
        Err(why) => {
            tracing::debug!(%why, main_pid, "could not read the portal frontend's environment");
        }
    }
}

/// Whether the frontend unit's main process, `main_pid`, must restart to route
/// to this desktop. `environ` reads a process's `/proc/<pid>/environ`.
///
/// Found by its unit, not its bus name: a frontend still loading its backends
/// owns no name yet but already has its environment. `main_pid` is 0 when the
/// unit runs nothing; a frontend started later reads the new environment. Only
/// one that does not name this desktop restarts, so a compositor restart leaves
/// running casts alone.
fn must_reroute(
    main_pid: u32,
    environ: impl FnOnce(u32) -> std::io::Result<Vec<u8>>,
) -> std::io::Result<bool> {
    match main_pid {
        0 => Ok(false),
        pid => environ(pid).map(|environ| !names_this_desktop(&environ)),
    }
}

/// Whether a process environment (`/proc/<pid>/environ`: NUL-separated
/// `KEY=value`) lists this desktop in `XDG_CURRENT_DESKTOP`, a colon-separated
/// list the frontend matches without case.
fn names_this_desktop(environ: &[u8]) -> bool {
    environ
        .split(|byte| *byte == 0)
        .filter_map(|entry| entry.strip_prefix(b"XDG_CURRENT_DESKTOP="))
        .any(|desktops| {
            desktops
                .split(|byte| *byte == b':')
                .any(|desktop| desktop.eq_ignore_ascii_case(CURRENT_DESKTOP.as_bytes()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use account::User;
    use domicile_protocol::{
        AccessDialog, AccountDialog, AppChooserDialog, FileChooserAnswer, Inhibited, Inhibition,
        Notification as Shown, PortalKind,
    };
    use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

    /// The frontend's handle for the dialog these tests open.
    const HANDLE: &str = "/org/freedesktop/portal/desktop/request/1_7/t";

    /// The interfaces served to a client, and what the queue publishes.
    struct Served {
        client: zbus::blocking::Connection,
        queue: Arc<Queue>,
        published: Receiver<Vec<PortalRequest>>,
        backends: Backends,
        server: zbus::blocking::Connection,
    }

    fn served(listening: bool) -> Served {
        served_opening(listening, Box::new(|_, _| Ok(())))
    }

    /// [`served`], opening `mailto:` URLs with `open`.
    fn served_opening(listening: bool, open: Open) -> Served {
        served_as(
            listening,
            open,
            Box::new(|| {
                Box::pin(async {
                    Ok(User {
                        id: "ada".into(),
                        name: "Ada Lovelace".into(),
                        image: Some("/home/ada/me.png".into()),
                    })
                })
            }),
        )
    }

    /// [`served_opening`], with the user `user` finds.
    fn served_as(listening: bool, open: Open, user: LookUp) -> Served {
        let (backends, _) = Backends::new(
            NotificationServer::unserved(Vec::new()),
            Tokens::load(None),
            Shortcuts::new(None),
        );
        let (publish, published) = channel();
        backends.queue.listen(
            move |items, _| {
                let _ = publish.send(items);
            },
            move || listening,
            |parent_window| (parent_window == "wayland:abc").then(|| "app-3".to_string()),
        );
        let (server, client) = socket_pair::connected(|builder| {
            let starting = Starting {
                lockdown: LockdownConfig {
                    disable_camera: true,
                    ..LockdownConfig::default()
                },
                screen_cast: idle_screen_cast(&backends.queue),
                shots: Shots::none(),
                open,
                user,
                cups: Cups::new(Vec::new(), "me".into()),
            };
            export(
                builder,
                Theme::Dark,
                Appearance::default(),
                starting,
                &backends,
                Vec::new(),
                "/home/me".into(),
            )
            .expect("the interfaces registered")
        });
        Served {
            client,
            queue: Arc::clone(&backends.queue),
            published,
            backends,
            server,
        }
    }

    /// The next signal named `member` the client hears.
    #[track_caller]
    /// The next signal named `member` in `messages`. Take `messages` before
    /// whatever sends the signal: one that arrives earlier is not kept.
    fn heard(messages: &mut zbus::blocking::MessageIterator, member: &str) -> zbus::message::Body {
        messages
            .map(|message| message.expect("a message"))
            .find(|message| {
                message.message_type() == zbus::message::Type::Signal
                    && message.header().member().is_some_and(|name| name == member)
            })
            .expect("the signal")
            .body()
    }

    /// Call `AccessDialog` from another thread, returning its response.
    fn ask_for_access(client: &zbus::blocking::Connection) -> thread::JoinHandle<u32> {
        let client = client.clone();
        thread::spawn(move || {
            let options = HashMap::from([(
                "grant_label".to_string(),
                OwnedValue::try_from(Value::from("Allow")).expect("ownable"),
            )]);
            let reply = client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.Access"),
                    "AccessDialog",
                    &(
                        ObjectPath::try_from(HANDLE).expect("a path"),
                        "org.example.App",
                        "wayland:abc",
                        "Use the camera?",
                        "",
                        "",
                        options,
                    ),
                )
                .expect("AccessDialog answered");
            let (response, results): (u32, HashMap<String, OwnedValue>) =
                reply.body().deserialize().expect("its reply");
            assert!(results.is_empty());
            response
        })
    }

    #[track_caller]
    fn next(published: &Receiver<Vec<PortalRequest>>) -> Vec<PortalRequest> {
        published
            .recv_timeout(Duration::from_secs(10))
            .expect("the queue published")
    }

    #[test]
    fn an_access_dialog_waits_for_the_shell_over_its_parent_and_takes_its_answer() {
        let served = served(true);
        let asking = ask_for_access(&served.client);

        assert_eq!(
            next(&served.published),
            [PortalRequest {
                id: 1,
                app_id: "org.example.App".into(),
                parent_app_id: Some("app-3".into()),
                kind: PortalKind::Access(AccessDialog {
                    title: "Use the camera?".into(),
                    subtitle: String::new(),
                    body: String::new(),
                    grant_label: Some("Allow".into()),
                    deny_label: None,
                    destructive: false,
                }),
            }]
        );
        served.queue.answer(1, PortalAnswer::Access);

        assert_eq!(asking.join().expect("the call returned"), 0);
        assert_eq!(next(&served.published), []);
    }

    #[test]
    fn a_dismissed_dialog_answers_one() {
        let served = served(true);
        let asking = ask_for_access(&served.client);
        next(&served.published);
        served.queue.answer(1, PortalAnswer::Canceled);

        assert_eq!(asking.join().expect("the call returned"), 1);
    }

    #[test]
    fn an_application_that_closes_its_request_takes_the_dialog_down() {
        let served = served(true);
        let asking = ask_for_access(&served.client);
        next(&served.published);

        served
            .client
            .call_method(
                None::<&str>,
                HANDLE,
                Some("org.freedesktop.impl.portal.Request"),
                "Close",
                &(),
            )
            .expect("Close answered");

        assert_eq!(next(&served.published), []);
        assert_eq!(asking.join().expect("the call returned"), 2);
    }

    #[test]
    fn a_dialog_nobody_listens_for_is_refused_at_once() {
        let served = served(false);

        assert_eq!(
            ask_for_access(&served.client)
                .join()
                .expect("the call returned"),
            2
        );
        assert!(
            served.published.try_iter().all(|items| items.is_empty()),
            "nothing reached the shell"
        );
    }

    /// Call `ChooseApplication` over `wayland:abc` from another thread,
    /// returning its reply. `modal` is the option, if sent.
    fn choose_application(
        client: &zbus::blocking::Connection,
        modal: Option<bool>,
    ) -> thread::JoinHandle<(u32, HashMap<String, OwnedValue>)> {
        let client = client.clone();
        thread::spawn(move || {
            let mut options = HashMap::from([
                (
                    "content_type".to_string(),
                    OwnedValue::try_from(Value::from("application/pdf")).expect("ownable"),
                ),
                (
                    "activation_token".to_string(),
                    OwnedValue::try_from(Value::from("token-1")).expect("ownable"),
                ),
            ]);
            if let Some(modal) = modal {
                options.insert(
                    "modal".to_string(),
                    OwnedValue::try_from(Value::from(modal)).expect("ownable"),
                );
            }
            client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.AppChooser"),
                    "ChooseApplication",
                    &(
                        ObjectPath::try_from(HANDLE).expect("a path"),
                        "org.example.App",
                        "wayland:abc",
                        vec!["org.gnome.Evince"],
                        options,
                    ),
                )
                .expect("ChooseApplication answered")
                .body()
                .deserialize()
                .expect("its reply")
        })
    }

    /// The dialog [`choose_application`] asks for, modal over `app-3`.
    fn pdf_dialog(choices: &[&str]) -> PortalRequest {
        PortalRequest {
            id: 1,
            app_id: "org.example.App".into(),
            parent_app_id: Some("app-3".into()),
            kind: PortalKind::AppChooser(AppChooserDialog {
                choices: choices.iter().map(|choice| choice.to_string()).collect(),
                last_choice: None,
                content_type: Some("application/pdf".into()),
                uri: None,
                filename: None,
            }),
        }
    }

    #[test]
    fn an_application_chosen_after_the_choices_change_is_answered() {
        let served = served(true);
        let choosing = choose_application(&served.client, None);
        assert_eq!(next(&served.published), [pdf_dialog(&["org.gnome.Evince"])]);

        served
            .client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some("org.freedesktop.impl.portal.AppChooser"),
                "UpdateChoices",
                &(
                    ObjectPath::try_from(HANDLE).expect("a path"),
                    vec!["org.gnome.Evince", "org.gnome.Papers"],
                ),
            )
            .expect("UpdateChoices answered");
        assert_eq!(
            next(&served.published),
            [pdf_dialog(&["org.gnome.Evince", "org.gnome.Papers"])]
        );
        served.queue.answer(
            1,
            PortalAnswer::AppChooser {
                choice: "org.gnome.Papers".into(),
            },
        );

        let (response, results) = choosing.join().expect("the call returned");
        assert_eq!(response, 0);
        assert_eq!(
            results,
            HashMap::from([
                (
                    "choice".to_string(),
                    OwnedValue::try_from(Value::from("org.gnome.Papers")).expect("ownable"),
                ),
                (
                    "activation_token".to_string(),
                    OwnedValue::try_from(Value::from("token-1")).expect("ownable"),
                ),
            ])
        );
    }

    #[test]
    fn a_dialog_that_need_not_be_modal_goes_over_the_focused_screen() {
        let served = served(true);
        let choosing = choose_application(&served.client, Some(false));

        assert_eq!(
            next(&served.published),
            [PortalRequest {
                parent_app_id: None,
                ..pdf_dialog(&["org.gnome.Evince"])
            }]
        );
        served.queue.answer(1, PortalAnswer::Canceled);
        choosing.join().expect("the call returned");
    }

    #[test]
    fn a_choice_that_was_not_offered_is_not_taken() {
        let served = served(true);
        let choosing = choose_application(&served.client, None);
        next(&served.published);

        served.queue.answer(
            1,
            PortalAnswer::AppChooser {
                choice: "org.example.Evil".into(),
            },
        );
        assert_eq!(next(&served.published).len(), 1, "still waiting");
        served.queue.answer(1, PortalAnswer::Canceled);

        let (response, results) = choosing.join().expect("the call returned");
        assert_eq!((response, results.len()), (1, 0));
    }

    /// The notifications the server's history holds after `act`.
    fn shown_after(served: &Served, act: impl FnOnce()) -> Vec<Shown> {
        act();
        let (publish, published) = channel();
        served.backends.notifications.listen(move |items| {
            let _ = publish.send(items);
        });
        published.recv().expect("the history")
    }

    #[test]
    fn a_portal_notification_joins_the_history_and_its_action_goes_back() {
        let served = served(true);
        let add = || {
            let notification = HashMap::from([
                ("title", Value::from("Update")),
                ("default-action", Value::from("app.open")),
                ("default-action-target", Value::from("inbox")),
            ]);
            served
                .client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.Notification"),
                    "AddNotification",
                    &("org.example.App", "update", notification),
                )
                .expect("AddNotification answered");
        };

        let shown = shown_after(&served, add);
        let mut messages = zbus::blocking::MessageIterator::from(&served.client);
        let iface = served
            .server
            .object_server()
            .interface::<_, Notification>(OBJECT_PATH)
            .expect("served");
        notification::invoked(
            &iface,
            Invoked {
                app_id: "org.example.App".into(),
                id: "update".into(),
                action: "app.open".into(),
                target: Some(OwnedValue::try_from(Value::from("inbox")).expect("ownable")),
            },
            "t0k".into(),
        );

        assert_eq!(
            shown
                .iter()
                .map(|shown| (shown.summary.as_str(), shown.clickable))
                .collect::<Vec<_>>(),
            [("Update", true)]
        );
        let (app_id, id, action, parameter): (String, String, String, Vec<OwnedValue>) =
            heard(&mut messages, "ActionInvoked")
                .deserialize()
                .expect("ActionInvoked's arguments");
        assert_eq!(
            (app_id.as_str(), id.as_str(), action.as_str()),
            ("org.example.App", "update", "app.open")
        );
        // The target, then the platform data with a token the application
        // raises its window with.
        let [target, platform_data] = <[OwnedValue; 2]>::try_from(parameter).expect("two values");
        assert_eq!(String::try_from(target), Ok("inbox".to_string()));
        assert_eq!(
            HashMap::<String, String>::try_from(platform_data),
            Ok(HashMap::from([(
                "activation-token".to_string(),
                "t0k".to_string()
            )]))
        );
    }

    #[test]
    fn an_application_removes_its_portal_notification() {
        let served = served(true);
        served
            .client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some("org.freedesktop.impl.portal.Notification"),
                "AddNotification",
                &(
                    "org.example.App",
                    "update",
                    HashMap::from([("title", Value::from("Update"))]),
                ),
            )
            .expect("AddNotification answered");

        let shown = shown_after(&served, || {
            served
                .client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.Notification"),
                    "RemoveNotification",
                    &("org.example.App", "update"),
                )
                .expect("RemoveNotification answered");
        });

        assert_eq!(shown, []);
    }

    /// The handle an application's inhibitor is held under.
    const INHIBITOR: &str = "/org/freedesktop/portal/desktop/request/1_7/i";

    #[test]
    fn an_inhibitor_is_listed_and_holds_idle_until_closed() {
        let served = served(false);
        let (told, held) = channel();
        served
            .backends
            .inhibitors
            .hold_idle_through(move |holds| told.send(holds).expect("the test listens"));

        served
            .client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some("org.freedesktop.impl.portal.Inhibit"),
                "Inhibit",
                &(
                    ObjectPath::try_from(INHIBITOR).expect("a path"),
                    "org.example.Editor",
                    "",
                    1u32 | 8,
                    HashMap::from([("reason", Value::from("Unsaved changes"))]),
                ),
            )
            .expect("Inhibit answered");
        let listed = next(&served.published);
        served
            .client
            .call_method(
                None::<&str>,
                INHIBITOR,
                Some("org.freedesktop.impl.portal.Request"),
                "Close",
                &(),
            )
            .expect("Close answered");

        assert_eq!(
            listed,
            [PortalRequest {
                id: 1,
                app_id: "org.example.Editor".into(),
                parent_app_id: None,
                kind: PortalKind::Inhibit(Inhibition {
                    what: vec![Inhibited::Logout],
                    reason: Some("Unsaved changes".into()),
                }),
            }]
        );
        assert_eq!(next(&served.published), []);
        assert_eq!(
            held.try_iter().collect::<Vec<_>>(),
            [vec!["org.example.Editor".to_string()], vec![]]
        );
    }

    /// Open a monitor at `session`.
    fn monitor(client: &zbus::blocking::Connection, session: &str) -> u32 {
        client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some("org.freedesktop.impl.portal.Inhibit"),
                "CreateMonitor",
                &(
                    ObjectPath::try_from(INHIBITOR).expect("a path"),
                    ObjectPath::try_from(session).expect("a path"),
                    "org.example.Player",
                    "",
                ),
            )
            .expect("CreateMonitor answered")
            .body()
            .deserialize()
            .expect("a response")
    }

    #[test]
    fn a_monitor_hears_the_screensaver_until_it_is_closed() {
        const GONE: &str = "/org/freedesktop/portal/desktop/session/1_7/gone";
        const STAYING: &str = "/org/freedesktop/portal/desktop/session/1_7/staying";
        let served = served(true);
        let inhibit = served
            .server
            .object_server()
            .interface::<_, Inhibit>(OBJECT_PATH)
            .expect("served");
        let responses = [
            monitor(&served.client, GONE),
            monitor(&served.client, STAYING),
        ];
        served
            .client
            .call_method(
                None::<&str>,
                GONE,
                Some("org.freedesktop.impl.portal.Session"),
                "Close",
                &(),
            )
            .expect("Close answered");

        let mut messages = zbus::blocking::MessageIterator::from(&served.client);
        inhibit::screensaver(&inhibit, true).expect("said");

        assert_eq!(responses, [0, 0]);
        // The closed monitor would have been told first.
        let (session, state): (OwnedObjectPath, HashMap<String, OwnedValue>) =
            heard(&mut messages, "StateChanged")
                .deserialize()
                .expect("StateChanged's arguments");
        assert_eq!(session.as_str(), STAYING);
        assert_eq!(bool::try_from(&state["screensaver-active"]), Ok(true));
        assert_eq!(u32::try_from(&state["session-state"]), Ok(1));
    }

    #[test]
    fn a_new_look_is_signaled_to_clients() {
        let served = served(true);
        let settings = served
            .server
            .object_server()
            .interface::<_, Settings>(OBJECT_PATH)
            .expect("served");
        let mut messages = zbus::blocking::MessageIterator::from(&served.client);

        settings::changed(
            &settings,
            None,
            Some(Appearance {
                reduced_motion: true,
                ..Appearance::default()
            }),
        )
        .expect("said");

        let (namespace, key, value): (String, String, OwnedValue) =
            heard(&mut messages, "SettingChanged")
                .deserialize()
                .expect("SettingChanged's arguments");
        assert_eq!(
            (namespace.as_str(), key.as_str(), u32::try_from(value)),
            ("org.freedesktop.appearance", "reduced-motion", Ok(1))
        );
    }

    #[test]
    fn a_file_chooser_waits_for_the_shell_and_answers_with_file_uris() {
        let served = served(true);
        let client = served.client.clone();
        let asking = thread::spawn(move || {
            let options = HashMap::from([(
                "multiple".to_string(),
                OwnedValue::try_from(Value::from(true)).expect("ownable"),
            )]);
            let reply = client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.FileChooser"),
                    "OpenFile",
                    &(
                        ObjectPath::try_from(HANDLE).expect("a path"),
                        "org.example.Editor",
                        "",
                        "Open Notes",
                        options,
                    ),
                )
                .expect("OpenFile answered");
            let (response, results): (u32, HashMap<String, OwnedValue>) =
                reply.body().deserialize().expect("its reply");
            (
                response,
                Vec::<String>::try_from(results["uris"].try_clone().expect("cloned"))
                    .expect("uris"),
            )
        });

        let [request] = &next(&served.published)[..] else {
            panic!("one request");
        };
        let PortalKind::FileChooser(dialog) = &request.kind else {
            panic!("a file chooser: {request:?}");
        };
        assert_eq!(
            (dialog.title.as_str(), dialog.multiple),
            ("Open Notes", true)
        );
        served.queue.answer(
            request.id,
            PortalAnswer::FileChooser(FileChooserAnswer {
                paths: vec!["/home/me/a.txt".into(), "/home/me/b.txt".into()],
                choices: Default::default(),
                current_filter: None,
            }),
        );

        assert_eq!(
            asking.join().expect("the call returned"),
            (
                0,
                vec![
                    "file:///home/me/a.txt".to_string(),
                    "file:///home/me/b.txt".to_string()
                ]
            )
        );
    }

    /// Call `GetUserInformation` from another thread, returning its reply.
    fn ask_for_the_user(
        client: &zbus::blocking::Connection,
    ) -> thread::JoinHandle<(u32, HashMap<String, OwnedValue>)> {
        let client = client.clone();
        thread::spawn(move || {
            let options = HashMap::from([(
                "reason".to_string(),
                OwnedValue::try_from(Value::from("To sign you in")).expect("ownable"),
            )]);
            client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.Account"),
                    "GetUserInformation",
                    &(
                        ObjectPath::try_from(HANDLE).expect("a path"),
                        "org.example.Mail",
                        "",
                        options,
                    ),
                )
                .expect("GetUserInformation answered")
                .body()
                .deserialize()
                .expect("its reply")
        })
    }

    #[test]
    fn an_allowed_account_request_answers_who_the_user_is() {
        let served = served(true);
        let asking = ask_for_the_user(&served.client);

        assert_eq!(
            next(&served.published),
            [PortalRequest {
                id: 1,
                app_id: "org.example.Mail".into(),
                parent_app_id: None,
                kind: PortalKind::Account(AccountDialog {
                    reason: Some("To sign you in".into()),
                    name: "Ada Lovelace".into(),
                    image: Some("/home/ada/me.png".into()),
                }),
            }]
        );
        served.queue.answer(1, PortalAnswer::Access);

        let (response, results) = asking.join().expect("the call returned");
        assert_eq!(response, 0);
        let text = |key: &str| {
            String::try_from(results.get(key).expect(key).try_clone().expect("cloned"))
                .expect("a string")
        };
        assert_eq!(
            [text("id"), text("name"), text("image")],
            ["ada", "Ada Lovelace", "file:///home/ada/me.png"]
        );
    }

    #[test]
    fn an_account_request_for_a_user_not_found_fails_without_asking() {
        let served = served_as(
            true,
            Box::new(|_, _| Ok(())),
            Box::new(|| Box::pin(async { Err("nobody".into()) })),
        );

        assert_eq!(
            ask_for_the_user(&served.client)
                .join()
                .expect("the call returned"),
            (2, HashMap::new()),
            "answered with nobody to answer the dialog"
        );
    }

    #[test]
    fn a_denied_account_request_answers_nothing() {
        let served = served(true);
        let asking = ask_for_the_user(&served.client);
        next(&served.published);
        served.queue.answer(1, PortalAnswer::Canceled);

        assert_eq!(
            asking.join().expect("the call returned"),
            (1, HashMap::new())
        );
    }

    /// Call `ComposeEmail` with one recipient, returning its response.
    fn compose(client: &zbus::blocking::Connection) -> u32 {
        let options = HashMap::from([(
            "address".to_string(),
            OwnedValue::try_from(Value::from("a@example.com")).expect("ownable"),
        )]);
        let (response, results): (u32, HashMap<String, OwnedValue>) = client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some("org.freedesktop.impl.portal.Email"),
                "ComposeEmail",
                &(
                    ObjectPath::try_from(HANDLE).expect("a path"),
                    "org.example.App",
                    "",
                    options,
                ),
            )
            .expect("ComposeEmail answered")
            .body()
            .deserialize()
            .expect("its reply");
        assert!(results.is_empty());
        response
    }

    #[test]
    fn an_email_opens_the_mail_client_without_a_dialog() {
        let (opened, heard) = channel();
        let served = served_opening(
            true,
            Box::new(move |url, _| {
                opened.send(url.to_string()).expect("the test listens");
                Ok(())
            }),
        );

        assert_eq!(compose(&served.client), 0);
        assert_eq!(heard.try_recv(), Ok("mailto:a@example.com".to_string()));
        assert!(
            served.published.try_iter().all(|items| items.is_empty()),
            "nothing reached the shell"
        );
    }

    #[test]
    fn an_email_goes_to_the_page_that_claims_mailto_links() {
        let links = Links::default();
        let (told, heard) = channel();
        let page = domicile_host::system::System::new(std::env::temp_dir(), Vec::new(), 0, {
            let told = Mutex::new(told);
            move |message| {
                let _ = told.lock().unwrap().send(message);
            }
        })
        .sharing_links(links.clone());
        page.handle(
            7,
            domicile_protocol::SystemRequest::ClaimLinks {
                schemes: vec!["mailto".into()],
            },
        );
        let open = mail_client(|_| panic!("the mail client started"), links);

        assert_eq!(open("mailto:a@example.com", "org.example.App"), Ok(()));
        let heard: Vec<domicile_protocol::HostMessage> = heard.try_iter().collect();
        assert_eq!(
            heard.last(),
            Some(&domicile_protocol::HostMessage::SystemEvent {
                id: 7,
                event: domicile_protocol::SystemEvent::Link {
                    url: "mailto:a@example.com".into(),
                    app_id: Some("org.example.App".into()),
                },
            })
        );
    }

    #[test]
    fn an_email_with_no_mail_client_fails() {
        let served = served_opening(true, Box::new(|_, _| Err("no mail client".into())));

        assert_eq!(compose(&served.client), 2);
    }

    /// The `Lockdown` switch `name`, as a client reads it.
    fn switch(client: &zbus::blocking::Connection, name: &str) -> bool {
        let value: OwnedValue = client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &("org.freedesktop.impl.portal.Lockdown", name),
            )
            .expect("Get answered")
            .body()
            .deserialize()
            .expect("a value");
        bool::try_from(value).expect("a boolean")
    }

    #[test]
    fn lockdown_reports_the_configs_switches() {
        let served = served(true);

        assert!(switch(&served.client, "disable-camera"));
        assert!(!switch(&served.client, "disable-printing"));
    }

    #[test]
    fn a_new_lockdown_is_signaled_and_then_read() {
        let served = served(true);
        let signals = zbus::blocking::MessageIterator::from(&served.client);
        let lockdown = served
            .server
            .object_server()
            .interface::<_, Lockdown>(OBJECT_PATH)
            .expect("Lockdown is served");

        lockdown::changed(
            &lockdown,
            LockdownConfig {
                disable_printing: true,
                ..LockdownConfig::default()
            },
        )
        .expect("signaled");

        let signal = signals
            .map(|message| message.expect("a message"))
            .find(|message| {
                message
                    .header()
                    .member()
                    .is_some_and(|member| member == "PropertiesChanged")
            })
            .expect("a PropertiesChanged signal");
        let (interface, changed, _): (String, HashMap<String, OwnedValue>, Vec<String>) =
            signal.body().deserialize().expect("its body");
        assert_eq!(interface, "org.freedesktop.impl.portal.Lockdown");
        assert_eq!(
            bool::try_from(changed["disable-printing"].try_clone().expect("cloned")),
            Ok(true)
        );
        assert!(switch(&served.client, "disable-printing"));
        assert!(!switch(&served.client, "disable-camera"));
    }

    #[test]
    fn the_print_dialog_is_served() {
        let served = served(true);
        let client = served.client.clone();
        let preparing = thread::spawn(move || {
            let empty = HashMap::<String, OwnedValue>::new();
            let (response, _): (u32, HashMap<String, OwnedValue>) = client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.Print"),
                    "PreparePrint",
                    &(
                        ObjectPath::try_from(HANDLE).expect("a path"),
                        "org.example.App",
                        "",
                        "Report",
                        &empty,
                        &empty,
                        &empty,
                    ),
                )
                .expect("PreparePrint answered")
                .body()
                .deserialize()
                .expect("its reply");
            response
        });

        assert!(matches!(
            next(&served.published).as_slice(),
            [PortalRequest {
                kind: PortalKind::Print(_),
                ..
            }]
        ));
        served.queue.answer(1, PortalAnswer::Canceled);
        assert_eq!(preparing.join().expect("the call returned"), 1);
    }

    #[test]
    fn a_desk_that_is_the_session_is_where_activated_apps_open() {
        // Activated apps open on the `WAYLAND_DISPLAY` in the activation
        // environment, which another session may have set.
        assert_eq!(
            activation_environment("wayland-1", false),
            [
                ("XDG_CURRENT_DESKTOP", CURRENT_DESKTOP.to_string()),
                ("WAYLAND_DISPLAY", "wayland-1".to_string()),
            ]
        );
    }

    #[test]
    fn a_desk_in_a_window_leaves_its_sessions_activation_environment_alone() {
        // The outer session owns its activated apps and portal routing.
        assert_eq!(activation_environment("wayland-1", true), []);
    }

    #[test]
    fn a_frontend_that_is_not_running_reads_the_new_environment_when_it_starts() {
        assert!(!must_reroute(0, |_| unreachable!("no process to read")).unwrap());
    }

    #[test]
    fn a_frontend_still_starting_under_another_desktops_name_is_restarted() {
        // A frontend forked before this desk named itself owns no bus name
        // until it has loaded its backends, which takes seconds. Its unit's
        // main process is what gives it away.
        let environ = |pid| {
            assert_eq!(pid, 4242);
            Ok(b"HOME=/home/ada\0".to_vec())
        };
        assert!(must_reroute(4242, environ).unwrap());
    }

    #[test]
    fn a_frontend_started_for_this_desktop_is_left_running() {
        assert!(names_this_desktop(
            b"HOME=/home/ada\0XDG_CURRENT_DESKTOP=domicile\0PATH=/bin\0"
        ));
        assert!(names_this_desktop(b"XDG_CURRENT_DESKTOP=sway:Domicile"));
    }

    #[test]
    fn a_frontend_started_for_another_desktop_or_none_is_restarted() {
        assert!(!names_this_desktop(b"XDG_CURRENT_DESKTOP=sway\0"));
        assert!(!names_this_desktop(b"HOME=/home/ada\0PATH=/bin\0"));
        assert!(!names_this_desktop(b"XDG_CURRENT_DESKTOP=domicile-ish\0"));
        assert!(!names_this_desktop(b"NOT_XDG_CURRENT_DESKTOP=domicile\0"));
    }
}
