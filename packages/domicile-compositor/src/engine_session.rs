//! The compositor's connection to the engine: the loaded library, the surfaces
//! brokered through it, and the client buffers it holds.
//!
//! [`crate::engine`] is the ABI; this module uses it.

use std::collections::HashMap;
use std::os::fd::{AsFd as _, OwnedFd};
use std::path::Path;
use std::time::Instant;

use crate::buffer_transform::Sampled;
use crate::eis::DeskInput;
use crate::frame_descriptor::FrameDescriptor;
use domicile_host::clipboard::Contents;
use smithay::reexports::wayland_server::backend::ObjectId;
use smithay::reexports::wayland_server::protocol::wl_buffer;
use smithay::reexports::wayland_server::Resource as _;

use crate::engine::{
    BufferId, Capture, Clipboard, Color, Connector, Dmabuf, Engine, EngineError, Event, Pointer,
    Request, Subsurface, SurfaceId, VirtualDisplay, LIBRARY, NEWEST_BOX,
};
use crate::engine_buffers::{HeldBuffers, Returned};
use crate::engine_imports::{Imports, Route, Then};
use crate::engine_lingering::{Linger, Lingering};
use crate::engine_retired::Retired;
use crate::engine_surfaces::Surfaces;
use crate::engine_waiting::Waiting;
use crate::uploads::UploadId;

/// A buffer submitted to the engine: a client's dmabuf, or a compositor buffer
/// holding a copied shm frame (on the GPU, or in memory for an engine on the
/// CPU).
///
/// Both are held until viz releases them. A client buffer then gets a
/// `wl_buffer.release`; an upload goes back to [`crate::uploads::Uploads`].
#[derive(Debug, Clone, PartialEq)]
pub enum Submitted {
    Client(wl_buffer::WlBuffer),
    Upload(UploadId),
}

/// Which buffer a frame shows.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum BufferKey {
    Client(ObjectId),
    Upload(UploadId),
}

/// The key an import is recorded under: the buffer, and the color it was
/// imported in, since viz fixes a buffer's color at import.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ImportKey {
    buffer: BufferKey,
    /// The surface's [`Colored::generation`] at import.
    color: u64,
}

impl Submitted {
    fn key(&self) -> BufferKey {
        match self {
            Submitted::Client(buffer) => BufferKey::Client(buffer.id()),
            Submitted::Upload(id) => BufferKey::Upload(*id),
        }
    }
}

/// How an app's pixels encode color, as the engine was last told.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Colored {
    /// `None` is sRGB.
    color: Option<Color>,
    /// Names this color in [`ImportKey`]: 0 for sRGB, a new number for each
    /// change otherwise.
    generation: u64,
}

/// What became of a frame handed to [`EngineSession::submit`].
#[derive(Debug, PartialEq)]
pub enum Submission {
    /// Viz has it. The caller must not release the buffer, and must release
    /// `replaced`, an older frame that was waiting.
    Taken { replaced: Option<Submitted> },
    /// The frame waits for a page to embed the surface (see
    /// `engine_waiting`) or for its buffer's import (see `engine_imports`).
    /// The caller must not release the buffer, and must release `replaced`.
    Waiting { replaced: Option<Submitted> },
    /// Nothing was submitted; the buffer is still the caller's.
    Refused,
}

/// What became of a frame handed to [`EngineSession::remap`].
#[derive(Debug, PartialEq)]
pub enum Remapped {
    /// Viz shows `buffer` mapped anew, as the engine's `frame`.
    Taken { buffer: Submitted, frame: u64 },
    /// The window's newest frame, of `buffer`, waits for an embed or an
    /// import, and goes up mapped anew.
    Waiting { buffer: Submitted },
    /// The engine has no frame of the window's, or maps it so already.
    Unchanged,
}

/// How a frame's buffer is shown: the part sampled and the box it fills.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Mapping {
    sampled: Sampled,
    at_box: u64,
}

/// A frame waiting to be submitted.
#[derive(Debug)]
struct Frame {
    buffer: Submitted,
    descriptor: FrameDescriptor,
    sampled: Sampled,
    at_box: u64,
    /// Signals when the compositor's draw into the buffer lands. `None` for a
    /// buffer already drawn.
    fence: Option<OwnedFd>,
}

impl Frame {
    fn mapping(&self) -> Mapping {
        Mapping {
            sampled: self.sampled,
            at_box: self.at_box,
        }
    }

    /// What [`EngineSession::show`] puts up.
    fn into_parts(self) -> (Submitted, Mapping, Option<OwnedFd>) {
        let mapping = self.mapping();
        (self.buffer, mapping, self.fence)
    }
}

/// What became of a frame handed to [`EngineSession::put_up`].
enum PutUp {
    /// As [`Submission::Taken`], as the engine's `frame`.
    Taken {
        replaced: Option<Submitted>,
        frame: u64,
    },
    /// Its buffer is being imported, and it goes up when that finishes.
    Importing { replaced: Option<Submitted> },
    /// The engine refused its buffer. The frame is handed back.
    Refused(Frame),
}

