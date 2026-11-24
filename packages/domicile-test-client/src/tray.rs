//! `--tray`: a tray icon on the session bus, with a menu, as a chat app shows
//! one.

use zbus::blocking::Connection;
use zbus::interface;
use zbus::zvariant::{ObjectPath, OwnedValue};

/// Where the icon is served, as the spec suggests.
const PATH: &str = "/StatusNotifierItem";

/// Where its menu is served, as libappindicator does.
const MENU_PATH: &str = "/MenuBar";

/// The icon: a click and the token handed before it are traced.
struct Item;

#[interface(name = "org.kde.StatusNotifierItem")]
impl Item {
    #[zbus(property)]
    fn id(&self) -> &str {
        "domicile-test-client"
    }

    #[zbus(property)]
    fn status(&self) -> &str {
        "Active"
    }

    #[zbus(property)]
    fn icon_name(&self) -> &str {
        "domicile-test-client"
    }

    #[zbus(property)]
    fn menu(&self) -> ObjectPath<'static> {
        ObjectPath::from_static_str_unchecked(MENU_PATH)
    }

    /// A token to raise a window with, handed before a click.
    fn provide_xdg_activation_token(&self, token: String) {
        crate::say!("tray", "token({token})");
    }

    fn activate(&self, _x: i32, _y: i32) {
        crate::say!("tray", "clicked()");
    }
}

/// The icon's menu: only a click on an entry is traced.
struct Menu;

#[interface(name = "com.canonical.dbusmenu")]
impl Menu {
    fn event(&self, id: i32, event_id: String, _data: OwnedValue, _timestamp: u32) {
        if event_id == "clicked" {
            crate::say!("menu", "clicked({id})");
        }
    }
}

/// Show the icon: serve it and its menu, and register it with the watcher.
///
/// Returns the connection, which serves the icon while it lives.
pub fn show() -> zbus::Result<Connection> {
    let bus = Connection::session()?;
    bus.object_server().at(PATH, Item)?;
    bus.object_server().at(MENU_PATH, Menu)?;
    bus.call_method(
        Some("org.kde.StatusNotifierWatcher"),
        "/StatusNotifierWatcher",
        Some("org.kde.StatusNotifierWatcher"),
        "RegisterStatusNotifierItem",
        &(PATH,),
    )?;
    crate::say!("tray", "shown()");
    Ok(bus)
}
