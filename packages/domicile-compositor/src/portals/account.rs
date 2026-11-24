//! `org.freedesktop.impl.portal.Account`: the user's name and picture, for an
//! application the user lets have them.
//!
//! Read from AccountsService on the system bus, or from the passwd entry when
//! it is not running. Read on each call, so a changed name or picture shows,
//! and shown in the dialog, so the user sees what is shared.

use std::collections::HashMap;
use std::ffi::CStr;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use domicile_protocol::{AccountDialog, PortalAnswer, PortalKind};
use tracing::{debug, warn};
use zbus::object_server::ObjectServer;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use super::queue::{ask, Queue};
use super::uri::file_uri;

/// AccountsService's bus name.
const ACCOUNTS: &str = "org.freedesktop.Accounts";

/// Who the user is, as the portal answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    /// The login name.
    pub id: String,
    /// The full name, or the login name when there is none.
    pub name: String,
    /// The picture's path.
    pub image: Option<String>,
}

/// Looks the user up. `Err` says why nobody could be found.
pub type LookUp =
    Box<dyn Fn() -> Pin<Box<dyn Future<Output = Result<User, String>> + Send>> + Send + Sync>;

/// The `Account` backend object.
pub struct Account {
    pub queue: Arc<Queue>,
    pub user: LookUp,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Account")]
impl Account {
    /// Look the user up, show the user what would be shared, then answer
    /// with it. Fails without asking when nobody is found.
    async fn get_user_information(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        mut options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let user = match (self.user)().await {
            Ok(user) => user,
            Err(why) => {
                warn!(%why, "an application asked for the user's name, and they were not found");
                return (2, HashMap::new());
            }
        };
        let reason = options
            .remove("reason")
            .and_then(|value| String::try_from(value).ok());
        let kind = PortalKind::Account(AccountDialog {
            reason,
            name: user.name.clone(),
            image: user.image.clone(),
        });
        match ask(&self.queue, server, handle, app_id, &parent_window, kind).await {
            PortalAnswer::Access => (0, results(user)),
            PortalAnswer::Canceled => (1, HashMap::new()),
            // The queue takes no other kind's answer; see `PortalKind::accepts`.
            PortalAnswer::Refused
            | PortalAnswer::AppChooser { .. }
            | PortalAnswer::FileChooser(_)
            | PortalAnswer::RemoteDesktop { .. }
            | PortalAnswer::InputCapture
            | PortalAnswer::GlobalShortcuts { .. }
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
            | PortalAnswer::Pressed
            | PortalAnswer::Released => (2, HashMap::new()),
        }
    }
}

/// The running user, from AccountsService or else their passwd entry.
pub fn the_user() -> LookUp {
    Box::new(|| {
        Box::pin(async {
            // SAFETY: `getuid` cannot fail.
            let uid = unsafe { libc::getuid() };
            let from_accounts = match zbus::Connection::system().await {
                Ok(system) => from_accounts_service(&system, uid).await,
                Err(why) => Err(why),
            };
            match from_accounts {
                Ok(user) => Ok(user),
                Err(why) => {
                    debug!(%why, "no AccountsService; the user's name comes from passwd");
                    from_passwd(uid)
                }
            }
        })
    })
}

/// The portal's results for `user`.
fn results(user: User) -> HashMap<String, OwnedValue> {
    [
        ("id", Some(user.id)),
        ("name", Some(user.name)),
        ("image", user.image.map(|path| file_uri(&path))),
    ]
    .into_iter()
    .filter_map(|(key, value)| {
        value.map(|value| {
            (
                key.to_string(),
                OwnedValue::from(zbus::zvariant::Str::from(value)),
            )
        })
    })
    .collect()
}

/// User `uid` as AccountsService describes them.
async fn from_accounts_service(connection: &zbus::Connection, uid: u32) -> zbus::Result<User> {
    let accounts = proxy(connection, "/org/freedesktop/Accounts", ACCOUNTS).await?;
    let path: OwnedObjectPath = accounts.call("FindUserById", &(i64::from(uid),)).await?;
    let user = proxy(connection, path, "org.freedesktop.Accounts.User").await?;
    let id: String = user.get_property("UserName").await?;
    let real_name: String = user.get_property("RealName").await?;
    let icon: String = user.get_property("IconFile").await?;
    Ok(User {
        name: if real_name.is_empty() {
            id.clone()
        } else {
            real_name
        },
        id,
        image: (!icon.is_empty()).then_some(icon),
    })
}

/// An uncached proxy, so it needs no match rules on the bus.
async fn proxy<'a>(
    connection: &zbus::Connection,
    path: impl TryInto<zbus::zvariant::ObjectPath<'a>, Error = impl Into<zbus::Error>>,
    interface: &'a str,
) -> zbus::Result<zbus::Proxy<'a>> {
    zbus::proxy::Builder::new(connection)
        .destination(ACCOUNTS)?
        .path(path)?
        .interface(interface)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