/// What [`EngineSession::dispatch`] found.
#[derive(Debug)]
pub struct Dispatched {
    /// The events for the caller to act on.
    pub events: Vec<Event>,
    /// The buffers to give back.
    pub releases: Vec<Release>,
    /// Apps whose frame went up once its buffer was imported, and the number
    /// the engine reports it by.
    pub shown: Vec<(String, u64)>,
}

#[derive(Debug)]
pub struct Release {
    pub buffer: Submitted,
    /// The window it belonged to, so the caller can log whose buffer it was.
    pub surface: SurfaceId,
    pub why: Returned,
}

/// Looks up a submitted buffer's description again.
///
/// The caller provides it because this module has no Smithay buffer types.
/// `None` means the window cannot be shown on the new engine.
pub type Describe<'a> = dyn Fn(&Submitted) -> Option<FrameDescriptor> + 'a;

/// The result of [`EngineSession::reconnect`].
#[derive(Debug)]
pub struct Reconnected {
    /// Buffers to release, since the engine holding them is gone.
    pub releases: Vec<Release>,
    /// Whether the new engine was joined. On `Err` the session stays inert so
    /// a later reconnect can try again.
    pub dialed: Result<(), EngineError>,
    /// Apps whose last frame was resubmitted to the new engine.
    pub shown: Vec<String>,
    /// Apps whose window stays blank until the client draws again. The caller
    /// logs each one.
    pub blank: Vec<String>,
}

/// A live connection to the forked engine.
#[derive(Debug)]
pub struct EngineSession {
    engine: Engine,
    /// The engine's socket. A restarted engine listens on the same path.
    socket: std::path::PathBuf,
    /// One surface per app, brokered on the app's first commit, and which of
    /// them a page has embedded.
    surfaces: Surfaces,
    /// The engine id of each buffer imported for each surface, and the frames
    /// waiting for an import. Clients commit the same buffer repeatedly, so
    /// importing per commit would send new fds every frame.
    imports: Imports<ImportKey, Frame>,
    held: HeldBuffers<Submitted>,
    /// How each app's last frame went up. A reconnect reuses its crop and
    /// transform, and a remap skips a mapping already shown.
    mapped: HashMap<String, Mapping>,
    /// The frame each surface committed before a page embedded it. See
    /// `engine_waiting`.
    waiting: Waiting<Frame>,
    /// Closed windows' surfaces, still drawn while the shell animates them
    /// out. See `engine_lingering`.
    lingering: Lingering,
    /// Imports whose buffer the client destroyed while it was on screen. See
    /// `engine_retired`.
    retired: Retired,
    /// Each surface's subsurfaces as last set, by app id, so a restarted
    /// engine gets them again.
    children: HashMap<String, Vec<Child>>,
    /// Each app's color, for apps that described one. See
    /// [`EngineSession::describe`].
    colors: HashMap<String, Colored>,
    /// The last [`Colored::generation`] handed out.
    last_color: u64,
}

/// One of a surface's subsurfaces, as [`EngineSession::set_children`] takes
/// it.
#[derive(Debug, Clone, PartialEq)]
pub struct Child {
    /// The id the compositor gave the subsurface. The host never sees it.
    pub app_id: String,
    /// Logical, from the top left of its parent's crop.
    pub position: (f64, f64),
    /// Logical.
    pub size: (f64, f64),
    /// Whether it is drawn over its parent rather than under it.
    pub above: bool,
}

/// What [`EngineSession::window_gone`] did.
#[derive(Debug, Default)]
pub struct WindowGone {
    /// Buffers to release now: frames that never went up.
    pub releases: Vec<Release>,
    /// The surface left on screen, for the caller to end with
    /// [`EngineSession::linger_over`] after [`crate::engine_lingering::LINGER`].
    pub linger: Option<Linger>,
}

impl EngineSession {
    /// Loads the engine and joins the browser.
    ///
    /// The error names the library. The caller stops on error instead of
    /// running with a blank screen.
    pub fn load(socket: &Path) -> Result<Self, EngineError> {
        Ok(Self {
            engine: Engine::load(LIBRARY, socket)?,
            socket: socket.to_path_buf(),
            surfaces: Surfaces::default(),
            imports: Imports::default(),
            held: HeldBuffers::default(),
            mapped: HashMap::new(),
            waiting: Waiting::default(),
            lingering: Lingering::default(),
            retired: Retired::default(),
            children: HashMap::new(),
            colors: HashMap::new(),
            last_color: 0,
        })
    }

