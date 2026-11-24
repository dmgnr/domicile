//! `org.freedesktop.impl.portal.Screenshot`: a PNG of the desk, or the color
//! of one pixel of it.
//!
//! Each call takes one frame of the whole desk (see
//! [`crate::casting::Casting::shoot`]). An interactive screenshot and
//! `PickColor` freeze that frame in the shell, which answers with the area or
//! pixel the user picked. The shell takes its own screenshots the same way,
//! through [`for_the_shell`]. See `docs/PORTALS.md`.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use domicile_host::data_url::data_url;
use domicile_host::screenshot::{
    color_at, crop, encode, file_name, fit, save, screenshots_dir, Shot, Taken,
};
use domicile_host::system::Kept;
use domicile_protocol::{
    AccessDialog, DeskRect, DeskShot, FrozenDesk, PortalAnswer, PortalKind, PreviewedWindow,
    ShotRect, SystemError, SystemErrorKind, SHELL_APP_ID,
};
use zbus::object_server::ObjectServer;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use super::queue::{ask, ask_unbidden, Queue};
use super::uri::file_uri;
use crate::casting::{Casting, Desk};

/// Takes a frame of the whole desk, or says why it cannot.
pub type Shoot =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Desk, String>> + Send>> + Send + Sync>;

/// Takes the last frame a window drew, by host app id, or says why it cannot.
pub type ShootWindow =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<Shot, String>> + Send>> + Send + Sync>;

/// Saves a screenshot as a PNG and returns its path, or says why it cannot.
pub type Save = Arc<dyn Fn(&Shot) -> Result<PathBuf, String> + Send + Sync>;

/// Puts a PNG on the clipboard, or says why it cannot.
pub type CopyPng = Arc<dyn Fn(Vec<u8>) -> Result<(), String> + Send + Sync>;

/// How screenshots are taken, saved and copied, for the portal and for the
/// shell.
#[derive(Clone)]
pub struct Shots {
    pub shoot: Shoot,
    pub shoot_window: ShootWindow,
    /// Shoots a browser window's page alone, by the engine's window id.
    pub shoot_browser_window: ShootWindow,
    pub save: Save,
    pub copy: CopyPng,
}

impl Shots {
    /// Shots of a desk that cannot be shot, for tests that take none.
    #[cfg(test)]
    pub fn none() -> Shots {
        Shots {
            shoot: Arc::new(|| Box::pin(async { Err("no desk here".into()) })),
            shoot_window: Arc::new(|_| Box::pin(async { Err("no windows here".into()) })),
            shoot_browser_window: Arc::new(|_| {
                Box::pin(async { Err("no browser windows here".into()) })
            }),
            save: Arc::new(|_| Err("no pictures here".into())),
            copy: Arc::new(|_| Err("no clipboard here".into())),
        }
    }
}

/// The frontend's permission store, where the user's answers are kept.
const PERMISSION_STORE: &str = "org.freedesktop.impl.portal.PermissionStore";
const PERMISSION_STORE_PATH: &str = "/org/freedesktop/impl/portal/PermissionStore";

/// The store's table and id for screenshots, as the frontend names them.
const TABLE: &str = "screenshot";

/// The `Screenshot` backend object.
pub struct Screenshot {
    pub queue: Arc<Queue>,
    pub shots: Shots,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.Screenshot")]
impl Screenshot {
    /// Saves a screenshot and answers with its `file://` URI. An interactive
    /// one keeps the area the user picks, and copies it too when the user
    /// asked to.
    ///
    /// A frontend that has not checked the `PermissionStore` itself
    /// (`permission_store_checked`) leaves it to the backend: a
    /// non-interactive screenshot then asks the user once per application.
    async fn screenshot(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        #[zbus(connection)] connection: &zbus::Connection,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let interactive = flag(&options, "interactive");
        let checked = flag(&options, "permission_store_checked");
        let taken = async {
            if !interactive && !checked {
                self.permit(server, connection, &handle, &app_id, &parent_window)
                    .await?;
            }
            let desk = self.desk().await?;
            let shot = if interactive {
                let frozen = frozen(&desk);
                let answer = ask(
                    &self.queue,
                    server,
                    handle,
                    app_id,
                    &parent_window,
                    PortalKind::Screenshot(frozen),
                )
                .await;
                let picked = picked(&self.shots, &desk, answer)
                    .await
                    .map_err(|unpicked| match unpicked {
                        Unpicked::Not(answer) => answer.response().max(1),
                        Unpicked::Failed(why) => {
                            tracing::error!(%why, "a window could not be shot for a screenshot");
                            2
                        }
                    })?;
                if picked.copy {
                    // The application asked for a file, so it still gets one.
                    if let Err(why) = (self.shots.copy)(encode(&picked.shot)) {
                        tracing::error!(%why, "a screenshot could not be copied; it is still saved");
                    }
                }
                picked.shot
            } else {
                desk.shot
            };
            let path = (self.shots.save)(&shot).map_err(|why| -> u32 {
                tracing::error!(%why, "a screenshot could not be saved");
                2
            })?;
            Ok(file_uri(&path.display().to_string()))
        };
        match taken.await {
            Ok(uri) => (
                0,
                HashMap::from([("uri".to_string(), owned(Value::from(uri)))]),
            ),
            Err(response) => (response, HashMap::new()),
        }
    }

    /// Answers with the color of the pixel the user picks, as sRGB `(ddd)`
    /// from 0 to 1.
    async fn pick_color(
        &self,
        #[zbus(object_server)] server: &ObjectServer,
        handle: OwnedObjectPath,
        app_id: String,
        parent_window: String,
        _options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let picked = async {
            let desk = self.desk().await?;
            let kind = PortalKind::PickColor(frozen(&desk));
            match ask(&self.queue, server, handle, app_id, &parent_window, kind).await {
                PortalAnswer::PickColor { x, y } => Ok(color_at(&desk.shot, x, y)),
                answer => Err(answer.response().max(1)),
            }
        };
        match picked.await {
            Ok(color) => (
                0,
                HashMap::from([("color".to_string(), owned(Value::from(color)))]),
            ),
            Err(response) => (response, HashMap::new()),
        }
    }

