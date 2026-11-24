//! `org.freedesktop.impl.portal.Wallpaper`: an application sets the picture
//! behind the desktop, on the lock screen, or both.
//!
//! The picture is copied into the state directory (`domicile_host::wallpaper`)
//! and sent to the shell in [`HostMessage::PortalRequests`]'s `wallpaper`,
//! which the shell draws. With `show-preview`, the shell first shows it in a
//! dialog.
//!
//! [`HostMessage::PortalRequests`]: domicile_protocol::HostMessage::PortalRequests

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use domicile_host::wallpaper::{local_path, Wallpapers};
use domicile_protocol::{
    PortalAnswer, PortalKind, PortalWallpaper, WallpaperDialog, WallpaperTarget,
};
use tracing::debug;
use zbus::object_server::ObjectServer;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use super::queue::{ask, Queue};

/// The `Wallpaper` backend object.
pub struct Wallpaper {
    pub queue: Arc<Queue>,
    pub pictures: Arc<Pictures>,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Wallpaper")]
impl Wallpaper {
    /// Set `uri`, after the shell's preview when asked. Response `2` for a
    /// picture that is not a local file or a `set-on` the spec does not name.
    #[zbus(name = "SetWallpaperURI")]
    async fn set_wallpaper_uri(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        uri: String,
        options: HashMap<String, OwnedValue>,
    ) -> u32 {
        let Some(asked) = asked(&uri, options) else {
            debug!(%uri, "a wallpaper this desktop cannot set; refused");
            return 2;
        };
        let answer = if asked.preview {
            let kind = PortalKind::Wallpaper(WallpaperDialog {
                path: asked.path.to_string_lossy().into_owned(),
                set_on: asked.set_on,
            });
            ask(&self.queue, server, handle, app_id, &parent_window, kind).await
        } else {
            PortalAnswer::Access
        };
        match answer {
            PortalAnswer::Access => match self.pictures.set(asked.set_on, asked.path) {
                Ok(()) => 0,
                Err(why) => {
                    tracing::error!(%why, %uri, "the wallpaper could not be kept");
                    2
                }
            },
            PortalAnswer::Canceled => 1,
            // A refusal, or an answer of another kind, which the queue
            // refuses (`accepts`).
            _ => 2,
        }
    }
}

/// The pictures set, and who hears when they change.
pub struct Pictures {
    held: Mutex<Wallpapers>,
    publish: OnceLock<Box<dyn Fn(PortalWallpaper) + Send + Sync>>,
}

impl Pictures {
    /// The store in `dir`. A record that cannot be read is logged and
    /// replaced by the next picture set.
    pub fn load(dir: PathBuf) -> Self {
        let held = Wallpapers::load(dir.clone()).unwrap_or_else(|why| {
            tracing::error!(%why, dir = %dir.display(), "the wallpaper set through the portal is forgotten");
            Wallpapers::empty(dir)
        });
        Pictures {
            held: Mutex::new(held),
            publish: OnceLock::new(),
        }
    }

    /// Publish the pictures through `publish` now and on every change.
    pub fn listen(&self, publish: impl Fn(PortalWallpaper) + Send + Sync + 'static) {
        let held = self.held.lock().unwrap();
        publish(held.chosen().clone());
        if self.publish.set(Box::new(publish)).is_err() {
            panic!("the wallpaper has one listener");
        }
    }

    fn set(&self, target: WallpaperTarget, picture: PathBuf) -> std::io::Result<()> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock is after 1970")
            .as_millis() as u64;
        let mut held = self.held.lock().unwrap();
        let chosen = held.set(target, &picture, stamp)?.clone();
        if let Some(publish) = self.publish.get() {
            publish(chosen);
        }
        Ok(())
    }
}

/// What a call asks for.
struct Asked {
    path: PathBuf,
    set_on: WallpaperTarget,
    preview: bool,
}