    /// Joins a restarted engine and restores the old engine's state on it.
    ///
    /// - The new browser restarts its `SurfaceId` and `BufferId` counters, so
    ///   every recorded surface and import is stale and is dropped.
    /// - Every hold is returned, even if the dial fails, since the old engine
    ///   will never release it and the client cannot draw until it is.
    /// - Each surface's on-screen frame is imported and submitted again.
    ///   Otherwise an idle client's window stays blank, since nothing else
    ///   makes it commit.
    /// - Frame callbacks waiting on the old engine are the caller's to answer
    ///   (`crate::frame_callbacks`). The new surfaces number their frames
    ///   afresh.
    ///
    /// No check in this repository covers this. See
    /// `docs/HARDWARE-CHECKS.md#dead-engine-with-windows-open`.
    pub fn reconnect(&mut self, describe: &Describe, now: Instant) -> Reconnected {
        // A retired import's buffer is gone, so it cannot go up again. Its
        // window stays blank until the client draws.
        for (surface, id) in self.retired.drain() {
            drop(self.held.release(surface, id));
        }
        let taken = self.held.take_all();
        let apps: HashMap<SurfaceId, String> = self
            .surfaces
            .drain()
            .map(|(app_id, surface)| (surface, app_id))
            .collect();
        let importing = self.imports.clear();
        // The old engine took lingering surfaces with it; `taken` has their
        // holds.
        self.lingering.clear();

        let dialed = self.engine.reconnect(&self.socket);
        if dialed.is_ok() {
            // Re-broker every app, including those with no frame to resubmit.
            // The browser holds the page's `embedExternalSurface()` until a
            // sink is brokered, and an idle client never commits to trigger
            // it. `surface_for` logs refusals; their frames end up in `blank`.
            for app_id in apps.values() {
                let _ = self.surface_for(app_id);
            }
            // Before the frames that draw them.
            let parents: Vec<String> = self.children.keys().cloned().collect();
            for parent in parents {
                self.send_the_children(&parent);
            }
        }

        let mut releases = returned(taken.superseded, Returned::Abandoned);
        // Waiting frames name old surfaces, so release them. The client draws
        // again once the new surface is embedded and configured.
        releases.extend(self.waiting.take_all().into_iter().chain(importing).map(
            |(surface, frame)| Release {
                buffer: frame.buffer,
                surface,
                why: Returned::Abandoned,
            },
        ));
        let mut session = Reconnected {
            releases,
            dialed,
            shown: Vec::new(),
            blank: Vec::new(),
        };
        for ((surface, _), buffer) in taken.on_screen {
            let Some(app_id) = apps.get(&surface) else {
                // A closed window's lingering surface, which has no app.
                // Release the buffer.
                session.releases.push(Release {
                    buffer,
                    surface,
                    why: Returned::Abandoned,
                });
                continue;
            };
            match self.show_again(app_id, &buffer, describe, now) {
                // Each replaced nothing, since it is the surface's only frame.
                Submission::Taken { .. } => session.shown.push(app_id.clone()),
                // Held until the page embeds the surface again.
                Submission::Waiting { .. } => session.blank.push(app_id.clone()),
                Submission::Refused => {
                    session.blank.push(app_id.clone());
                    session.releases.push(Release {
                        buffer,
                        surface,
                        why: Returned::Abandoned,
                    });
                }
            }
        }
        session
    }

    /// Resubmits one app's last frame to the new engine and keeps it held.
    ///
    /// [`Submission::Refused`] means the window stays blank until its client
    /// draws, and the caller logs it.
    fn show_again(
        &mut self,
        app_id: &str,
        buffer: &Submitted,
        describe: &Describe,
        now: Instant,
    ) -> Submission {
        let Some(descriptor) = describe(buffer) else {
            return Submission::Refused;
        };
        let sampled = self
            .mapped
            .get(app_id)
            .map(|mapped| mapped.sampled)
            .unwrap_or_default();
        // A new engine numbers its boxes afresh.
        self.submit(
            app_id,
            buffer.clone(),
            &descriptor,
            sampled,
            (0, 0, 0, 0),
            NEWEST_BOX,
            None,
            now,
        )
    }

    /// The fd to add to the compositor's loop.
    pub fn fd(&self) -> std::os::fd::RawFd {
        self.engine.fd()
    }

    /// Tells the engine which connectors to light and where.
    ///
    /// See [`crate::engine::Engine::configure_displays`], including what an
    /// empty list means.
    pub fn configure_displays(&self, connectors: &[Connector]) {
        self.engine.configure_displays(connectors);
    }

    /// Tells the browser which monitors with no connector to add.
    ///
    /// See [`crate::engine::Engine::configure_virtual_displays`].
    pub fn configure_virtual_displays(&self, displays: &[VirtualDisplay]) {
        self.engine.configure_virtual_displays(displays);
    }

    /// Applies the desktop's touchpad and relative mouse settings.
    pub fn configure_input(&self, input: &domicile_config::InputConfig) {
        self.engine.configure_input(input);
    }