    #[zbus(property(emits_changed_signal = "const"), name = "version")]
    fn version(&self) -> u32 {
        2
    }
}

impl Screenshot {
    /// A frame of the desk, or response `2`.
    async fn desk(&self) -> Result<Desk, u32> {
        (self.shots.shoot)().await.map_err(|why| {
            tracing::error!(%why, "the desk could not be shot for a screenshot");
            2
        })
    }

    /// Whether `app_id` may take a screenshot without picking it: the
    /// user's answer in the permission store on `connection`, else theirs
    /// now, which is kept there. `Err(2)` when not.
    async fn permit(
        &self,
        server: &ObjectServer,
        connection: &zbus::Connection,
        handle: &OwnedObjectPath,
        app_id: &str,
        parent_window: &str,
    ) -> Result<(), u32> {
        let allowed = match kept(connection, app_id).await {
            Some(allowed) => allowed,
            None => {
                let answer = ask(
                    &self.queue,
                    server,
                    handle.clone(),
                    app_id.to_string(),
                    parent_window,
                    PortalKind::Access(AccessDialog {
                        title: "Allow screenshots?".into(),
                        subtitle: "It will see everything on your screens, without asking again."
                            .into(),
                        body: String::new(),
                        grant_label: Some("Allow".into()),
                        deny_label: None,
                        destructive: false,
                    }),
                )
                .await;
                match answer {
                    PortalAnswer::Access => {
                        keep(connection, app_id, true).await;
                        true
                    }
                    PortalAnswer::Canceled => {
                        keep(connection, app_id, false).await;
                        false
                    }
                    // No shell answered: ask again next time.
                    _ => false,
                }
            }
        };
        if allowed {
            Ok(())
        } else {
            Err(2)
        }
    }
}

/// The answer the permission store keeps for `app_id`, or `None` if the user
/// was never asked. A store that cannot be read is logged, and the user is
/// asked.
async fn kept(connection: &zbus::Connection, app_id: &str) -> Option<bool> {
    let looked_up = connection
        .call_method(
            Some(PERMISSION_STORE),
            PERMISSION_STORE_PATH,
            Some(PERMISSION_STORE),
            "Lookup",
            &(TABLE, TABLE),
        )
        .await
        .and_then(|reply| {
            Ok(reply
                .body()
                .deserialize::<(HashMap<String, Vec<String>>, OwnedValue)>()?
                .0)
        });
    match looked_up {
        Ok(permissions) => permissions
            .get(app_id)
            .and_then(|kept| kept.first())
            .map(|kept| kept == "yes"),
        // No application was ever asked.
        Err(zbus::Error::MethodError(name, _, _))
            if name.as_str() == "org.freedesktop.portal.Error.NotFound" =>
        {
            None
        }
        Err(why) => {
            tracing::error!(%why, "the permission store could not be read; asking about screenshots again");
            None
        }
    }
}

/// Keeps the user's answer for `app_id` in the permission store. One that
/// cannot be kept is logged, and asked again next time.
async fn keep(connection: &zbus::Connection, app_id: &str, allowed: bool) {
    let answer = if allowed { "yes" } else { "no" };
    let kept = connection
        .call_method(
            Some(PERMISSION_STORE),
            PERMISSION_STORE_PATH,
            Some(PERMISSION_STORE),
            "SetPermission",
            &(TABLE, true, TABLE, app_id, vec![answer]),
        )
        .await;
    if let Err(why) = kept {
        tracing::error!(%why, "the permission store did not keep a screenshot answer; it will be asked again");
    }
}

/// Takes a screenshot the shell asked for itself, as `SystemRequest::Screenshot`
/// describes: the whole desk into `file`, or else the area the shell picks,
/// as for an interactive screenshot, through `shots.save`, or through
/// `shots.copy` alone when the user copied it.
pub async fn for_the_shell(
    queue: &Queue,
    shots: &Shots,
    file: Option<PathBuf>,
) -> Result<Kept, SystemError> {
    let desk = (shots.shoot)()
        .await
        .map_err(|why| other(format!("the desk could not be shot: {why}")))?;
    match file {
        Some(file) => std::fs::write(&file, encode(&desk.shot))
            .map(|()| Kept::Saved(file))
            .map_err(|why| other(format!("the screenshot could not be written: {why}"))),
        None => {
            let kind = PortalKind::Screenshot(frozen(&desk));
            let answer = ask_unbidden(queue, SHELL_APP_ID.into(), "", kind).await;
            match picked(shots, &desk, answer).await {
                Ok(Picked { shot, copy: true }) => (shots.copy)(encode(&shot))
                    .map(|()| Kept::Copied)
                    .map_err(|why| other(format!("the screenshot could not be copied: {why}"))),
                Ok(Picked { shot, copy: false }) => (shots.save)(&shot)
                    .map(Kept::Saved)
                    .map_err(|why| other(format!("the screenshot could not be saved: {why}"))),
                Err(Unpicked::Not(PortalAnswer::Canceled)) => Err(SystemError {
                    kind: SystemErrorKind::Canceled,
                    message: "the screenshot dialog was dismissed".into(),
                }),
                Err(Unpicked::Not(answer)) => Err(other(format!(
                    "the screenshot dialog was not answered: {answer:?}"
                ))),
                Err(Unpicked::Failed(why)) => {
                    Err(other(format!("the window could not be shot: {why}")))
                }
            }
        }
    }
}

/// What the shell's own screenshot dialog answers.
type ShellAnswer = Result<Kept, SystemError>;

/// The shell's own screenshot dialog, while one is up.
///
/// A shell screenshot asked for meanwhile, such as a second Print, answers as
/// that dialog does. Queued instead, it would show a second dialog, of a desk
/// shot with the first over it, once the first closed.
#[derive(Clone, Default)]
pub struct ShellDialog(Arc<Mutex<Option<Vec<Sender<ShellAnswer>>>>>);

impl ShellDialog {
    /// `ask`'s answer, or the answer of the dialog already up instead of
    /// running `ask`. Blocks until then.
    pub fn take(&self, ask: impl FnOnce() -> ShellAnswer) -> ShellAnswer {
        let joined = {
            let mut up = self.0.lock().unwrap();
            match up.as_mut() {
                Some(waiting) => {
                    let (answer, answered) = channel();
                    waiting.push(answer);
                    Some(answered)
                }
                None => {
                    *up = Some(Vec::new());
                    None
                }
            }
        };
        if let Some(answered) = joined {
            return answered
                .recv()
                .expect("the dialog up answers every call waiting on it, or panicked");
        }
        // Closed even when `ask` panics, so the next Print shows a dialog and
        // the calls waiting on this one panic too rather than hang.
        let closed = Closed(&self.0);
        let answer = ask();
        let waiting = closed.0.lock().unwrap().take();
        for waiter in waiting.into_iter().flatten() {
            // A waiter is a blocked call; it cannot have gone.
            waiter
                .send(answer.clone())
                .expect("a call waiting on the dialog is still waiting");
        }
        answer
    }
}

/// Closes a [`ShellDialog`] when dropped, dropping any call still waiting on
/// it.
struct Closed<'a>(&'a Mutex<Option<Vec<Sender<ShellAnswer>>>>);

