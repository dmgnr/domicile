//! `org.freedesktop.impl.portal.Inhibit`: applications holding off idle,
//! logout, user switching and suspend, and watching the session's state.
//!
//! - An idle inhibitor (flag 8) vetoes blanking, as a
//!   `zwp_idle_inhibit_manager_v1` inhibitor does; see [`crate::idle`]. The
//!   desk hears who holds each one, so a shell can name them.
//! - Logout, user-switch and suspend inhibitors (1, 2, 4) are listed in the
//!   portal requests as [`PortalKind::Inhibit`], so a shell can say who holds
//!   them. The desk has none of those actions yet, so nothing else reads them.
//! - A monitor hears `StateChanged` when the screensaver (blanking or the
//!   lock) starts or stops. The session is always running: the desk has no
//!   logout, so it never asks monitors to end (query-end).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use domicile_protocol::{Inhibited, Inhibition, PortalKind};
use tracing::{debug, warn};
use zbus::object_server::{ObjectServer, SignalEmitter};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use super::queue::Queue;
use super::session;

/// The idle flag, which the compositor's idle timer honors.
const IDLE: u32 = 8;

/// `session-state` for a running session.
const RUNNING: u32 = 1;

/// The flags this records for the shell, and what each holds off.
const LISTED: [(u32, Inhibited); 3] = [
    (1, Inhibited::Logout),
    (2, Inhibited::UserSwitch),
    (4, Inhibited::Suspend),
];

/// What every inhibitor and monitor shares.
#[derive(Default)]
pub struct Inhibitors {
    /// Idle inhibitors held: each one's handle, and the application holding
    /// it.
    idle: Mutex<Vec<(OwnedObjectPath, String)>>,
    hold_idle: OnceLock<Box<dyn Fn(Vec<String>) + Send + Sync>>,
    /// Sessions that hear `StateChanged`.
    monitors: Mutex<Vec<OwnedObjectPath>>,
}

impl Inhibitors {
    /// Call `hold` with the applications holding idle inhibitors, one name
    /// per inhibitor, each time one starts or ends.
    pub fn hold_idle_through(&self, hold: impl Fn(Vec<String>) + Send + Sync + 'static) {
        if self.hold_idle.set(Box::new(hold)).is_err() {
            panic!("idle inhibitors have one listener");
        }
    }

    /// `app` took an idle inhibitor under `handle`.
    fn idle_held(&self, handle: OwnedObjectPath, app: String) {
        let mut held = self.idle.lock().unwrap();
        held.push((handle, app));
        self.tell(&held);
    }

    /// The idle inhibitor under `handle` ended.
    fn idle_released(&self, handle: &OwnedObjectPath) {
        let mut held = self.idle.lock().unwrap();
        held.retain(|(holding, _)| holding != handle);
        self.tell(&held);
    }

    fn tell(&self, held: &[(OwnedObjectPath, String)]) {
        match self.hold_idle.get() {
            Some(hold) => hold(held.iter().map(|(_, app)| app.clone()).collect()),
            None => tracing::error!("an idle inhibitor reached a desk not listening for one"),
        }
    }
}

/// The `Inhibit` backend object.
pub struct Inhibit {
    pub queue: Arc<Queue>,
    pub inhibitors: Arc<Inhibitors>,
    /// Whether the screens are blanked or locked.
    pub screensaver_active: bool,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Inhibit")]
impl Inhibit {
    /// Hold what `flags` names until the application closes `handle`.
    #[allow(clippy::too_many_arguments)] // The spec's own signature.
    async fn inhibit(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        #[zbus(connection)] connection: &zbus::Connection,
        handle: OwnedObjectPath,
        app_id: String,
        window: String,
        flags: u32,
        mut options: HashMap<String, OwnedValue>,
    ) -> zbus::fdo::Result<()> {
        let reason = options
            .remove("reason")
            .and_then(|value| String::try_from(value).ok());
        let idle = flags & IDLE != 0;
        if idle {
            let app = match app_id.is_empty() {
                true => process_of(connection, &handle).await,
                false => app_id.clone(),
            };
            self.inhibitors.idle_held(handle.clone(), app);
        }
        let listed = inhibition(flags, reason)
            .map(|kind| self.queue.hold(app_id, &window, PortalKind::Inhibit(kind)));
        let held = Held {
            queue: Arc::clone(&self.queue),
            inhibitors: Arc::clone(&self.inhibitors),
            listed,
            idle,
        };
        server.at(&handle, held).await?;
        Ok(())
    }

    /// Send `session_handle` the session's state on each change, until it is
    /// closed.
    async fn create_monitor(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        session_handle: OwnedObjectPath,
        app_id: String,
        window: String,
    ) -> zbus::fdo::Result<u32> {
        debug!(%handle, %app_id, %window, "an application watches the session's state");
        let inhibitors = Arc::clone(&self.inhibitors);
        let closing = session_handle.clone();
        session::open(server, &session_handle, move || {
            inhibitors
                .monitors
                .lock()
                .unwrap()
                .retain(|monitor| *monitor != closing);
        })
        .await?;
        self.inhibitors
            .monitors
            .lock()
            .unwrap()
            .push(session_handle);
        Ok(0)
    }

    /// A monitor is ready for the session to end. The desk never asks, so
    /// there is nothing to wait for.
    fn query_end_response(&self, session_handle: OwnedObjectPath) {
        debug!(%session_handle, "a monitor answered a query-end this desk never sent");
    }