    /// Tells the browser which display each tablet or touchscreen covers.
    ///
    /// See [`crate::engine::Engine::configure_pointers`].
    pub fn configure_pointers(&self, pointers: &[Pointer]) {
        self.engine.configure_pointers(pointers);
    }

    /// Sets the gamma ramp one monitor draws with.
    ///
    /// See [`crate::engine::Engine::set_gamma`].
    pub fn set_gamma(&self, display: i64, ramp: &[u16]) {
        self.engine.set_gamma(display, ramp);
    }

    /// Sets the color matrix display `display` draws with in linear light.
    ///
    /// See [`crate::engine::Engine::set_color_matrix`].
    pub fn set_color_matrix(&self, display: i64, matrix: &[f32; 9]) {
        self.engine.set_color_matrix(display, matrix);
    }

    /// Hands one emulated event to the shell's window.
    ///
    /// See [`crate::engine::Engine::inject_input`].
    pub fn inject_input(&self, input: DeskInput) -> bool {
        self.engine.inject_input(input)
    }

    /// Tells the browser what is on one of the desktop's two clipboards.
    ///
    /// See [`crate::engine::Engine::set_clipboard`], including why the browser
    /// is told rather than asked.
    pub fn set_clipboard(&self, clipboard: Clipboard, contents: &Contents) {
        self.engine.set_clipboard(clipboard, contents);
    }

    /// Sets how `app_id`'s pixels encode color, from its committed image
    /// description; `None` is sRGB. Call it before each submit: a change makes
    /// the next frames' buffers import again, in the new color.
    pub fn describe(&mut self, app_id: &str, color: Option<Color>) {
        let known = self.colors.get(app_id).map(|colored| colored.color);
        if known.unwrap_or_default() == color {
            return;
        }
        let generation = match color {
            Some(_) => {
                self.last_color += 1;
                self.last_color
            }
            None => 0,
        };
        self.colors
            .insert(app_id.to_owned(), Colored { color, generation });
        if let Some(surface) = self.surfaces.get(app_id) {
            self.engine.set_surface_color(surface, color.as_ref());
        }
    }

    /// The [`ImportKey`] `buffer` is imported under for `app_id`.
    fn import_key(&self, app_id: &str, buffer: &Submitted) -> ImportKey {
        ImportKey {
            buffer: buffer.key(),
            color: self
                .colors
                .get(app_id)
                .map_or(0, |colored| colored.generation),
        }
    }

    /// Submits a buffer as `app_id`'s window, at the box `at_box` names, read
    /// once `fence` signals (see [`crate::engine::Engine::submit`]). See
    /// [`Submission`] for who owns the buffer afterward.
    #[allow(clippy::too_many_arguments)] // One frame's worth.
    pub fn submit(
        &mut self,
        app_id: &str,
        buffer: Submitted,
        descriptor: &FrameDescriptor,
        sampled: Sampled,
        damage: (i32, i32, i32, i32),
        at_box: u64,
        fence: Option<OwnedFd>,
        now: Instant,
    ) -> Submission {
        let Some(surface) = self.surface_for(app_id) else {
            return Submission::Refused;
        };
        let frame = Frame {
            buffer,
            descriptor: descriptor.clone(),
            sampled,
            at_box,
            fence,
        };
        // The engine drops frames for unembedded surfaces and never releases
        // them (see `engine_surfaces`), so the frame waits for the embed. See
        // `engine_waiting`.
        if !self.surfaces.takes_frames(surface) {
            return Submission::Waiting {
                replaced: self
                    .waiting
                    .wait(surface, frame)
                    .map(|replaced| replaced.buffer),
            };
        }
        match self.put_up(app_id, surface, frame, damage, now) {
            PutUp::Taken { replaced, .. } => Submission::Taken { replaced },
            PutUp::Importing { replaced } => Submission::Waiting { replaced },
            PutUp::Refused(_) => Submission::Refused,
        }
    }

    /// Submits the frame waiting for `surface` after a page embeds it.
    ///
    /// Returns the number the engine reports it by, `Ok(None)` if nothing was
    /// waiting or the frame now waits for its import, and `Err` with the
    /// buffer to release if the engine refused it.
    pub fn show_what_was_waiting(
        &mut self,
        surface: SurfaceId,
        now: Instant,
    ) -> Result<Option<u64>, Release> {
        let Some(frame) = self.waiting.take(surface) else {
            return Ok(None);
        };
        let refused = |buffer| Release {
            buffer,
            surface,
            why: Returned::Abandoned,
        };
        let Some(app_id) = self.surfaces.app_for(surface).map(str::to_owned) else {
            return Err(refused(frame.buffer));
        };
        // A frame waits for an import only on an embedded surface, and this
        // one was not embedded until now, so none is replaced.
        match self.put_up(&app_id, surface, frame, (0, 0, 0, 0), now) {
            PutUp::Taken {
                replaced: None,
                frame,
            } => Ok(Some(frame)),
            PutUp::Importing { replaced: None } => Ok(None),
            PutUp::Taken {
                replaced: Some(_), ..
            }
            | PutUp::Importing { replaced: Some(_) } => {
                unreachable!("a surface embedded just now had a frame waiting for an import")
            }
            PutUp::Refused(frame) => Err(refused(frame.buffer)),
        }
    }

