//! `org.freedesktop.impl.portal.Background`: which applications run, and
//! their autostart entries.
//!
//! The frontend asks the user whether an application may run in the
//! background through [`Access`](super::access::Access), so this backend has
//! no dialog of its own. It reports each window's application, tells the user
//! through a notification when one keeps running without a window, and writes
//! autostart entries (`domicile_host::autostart`).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use domicile_host::app_names::app;
use zbus::blocking::object_server::InterfaceRef;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

/// `GetAppState`'s value for an application with an open window.
const RUNNING: u32 = 1;

/// `GetAppState`'s value for the application with the focused window.
const ACTIVE: u32 = 2;

/// `NotifyBackground`'s `result` that lets this one instance run on.
const ALLOW_ONCE: u32 = 2;

/// The `EnableAutostart` flag for D-Bus activation.
const DBUS_ACTIVATABLE: u32 = 1;

/// The `Background` backend object.
pub struct Background {
    pub apps: Arc<RunningApps>,
    /// `$XDG_CONFIG_HOME`, where autostart entries go. `None` when neither it
    /// nor `HOME` is set.
    pub config_home: Option<PathBuf>,
    /// Where desktop entries are, to name an application the frontend gave no
    /// name for.
    pub applications: Vec<PathBuf>,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Background")]
impl Background {
    /// Each application with a window: `1` running, `2` focused. The frontend
    /// reads an application missing here as running without a window.
    fn get_app_state(&self) -> HashMap<String, OwnedValue> {
        self.apps
            .held
            .lock()
            .unwrap()
            .iter()
            .map(|(app_id, state)| (app_id.clone(), OwnedValue::from(*state)))
            .collect()
    }

    /// Tell the user that `name` runs without a window, and let it go on.
    ///
    /// A notification rather than a dialog: an application asked already,
    /// through the frontend's access dialog, so this only informs.
    async fn notify_background(
        &self,
        #[zbus(connection)] connection: &zbus::Connection,
        _handle: OwnedObjectPath,
        app_id: String,
        name: String,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let shown = if name.is_empty() {
            app(&app_id, &self.applications).name
        } else {
            name
        };
        let summary = format!("{shown} is running in the background");
        let hints: HashMap<&str, Value<'_>> = HashMap::new();
        let notified = connection
            .call_method(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                Some("org.freedesktop.Notifications"),
                "Notify",
                &(
                    shown.as_str(),
                    0u32,
                    app_id.as_str(),
                    summary.as_str(),
                    "",
                    Vec::<&str>::new(),
                    hints,
                    -1i32,
                ),
            )
            .await;
        if let Err(why) = notified {
            tracing::error!(%why, %app_id, "the user was not told an application runs in the background");
        }
        (
            0,
            HashMap::from([("result".to_string(), OwnedValue::from(ALLOW_ONCE))]),
        )
    }

    /// Write or remove `app_id`'s autostart entry. `false` when it does not
    /// start with the session, including when the entry could not be written.
    fn enable_autostart(
        &self,
        app_id: String,
        enable: bool,
        commandline: Vec<String>,
        flags: u32,
    ) -> bool {
        let Some(config_home) = &self.config_home else {
            tracing::error!(
                %app_id,
                "nowhere to keep autostart entries: neither XDG_CONFIG_HOME \
                 nor HOME is set"
            );
            return false;
        };
        domicile_host::autostart::set(
            config_home,
            &app_id,
            enable,
            &commandline,
            flags & DBUS_ACTIVATABLE != 0,
        )
        .unwrap_or_else(|why| {
            tracing::error!(%why, %app_id, "an autostart entry could not be changed");
            false
        })
    }

