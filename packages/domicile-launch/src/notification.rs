//! Sends desktop notifications from the supervisor.
//!
//! Errors after startup, such as a config edit that fails to build, happen
//! when nobody is watching the terminal. They are sent as a standard `Notify`
//! on the session bus, which the compositor serves.

use std::collections::HashMap;
use std::time::Duration;

use zbus::zvariant::Value;

/// The application name shown on notifications.
const APP_NAME: &str = "Domicile";

/// Critical urgency, so the notification stays until dismissed. The desktop
/// does not match the config until the user fixes it.
const CRITICAL: u8 = 2;

/// How long a `Notify` waits for a reply. Without it, an unresponsive server
/// would block the config watcher's thread and every later reload.
pub const ANSWER_WITHIN: Duration = Duration::from_secs(2);

/// Builds a connection whose calls time out after [`ANSWER_WITHIN`].
pub fn connected(
    builder: zbus::blocking::connection::Builder<'_>,
) -> Result<zbus::blocking::Connection, zbus::Error> {
    builder.method_timeout(ANSWER_WITHIN).build()
}

/// Connects to the session bus with [`connected`].
pub fn session_bus() -> Result<zbus::blocking::Connection, zbus::Error> {
    connected(zbus::blocking::connection::Builder::session()?)
}

/// Shows a notification through the server on `bus`, drawn with `icon`: an
/// icon's name or a path, as `app_icon` takes it, or empty for Domicile's.
pub fn notify(
    bus: &zbus::blocking::Connection,
    icon: &str,
    summary: &str,
    body: &str,
) -> Result<(), zbus::Error> {
    let hints = HashMap::from([("urgency", Value::from(CRITICAL))]);
    bus.call_method(
        Some("org.freedesktop.Notifications"),
        "/org/freedesktop/Notifications",
        Some("org.freedesktop.Notifications"),
        "Notify",
        &(
            APP_NAME,
            0_u32,
            icon,
            summary,
            body,
            Vec::<&str>::new(),
            hints,
            -1_i32,
        ),
    )
    .map(drop)
}