    /// Submits and holds a frame for an embedded surface, or starts importing
    /// its buffer and holds it back until the import finishes.
    ///
    /// An engine without `domicile_surface_import_async` imports while the
    /// caller waits.
    fn put_up(
        &mut self,
        app_id: &str,
        surface: SurfaceId,
        frame: Frame,
        damage: (i32, i32, i32, i32),
        now: Instant,
    ) -> PutUp {
        let key = self.import_key(app_id, &frame.buffer);
        let dmabuf = match (&frame.descriptor, self.imports.knows(surface, &key)) {
            (_, true) => None,
            // Mapping memory is quick, so a window in memory is imported while
            // the caller waits.
            (FrameDescriptor::Shm(shm), false) => match self.engine.import_shm(surface, shm) {
                Some(id) => {
                    self.imports.imported(surface, key.clone(), id);
                    None
                }
                None => {
                    say_it_was_refused(&frame.descriptor);
                    return PutUp::Refused(frame);
                }
            },
            (FrameDescriptor::Dmabuf(descriptor), false) => {
                match Dmabuf::from_descriptor(descriptor) {
                    Some(dmabuf) => Some(dmabuf),
                    None => {
                        tracing::error!(
                            planes = descriptor.planes.len(),
                            "a dmabuf with this many planes cannot cross the engine ABI"
                        );
                        return PutUp::Refused(frame);
                    }
                }
            }
        };
        if let Some(dmabuf) = &dmabuf {
            if !self.engine.imports_in_the_background() {
                match self.engine.import(surface, dmabuf) {
                    Some(id) => self.imports.imported(surface, key.clone(), id),
                    None => {
                        say_it_was_refused(&frame.descriptor);
                        return PutUp::Refused(frame);
                    }
                }
            }
        }
        match self.imports.route(surface, key, frame) {
            Route::Submit {
                id,
                frame,
                replaced,
            } => PutUp::Taken {
                frame: self.show(app_id, surface, id, frame.into_parts(), damage, now),
                replaced: replaced.map(|frame| frame.buffer),
            },
            Route::Wait { replaced, start } => {
                if let Some(request) = start {
                    let dmabuf = dmabuf
                        .as_ref()
                        .expect("an import starts only for a buffer not yet imported");
                    self.engine
                        .import_in_the_background(surface, dmabuf, request);
                }
                PutUp::Importing {
                    replaced: replaced.map(|frame| frame.buffer),
                }
            }
        }
    }

    /// Submits and holds a frame whose buffer is imported as `id`. Returns the
    /// number the engine reports it by.
    fn show(
        &mut self,
        app_id: &str,
        surface: SurfaceId,
        id: BufferId,
        (buffer, mapping, fence): (Submitted, Mapping, Option<OwnedFd>),
        damage: (i32, i32, i32, i32),
        now: Instant,
    ) -> u64 {
        self.engine.submit(
            surface,
            id,
            mapping.sampled,
            damage,
            mapping.at_box,
            fence.as_ref().map(OwnedFd::as_fd),
        );
        self.mapped.insert(app_id.to_owned(), mapping);
        // A replaced hold is the same buffer, since `imports` is keyed on the
        // surface and the object. Drop it without releasing: viz holds it
        // again.
        drop(self.held.hold(surface, id, buffer, now));
        self.surfaces.submitted(surface)
    }

    /// Maps `app_id`'s newest frame anew, for a commit that changed how its
    /// buffer maps but attached none.
    ///
    /// `sample` gives the crop and turn for the frame's buffer, and the frame
    /// fills the box `at_box` names. A frame on screen goes up again with the
    /// whole box damaged. A waiting frame keeps its fence and its place.
    /// Either way the buffer stays held as it was: the client attached it
    /// once and is owed one release.
    pub fn remap(
        &mut self,
        app_id: &str,
        sample: &dyn Fn(&Submitted) -> Option<Sampled>,
        at_box: u64,
        now: Instant,
    ) -> Remapped {
        let Some(surface) = self.surfaces.get(app_id) else {
            return Remapped::Unchanged;
        };
        let waiting = match self.waiting.get_mut(surface) {
            Some(frame) => Some(frame),
            None => self.imports.waiting_mut(surface),
        };
        if let Some(frame) = waiting {
            let Some(sampled) = sample(&frame.buffer) else {
                return Remapped::Unchanged;
            };
            let mapping = Mapping { sampled, at_box };
            if mapping == frame.mapping() {
                return Remapped::Unchanged;
            }
            frame.sampled = sampled;
            frame.at_box = at_box;
            return Remapped::Waiting {
                buffer: frame.buffer.clone(),
            };
        }
        let Some((id, buffer)) = self.held.on_screen(surface) else {
            return Remapped::Unchanged;
        };
        let buffer = buffer.clone();
        let Some(sampled) = sample(&buffer) else {
            return Remapped::Unchanged;
        };
        let mapping = Mapping { sampled, at_box };
        if self.mapped.get(app_id) == Some(&mapping) {
            return Remapped::Unchanged;
        }
        // Held only once embedded, so this frame reaches viz.
        let frame = self.show(
            app_id,
            surface,
            id,
            (buffer.clone(), mapping, None),
            (0, 0, 0, 0),
            now,
        );
        Remapped::Taken { buffer, frame }
    }

