//! `org.freedesktop.ScreenSaver`: applications asking to keep the screens on.
//!
//! A browser holding a screen wake lock (a video call, a film) asks here when
//! no GNOME session manager owns its name; Chromium, Firefox, mpv and VLC all
//! do. So do browser windows in the engine, which are not Wayland clients and
//! have no idle inhibitor to take.
//!
//! - Each hold is reported to the Wayland thread, which honors it like a
//!   portal inhibitor; see [`crate::idle`].
//! - A hold from a process with windows holds only while one of them is shown
//!   (see [`still_holds`]), as a Wayland inhibitor holds only on a shown
//!   window. Electron apps ask here as well as through Wayland.
//! - A hold ends with `UnInhibit`, or when its application leaves the bus.

use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use tracing::debug;
use zbus::blocking::connection::Builder;
use zbus::blocking::MessageIterator;
use zbus::message::{Header, Type};
use zbus::MatchRule;

const NAME: &str = "org.freedesktop.ScreenSaver";

/// Firefox and VLC use the short path; Chromium the long one.
const PATHS: [&str; 2] = ["/org/freedesktop/ScreenSaver", "/ScreenSaver"];

/// What a hold from the engine's own browser process is called: a page in a
/// browser window, which the shell names by its site (`<webview>`'s
/// `wakeLock`).
pub const BROWSER: &str = "domicile-browser";

/// One application's request to keep the screens on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    /// The application's name, for the shell.
    pub app: String,
    /// The asking process, when the bus could tell.
    pub pid: Option<u32>,
}

/// Why the holds changed, for the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Asked,
    Gone,
}

/// The holds, by cookie and the bus connection that asked.
#[derive(Default)]
struct Holds {
    last: u32,
    held: Vec<(u32, String, Hold)>,
}

impl Holds {
    fn inhibit(&mut self, sender: String, hold: Hold) -> u32 {
        // Zero reads as a failure to some applications.
        self.last = self.last.checked_add(1).unwrap_or(1);
        self.held.push((self.last, sender, hold));
        self.last
    }

    /// Ends `cookie`, if `sender` holds it. Returns whether one ended.
    fn uninhibit(&mut self, sender: &str, cookie: u32) -> bool {
        let before = self.held.len();
        self.held
            .retain(|(held, by, _)| !(*held == cookie && by == sender));
        self.held.len() != before
    }

    /// Ends every hold `sender` has. Returns whether one ended.
    fn gone(&mut self, sender: &str) -> bool {
        let before = self.held.len();
        self.held.retain(|(_, by, _)| by != sender);
        self.held.len() != before
    }

    fn holds(&self) -> Vec<Hold> {
        self.held.iter().map(|(_, _, hold)| hold.clone()).collect()
    }
}

/// Whether a hold from `pid` keeps the screens on, given every window as its
/// process and whether the page shows it.
///
/// A process with no windows, like the engine, always holds. One with windows
/// holds while one is shown, so an app on another workspace lets go.
pub fn still_holds(pid: Option<u32>, windows: &[(Option<u32>, bool)]) -> bool {
    let Some(pid) = pid else {
        return true;
    };
    let mut its = windows.iter().filter(|(of, _)| *of == Some(pid)).peekable();
    its.peek().is_none() || its.any(|(_, shown)| *shown)
}

type Tell = Box<dyn Fn(Vec<Hold>, Change) + Send + Sync>;

/// What the object and the bus listener share.
struct Shared {
    holds: Mutex<Holds>,
    tell: Tell,
}

impl Shared {
    fn changed(&self, holds: &Holds, change: Change) {
        (self.tell)(holds.holds(), change);
    }
}

/// Serves the screen saver, calling `tell` with every hold each time one
/// starts or ends. A desk `in_a_window` queues behind its host; see
/// [`crate::bus_names`].
///
/// Returns once the thread is spawned, so startup does not wait on the bus.
pub fn serve(in_a_window: bool, tell: impl Fn(Vec<Hold>, Change) + Send + Sync + 'static) {
    let shared = Arc::new(Shared {
        holds: Mutex::default(),
        tell: Box::new(tell),
    });
    thread::spawn(move || {
        if let Err(why) = answer(&shared, in_a_window) {
            tracing::error!(
                %why,
                "the screen saver is not being served; a browser's video call will \
                 not keep this desktop's screens on"
            );
        }
    });
}