/// Read a call, or `None` when it cannot be done. A missing `set-on` sets
/// both pictures; a mistyped option reads as absent.
fn asked(uri: &str, mut options: HashMap<String, OwnedValue>) -> Option<Asked> {
    let preview = options
        .remove("show-preview")
        .and_then(|value| bool::try_from(value).ok())
        .unwrap_or(false);
    let set_on = match options
        .remove("set-on")
        .and_then(|value| String::try_from(value).ok())
        .as_deref()
    {
        None | Some("both") => WallpaperTarget::Both,
        Some("background") => WallpaperTarget::Background,
        Some("lockscreen") => WallpaperTarget::Lockscreen,
        Some(_) => return None,
    };
    Some(Asked {
        path: local_path(uri)?,
        set_on,
        preview,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc::{channel, Receiver};
    use std::thread;
    use std::time::Duration;

    use domicile_protocol::PortalRequest;
    use zbus::zvariant::{ObjectPath, Value};

    use crate::portals::socket_pair::connected;

    const HANDLE: &str = "/org/freedesktop/portal/desktop/request/1_7/w";

    struct Served {
        client: zbus::blocking::Connection,
        queue: Arc<Queue>,
        published: Receiver<Vec<PortalRequest>>,
        shown: Receiver<PortalWallpaper>,
        state: tempfile::TempDir,
        _server: zbus::blocking::Connection,
    }

    fn served() -> Served {
        let state = tempfile::tempdir().expect("a directory");
        let queue = Arc::<Queue>::default();
        let (publish, published) = channel();
        queue.listen(
            move |items, _| {
                let _ = publish.send(items);
            },
            || true,
            |_| None,
        );
        let pictures = Arc::new(Pictures::load(state.path().join("wallpaper")));
        let (show, shown) = channel();
        pictures.listen(move |wallpaper| {
            let _ = show.send(wallpaper);
        });
        let serving = Arc::clone(&queue);
        let (server, client) = connected(move |builder| {
            builder
                .serve_at(
                    super::super::OBJECT_PATH,
                    Wallpaper {
                        queue: serving,
                        pictures,
                    },
                )
                .expect("served")
        });
        Served {
            client,
            queue,
            published,
            shown,
            state,
            _server: server,
        }
    }

    /// Call `SetWallpaperURI` from another thread, returning its response.
    fn set_wallpaper(
        client: &zbus::blocking::Connection,
        uri: String,
        options: Vec<(&'static str, Value<'static>)>,
    ) -> thread::JoinHandle<u32> {
        let client = client.clone();
        thread::spawn(move || {
            let options: HashMap<String, OwnedValue> = options
                .into_iter()
                .map(|(name, value)| {
                    (
                        name.to_string(),
                        OwnedValue::try_from(value).expect("ownable"),
                    )
                })
                .collect();
            client
                .call_method(
                    None::<&str>,
                    super::super::OBJECT_PATH,
                    Some("org.freedesktop.impl.portal.Wallpaper"),
                    "SetWallpaperURI",
                    &(
                        ObjectPath::try_from(HANDLE).expect("a path"),
                        "org.example.Photos",
                        "",
                        uri,
                        options,
                    ),
                )
                .expect("SetWallpaperURI answered")
                .body()
                .deserialize()
                .expect("a response")
        })
    }

    fn sky(served: &Served) -> (PathBuf, String) {
        let path = served.state.path().join("sky.jpg");
        fs::write(&path, b"sky").expect("the picture is written");
        let uri = format!("file://{}", path.display());
        (path, uri)
    }

    #[track_caller]
    fn next<T>(heard: &Receiver<T>) -> T {
        heard
            .recv_timeout(Duration::from_secs(10))
            .expect("it was published")
    }

    #[test]
    fn a_picture_without_a_preview_is_set_at_once() {
        let served = served();
        assert_eq!(next(&served.shown), PortalWallpaper::default());
        let (_, uri) = sky(&served);

        let response = set_wallpaper(
            &served.client,
            uri,
            vec![("set-on", Value::from("background"))],
        );

        assert_eq!(response.join().expect("the call returned"), 0);
        let shown = next(&served.shown);
        let background = shown.background.expect("the background is set");
        assert_eq!(fs::read(background).expect("the copy is there"), b"sky");
        assert_eq!(shown.lockscreen, None);
    }

    #[test]
    fn a_preview_waits_for_the_shell() {
        let served = served();
        next(&served.shown);
        let (path, uri) = sky(&served);

        let response = set_wallpaper(
            &served.client,
            uri,
            vec![("show-preview", Value::from(true))],
        );
        assert_eq!(
            next(&served.published)
                .into_iter()
                .map(|request| request.kind)
                .collect::<Vec<_>>(),
            [PortalKind::Wallpaper(WallpaperDialog {
                path: path.to_string_lossy().into_owned(),
                set_on: WallpaperTarget::Both,
            })]
        );
        served.queue.answer(1, PortalAnswer::Access);

        assert_eq!(response.join().expect("the call returned"), 0);
        let shown = next(&served.shown);
        assert!(shown.background.is_some());
        assert_eq!(shown.background, shown.lockscreen);
    }

    #[test]
    fn a_preview_dismissed_sets_nothing() {
        let served = served();
        next(&served.shown);
        let (_, uri) = sky(&served);

        let response = set_wallpaper(
            &served.client,
            uri,
            vec![("show-preview", Value::from(true))],
        );
        next(&served.published);
        served.queue.answer(1, PortalAnswer::Canceled);

        assert_eq!(response.join().expect("the call returned"), 1);
        assert!(served.shown.try_recv().is_err(), "nothing was set");
    }

    #[test]
    fn a_record_that_cannot_be_read_is_forgotten() {
        let state = tempfile::tempdir().expect("a directory");
        let dir = state.path().join("wallpaper");
        fs::create_dir_all(&dir).expect("the directory is made");
        fs::write(dir.join("wallpaper.json"), b"{").expect("the record is written");
        let (show, shown) = channel();

        Pictures::load(dir).listen(move |wallpaper| {
            let _ = show.send(wallpaper);
        });

        assert_eq!(next(&shown), PortalWallpaper::default());
    }

    #[test]
    fn a_picture_that_is_no_local_file_is_refused() {
        let served = served();
        next(&served.shown);

        let response = set_wallpaper(
            &served.client,
            "https://example.com/sky.jpg".into(),
            Vec::new(),
        );

        assert_eq!(response.join().expect("the call returned"), 2);
    }

    #[test]
    fn a_place_the_spec_does_not_name_is_refused() {
        let served = served();
        next(&served.shown);
        let (_, uri) = sky(&served);

        let response = set_wallpaper(
            &served.client,
            uri,
            vec![("set-on", Value::from("ceiling"))],
        );

        assert_eq!(response.join().expect("the call returned"), 2);
    }
}