    /// Runs the engine's pending work, and puts up the frames whose imports
    /// finished.
    pub fn dispatch(&mut self, now: Instant) -> Dispatched {
        let events = self.engine.dispatch();
        let mut dispatched = Dispatched {
            events: Vec::new(),
            releases: Vec::new(),
            shown: Vec::new(),
        };
        for event in &events {
            match event {
                Event::Released { surface, buffer } => {
                    if self.retired.take(*surface, *buffer) {
                        // Its client destroyed it, so it takes no release.
                        drop(self.held.release(*surface, *buffer));
                        self.engine.forget(*surface, *buffer);
                    } else if let Some(buffer) = self.held.release(*surface, *buffer) {
                        dispatched.releases.push(Release {
                            buffer,
                            surface: *surface,
                            why: Returned::Released,
                        });
                    }
                }
                // A page embedded this surface, so `submit` may now hold
                // buffers for it. See `engine_surfaces`.
                Event::Configure { surface, .. } => self.surfaces.embedded(*surface),
                Event::Imported {
                    request, buffer, ..
                } => self.import_finished(*request, *buffer, now, &mut dispatched),
                Event::Copied { .. }
                | Event::Displays(_)
                | Event::GammaSizes(_)
                | Event::Captured { .. }
                | Event::CaptureEnded { .. }
                | Event::FrameDone { .. }
                | Event::Presented { .. }
                | Event::Disconnected
                | Event::Compositing { .. }
                | Event::BrowserWindows(_)
                | Event::InputDevices(_) => {}
            }
        }
        dispatched.events = events;
        dispatched
    }

    /// Puts up or hands back the frame that waited on `request`.
    fn import_finished(
        &mut self,
        request: Request,
        buffer: Option<BufferId>,
        now: Instant,
        dispatched: &mut Dispatched,
    ) {
        let finished = self.imports.finished(request, buffer);
        if let Some((surface, id)) = finished.forget {
            self.engine.forget(surface, id);
        }
        if let Some(then) = finished.then {
            match then {
                Then::Submit { surface, id, frame } => {
                    let app_id = self
                        .surfaces
                        .app_for(surface)
                        .expect("`window_gone` takes the frames of the surfaces it forgets")
                        .to_owned();
                    let frame =
                        self.show(&app_id, surface, id, frame.into_parts(), (0, 0, 0, 0), now);
                    dispatched.shown.push((app_id, frame));
                }
                Then::Refused { surface, frame } => {
                    say_it_was_refused(&frame.descriptor);
                    dispatched.releases.push(Release {
                        buffer: frame.buffer,
                        surface,
                        why: Returned::Abandoned,
                    });
                }
            }
        }
    }
    /// Buffers viz kept past the deadline, taken back so the client can draw.
    /// Each one is an engine bug, and the caller logs it.
    pub fn overdue(&mut self, now: Instant) -> Vec<Release> {
        let (retired, expired): (Vec<_>, Vec<_>) = self
            .held
            .expired(now)
            .into_iter()
            .partition(|((surface, id), _)| self.retired.take(*surface, *id));
        // Their clients destroyed them, so they take no release.
        for ((surface, id), _) in retired {
            self.engine.forget(surface, id);
        }
        returned(expired, Returned::Expired)
    }

    /// When [`EngineSession::overdue`] next has a buffer to take back.
    pub fn next_overdue(&self) -> Option<Instant> {
        self.held.next_expiry()
    }

    /// Forgets the app's surface, leaving its last frame on screen.
    ///
    /// The surface lingers, with its imports and holds, until
    /// [`EngineSession::linger_over`], so the shell's close animation shows
    /// the window rather than an empty box. Frames that never went up are
    /// released now.
    pub fn window_gone(&mut self, app_id: &str) -> WindowGone {
        self.mapped.remove(app_id);
        self.children.remove(app_id);
        self.colors.remove(app_id);
        let Some(surface) = self.surfaces.forget(app_id) else {
            return WindowGone::default();
        };
        // Taken now so a finished import has no app to show it for.
        let mut gone = self.imports.surface_gone(surface);
        // Most likely the last frame itself, which the close animation shows.
        gone.ids.extend(self.retired.surface_gone(surface));
        let waited = self.waiting.take(surface).into_iter().chain(gone.waited);
        WindowGone {
            releases: waited
                .map(|frame| Release {
                    buffer: frame.buffer,
                    surface,
                    why: Returned::Abandoned,
                })
                .collect(),
            linger: Some(self.lingering.start(surface, gone.ids)),
        }
    }