impl Drop for Closed<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().take();
    }
}

/// Writes a PNG of the whole desk, or of its `area`, to `file`, its longer
/// side at most `fit` pixels, for `domicile screenshot --fit`, and says what
/// it shows.
pub async fn for_an_agent(
    shots: &Shots,
    file: PathBuf,
    fit_into: u32,
    area: Option<DeskRect>,
) -> Result<DeskShot, String> {
    let desk = (shots.shoot)()
        .await
        .map_err(|why| format!("the desk could not be shot: {why}"))?;
    let whole = DeskRect {
        position: (desk.place.0, desk.place.1),
        size: (desk.place.2, desk.place.3),
    };
    let (shot, place) = match area {
        None => (desk.shot, whole),
        Some(area) => (crop(&desk.shot, pixels_of(&desk.shot, whole, area)?), area),
    };
    let shot = fit(&shot, fit_into);
    std::fs::write(&file, encode(&shot))
        .map_err(|why| format!("the screenshot could not be written: {why}"))?;
    Ok(DeskShot {
        place,
        width: shot.width,
        height: shot.height,
    })
}

/// `area` of the desk `whole` as the pixels of `shot`, which shows `whole`,
/// or why it is not all on the desk.
fn pixels_of(shot: &Shot, whole: DeskRect, area: DeskRect) -> Result<ShotRect, String> {
    let describe = |rect: DeskRect| {
        format!(
            "{},{} {}x{}",
            rect.position.0, rect.position.1, rect.size.0, rect.size.1
        )
    };
    let (left, top) = (
        area.position.0 - whole.position.0,
        area.position.1 - whole.position.1,
    );
    let (right, bottom) = (left + area.size.0, top + area.size.1);
    if left < 0
        || top < 0
        || right > whole.size.0
        || bottom > whole.size.1
        || area.size.0 < 1
        || area.size.1 < 1
    {
        return Err(format!(
            "the area {} is not all on the desk, which is {}",
            describe(area),
            describe(whole)
        ));
    }
    // Logical pixels to the shot's, rounding outward so the area is all in.
    let across = |at: i32| u64::from(shot.width) * at as u64;
    let down = |at: i32| u64::from(shot.height) * at as u64;
    let (width, height) = (whole.size.0 as u64, whole.size.1 as u64);
    let x = (across(left) / width) as u32;
    let y = (down(top) / height) as u32;
    Ok(ShotRect {
        x,
        y,
        width: (across(right).div_ceil(width) as u32) - x,
        height: (down(bottom).div_ceil(height) as u32) - y,
    })
}

/// Draws `window` as it last drew itself, for the shell's picker to preview,
/// as `SystemRequest::PreviewWindow` describes.
pub async fn preview(shots: &Shots, window: PreviewedWindow) -> Result<String, SystemError> {
    let shot = match window {
        PreviewedWindow::App { id } => (shots.shoot_window)(id).await,
        PreviewedWindow::Browser { id } => (shots.shoot_browser_window)(id).await,
    };
    shot.map(|shot| data_url("image/png", &encode(&shot)))
        .map_err(|why| other(format!("the window could not be drawn: {why}")))
}

/// Why a picker's answer kept no shot.
enum Unpicked {
    /// It answered no picture: a dismissal, or no shell.
    Not(PortalAnswer),
    /// The window it picked could not be shot.
    Failed(String),
}

/// What a picker kept, and whether the user asked to copy it.
struct Picked {
    shot: Shot,
    copy: bool,
}

/// The shot a picker over `desk` kept: an area of the desk, a window's own
/// last frame, or a browser window's page alone.
async fn picked(shots: &Shots, desk: &Desk, answer: PortalAnswer) -> Result<Picked, Unpicked> {
    match answer {
        PortalAnswer::Screenshot { area, copy } => Ok(Picked {
            shot: crop(&desk.shot, area),
            copy,
        }),
        PortalAnswer::ScreenshotWindow { id, copy, area } => (shots.shoot_window)(id)
            .await
            .map(|shot| Picked {
                shot: part(shot, area),
                copy,
            })
            .map_err(Unpicked::Failed),
        PortalAnswer::ScreenshotBrowserWindow { id, copy, area } => {
            (shots.shoot_browser_window)(id)
                .await
                .map(|shot| Picked {
                    shot: part(shot, area),
                    copy,
                })
                .map_err(Unpicked::Failed)
        }
        answer => Err(Unpicked::Not(answer)),
    }
}

/// `area` of a window's `shot`, or all of it. The window may have resized
/// since the picker drew it, so the area is kept inside the shot, and one
/// left wholly outside it keeps all of it.
fn part(shot: Shot, area: Option<ShotRect>) -> Shot {
    let Some(area) = area else {
        return shot;
    };
    let (left, top) = (area.x.min(shot.width), area.y.min(shot.height));
    let right = area.x.saturating_add(area.width).min(shot.width);
    let bottom = area.y.saturating_add(area.height).min(shot.height);
    if right <= left || bottom <= top {
        return shot;
    }
    crop(
        &shot,
        ShotRect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        },
    )
}

/// A [`Shoot`] that takes its frames through `casting`.
pub fn shooting(casting: Casting) -> Shoot {
    Arc::new(move || {
        let (replier, developed) = crate::reply::reply();
        casting.shoot(Box::new(move |desk| replier.send(desk)));
        Box::pin(async move {
            developed
                .await
                .unwrap_or_else(|| Err("the compositor dropped the shot".into()))
        })
    })
}