    #[zbus(signal)]
    async fn running_applications_changed(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;
}

/// Each application with a window, and its `GetAppState` value.
#[derive(Default)]
pub struct RunningApps {
    held: Mutex<BTreeMap<String, u32>>,
}

impl RunningApps {
    /// Replace the windows' applications from each window's app id and
    /// whether it has focus. Returns whether anything changed.
    pub fn set(&self, windows: impl IntoIterator<Item = (String, bool)>) -> bool {
        let mut states = BTreeMap::new();
        for (app_id, focused) in windows {
            if app_id.is_empty() {
                continue;
            }
            let state = if focused { ACTIVE } else { RUNNING };
            let held = states.entry(app_id).or_insert(state);
            *held = (*held).max(state);
        }
        let mut held = self.held.lock().unwrap();
        let changed = *held != states;
        *held = states;
        changed
    }
}

/// Emit `RunningApplicationsChanged`. A failure is logged, as in
/// `settings::changed`.
pub fn changed(served: &InterfaceRef<Background>) {
    let said = zbus::block_on(Background::running_applications_changed(
        served.signal_emitter(),
    ));
    if let Err(why) = said {
        tracing::error!(%why, "the frontend was not told the running applications changed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc::{channel, Sender};
    use std::time::Duration;

    use crate::portals::socket_pair::connected_both;

    const PATH: &str = "/org/freedesktop/portal/desktop";
    const INTERFACE: &str = "org.freedesktop.impl.portal.Background";

    /// A notification server on the application's end, standing in for the
    /// desktop's.
    struct Notifications {
        heard: Sender<(String, String, String)>,
    }

    #[zbus::interface(name = "org.freedesktop.Notifications")]
    impl Notifications {
        #[allow(clippy::too_many_arguments)] // The spec's own signature.
        fn notify(
            &self,
            app_name: String,
            _replaces_id: u32,
            app_icon: String,
            summary: String,
            _body: String,
            _actions: Vec<String>,
            _hints: HashMap<String, OwnedValue>,
            _expire_timeout: i32,
        ) -> u32 {
            let _ = self.heard.send((app_name, app_icon, summary));
            1
        }
    }

    fn served(
        config_home: Option<PathBuf>,
        heard: Sender<(String, String, String)>,
    ) -> (zbus::blocking::Connection, zbus::blocking::Connection) {
        connected_both(
            move |builder| {
                builder
                    .serve_at(
                        PATH,
                        Background {
                            apps: Arc::default(),
                            config_home,
                            applications: Vec::new(),
                        },
                    )
                    .expect("served")
            },
            move |builder| {
                builder
                    .serve_at("/org/freedesktop/Notifications", Notifications { heard })
                    .expect("served")
            },
        )
    }

    #[test]
    fn the_focused_window_s_application_is_active() {
        let apps = RunningApps::default();

        assert!(apps.set([
            ("org.example.Chat".to_string(), false),
            ("org.example.Editor".to_string(), true),
            ("org.example.Editor".to_string(), false),
            (String::new(), true),
        ]));

        assert_eq!(
            *apps.held.lock().unwrap(),
            BTreeMap::from([
                ("org.example.Chat".to_string(), RUNNING),
                ("org.example.Editor".to_string(), ACTIVE),
            ])
        );
        assert!(
            !apps.set([
                ("org.example.Editor".to_string(), true),
                ("org.example.Chat".to_string(), false),
            ]),
            "the same windows change nothing"
        );
    }

    #[test]
    fn the_frontend_reads_each_application_s_state_and_hears_changes() {
        let (heard, _) = channel();
        let (server, client) = served(None, heard);
        let served = server
            .object_server()
            .interface::<_, Background>(PATH)
            .expect("served");
        served
            .get()
            .apps
            .set([("org.example.Chat".to_string(), true)]);
        let signals = zbus::blocking::MessageIterator::for_match_rule(
            zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .interface(INTERFACE)
                .expect("an interface")
                .member("RunningApplicationsChanged")
                .expect("a member")
                .build(),
            &client,
            None,
        )
        .expect("listening");

        changed(&served);

        let states: HashMap<String, OwnedValue> = client
            .call_method(None::<&str>, PATH, Some(INTERFACE), "GetAppState", &())
            .expect("GetAppState answered")
            .body()
            .deserialize()
            .expect("the states");
        assert_eq!(
            states
                .into_iter()
                .map(|(app_id, state)| (app_id, u32::try_from(state).expect("a u")))
                .collect::<Vec<_>>(),
            [("org.example.Chat".to_string(), ACTIVE)]
        );
        assert!(signals.into_iter().next().is_some(), "the change was said");
    }

    #[test]
    fn an_application_in_the_background_is_a_notification_and_runs_on() {
        let (heard, notified) = channel();
        let (_server, client) = served(None, heard);

        let (response, results): (u32, HashMap<String, OwnedValue>) = client
            .call_method(
                None::<&str>,
                PATH,
                Some(INTERFACE),
                "NotifyBackground",
                &(
                    OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/request/1_7/b")
                        .expect("a path"),
                    "org.example.Chat",
                    "Chat",
                ),
            )
            .expect("NotifyBackground answered")
            .body()
            .deserialize()
            .expect("its reply");

        assert_eq!(response, 0);
        assert_eq!(
            results
                .get("result")
                .map(|result| u32::try_from(result.try_clone().expect("cloned"))),
            Some(Ok(ALLOW_ONCE))
        );
        assert_eq!(
            notified
                .recv_timeout(Duration::from_secs(10))
                .expect("the user was told"),
            (
                "Chat".to_string(),
                "org.example.Chat".to_string(),
                "Chat is running in the background".to_string()
            )
        );
    }

    #[test]
    fn an_application_the_frontend_does_not_name_is_named_by_its_id() {
        let (heard, notified) = channel();
        let (_server, client) = served(None, heard);

        let _: (u32, HashMap<String, OwnedValue>) = client
            .call_method(
                None::<&str>,
                PATH,
                Some(INTERFACE),
                "NotifyBackground",
                &(
                    OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/request/1_7/b")
                        .expect("a path"),
                    "org.example.Chat",
                    "",
                ),
            )
            .expect("NotifyBackground answered")
            .body()
            .deserialize()
            .expect("its reply");

        assert_eq!(
            notified
                .recv_timeout(Duration::from_secs(10))
                .expect("the user was told")
                .2,
            "Chat is running in the background"
        );
    }

    #[test]
    fn autostart_writes_and_removes_the_entry() {
        let config = tempfile::tempdir().expect("a directory");
        let (heard, _) = channel();
        let (_server, client) = served(Some(config.path().to_path_buf()), heard);
        let enable = |enable: bool| -> bool {
            client
                .call_method(
                    None::<&str>,
                    PATH,
                    Some(INTERFACE),
                    "EnableAutostart",
                    &("org.example.Chat", enable, vec!["chat", "--hidden"], 0u32),
                )
                .expect("EnableAutostart answered")
                .body()
                .deserialize()
                .expect("a result")
        };
        let entry = config.path().join("autostart/org.example.Chat.desktop");

        assert!(enable(true));
        assert!(fs::read_to_string(&entry)
            .expect("the entry is there")
            .contains("Exec=chat --hidden\n"));
        assert!(!enable(false));
        assert!(!entry.exists());
    }

    #[test]
    fn autostart_with_nowhere_to_write_is_refused() {
        let (heard, _) = channel();
        let (_server, client) = served(None, heard);

        let enabled: bool = client
            .call_method(
                None::<&str>,
                PATH,
                Some(INTERFACE),
                "EnableAutostart",
                &("org.example.Chat", true, vec!["chat"], 0u32),
            )
            .expect("EnableAutostart answered")
            .body()
            .deserialize()
            .expect("a result");

        assert!(!enabled);
    }
}