/// Serves the object, then drops the holds of applications that leave the
/// bus. Returns only on failure.
fn answer(shared: &Arc<Shared>, in_a_window: bool) -> zbus::Result<()> {
    let connection = Builder::session()?.build()?;
    for path in PATHS {
        connection.object_server().at(
            path,
            ScreenSaver {
                shared: Arc::clone(shared),
            },
        )?;
    }
    // Listen before taking the name, so an application that asks and exits
    // at once is not missed.
    let left = MessageIterator::for_match_rule(
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender("org.freedesktop.DBus")?
            .interface("org.freedesktop.DBus")?
            .member("NameOwnerChanged")?
            .build(),
        &connection,
        None,
    )?;
    crate::bus_names::take(&connection, NAME, in_a_window)?;
    debug!("this desktop serves the screen saver");

    let (told, gone) = channel::<String>();
    listen(left, told);
    for name in gone {
        let mut holds = shared.holds.lock().unwrap();
        if holds.gone(&name) {
            shared.changed(&holds, Change::Gone);
        }
    }
    Ok(())
}

/// Sends each unique name that leaves the bus through `told`.
fn listen(messages: MessageIterator, told: Sender<String>) {
    thread::spawn(move || {
        for message in messages.flatten() {
            let Ok((name, _, owner)) = message.body().deserialize::<(String, String, String)>()
            else {
                continue;
            };
            if name.starts_with(':') && owner.is_empty() && told.send(name).is_err() {
                break;
            }
        }
    });
}

struct ScreenSaver {
    shared: Arc<Shared>,
}

#[zbus::interface(name = "org.freedesktop.ScreenSaver")]
impl ScreenSaver {
    /// Keeps the screens on for `application` until `UnInhibit` with the
    /// cookie returned, or until it leaves the bus.
    async fn inhibit(
        &self,
        application: String,
        reason: String,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::fdo::Result<u32> {
        let sender = header
            .sender()
            .ok_or_else(|| zbus::fdo::Error::Failed("no sender".into()))?
            .to_owned();
        let pid = match zbus::fdo::DBusProxy::new(connection).await {
            Ok(bus) => bus
                .get_connection_unix_process_id(sender.clone().into())
                .await
                .ok(),
            Err(_) => None,
        };
        let app = if application.is_empty() {
            pid.and_then(|pid| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
                .map(|comm| comm.trim().to_string())
                .unwrap_or_else(|| "an application".into())
        } else {
            application
        };
        debug!(%app, %reason, "an application asked to keep the screens on");
        let mut holds = self.shared.holds.lock().unwrap();
        let cookie = holds.inhibit(sender.to_string(), Hold { app, pid });
        self.shared.changed(&holds, Change::Asked);
        Ok(cookie)
    }

    fn un_inhibit(&self, cookie: u32, #[zbus(header)] header: Header<'_>) {
        let Some(sender) = header.sender() else {
            return;
        };
        let mut holds = self.shared.holds.lock().unwrap();
        if holds.uninhibit(sender, cookie) {
            self.shared.changed(&holds, Change::Asked);
        }
    }

    /// The desk tells applications of blanking through the portal's
    /// `StateChanged`, not here.
    fn get_active(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hold(app: &str) -> Hold {
        Hold {
            app: app.into(),
            pid: None,
        }
    }

    #[test]
    fn a_cookie_ends_only_the_hold_it_names() {
        let mut holds = Holds::default();
        let film = holds.inhibit(":1.1".into(), hold("mpv"));
        holds.inhibit(":1.1".into(), hold("Firefox"));
        assert!(holds.uninhibit(":1.1", film));
        assert_eq!(holds.holds(), vec![hold("Firefox")]);
    }

    #[test]
    fn an_application_cannot_end_another_applications_hold() {
        let mut holds = Holds::default();
        let call = holds.inhibit(":1.1".into(), hold("Chromium"));
        assert!(!holds.uninhibit(":1.2", call));
        assert_eq!(holds.holds(), vec![hold("Chromium")]);
    }

    #[test]
    fn an_application_leaving_the_bus_ends_its_holds() {
        let mut holds = Holds::default();
        holds.inhibit(":1.1".into(), hold("Chromium"));
        holds.inhibit(":1.1".into(), hold("Chromium"));
        holds.inhibit(":1.2".into(), hold("mpv"));
        assert!(holds.gone(":1.1"));
        assert!(!holds.gone(":1.1"));
        assert_eq!(holds.holds(), vec![hold("mpv")]);
    }

    #[test]
    fn no_cookie_is_zero() {
        let mut holds = Holds {
            last: u32::MAX,
            held: Vec::new(),
        };
        assert_eq!(holds.inhibit(":1.1".into(), hold("mpv")), 1);
    }

    #[test]
    fn a_process_with_no_windows_holds() {
        assert!(still_holds(Some(7), &[(Some(8), false)]));
        assert!(still_holds(None, &[(Some(8), false)]));
    }

    #[test]
    fn a_process_holds_only_while_one_of_its_windows_is_shown() {
        assert!(!still_holds(Some(7), &[(Some(7), false), (Some(8), true)]));
        assert!(still_holds(Some(7), &[(Some(7), false), (Some(7), true)]));
    }
}