/// The running user's login name, for CUPS's `requesting-user-name`. From
/// passwd, else `unknown`, as libcups's `cupsUser` does.
pub fn login_name() -> String {
    // SAFETY: `getuid` cannot fail.
    match from_passwd(unsafe { libc::getuid() }) {
        Ok(user) => user.id,
        Err(why) => {
            tracing::error!(%why, "print jobs go to CUPS as user unknown");
            "unknown".into()
        }
    }
}

/// User `uid` from the passwd database: the GECOS full name, and no picture.
fn from_passwd(uid: u32) -> Result<User, String> {
    // SAFETY: `passwd` and `buffer` outlive the call, and `found` points into
    // them only while they live.
    unsafe {
        let mut passwd: libc::passwd = std::mem::zeroed();
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        let failed = libc::getpwuid_r(
            uid,
            &mut passwd,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        );
        if found.is_null() {
            return Err(format!("uid {uid} has no passwd entry (error {failed})"));
        }
        let id = CStr::from_ptr(passwd.pw_name)
            .to_string_lossy()
            .into_owned();
        let gecos = CStr::from_ptr(passwd.pw_gecos).to_string_lossy();
        Ok(User {
            name: full_name(&gecos).unwrap_or(&id).to_string(),
            id,
            image: None,
        })
    }
}

/// The full name in a GECOS field: its first comma-separated part, if any.
fn full_name(gecos: &str) -> Option<&str> {
    gecos.split(',').next().filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    use super::super::socket_pair;

    #[test]
    fn a_full_name_is_the_first_part_of_the_gecos_field() {
        assert_eq!(full_name("Ada Lovelace,Room 1,,"), Some("Ada Lovelace"));
        assert_eq!(full_name(",Room 1"), None);
        assert_eq!(full_name(""), None);
    }

    #[test]
    fn the_running_user_has_a_passwd_entry_under_their_login_name() {
        let ran = Command::new("id").arg("-un").output().expect("`id` runs");
        // SAFETY: `getuid` cannot fail.
        let user = from_passwd(unsafe { libc::getuid() }).expect("an entry");

        assert_eq!(user.id, String::from_utf8_lossy(&ran.stdout).trim());
        assert_eq!(user.image, None);
        assert_eq!(login_name(), user.id);
    }

    /// A stand-in AccountsService with one user.
    struct Accounts;

    #[zbus::interface(name = "org.freedesktop.Accounts")]
    impl Accounts {
        fn find_user_by_id(&self, uid: i64) -> zbus::fdo::Result<OwnedObjectPath> {
            match uid {
                1000 => Ok(
                    OwnedObjectPath::try_from("/org/freedesktop/Accounts/User1000")
                        .expect("a path"),
                ),
                _ => Err(zbus::fdo::Error::Failed(format!("no user {uid}"))),
            }
        }
    }

    struct AccountsUser {
        real_name: String,
    }

    #[zbus::interface(name = "org.freedesktop.Accounts.User")]
    impl AccountsUser {
        #[zbus(property)]
        fn user_name(&self) -> String {
            "ada".into()
        }

        #[zbus(property)]
        fn real_name(&self) -> String {
            self.real_name.clone()
        }

        #[zbus(property)]
        fn icon_file(&self) -> String {
            "/var/lib/AccountsService/icons/ada".into()
        }
    }

    fn accounts_service(real_name: &str) -> (zbus::blocking::Connection, zbus::Connection) {
        let real_name = real_name.to_string();
        let (server, client) = socket_pair::connected(|builder| {
            builder
                .serve_at("/org/freedesktop/Accounts", Accounts)
                .and_then(|builder| {
                    builder.serve_at(
                        "/org/freedesktop/Accounts/User1000",
                        AccountsUser { real_name },
                    )
                })
                .expect("the stand-in registered")
        });
        (server, client.into_inner())
    }

    #[test]
    fn accounts_service_names_the_user_and_their_picture() {
        let (_server, client) = accounts_service("Ada Lovelace");

        assert_eq!(
            zbus::block_on(from_accounts_service(&client, 1000)).expect("found"),
            User {
                id: "ada".into(),
                name: "Ada Lovelace".into(),
                image: Some("/var/lib/AccountsService/icons/ada".into()),
            }
        );
    }

    #[test]
    fn a_user_with_no_full_name_goes_by_their_login_name() {
        let (_server, client) = accounts_service("");

        assert_eq!(
            zbus::block_on(from_accounts_service(&client, 1000))
                .expect("found")
                .name,
            "ada"
        );
    }

    #[test]
    fn a_user_accounts_service_does_not_know_is_an_error() {
        let (_server, client) = accounts_service("Ada Lovelace");

        assert!(zbus::block_on(from_accounts_service(&client, 7)).is_err());
    }
}