/// A [`ShootWindow`] that captures browser windows through `casting`.
pub fn shooting_browser_windows(casting: Casting) -> ShootWindow {
    Arc::new(move |id| {
        let (replier, developed) = crate::reply::reply();
        casting.shoot_browser_window(id, Box::new(move |shot| replier.send(shot)));
        Box::pin(async move {
            developed
                .await
                .unwrap_or_else(|| Err("the compositor dropped the shot".into()))
        })
    })
}

/// A [`ShootWindow`] that takes its frames through `casting`.
pub fn shooting_windows(casting: Casting) -> ShootWindow {
    Arc::new(move |app_id| {
        let (replier, developed) = crate::reply::reply();
        casting.shoot_window(app_id, Box::new(move |shot| replier.send(shot)));
        Box::pin(async move {
            developed
                .await
                .unwrap_or_else(|| Err("the compositor dropped the shot".into()))
        })
    })
}

/// A [`Save`] into `Screenshots` in the user's pictures folder, found again
/// on each screenshot.
pub fn in_pictures() -> Save {
    saving_into(|| {
        let (user_dirs, home) = user_dirs();
        screenshots_dir(user_dirs.as_deref(), &home)
    })
}

/// The contents of `user-dirs.dirs`, if there is one, and the home folder.
pub(super) fn user_dirs() -> (Option<String>, PathBuf) {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/".into()));
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    (
        std::fs::read_to_string(config.join("user-dirs.dirs")).ok(),
        home,
    )
}

/// A [`Save`] into the folder `dir` names, named for the local time.
fn saving_into(dir: impl Fn() -> PathBuf + Send + Sync + 'static) -> Save {
    Arc::new(move |shot| {
        save(&dir(), &file_name(now()), &encode(shot)).map_err(|why| why.to_string())
    })
}

/// The local time now.
pub(super) fn now() -> Taken {
    // SAFETY: `time` with a null argument only returns the time.
    let seconds = unsafe { libc::time(std::ptr::null_mut()) };
    // SAFETY: all-zero is a valid `tm`, filled below.
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are to live locals.
    unsafe { libc::localtime_r(&seconds, &mut local) };
    Taken {
        year: local.tm_year + 1900,
        month: (local.tm_mon + 1) as u32,
        day: local.tm_mday as u32,
        hour: local.tm_hour as u32,
        minute: local.tm_min as u32,
        second: local.tm_sec as u32,
    }
}

/// `desk` as the shell's picker shows it.
pub(super) fn frozen(desk: &Desk) -> FrozenDesk {
    FrozenDesk {
        frame: data_url("image/png", &encode(&desk.shot)),
        width: desk.shot.width,
        height: desk.shot.height,
        monitors: desk.monitors.clone(),
        windows: desk.windows.clone(),
        desk: DeskRect {
            position: (desk.place.0, desk.place.1),
            size: (desk.place.2, desk.place.3),
        },
    }
}

/// Whether boolean option `name` is set. Absent, or of another type, is
/// unset.
fn flag(options: &HashMap<String, OwnedValue>, name: &str) -> bool {
    options
        .get(name)
        .and_then(|value| bool::try_from(value).ok())
        .unwrap_or(false)
}

/// A failure of kind `Other`, saying `why`.
fn other(why: String) -> SystemError {
    SystemError {
        kind: SystemErrorKind::Other,
        message: why,
    }
}