    /// Destroys a closed window's lingering surface and returns its buffers,
    /// since no release will arrive for them. Nothing if a lost engine already
    /// took it.
    pub fn linger_over(&mut self, linger: Linger) -> Vec<Release> {
        let Some(imports) = self.lingering.over(linger) else {
            return Vec::new();
        };
        let surface = linger.surface;
        // The GPU process keeps each imported buffer's fds until told to
        // forget it. Leaked imports exhaust its fds and crash it on a `CHECK`.
        for buffer in imports {
            self.engine.forget(surface, buffer);
        }
        self.engine.destroy_surface(surface);
        returned(self.held.abandon(surface), Returned::Abandoned)
    }

    /// Drops a destroyed `wl_buffer`'s imports on every surface and returns
    /// its holds and waiting frames, since no release will arrive for them.
    ///
    /// An import still on screen is retired instead (see `engine_retired`).
    pub fn buffer_destroyed(&mut self, buffer: &wl_buffer::WlBuffer) -> Vec<Release> {
        let key = BufferKey::Client(buffer.id());
        let embeds = self.waiting.take_where(|frame| frame.buffer.key() == key);
        let forgotten = self.imports.forget(|import| import.buffer == key);
        let held: Vec<(SurfaceId, Submitted)> = forgotten
            .ids
            .into_iter()
            .filter_map(|(surface, id)| {
                // The frame on screen stays imported and held until viz lets
                // it go, or the window's close animation would be blank.
                if self
                    .held
                    .on_screen(surface)
                    .is_some_and(|(shown, _)| shown == id)
                {
                    self.retired.retire(surface, id);
                    return None;
                }
                self.engine.forget(surface, id);
                self.held
                    .release(surface, id)
                    .map(|buffer| (surface, buffer))
            })
            .collect();
        let waited = embeds
            .into_iter()
            .chain(forgotten.waited)
            .map(|(surface, frame)| (surface, frame.buffer));
        held.into_iter()
            .chain(waited)
            .map(|(surface, buffer)| Release {
                buffer,
                surface,
                why: Returned::Abandoned,
            })
            .collect()
    }

    /// Drops the import for a freed compositor buffer so the browser closes its
    /// fds. [`crate::uploads`] frees only buffers the engine is not holding or
    /// waiting to show.
    pub fn upload_dropped(&mut self, upload: UploadId) {
        let key = BufferKey::Upload(upload);
        let forgotten = self.imports.forget(|import| import.buffer == key);
        assert!(
            forgotten.waited.is_empty(),
            "a freed upload had a frame waiting for its import"
        );
        for (surface, id) in forgotten.ids {
            self.engine.forget(surface, id);
        }
    }

    /// Spike helper. See [`crate::engine::Engine::spike_window_center`].
    pub fn spike_window_center(&self) -> Option<u32> {
        self.engine.spike_window_center()
    }

    /// Spike helper. See [`crate::engine::Engine::spike_pixel`].
    pub fn spike_pixel(&self, x: i32, y: i32) -> Option<u32> {
        self.engine.spike_pixel(x, y)
    }

    /// Spike helper. See [`crate::engine::Engine::spike_find`].
    pub fn spike_find(&self, argb: u32) -> Option<Capture> {
        self.engine.spike_find(argb)
    }

    /// The number of `app_id`'s last submitted frame, which
    /// [`Event::FrameDone`] and [`Event::Presented`] name.
    pub fn frame_of(&self, app_id: &str) -> Option<u64> {
        self.surfaces.last_frame(app_id)
    }

    /// See [`crate::engine::Engine::reports_frames`].
    pub fn reports_frames(&self) -> bool {
        self.engine.reports_frames()
    }

    /// See [`crate::engine::Engine::imports_shm`].
    pub fn imports_shm(&self) -> bool {
        self.engine.imports_shm()
    }

    /// See [`crate::engine::Engine::takes_fences`].
    pub fn takes_fences(&self) -> bool {
        self.engine.takes_fences()
    }

    /// See [`crate::engine::Engine::syncs_frames`].
    pub fn syncs_frames(&self) -> bool {
        self.engine.syncs_frames()
    }

    /// Makes `app_id`'s next submit go up at synced `frame`. See
    /// [`crate::engine::Engine::sync`]. Returns false if the browser refused
    /// the surface.
    pub fn sync(&mut self, app_id: &str, frame: u32) -> bool {
        let Some(surface) = self.surface_for(app_id) else {
            return false;
        };
        self.engine.sync(surface, frame);
        true
    }