    #[zbus(signal)]
    async fn state_changed(
        emitter: &SignalEmitter<'_>,
        session_handle: OwnedObjectPath,
        state: HashMap<&str, Value<'_>>,
    ) -> zbus::Result<()>;
}

/// Store whether the screensaver is active, and tell every monitor if that
/// changed.
pub fn screensaver(
    served: &zbus::blocking::object_server::InterfaceRef<Inhibit>,
    active: bool,
) -> zbus::Result<()> {
    let monitors = {
        let mut inhibit = served.get_mut();
        let changed = inhibit.screensaver_active != active;
        inhibit.screensaver_active = active;
        if changed {
            inhibit.inhibitors.monitors.lock().unwrap().clone()
        } else {
            Vec::new()
        }
    };
    for monitor in monitors {
        zbus::block_on(Inhibit::state_changed(
            served.signal_emitter(),
            monitor,
            HashMap::from([
                ("screensaver-active", Value::from(active)),
                ("session-state", Value::from(RUNNING)),
            ]),
        ))?;
    }
    Ok(())
}

/// What `flags` asks a shell to show, or `None` for idle alone.
fn inhibition(flags: u32, reason: Option<String>) -> Option<Inhibition> {
    let what: Vec<Inhibited> = LISTED
        .iter()
        .filter(|(flag, _)| flags & flag != 0)
        .map(|(_, inhibited)| *inhibited)
        .collect();
    (!what.is_empty()).then_some(Inhibition { what, reason })
}

/// The unique bus name of the application that asked under `handle`, which
/// xdg-desktop-portal writes into the handle as
/// `/org/freedesktop/portal/desktop/request/<sender>/<token>`, the sender's
/// `:` dropped and its `.` written `_`.
fn asker(handle: &str) -> Option<String> {
    let sender = handle
        .strip_prefix("/org/freedesktop/portal/desktop/request/")?
        .split('/')
        .next()?;
    Some(format!(":{}", sender.replace('_', ".")))
}

/// What a holder the shell took, like the bar's eye, is called.
pub const SHELL: &str = "domicile";

/// The process name of the application holding the inhibitor under `handle`.
///
/// For an application xdg-desktop-portal gives no app id, which is any not
/// sandboxed. Only a name for the shell, so a name that cannot be read is
/// logged and stands in, rather than refusing the inhibitor. One a shell page
/// took is [`SHELL`].
async fn process_of(connection: &zbus::Connection, handle: &OwnedObjectPath) -> String {
    let named = async {
        let sender = asker(handle.as_str()).ok_or("the handle names no sender")?;
        let bus = zbus::fdo::DBusProxy::new(connection).await?;
        let pid = bus
            .get_connection_unix_process_id(zbus::names::BusName::try_from(sender)?)
            .await?;
        // Each shell page has its own bus connection from this process.
        if pid == std::process::id() {
            return Ok(SHELL.to_string());
        }
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm"))?;
        Ok::<_, Box<dyn std::error::Error>>(comm.trim().to_string())
    };
    match named.await {
        Ok(name) => name,
        Err(why) => {
            warn!(%handle, %why, "no name for the application holding an idle inhibitor");
            "an application".into()
        }
    }
}

/// One inhibitor's `Request` object. Closing it lets go.
struct Held {
    queue: Arc<Queue>,
    inhibitors: Arc<Inhibitors>,
    /// Its id in the portal requests.
    listed: Option<u32>,
    idle: bool,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Request")]
impl Held {
    async fn close(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        if let Some(id) = self.listed {
            self.queue.withdraw(id);
        }
        if self.idle {
            self.inhibitors
                .idle_released(&emitter.path().to_owned().into());
        }
        server.remove::<Held, _>(emitter.path()).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_user_switching_and_suspend_are_listed_and_idle_is_not() {
        assert_eq!(
            inhibition(1 | 2 | 4 | 8, Some("Burning a disc".into())),
            Some(Inhibition {
                what: vec![Inhibited::Logout, Inhibited::UserSwitch, Inhibited::Suspend],
                reason: Some("Burning a disc".into()),
            })
        );
        assert_eq!(inhibition(IDLE, None), None);
    }

    #[test]
    fn each_idle_inhibitor_reaches_the_desk_with_who_holds_it() {
        let inhibitors = Inhibitors::default();
        let (told, heard) = std::sync::mpsc::channel();
        inhibitors.hold_idle_through(move |by| told.send(by).expect("the test listens"));
        let film = OwnedObjectPath::try_from("/request/1_7/film").expect("a path");
        let call = OwnedObjectPath::try_from("/request/1_9/call").expect("a path");

        inhibitors.idle_held(film.clone(), "mpv".into());
        inhibitors.idle_held(call.clone(), "slack".into());
        inhibitors.idle_released(&film);
        inhibitors.idle_released(&call);

        assert_eq!(
            heard.try_iter().collect::<Vec<_>>(),
            [
                vec!["mpv".to_string()],
                vec!["mpv".to_string(), "slack".to_string()],
                vec!["slack".to_string()],
                vec![],
            ]
        );
    }

    #[test]
    fn a_handle_names_the_application_that_asked() {
        assert_eq!(
            asker("/org/freedesktop/portal/desktop/request/1_7/token"),
            Some(":1.7".to_string())
        );
        assert_eq!(asker("/org/freedesktop/portal/desktop/session/x"), None);
    }
}