fn owned(value: Value) -> OwnedValue {
    OwnedValue::try_from(value).expect("a string or a tuple of doubles holds no fd")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as Map;
    use std::sync::mpsc::{channel, Receiver};
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    use domicile_protocol::{
        AccessDialog, DeskRect, FrozenDesk, PortalAnswer, PortalKind, PortalRequest, ShotArea,
        ShotRect, ShotWindow,
    };
    use zbus::blocking::Connection;
    use zbus::zvariant::{ObjectPath, Value};

    use crate::portals::socket_pair::connected_both;
    use crate::portals::OBJECT_PATH;

    const INTERFACE: &str = "org.freedesktop.impl.portal.Screenshot";
    const HANDLE: &str = "/org/freedesktop/portal/desktop/request/1_7/s";
    const APP: &str = "org.example.Shooter";

    /// The frontend's permission store, holding the screenshot table: empty
    /// until an answer is kept, as the frontend's is.
    #[derive(Clone, Default)]
    struct Store(Arc<Mutex<Option<Table>>>);

    /// Each application's permissions.
    type Table = Map<String, Vec<String>>;

    #[zbus::interface(name = "org.freedesktop.impl.portal.PermissionStore")]
    impl Store {
        fn lookup(&self, table: String, id: String) -> Result<(Table, OwnedValue), NotFound> {
            assert_eq!((table.as_str(), id.as_str()), (TABLE, TABLE));
            let kept = self
                .0
                .lock()
                .unwrap()
                .clone()
                .ok_or(NotFound::NotFound("no screenshot table".into()))?;
            Ok((kept, owned(Value::from(0u8))))
        }

        fn set_permission(
            &self,
            table: String,
            create: bool,
            id: String,
            app: String,
            permissions: Vec<String>,
        ) {
            assert_eq!((table.as_str(), create, id.as_str()), (TABLE, true, TABLE));
            self.0
                .lock()
                .unwrap()
                .get_or_insert_default()
                .insert(app, permissions);
        }
    }

    /// The store's error for a table it does not have.
    #[derive(Debug, zbus::DBusError)]
    #[zbus(prefix = "org.freedesktop.portal.Error")]
    enum NotFound {
        NotFound(String),
    }

    #[test]
    fn an_agents_shot_is_the_desk_fit_into_its_file_and_says_where_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("desk.png");
        let shots = Shots {
            shoot: shot_of(Ok(desk())),
            ..Shots::none()
        };

        let shot = zbus::block_on(for_an_agent(&shots, file.clone(), 1, None)).unwrap();

        assert_eq!(
            shot,
            DeskShot {
                place: DeskRect {
                    position: (-1, 0),
                    size: (2, 1),
                },
                width: 1,
                height: 1,
            }
        );
        assert_eq!(png_of(std::fs::read(&file).unwrap()).0, (1, 1));
    }

    #[test]
    fn an_agents_shot_of_an_area_is_that_area_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("desk.png");
        let shots = Shots {
            shoot: shot_of(Ok(desk())),
            ..Shots::none()
        };
        let right = DeskRect {
            position: (0, 0),
            size: (1, 1),
        };

        let shot = zbus::block_on(for_an_agent(&shots, file.clone(), 8, Some(right))).unwrap();

        assert_eq!(
            shot,
            DeskShot {
                place: right,
                width: 1,
                height: 1,
            }
        );
        let off_the_desk = DeskRect {
            position: (0, 0),
            size: (2, 1),
        };
        assert_eq!(
            zbus::block_on(for_an_agent(&shots, file, 8, Some(off_the_desk))),
            Err("the area 0,0 2x1 is not all on the desk, which is -1,0 2x1".to_string())
        );
    }

    /// A 2x1 desk: an orange pixel on monitor `left`, then a half-transparent
    /// blue one on `right`, with a window over the second.
    fn desk() -> Desk {
        Desk {
            shot: Shot {
                width: 2,
                height: 1,
                bgra: [[0, 51, 255, 255], [128, 0, 0, 128]].concat(),
            },
            monitors: vec![area("left", 0), area("right", 1)],
            windows: vec![ShotWindow {
                id: "app-3".into(),
                title: "~/src".into(),
                app_id: "kitty".into(),
            }],
            place: (-1, 0, 2, 1),
        }
    }

    fn area(name: &str, x: u32) -> ShotArea {
        ShotArea {
            name: name.into(),
            description: String::new(),
            area: ShotRect {
                x,
                y: 0,
                width: 1,
                height: 1,
            },
        }
    }

    /// Window `app-3`'s own last frame: one opaque green pixel.
    fn own_frame() -> ShootWindow {
        Arc::new(|id| {
            Box::pin(async move {
                if id == "app-3" {
                    Ok(Shot {
                        width: 1,
                        height: 1,
                        bgra: vec![0, 255, 0, 255],
                    })
                } else {
                    Err(format!("no window {id}"))
                }
            })
        })
    }

    /// Browser window `1`'s page, captured alone: one opaque blue pixel.
    fn browser_page() -> ShootWindow {
        Arc::new(|id| {
            Box::pin(async move {
                if id == "1" {
                    Ok(Shot {
                        width: 1,
                        height: 1,
                        bgra: vec![255, 0, 0, 255],
                    })
                } else {
                    Err(format!("no browser window {id}"))
                }
            })
        })
    }

    /// A [`Shoot`] that always answers `shot`.
    fn shot_of(shot: Result<Desk, String>) -> Shoot {
        Arc::new(move || {
            let shot = shot.clone();
            Box::pin(async move { shot })
        })
    }

    struct Served {
        client: Connection,
        queue: Arc<Queue>,
        published: Receiver<Vec<PortalRequest>>,
        store: Store,
        album: tempfile::TempDir,
        copied: Receiver<Vec<u8>>,
        _server: Connection,
    }

    /// A [`CopyPng`] that hands each PNG to the returned receiver.
    fn copying() -> (CopyPng, Receiver<Vec<u8>>) {
        let (copy, copied) = channel();
        let copy = Mutex::new(copy);
        (
            Arc::new(move |png| {
                copy.lock().expect("unpoisoned").send(png).expect("heard");
                Ok(())
            }),
            copied,
        )
    }

    /// The backend over a socket pair, shooting `shot` and saving into a
    /// temporary folder.
    fn served(shot: Result<Desk, String>) -> Served {
        let queue = Arc::<Queue>::default();
        let (publish, published) = channel();
        queue.listen(
            move |items, _| {
                let _ = publish.send(items);
            },
            || true,
            |_| None,
        );
        let store = Store::default();
        let album = tempfile::tempdir().expect("a temporary folder");
        let (copy, copied) = copying();
        let backend = Screenshot {
            queue: Arc::clone(&queue),
            shots: Shots {
                shoot: shot_of(shot),
                shoot_window: own_frame(),
                shoot_browser_window: browser_page(),
                save: {
                    let dir = album.path().join("Screenshots");
                    saving_into(move || dir.clone())
                },
                copy,
            },
        };
        // The frontend serves its store on the bus; here, the client's end.
        // Served by the builder, whose `build` waits for the object server to
        // listen; served later, a `Lookup` can arrive first and is dropped.
        let (server, client) = connected_both(
            |builder| builder.serve_at(OBJECT_PATH, backend).expect("served"),
            |builder| {
                builder
                    .serve_at(PERMISSION_STORE_PATH, store.clone())
                    .expect("the store served")
            },
        );
        Served {
            client,
            queue,
            published,
            store,
            album,
            copied,
            _server: server,
        }
    }

    /// Calls `method` with `options` on another thread, returning its reply.
    fn calling(
        served: &Served,
        method: &'static str,
        options: Vec<(&'static str, bool)>,
    ) -> thread::JoinHandle<(u32, Map<String, OwnedValue>)> {
        let client = served.client.clone();
        thread::spawn(move || {
            let options: Map<String, OwnedValue> = options
                .into_iter()
                .map(|(name, on)| {
                    (
                        name.to_string(),
                        OwnedValue::try_from(Value::from(on)).expect("ownable"),
                    )
                })
                .collect();
            client
                .call_method(
                    None::<&str>,
                    OBJECT_PATH,
                    Some(INTERFACE),
                    method,
                    &(
                        ObjectPath::try_from(HANDLE).expect("a path"),
                        APP,
                        "",
                        options,
                    ),
                )
                .expect("answered")
                .body()
                .deserialize()
                .expect("a response")
        })
    }

    #[track_caller]
    fn next(served: &Served) -> Vec<PortalRequest> {
        served
            .published
            .recv_timeout(Duration::from_secs(10))
            .expect("the queue published")
    }

    /// The PNG `uri` names: its size and straight RGBA pixels.
    fn png_at(uri: &OwnedValue) -> ((u32, u32), Vec<u8>) {
        let uri = String::try_from(uri.try_clone().expect("cloned")).expect("a string");
        // The file names have spaces; the temporary folder's path has no
        // other encoded byte.
        let path = uri
            .strip_prefix("file://")
            .expect("a file URI")
            .replace("%20", " ");
        png_of(std::fs::read(path).expect("saved"))
    }

    /// A PNG's size and straight RGBA pixels.
    fn png_of(png: Vec<u8>) -> ((u32, u32), Vec<u8>) {
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let mut reader = decoder.read_info().expect("a PNG");
        let mut pixels = vec![0; reader.output_buffer_size().expect("a size")];
        let info = reader.next_frame(&mut pixels).expect("a frame");
        ((info.width, info.height), pixels)
    }

    /// Shots that draw window `app-3` and browser window `1`.
    fn windows() -> Shots {
        Shots {
            shoot_window: own_frame(),
            shoot_browser_window: browser_page(),
            ..Shots::none()
        }
    }

    /// The PNG in a `data:` URL: its size and straight RGBA pixels.
    fn png_in(frame: &str) -> ((u32, u32), Vec<u8>) {
        let base64 = frame
            .strip_prefix("data:image/png;base64,")
            .expect("a PNG data URL");
        png_of(domicile_host::base64::decoded(base64).expect("base64"))
    }

    #[test]
    fn a_window_previews_as_its_own_last_frame() {
        let frame = zbus::block_on(preview(
            &windows(),
            PreviewedWindow::App { id: "app-3".into() },
        ))
        .expect("drawn");

        assert_eq!(png_in(&frame), ((1, 1), vec![0, 255, 0, 255]));
    }

    #[test]
    fn a_browser_window_previews_as_its_page_alone() {
        let frame = zbus::block_on(preview(
            &windows(),
            PreviewedWindow::Browser { id: "1".into() },
        ))
        .expect("drawn");

        assert_eq!(png_in(&frame), ((1, 1), vec![0, 0, 255, 255]));
    }

    #[test]
    fn a_window_that_cannot_be_drawn_says_why() {
        let failed = zbus::block_on(preview(
            &windows(),
            PreviewedWindow::App { id: "app-9".into() },
        ))
        .expect_err("not drawn");

        assert_eq!(failed.kind, SystemErrorKind::Other);
        assert!(failed.message.contains("no window app-9"), "{failed:?}");
    }

    #[test]
    fn a_screenshot_the_frontend_allowed_saves_the_whole_desk() {
        let served = served(Ok(desk()));

        let (response, results) = calling(
            &served,
            "Screenshot",
            vec![("interactive", false), ("permission_store_checked", true)],
        )
        .join()
        .expect("returned");

        assert_eq!(response, 0);
        let (size, pixels) = png_at(&results["uri"]);
        assert_eq!(size, (2, 1));
        assert_eq!(pixels, [[255, 51, 0, 255], [0, 0, 255, 128]].concat());
        let saved: Vec<_> = std::fs::read_dir(served.album.path().join("Screenshots"))
            .expect("the folder was made")
            .collect();
        assert_eq!(saved.len(), 1);
    }

    #[test]
    fn an_unchecked_screenshot_asks_once_and_keeps_the_answer() {
        let served = served(Ok(desk()));
        let first = calling(&served, "Screenshot", Vec::new());

        assert_eq!(
            next(&served),
            [PortalRequest {
                id: 1,
                app_id: APP.into(),
                parent_app_id: None,
                kind: PortalKind::Access(AccessDialog {
                    title: "Allow screenshots?".into(),
                    subtitle: "It will see everything on your screens, without asking again."
                        .into(),
                    body: String::new(),
                    grant_label: Some("Allow".into()),
                    deny_label: None,
                    destructive: false,
                }),
            }]
        );
        served.queue.answer(1, PortalAnswer::Access);
        assert_eq!(first.join().expect("returned").0, 0);
        let second = calling(&served, "Screenshot", Vec::new());

        assert_eq!(second.join().expect("returned").0, 0);
        assert!(
            served.published.try_iter().all(|items| items.is_empty()),
            "asked once"
        );
        assert_eq!(
            served.store.0.lock().unwrap().as_ref().expect("a table")[APP],
            ["yes"]
        );
    }

    #[test]
    fn a_denied_screenshot_saves_nothing_and_is_not_asked_again() {
        let served = served(Ok(desk()));
        let first = calling(&served, "Screenshot", Vec::new());
        next(&served);
        served.queue.answer(1, PortalAnswer::Canceled);

        assert_eq!(first.join().expect("returned").0, 2);
        assert_eq!(
            calling(&served, "Screenshot", Vec::new())
                .join()
                .expect("returned")
                .0,
            2
        );
        assert!(!served.album.path().join("Screenshots").exists());
    }

    #[test]
    fn an_interactive_screenshot_keeps_the_area_the_shell_picked() {
        let served = served(Ok(desk()));
        let picking = calling(&served, "Screenshot", vec![("interactive", true)]);

        let asked = next(&served);
        let PortalKind::Screenshot(FrozenDesk {
            frame,
            width,
            height,
            monitors,
            windows,
            desk,
        }) = &asked[0].kind
        else {
            panic!("a picker, not {:?}", asked[0].kind);
        };
        assert!(frame.starts_with("data:image/png;base64,"));
        assert_eq!((*width, *height), (2, 1));
        assert_eq!((monitors.len(), windows.len()), (2, 1));
        assert_eq!(windows[0].app_id, "kitty");
        assert_eq!(
            *desk,
            DeskRect {
                position: (-1, 0),
                size: (2, 1),
            }
        );
        served.queue.answer(
            asked[0].id,
            PortalAnswer::Screenshot {
                area: monitors[1].area,
                copy: false,
            },
        );

        let (response, results) = picking.join().expect("returned");
        assert_eq!(response, 0);
        assert_eq!(png_at(&results["uri"]), ((1, 1), vec![0, 0, 255, 128]));
    }

    /// Ctrl+C in the dialog copies the area; the asking application still
    /// gets its file.
    #[test]
    fn an_interactive_screenshot_copied_is_copied_and_saved_for_the_app() {
        let served = served(Ok(desk()));
        let picking = calling(&served, "Screenshot", vec![("interactive", true)]);

        let asked = next(&served);
        let PortalKind::Screenshot(FrozenDesk { monitors, .. }) = &asked[0].kind else {
            panic!("a picker, not {:?}", asked[0].kind);
        };
        served.queue.answer(
            asked[0].id,
            PortalAnswer::Screenshot {
                area: monitors[1].area,
                copy: true,
            },
        );

        let (response, results) = picking.join().expect("returned");
        assert_eq!(response, 0);
        assert_eq!(png_at(&results["uri"]), ((1, 1), vec![0, 0, 255, 128]));
        let copied = served
            .copied
            .recv_timeout(Duration::from_secs(10))
            .expect("copied");
        assert_eq!(png_of(copied), ((1, 1), vec![0, 0, 255, 128]));
    }

    #[test]
    fn a_window_picked_is_saved_from_its_own_frame() {
        // A window the shell does not show, as a hidden tab, is not on the
        // frozen desk.
        let served = served(Ok(desk()));
        let picking = calling(&served, "Screenshot", vec![("interactive", true)]);
        let asked = next(&served);

        served.queue.answer(
            asked[0].id,
            PortalAnswer::ScreenshotWindow {
                id: "app-3".into(),
                copy: false,
                area: None,
            },
        );

        let (response, results) = picking.join().expect("returned");
        assert_eq!(response, 0);
        assert_eq!(png_at(&results["uri"]), ((1, 1), vec![0, 255, 0, 255]));
    }

    /// A 3x2 shot, each pixel's blue byte its index.
    fn numbered() -> Shot {
        Shot {
            width: 3,
            height: 2,
            bgra: (0..6).flat_map(|blue| [blue, 0, 0, 255]).collect(),
        }
    }

    /// A part of a hidden window dragged over its preview is cut from its
    /// own frame, which the preview drew.
    #[test]
    fn a_part_of_a_window_is_cut_from_its_frame() {
        let area = |x, y, width, height| {
            Some(ShotRect {
                x,
                y,
                width,
                height,
            })
        };
        let blues = |shot: Shot| {
            (
                shot.width,
                shot.height,
                shot.bgra.iter().step_by(4).copied().collect::<Vec<u8>>(),
            )
        };

        assert_eq!(
            blues(part(numbered(), area(1, 0, 2, 2))),
            (2, 2, vec![1, 2, 4, 5])
        );
        assert_eq!(
            blues(part(numbered(), None)),
            (3, 2, vec![0, 1, 2, 3, 4, 5])
        );
        // The window shrank since the preview: what is left of the part.
        assert_eq!(blues(part(numbered(), area(2, 1, 5, 5))), (1, 1, vec![5]));
        // All of the part is gone: all of the window.
        assert_eq!(
            blues(part(numbered(), area(9, 9, 2, 2))),
            (3, 2, vec![0, 1, 2, 3, 4, 5])
        );
    }

    #[test]
    fn a_browser_window_picked_is_saved_from_its_page_alone() {
        // Whatever the shell draws over the window, such as a notification,
        // is on the frozen desk but not in the page.
        let served = served(Ok(desk()));
        let picking = calling(&served, "Screenshot", vec![("interactive", true)]);
        let asked = next(&served);

        served.queue.answer(
            asked[0].id,
            PortalAnswer::ScreenshotBrowserWindow {
                id: "1".into(),
                copy: false,
                area: None,
            },
        );

        let (response, results) = picking.join().expect("returned");
        assert_eq!(response, 0);
        assert_eq!(png_at(&results["uri"]), ((1, 1), vec![0, 0, 255, 255]));
    }

    #[test]
    fn a_dismissed_picker_answers_one() {
        let served = served(Ok(desk()));
        let picking = calling(&served, "Screenshot", vec![("interactive", true)]);
        next(&served);
        served.queue.answer(1, PortalAnswer::Canceled);

        assert_eq!(picking.join().expect("returned").0, 1);
    }

    #[test]
    fn a_picked_color_is_srgb_from_zero_to_one() {
        let served = served(Ok(desk()));
        let picking = calling(&served, "PickColor", Vec::new());

        let asked = next(&served);
        assert!(matches!(asked[0].kind, PortalKind::PickColor(_)));
        served
            .queue
            .answer(asked[0].id, PortalAnswer::PickColor { x: 0, y: 0 });

        let (response, results) = picking.join().expect("returned");
        assert_eq!(response, 0);
        assert_eq!(
            <(f64, f64, f64)>::try_from(results["color"].try_clone().expect("cloned"))
                .expect("(ddd)"),
            (1.0, 0.2, 0.0)
        );
    }

    #[test]
    fn a_desk_that_cannot_be_shot_answers_two() {
        let served = served(Err("no engine".into()));

        let (response, results) = calling(
            &served,
            "Screenshot",
            vec![("permission_store_checked", true)],
        )
        .join()
        .expect("returned");

        assert_eq!(response, 2);
        assert!(results.is_empty());
    }

    /// The shell's own screenshot of `shot`, into `file` if given, on another
    /// thread, with the queue it asks through and the folder it saves into.
    struct ShellShot {
        taken: thread::JoinHandle<Result<Kept, SystemError>>,
        queue: Arc<Queue>,
        published: Receiver<Vec<PortalRequest>>,
        album: tempfile::TempDir,
        copied: Receiver<Vec<u8>>,
    }

    fn shell_shot(shot: Result<Desk, String>, file: Option<PathBuf>) -> ShellShot {
        let queue = Arc::<Queue>::default();
        let (publish, published) = channel();
        queue.listen(
            move |items, _| {
                let _ = publish.send(items);
            },
            || true,
            |_| None,
        );
        let album = tempfile::tempdir().expect("a temporary folder");
        let (copy, copied) = copying();
        let shots = Shots {
            shoot: shot_of(shot),
            shoot_window: own_frame(),
            shoot_browser_window: browser_page(),
            save: {
                let dir = album.path().join("Screenshots");
                saving_into(move || dir.clone())
            },
            copy,
        };
        let taken = {
            let queue = Arc::clone(&queue);
            thread::spawn(move || zbus::block_on(for_the_shell(&queue, &shots, file)))
        };
        ShellShot {
            taken,
            queue,
            published,
            album,
            copied,
        }
    }

    /// A second Print while the shell's dialog is up shows no second dialog,
    /// then or once the first closes.
    #[test]
    fn a_shell_screenshot_asked_while_its_dialog_is_up_answers_as_that_dialog() {
        let dialog = ShellDialog::default();
        let (answer, answered) = channel::<ShellAnswer>();
        let (up, shown) = channel();
        let first = {
            let dialog = dialog.clone();
            thread::spawn(move || {
                dialog.take(|| {
                    up.send(()).expect("the test listens");
                    answered.recv().expect("the test answers")
                })
            })
        };
        shown
            .recv_timeout(Duration::from_secs(10))
            .expect("the first dialog is up");
        let second = {
            let dialog = dialog.clone();
            thread::spawn(move || dialog.take(|| panic!("a second dialog was shown")))
        };
        let waited = std::time::Instant::now();
        while dialog.0.lock().unwrap().as_ref().map_or(0, Vec::len) == 0 {
            assert!(
                waited.elapsed() < Duration::from_secs(10),
                "the second call waits on the first dialog"
            );
            thread::sleep(Duration::from_millis(1));
        }

        answer.send(Ok(Kept::Copied)).expect("the dialog waits");

        assert_eq!(first.join().expect("returned"), Ok(Kept::Copied));
        assert_eq!(second.join().expect("returned"), Ok(Kept::Copied));
        // Closed, so the next Print shows its own.
        assert_eq!(
            dialog.take(|| Err(other("shown".into()))),
            Err(other("shown".into()))
        );
    }

    /// A dialog whose call panicked is closed: the next Print shows its own.
    #[test]
    fn a_shell_screenshot_after_one_that_panicked_shows_its_own_dialog() {
        let dialog = ShellDialog::default();
        let panicked = {
            let dialog = dialog.clone();
            thread::spawn(move || dialog.take(|| panic!("the desk could not be shot")))
        };
        assert!(panicked.join().is_err());

        assert_eq!(dialog.take(|| Ok(Kept::Copied)), Ok(Kept::Copied));
    }

    #[test]
    fn the_shells_own_screenshot_keeps_the_area_it_picked() {
        let shooting = shell_shot(Ok(desk()), None);

        let asked = shooting
            .published
            .recv_timeout(Duration::from_secs(10))
            .expect("the queue published");
        assert_eq!(asked[0].app_id, SHELL_APP_ID);
        let PortalKind::Screenshot(FrozenDesk { monitors, .. }) = &asked[0].kind else {
            panic!("a picker, not {:?}", asked[0].kind);
        };
        shooting.queue.answer(
            asked[0].id,
            PortalAnswer::Screenshot {
                area: monitors[1].area,
                copy: false,
            },
        );

        let Ok(Kept::Saved(path)) = shooting.taken.join().expect("returned") else {
            panic!("saved");
        };
        assert!(path.starts_with(shooting.album.path().join("Screenshots")));
        assert_eq!(
            png_at(&owned(Value::from(file_uri(&path.display().to_string())))),
            ((1, 1), vec![0, 0, 255, 128])
        );
    }

    #[test]
    fn the_shells_own_screenshot_of_a_window_is_its_own_frame() {
        let shooting = shell_shot(Ok(desk()), None);
        let asked = shooting
            .published
            .recv_timeout(Duration::from_secs(10))
            .expect("the queue published");

        shooting.queue.answer(
            asked[0].id,
            PortalAnswer::ScreenshotWindow {
                id: "app-3".into(),
                copy: false,
                area: None,
            },
        );

        let Ok(Kept::Saved(path)) = shooting.taken.join().expect("returned") else {
            panic!("saved");
        };
        assert_eq!(
            png_at(&owned(Value::from(file_uri(&path.display().to_string())))),
            ((1, 1), vec![0, 255, 0, 255])
        );
    }

    /// Ctrl+C in the shell's own dialog copies the window and saves nothing.
    #[test]
    fn the_shells_own_screenshot_copied_is_not_saved() {
        let shooting = shell_shot(Ok(desk()), None);
        let asked = shooting
            .published
            .recv_timeout(Duration::from_secs(10))
            .expect("the queue published");

        shooting.queue.answer(
            asked[0].id,
            PortalAnswer::ScreenshotWindow {
                id: "app-3".into(),
                copy: true,
                area: None,
            },
        );

        assert_eq!(shooting.taken.join().expect("returned"), Ok(Kept::Copied));
        let copied = shooting.copied.try_recv().expect("copied");
        assert_eq!(png_of(copied), ((1, 1), vec![0, 255, 0, 255]));
        assert!(!shooting.album.path().join("Screenshots").exists());
    }

    #[test]
    fn a_dismissed_shell_screenshot_is_canceled() {
        let shooting = shell_shot(Ok(desk()), None);
        let asked = shooting
            .published
            .recv_timeout(Duration::from_secs(10))
            .expect("the queue published");
        shooting.queue.answer(asked[0].id, PortalAnswer::Canceled);

        let error = shooting
            .taken
            .join()
            .expect("returned")
            .expect_err("canceled");

        assert_eq!(error.kind, SystemErrorKind::Canceled);
        assert!(!shooting.album.path().join("Screenshots").exists());
    }

    #[test]
    fn a_screenshot_into_a_file_is_the_whole_desk_without_a_dialog() {
        let folder = tempfile::tempdir().expect("a temporary folder");
        let file = folder.path().join("shot.png");
        let shooting = shell_shot(Ok(desk()), Some(file.clone()));

        assert_eq!(
            shooting.taken.join().expect("returned"),
            Ok(Kept::Saved(file.clone()))
        );
        assert_eq!(
            png_at(&owned(Value::from(file_uri(&file.display().to_string())))).0,
            (2, 1)
        );
        assert!(
            shooting.published.try_iter().all(|items| items.is_empty()),
            "no dialog"
        );
    }

    #[test]
    fn a_shell_screenshot_of_a_desk_that_cannot_be_shot_says_why() {
        let shooting = shell_shot(Err("no engine".into()), None);

        let error = shooting
            .taken
            .join()
            .expect("returned")
            .expect_err("unshot");

        assert_eq!(error.kind, SystemErrorKind::Other);
        assert!(error.message.contains("no engine"), "{}", error.message);
    }

    #[test]
    fn it_is_version_two() {
        let served = served(Ok(desk()));

        let version: OwnedValue = served
            .client
            .call_method(
                None::<&str>,
                OBJECT_PATH,
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &(INTERFACE, "version"),
            )
            .expect("answered")
            .body()
            .deserialize()
            .expect("a variant");
        let version = u32::try_from(version).expect("a u32");

        assert_eq!(version, 2);
    }
}