    /// Sets `app_id`'s subsurfaces, bottom to top, which its frames draw from
    /// its next one. See [`crate::engine::Engine::set_children`]. Returns
    /// whether they changed: if so and no frame of its own follows, the
    /// caller [`EngineSession::redraw`]s it.
    ///
    /// Each child's surface is brokered now, so the parent's frame can embed
    /// it before it has a frame of its own.
    pub fn set_children(&mut self, app_id: &str, children: Vec<Child>) -> bool {
        if self
            .children
            .get(app_id)
            .map_or(children.is_empty(), |set| *set == children)
        {
            return false;
        }
        for child in &children {
            let _ = self.surface_for(&child.app_id);
        }
        self.children.insert(app_id.to_owned(), children);
        self.send_the_children(app_id);
        true
    }

    /// Shows `app_id`'s last frame again with its subsurfaces as last set.
    /// See [`crate::engine::Engine::redraw`].
    pub fn redraw(&self, app_id: &str) {
        if let Some(surface) = self.surfaces.get(app_id) {
            self.engine.redraw(surface);
        }
    }

    /// Tells the engine `app_id`'s subsurfaces as last set.
    fn send_the_children(&mut self, app_id: &str) {
        let Some(children) = self.children.get(app_id).cloned() else {
            return;
        };
        let Some(surface) = self.surface_for(app_id) else {
            return;
        };
        let children: Vec<Subsurface> = children
            .iter()
            .filter_map(|child| {
                Some(Subsurface {
                    surface: self.surfaces.get(&child.app_id)?,
                    x: child.position.0,
                    y: child.position.1,
                    width: child.size.0,
                    height: child.size.1,
                    above: u8::from(child.above),
                })
            })
            .collect();
        self.engine.set_children(surface, &children);
    }

    /// Which app a surface belongs to, for an event that names only the
    /// surface.
    pub fn app_for(&self, surface: SurfaceId) -> Option<&str> {
        self.surfaces.app_for(surface)
    }

    /// The surface for `app_id`, brokered on first use. `None` if the browser
    /// refused, which is logged.
    fn surface_for(&mut self, app_id: &str) -> Option<SurfaceId> {
        if let Some(surface) = self.surfaces.get(app_id) {
            return Some(surface);
        }
        match self.engine.create_surface(app_id) {
            Ok(surface) => {
                tracing::debug!(%app_id, surface, "the browser brokered a frame sink");
                self.surfaces.brokered(app_id, surface);
                // A surface starts in sRGB, as on a reconnect.
                if let Some(color) = self.colors.get(app_id).and_then(|colored| colored.color) {
                    self.engine.set_surface_color(surface, Some(&color));
                }
                Some(surface)
            }
            Err(err) => {
                tracing::error!(%app_id, %err, "no frame sink for this app; it will not be shown");
                None
            }
        }
    }
}

/// Logs a buffer the browser would not import.
fn say_it_was_refused(descriptor: &FrameDescriptor) {
    match descriptor {
        FrameDescriptor::Dmabuf(dmabuf) => tracing::error!(
            fourcc = dmabuf.fourcc,
            modifier = dmabuf.modifier,
            "the browser refused this dmabuf"
        ),
        FrameDescriptor::Shm(shm) => tracing::error!(
            fourcc = shm.fourcc,
            "the browser refused this window in shared memory; it takes one only while it \
             composites on the CPU"
        ),
    }
}

/// Converts removed holds into releases.
fn returned(holds: Vec<((SurfaceId, BufferId), Submitted)>, why: Returned) -> Vec<Release> {
    holds
        .into_iter()
        .map(|((surface, _), buffer)| Release {
            buffer,
            surface,
            why,
        })
        .collect()
}

/// The engine's display captures, for monitor and region casts. Thin glue
/// over [`crate::engine::Engine`]; the bookkeeping is in
/// [`crate::casting::Capturer`]'s callers.
impl crate::casting::Capturer for EngineSession {
    fn start(
        &mut self,
        display: i64,
        size: (u32, u32),
        max_fps: u32,
    ) -> Result<crate::engine::CaptureId, String> {
        self.engine
            .start_capture(display, size, max_fps)
            .map_err(|why| why.to_string())
    }

    fn start_browser_window(
        &mut self,
        window: &str,
        max_fps: u32,
    ) -> Result<crate::engine::CaptureId, String> {
        self.engine
            .start_browser_window_capture(window, max_fps)
            .map_err(|why| why.to_string())
    }

    fn resize(&mut self, capture: crate::engine::CaptureId, size: (u32, u32)) {
        self.engine.resize_capture(capture, size);
    }

    fn stop(&mut self, capture: crate::engine::CaptureId) {
        self.engine.stop_capture(capture);
    }

    fn release(&mut self, capture: crate::engine::CaptureId, frame: u64) {
        self.engine.release_captured(capture, frame);
    }
}
