//! The Wayland thread's side of casting: routes requests and fills lent
//! buffers with each source's frames.
//!
//! - A cast window's commit is kept as a [`Snapshot`] before the client's
//!   buffer is released, so no client buffer is held for a stream.
//! - A monitor or region is drawn from the engine's display captures (see
//!   [`captures`](crate::casting::captures)). A region across monitors is one
//!   piece per monitor (see [`region`](crate::casting::region)).
//! - A damaged frame fills a lent buffer from what is kept.
//! - Damage that found no buffer is owed. It is filled when a buffer is lent,
//!   so a source that stops drawing still reaches the consumer. A stream's
//!   first frame is owed this way.
//! - Pointer motion damages the pointer's old and new places, for streams
//!   that show the pointer.
//! - A shot of the desk (see [`shots`](crate::casting::shots)) shows every
//!   monitor like a stream, until each has a frame.
//! - A shot of a browser window alone is the first frame of an engine
//!   capture of its page, which then stops.

use std::collections::{HashMap, HashSet};
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use domicile_protocol::{PointerOverWindow, ShotWindow};
use pipewire as pw;
use smithay::backend::allocator::Buffer as _;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::reexports::calloop::channel::Sender;
use smithay::reexports::wayland_server::protocol::wl_buffer::WlBuffer;
use smithay::utils::Transform;
use tracing::debug;

use crate::buffer_transform::{crop_in_buffer, upright_size, Sampled};
use crate::casting::audio::Heard;
use crate::casting::captured::{self, Kept};
use crate::casting::captures::{Capturer, Captures, Frame};
use crate::casting::cursor::{arrow, at_density, embed, plan, CursorMode, Plan, Sprite};
use crate::casting::gpu::{self, FillError, Layer, Snapshot};
use crate::casting::lifecycle::Ended;
use crate::casting::negotiation::{offer, shm_layout, Pixel, MAX_FRAMERATE, PIXELS};
use crate::casting::pacing::{within, Due, Pacing, Rect};
use crate::casting::paint::paint;
use crate::casting::producer::{self, BufferId, StreamFormat, Target, ToPipewire, ToWayland};
use crate::casting::region::{self, damage_in_stream, in_frame, Layout, Screen};
use crate::casting::shots::{
    self, compose, desk_of, monitors, Desk, Developed, DevelopedWindow, Shown,
};
use crate::casting::{Candidate, Consumer, Event, Listener, Region, Request, Source, StreamId};
use crate::engine::{BrowserView, BrowserWindow, CaptureId, CapturedFrame};

/// A window's frame, as its commit brought it.
pub struct Committed<'a> {
    pub app_id: &'a str,
    pub buffer: &'a WlBuffer,
    /// The part of the buffer that is the window, in buffer pixels, and the
    /// turn that makes it upright.
    pub sampled: Sampled,
    /// How many buffer pixels span one of the surface's points across and
    /// down, for the pointer's position.
    pub pixels_a_point: (f64, f64),
    /// The bounding box of the commit's damage, in buffer pixels.
    pub damage: Option<Rect>,
}

/// The GPU the streams' dmabufs are allocated on.
pub struct Gpu {
    /// The render node, for the PipeWire thread's allocator.
    node: PathBuf,
    /// The modifiers the renderer can draw each layout in.
    modifiers: HashMap<Pixel, Vec<u64>>,
}

impl Gpu {
    /// The GPU on `node`, where `modifiers` gives the modifiers the renderer
    /// draws a DRM fourcc in.
    pub fn new(node: PathBuf, modifiers: impl Fn(u32) -> Vec<u64>) -> Self {
        Self {
            node,
            modifiers: PIXELS
                .iter()
                .map(|&pixel| (pixel, modifiers(producer::fourcc(pixel))))
                .collect(),
        }
    }
}

/// Every stream, on the Wayland thread.
pub struct Streams {
    news: Sender<ToWayland>,
    /// Requests for the casts Wayland capture clients take, which
    /// [`crate::screencopy`] answers in PipeWire's place.
    to_clients: Sender<ToPipewire>,
    /// The casts Wayland capture clients take.
    clients: HashSet<StreamId>,
    gpu: Option<Gpu>,
    /// Started on the first cast, so a desktop that never casts runs no
    /// PipeWire thread.
    to_pipewire: Option<pw::channel::Sender<ToPipewire>>,
    casts: HashMap<StreamId, Cast>,
    /// Each window's last frame size, offered when a stream starts.
    sizes: HashMap<String, (u32, u32)>,
    /// How many buffer pixels span each window's surface point, for the
    /// pointer over it.
    densities: HashMap<String, (f64, f64)>,
    /// Each cast window's last frame.
    shots: HashMap<String, Shot>,
    /// Each window's last frame the engine shows, for a shot of it alone.
    shown: HashMap<String, Shown>,
    /// The window under the pointer, and where, in its box's logical pixels.
    pointer: Option<(String, (f64, f64))>,
    /// Where the engine reports the pointer.
    engine_pointer: EnginePointer,
    /// The monitors, for monitor and region streams.
    screens: Vec<Screen>,
    captures: Captures,
    /// Shots waiting for their monitors' frames.
    shooting: Vec<Shooting>,
    /// Shots of one browser window alone, waiting for their captures' first
    /// frames.
    browser_shots: Vec<BrowserShot>,
    /// The views each browser window holds and shows, bottom first, by its
    /// id.
    views: HashMap<String, Vec<BrowserView>>,
    /// The pages browser window streams show, by their capture.
    pages: HashMap<CaptureId, Page>,
    sprite: Sprite,
}

/// A shot of one browser window alone: its page, with the views it holds
/// drawn over it.
struct BrowserShot {
    /// The window's page first, then each view, bottom first.
    parts: Vec<ShotPart>,
    developed: DevelopedWindow,
}

/// A page a [`BrowserShot`] draws, from its capture's first frame.
struct ShotPart {
    capture: CaptureId,
    /// Where a view is in the window's page, in its CSS pixels; `None` for
    /// the window's own page.
    place: Option<Rect>,
    /// Its first frame, once read.
    shot: Option<domicile_host::screenshot::Shot>,
}

/// A shot of the desk, waiting for a frame of every monitor.
struct Shooting {
    stream: StreamId,
    /// The desk, in logical pixels.
    desk: Rect,
    layout: Layout,
    windows: Vec<ShotWindow>,
    /// Each monitor's make and model, by name.
    descriptions: HashMap<String, String>,
    developed: Developed,
}

/// A window's last frame and how to read it.
struct Shot {
    snapshot: Snapshot,
    sampled: Sampled,
    pixels_a_point: (f64, f64),
}

/// What one stream shows.
enum Shows {
    Window(String),
    /// A browser window's page alone, from this engine capture, which the
    /// stream owns.
    BrowserWindow(CaptureId),
    /// A rectangle of the desktop: a monitor, followed by name, or a region.
    Desk {
        monitor: Option<String>,
        target: Rect,
        /// The most pixels its frames have; see [`region::layout`].
        most_pixels: Option<u64>,
        layout: Layout,
    },
}

/// Where the engine reports the pointer.
#[derive(Clone, Debug, Default, PartialEq)]
struct EnginePointer {
    /// On the desktop, in logical pixels, or `None` off it.
    desk: Option<(f64, f64)>,
    /// Over each browser window's page, by id, as a fraction of the page.
    pages: HashMap<String, (f64, f64)>,
}

/// A browser window's page, as its capture last drew it.
#[derive(Default)]
struct Page {
    /// The browser window's id.
    window: String,
    frame: Option<Frame>,
    /// The engine's frame `frame` samples, if it is sampled in place.
    held: Option<u64>,
    /// The views the window holds and shows, bottom first, each from a
    /// capture of its own, drawn over the page.
    views: Vec<PageView>,
}

/// A view a cast browser window holds, as its capture last drew it.
struct PageView {
    /// The view's id.
    id: String,
    capture: CaptureId,
    /// Where the app placed it in the window's page, in its CSS pixels.
    place: Rect,
    frame: Option<Frame>,
    /// The engine's frame `frame` samples, if it is sampled in place.
    held: Option<u64>,
}

impl PageView {
    /// `view`, captured by `capture`, before its first frame.
    fn of(view: &BrowserView, capture: CaptureId) -> Self {
        Self {
            id: view.id.clone(),
            capture,
            place: (view.x, view.y, view.width, view.height),
            frame: None,
            held: None,
        }
    }
}

/// One stream.
struct Cast {
    shows: Shows,
    cursor: CursorMode,
    format: Option<StreamFormat>,
    pacing: Option<Pacing<BufferId>>,
    targets: HashMap<BufferId, Target>,
    filling: bool,
    /// The size last asked of PipeWire, so a resize is asked once.
    asked: (u32, u32),
    /// The part of a window shown, in its frame's pixels, or `None` for all
    /// of it.
    part: Option<Rect>,
    /// Its [`ToPipewire::Start`], held until its source's size is known: a
    /// browser window's page has none until it draws.
    unstarted: Option<ToPipewire>,
}

/// The pointer over a source.
#[derive(Clone, Debug, PartialEq)]
pub struct Over {
    /// In the source's pixels.
    pub at: (f64, f64),
    /// At the source's density.
    pub sprite: Sprite,
}

/// What a stream's next frame is made of.
struct View<'a> {
    size: (u32, u32),
    layers: Vec<Layer<'a>>,
    /// The pointer, in stream pixels, or `None` off the source.
    pointer: Option<(f64, f64)>,
}

/// What one stream does with a frame.
enum Outcome {
    Nothing,
    Send(ToPipewire),
    Starved,
    Resize((u32, u32)),
    Failed(FillError),
}

impl Streams {
    /// Streams whose news arrives through `news`, and whose clients' casts
    /// are asked through `to_clients`. `gpu` is `None` without a renderer and
    /// allocator, and streams then offer shm only.
    pub fn new(news: Sender<ToWayland>, to_clients: Sender<ToPipewire>, gpu: Option<Gpu>) -> Self {
        Self {
            news,
            to_clients,
            clients: HashSet::new(),
            gpu,
            to_pipewire: None,
            casts: HashMap::new(),
            sizes: HashMap::new(),
            densities: HashMap::new(),
            shots: HashMap::new(),
            shown: HashMap::new(),
            pointer: None,
            engine_pointer: EnginePointer::default(),
            screens: Vec::new(),
            captures: Captures::default(),
            shooting: Vec::new(),
            browser_shots: Vec::new(),
            views: HashMap::new(),
            pages: HashMap::new(),
            sprite: arrow(),
        }
    }

    /// Handles a caller's request. `open` lists the windows that can be cast
    /// now, which a shot also names; `capturer` is the engine, if one is
    /// connected.
    pub fn request(
        &mut self,
        request: Request,
        open: impl FnOnce() -> Vec<Candidate>,
        renderer: Option<&mut GlesRenderer>,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        match request {
            Request::Start {
                stream,
                source,
                part,
                most_pixels,
                cursor,
                consumer,
                listener,
            } => {
                if consumer == Consumer::Client {
                    self.clients.insert(stream);
                }
                let open = open();
                let window = |app_id: &str| {
                    open.iter().find(
                        |candidate| matches!(&candidate.source, Source::Window(id) if id == app_id),
                    )
                };
                let process = match &source {
                    Source::Window(app_id) => window(app_id).and_then(|window| window.process),
                    _ => None,
                };
                self.start(
                    stream,
                    source,
                    part,
                    most_pixels,
                    cursor,
                    listener,
                    process,
                    |app_id| window(app_id).is_some(),
                    capturer,
                );
            }
            Request::List { reply } => reply.send(open()),
            Request::Shoot { stream, developed } => {
                let desk = desk_of(&self.screens).ok_or_else(|| "no monitor is plugged in".into());
                self.shoot(stream, desk, open(), developed, renderer, capturer);
            }
            Request::ShootBrowserWindow { id, developed } => {
                self.shoot_browser_window(&id, developed, capturer);
            }
            Request::ShootWindow { app_id, developed } => developed(
                self.shown
                    .get(&app_id)
                    .ok_or_else(|| format!("window {app_id} has shown no frame"))
                    .and_then(|shown| shots::window(shown, renderer)),
            ),
            Request::Stop { stream } => {
                if self.casts.contains_key(&stream) {
                    self.send(ToPipewire::End {
                        stream,
                        why: Ended::Stopped,
                    });
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        &mut self,
        stream: StreamId,
        source: Source,
        part: Option<Rect>,
        most_pixels: Option<u64>,
        cursor: CursorMode,
        mut listener: Listener,
        process: Option<u32>,
        window_open: impl Fn(&str) -> bool,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        let shows = match self.shows(stream, source, most_pixels, window_open, capturer) {
            Ok(shows) => shows,
            Err(why) if self.clients.contains(&stream) => {
                self.send(ToPipewire::End { stream, why });
                return;
            }
            Err(why) => {
                listener(Event::Ended(why));
                return;
            }
        };
        let heard = heard(&shows, process, self.clients.contains(&stream));
        let size = match (&shows, part) {
            // Asks again with the first frame if the window is now smaller.
            (Shows::Window(_) | Shows::BrowserWindow(_), Some((_, _, width, height))) => {
                (width.max(1) as u32, height.max(1) as u32)
            }
            // A window that has not drawn is offered at one pixel, and asks
            // again with its first frame.
            (Shows::Window(app_id), None) => self.sizes.get(app_id).copied().unwrap_or((1, 1)),
            // Offered once its page draws, at its size; see `page_drawn`.
            (Shows::BrowserWindow(_), None) => (1, 1),
            (Shows::Desk { layout, .. }, _) => layout.size,
        };
        let offered = offer(|pixel| {
            self.gpu
                .as_ref()
                .and_then(|gpu| gpu.modifiers.get(&pixel).cloned())
                .unwrap_or_default()
        });
        let waits = matches!((&shows, part), (Shows::BrowserWindow(_), None));
        let start = ToPipewire::Start {
            stream,
            offered,
            size,
            cursor,
            heard,
            listener,
        };
        let unstarted = if waits {
            Some(start)
        } else {
            self.send(start);
            None
        };
        self.casts.insert(
            stream,
            Cast {
                shows,
                cursor,
                format: None,
                pacing: None,
                targets: HashMap::new(),
                filling: false,
                asked: size,
                part,
                unstarted,
            },
        );
    }

    /// What `stream` shows of `source`, with any capture it draws from
    /// running, or why it cannot.
    fn shows(
        &mut self,
        stream: StreamId,
        source: Source,
        most_pixels: Option<u64>,
        window_open: impl Fn(&str) -> bool,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) -> Result<Shows, Ended> {
        match source {
            Source::Window(app_id) if window_open(&app_id) => Ok(Shows::Window(app_id)),
            Source::Window(_) => {
                debug!(?stream, "a cast of a window that is not open");
                Err(Ended::SourceGone)
            }
            Source::BrowserWindow(id) => {
                let capturer = capturer.ok_or_else(|| {
                    Ended::Failed("no engine is connected to capture the browser window".into())
                })?;
                let capture = capturer
                    .start_browser_window(&id, MAX_FRAMERATE)
                    .map_err(Ended::Failed)?;
                let mut views = Vec::new();
                for view in self.views.get(&id).into_iter().flatten() {
                    match capturer.start_browser_window(&view.id, MAX_FRAMERATE) {
                        Ok(started) => views.push(PageView::of(view, started)),
                        Err(why) => {
                            for started in views.iter().map(|view| view.capture) {
                                capturer.stop(started);
                            }
                            capturer.stop(capture);
                            return Err(Ended::Failed(why));
                        }
                    }
                }
                self.pages.insert(
                    capture,
                    Page {
                        window: id,
                        views,
                        ..Page::default()
                    },
                );
                Ok(Shows::BrowserWindow(capture))
            }
            Source::Monitor(name) => {
                let Some(target) = self.monitor(&name) else {
                    debug!(?stream, %name, "a cast of a monitor that is not plugged in");
                    return Err(Ended::SourceGone);
                };
                self.desk(stream, Some(name), target, most_pixels, capturer)
                    .map_err(Ended::Failed)
            }
            Source::Region(region) => {
                let target = (
                    region.position.0,
                    region.position.1,
                    region.size.0,
                    region.size.1,
                );
                self.desk(stream, None, target, most_pixels, capturer)
                    .map_err(Ended::Failed)
            }
        }
    }

    /// Takes a shot of `desk`, a rectangle of the desktop, under `stream`,
    /// naming the windows among `open` in it. `developed` hears it once every
    /// monitor it touches has a frame, or why it failed.
    fn shoot(
        &mut self,
        stream: StreamId,
        desk: Result<Rect, String>,
        open: Vec<Candidate>,
        developed: Developed,
        renderer: Option<&mut GlesRenderer>,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        let Some(capturer) = capturer else {
            developed(Err("no engine is connected to capture the desktop".into()));
            return;
        };
        match desk.and_then(|desk| self.frame_the_desk(stream, desk, capturer)) {
            Ok((desk, layout)) => {
                let (windows, descriptions) = named(open);
                self.shooting.push(Shooting {
                    stream,
                    desk,
                    layout,
                    windows,
                    descriptions,
                    developed,
                });
                self.develop(renderer, capturer);
            }
            Err(why) => developed(Err(why)),
        }
    }

    /// The browser windows the engine lists, for the views each holds. A
    /// cast window's views follow: a view it no longer holds stops being
    /// captured, and one it now holds starts.
    pub fn browser_windows(
        &mut self,
        windows: &[BrowserWindow],
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        self.views = windows
            .iter()
            .map(|window| (window.id.clone(), window.views.clone()))
            .collect();
        let Some(capturer) = capturer else {
            return;
        };
        for page in self.pages.values_mut() {
            let held = self.views.get(&page.window).map_or(&[][..], Vec::as_slice);
            let mut before = std::mem::take(&mut page.views);
            for view in held {
                match before.iter().position(|kept| kept.id == view.id) {
                    Some(at) => {
                        let mut kept = before.remove(at);
                        kept.place = (view.x, view.y, view.width, view.height);
                        page.views.push(kept);
                    }
                    None => match capturer.start_browser_window(&view.id, MAX_FRAMERATE) {
                        Ok(started) => page.views.push(PageView::of(view, started)),
                        // The view closed since the list was sent; the next
                        // list drops it.
                        Err(why) => {
                            tracing::error!(%why, view = %view.id, "a cast window's view could not be captured")
                        }
                    },
                }
            }
            // Stopping releases the frame each holds.
            for gone in before {
                capturer.stop(gone.capture);
            }
        }
    }

    /// Takes a shot of browser window `id` alone, from a capture of its page
    /// and one of each view it holds, drawn over the page where its app
    /// placed it. `developed` hears it once every capture has a first frame,
    /// or why one failed.
    fn shoot_browser_window(
        &mut self,
        id: &str,
        developed: DevelopedWindow,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        let Some(capturer) = capturer else {
            developed(Err(
                "no engine is connected to capture the browser window".into()
            ));
            return;
        };
        let pages = std::iter::once((id, None)).chain(
            self.views.get(id).into_iter().flatten().map(|view| {
                (
                    view.id.as_str(),
                    Some((view.x, view.y, view.width, view.height)),
                )
            }),
        );
        let mut parts = Vec::new();
        for (page, place) in pages {
            match capturer.start_browser_window(page, MAX_FRAMERATE) {
                Ok(capture) => parts.push(ShotPart {
                    capture,
                    place,
                    shot: None,
                }),
                Err(why) => {
                    for part in parts {
                        capturer.stop(part.capture);
                    }
                    developed(Err(why));
                    return;
                }
            }
        }
        self.browser_shots.push(BrowserShot { parts, developed });
    }

    /// The browser window shot waiting for a first frame from `capture`.
    fn shooting_browser_window(&self, capture: CaptureId) -> Option<usize> {
        self.browser_shots.iter().position(|shot| {
            shot.parts
                .iter()
                .any(|part| part.capture == capture && part.shot.is_none())
        })
    }

    /// Keeps `captured` as the first frame of `capture`, a part of browser
    /// window shot `at`, and stops the capture. Hears the shot once every
    /// part has a frame, or as soon as one fails.
    fn shot_part_drawn(
        &mut self,
        at: usize,
        capture: CaptureId,
        captured: Result<CapturedFrame, String>,
        renderer: Option<&mut GlesRenderer>,
        capturer: &mut (dyn Capturer + 'static),
    ) {
        let read = captured
            .map_err(|why| why.to_string())
            .and_then(|frame| shots::browser_window(&frame, renderer));
        // Stopping releases the frame, so only once it is read.
        capturer.stop(capture);
        match read {
            Ok(shot) => {
                let browser_shot = &mut self.browser_shots[at];
                for part in &mut browser_shot.parts {
                    if part.capture == capture && part.shot.is_none() {
                        part.shot = Some(shot);
                        break;
                    }
                }
                if browser_shot.parts.iter().all(|part| part.shot.is_some()) {
                    let browser_shot = self.browser_shots.remove(at);
                    (browser_shot.developed)(Ok(drawn(browser_shot.parts)));
                }
            }
            Err(why) => self.shot_failed(at, capture, why, Some(capturer)),
        }
    }

    /// Browser window shot `at` failed on `capture`: its other captures
    /// still waiting stop, and it hears `why`.
    fn shot_failed(
        &mut self,
        at: usize,
        capture: CaptureId,
        why: String,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        let browser_shot = self.browser_shots.remove(at);
        if let Some(capturer) = capturer {
            for part in &browser_shot.parts {
                if part.capture != capture && part.shot.is_none() {
                    capturer.stop(part.capture);
                }
            }
        }
        (browser_shot.developed)(Err(why));
    }

    /// `desk` and its layout, with the captures a shot of it draws from
    /// running under `stream`.
    fn frame_the_desk(
        &mut self,
        stream: StreamId,
        desk: Rect,
        capturer: &mut (dyn Capturer + 'static),
    ) -> Result<(Rect, Layout), String> {
        let layout = region::layout(desk, &self.screens, None).map_err(|why| why.to_string())?;
        self.captures.show(
            stream,
            &self.capture_sizes(&layout),
            MAX_FRAMERATE,
            capturer,
        )?;
        Ok((desk, layout))
    }

    /// Finishes each shot whose monitors all have a frame, and lets its
    /// captures go.
    fn develop(
        &mut self,
        mut renderer: Option<&mut GlesRenderer>,
        capturer: &mut (dyn Capturer + 'static),
    ) {
        let mut index = 0;
        while index < self.shooting.len() {
            let shooting = &self.shooting[index];
            let shows = Shows::Desk {
                monitor: None,
                target: shooting.desk,
                most_pixels: None,
                layout: shooting.layout.clone(),
            };
            let composed = view(
                &shows,
                &self.shots,
                &self.captures,
                &self.pages,
                &self.screens,
                None,
                &EnginePointer::default(),
            )
            .map(|view| compose(view.size, &view.layers, renderer.as_deref_mut()));
            let Some(composed) = composed else {
                index += 1;
                continue;
            };
            let shooting = self.shooting.remove(index);
            self.captures.forget(shooting.stream, capturer);
            let scale = f64::from(shooting.layout.size.0) / f64::from(shooting.desk.2);
            let monitors = monitors(shooting.desk, scale, &self.screens, |name| {
                shooting.descriptions.get(name).cloned()
            });
            let windows = shooting.windows;
            (shooting.developed)(
                composed
                    .map(|shot| Desk {
                        shot,
                        monitors,
                        windows,
                        place: shooting.desk,
                    })
                    .map_err(|why| why.to_string()),
            );
        }
    }

    /// Ends `stream`, a stream or a shot, from this side.
    fn end_or_fail(
        &mut self,
        stream: StreamId,
        why: String,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        match self
            .shooting
            .iter()
            .position(|shooting| shooting.stream == stream)
        {
            Some(index) => {
                let shooting = self.shooting.remove(index);
                if let Some(capturer) = capturer {
                    self.captures.forget(stream, capturer);
                }
                (shooting.developed)(Err(why));
            }
            None => self.end(stream, Ended::Failed(why), capturer),
        }
    }

    /// The desktop rectangle of `region` of monitor `name`, in logical
    /// pixels from its corner, cut at the monitor's edges.
    pub fn monitor_region(&self, name: &str, region: Region) -> Result<Region, String> {
        let monitor = self
            .monitor(name)
            .ok_or_else(|| format!("monitor {name} is not plugged in"))?;
        let Region { position, size } = region;
        let (x, y, width, height) = region::intersection(
            (
                monitor.0 + position.0,
                monitor.1 + position.1,
                size.0,
                size.1,
            ),
            monitor,
        )
        .ok_or_else(|| format!("the region is off monitor {name}"))?;
        Ok(Region {
            position: (x, y),
            size: (width, height),
        })
    }

    /// The desktop rectangle of the monitor named `name`.
    fn monitor(&self, name: &str) -> Option<Rect> {
        self.screens
            .iter()
            .find(|screen| screen.name == name)
            .map(|screen| screen.desk)
    }

    /// What `stream` shows of `target`, with the captures it draws from
    /// running.
    fn desk(
        &mut self,
        stream: StreamId,
        monitor: Option<String>,
        target: Rect,
        most_pixels: Option<u64>,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) -> Result<Shows, String> {
        let layout =
            region::layout(target, &self.screens, most_pixels).map_err(|why| why.to_string())?;
        let capturer = capturer.ok_or("no engine is connected to capture the desktop")?;
        self.captures.show(
            stream,
            &self.capture_sizes(&layout),
            MAX_FRAMERATE,
            capturer,
        )?;
        Ok(Shows::Desk {
            monitor,
            target,
            most_pixels,
            layout,
        })
    }

    /// Each display `layout` draws from, at its mode size.
    fn capture_sizes(&self, layout: &Layout) -> Vec<(i64, (u32, u32))> {
        layout
            .pieces
            .iter()
            .filter_map(|piece| {
                let screen = self
                    .screens
                    .iter()
                    .find(|screen| screen.display == piece.display)?;
                Some((piece.display, capture_size(screen)))
            })
            .collect()
    }

    /// The monitors changed. Monitor and region streams follow: a gone
    /// monitor ends its streams, and a new size is negotiated again.
    pub fn screens(
        &mut self,
        screens: Vec<Screen>,
        mut capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        self.screens = screens;
        let desk: Vec<StreamId> = self
            .casts
            .iter()
            .filter(|(_, cast)| matches!(cast.shows, Shows::Desk { .. }))
            .map(|(&stream, _)| stream)
            .collect();
        for stream in desk {
            let Some(Shows::Desk {
                monitor,
                target,
                most_pixels,
                ..
            }) = self.casts.get(&stream).map(|cast| &cast.shows)
            else {
                continue;
            };
            let (monitor, target, most_pixels) = (monitor.clone(), *target, *most_pixels);
            let target = match &monitor {
                Some(name) => match self.monitor(name) {
                    Some(target) => target,
                    None => {
                        self.end(stream, Ended::SourceGone, capturer.as_deref_mut());
                        continue;
                    }
                },
                None => target,
            };
            match self.desk(
                stream,
                monitor,
                target,
                most_pixels,
                capturer.as_deref_mut(),
            ) {
                Ok(shows) => {
                    let cast = self.casts.get_mut(&stream).expect("listed above");
                    cast.shows = shows;
                    if let Some(pacing) = cast.pacing.as_mut() {
                        let (width, height) = cast.asked;
                        pacing.damaged(&[(0, 0, width as i32, height as i32)]);
                    }
                }
                Err(why) => self.end(stream, Ended::Failed(why), capturer.as_deref_mut()),
            }
        }
    }

    /// Ends `stream` from this side.
    fn end(
        &mut self,
        stream: StreamId,
        why: Ended,
        capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        if let Some(capturer) = capturer {
            self.captures.forget(stream, capturer);
        }
        self.send(ToPipewire::End { stream, why });
    }

    /// Handles news from the PipeWire thread. Returns when to call
    /// [`Streams::tick`], if a filled frame waits.
    pub fn news(
        &mut self,
        news: ToWayland,
        renderer: Option<&mut GlesRenderer>,
        capturer: Option<&mut (dyn Capturer + 'static)>,
        now: Instant,
    ) -> Option<Instant> {
        match news {
            ToWayland::Format {
                stream,
                format,
                framerate,
            } => {
                if let Some(cast) = self.casts.get_mut(&stream) {
                    let mut pacing = Pacing::new(framerate);
                    // The consumer has no frame yet: the first is owed.
                    pacing.damaged(&[(0, 0, format.size.0 as i32, format.size.1 as i32)]);
                    cast.format = Some(format);
                    cast.pacing = Some(pacing);
                    cast.targets.clear();
                }
            }
            ToWayland::Added {
                stream,
                buffer,
                target,
            } => {
                if let Some(cast) = self.casts.get_mut(&stream) {
                    cast.targets.insert(buffer, target);
                }
            }
            ToWayland::Removed { stream, buffer } => {
                if let Some(cast) = self.casts.get_mut(&stream) {
                    cast.targets.remove(&buffer);
                    // PipeWire removes buffers all at once, to make new ones.
                    if let Some(pacing) = cast.pacing.as_mut() {
                        pacing.forget_buffers();
                    }
                }
            }
            ToWayland::Lent { stream, buffer } => {
                if let Some(pacing) = self.casts.get_mut(&stream).and_then(|c| c.pacing.as_mut()) {
                    pacing.lent(buffer);
                }
                // Fill what is owed, if anything.
                self.offer(stream, Vec::new(), renderer, now);
            }
            ToWayland::Wanted { stream } => {
                let format = self.casts.get(&stream).and_then(|cast| cast.format);
                if let Some(StreamFormat { size, .. }) = format {
                    let whole = (0, 0, size.0 as i32, size.1 as i32);
                    self.offer(stream, vec![whole], renderer, now);
                }
            }
            ToWayland::Filling { stream, on } => {
                if let Some(cast) = self.casts.get_mut(&stream) {
                    cast.filling = on;
                }
            }
            ToWayland::Ended { stream } => {
                self.clients.remove(&stream);
                match self.casts.remove(&stream).map(|cast| cast.shows) {
                    Some(Shows::Window(app_id)) => {
                        let shown = self.casts.values().any(
                            |other| matches!(&other.shows, Shows::Window(id) if *id == app_id),
                        );
                        if !shown {
                            self.shots.remove(&app_id);
                        }
                    }
                    Some(Shows::Desk { .. }) => {
                        if let Some(capturer) = capturer {
                            self.captures.forget(stream, capturer);
                        }
                    }
                    // Stopping releases the frame it holds. A capture the
                    // engine ended is gone already.
                    Some(Shows::BrowserWindow(capture)) => {
                        if let (Some(page), Some(capturer)) =
                            (self.pages.remove(&capture), capturer)
                        {
                            capturer.stop(capture);
                            for view in page.views {
                                capturer.stop(view.capture);
                            }
                        }
                    }
                    None => {}
                }
            }
        }
        self.next_due()
    }

    /// A window committed a frame. Fills its streams' buffers and sends the
    /// ones that are due. Returns when to call [`Streams::tick`], if a filled
    /// frame waits.
    pub fn committed(
        &mut self,
        frame: Committed,
        mut renderer: Option<&mut GlesRenderer>,
        now: Instant,
    ) -> Option<Instant> {
        self.sizes
            .insert(frame.app_id.to_string(), frame.sampled.upright_size());
        self.densities
            .insert(frame.app_id.to_string(), frame.pixels_a_point);
        let streams: Vec<_> = self
            .casts
            .iter()
            .filter(|(_, cast)| matches!(&cast.shows, Shows::Window(id) if id == frame.app_id))
            .map(|(&stream, _)| stream)
            .collect();
        if streams.is_empty() {
            return self.next_due();
        }
        match gpu::snapshot(frame.buffer, renderer.as_deref_mut()) {
            Ok(snapshot) => {
                self.shots.insert(
                    frame.app_id.to_string(),
                    Shot {
                        snapshot,
                        sampled: frame.sampled,
                        pixels_a_point: frame.pixels_a_point,
                    },
                );
            }
            Err(why) => {
                for stream in streams {
                    self.fail(stream, &why);
                }
                return self.next_due();
            }
        }
        let damage = damage_in_view(frame.damage, frame.sampled);
        for stream in streams {
            self.offer(stream, damage.clone(), renderer.as_deref_mut(), now);
        }
        self.next_due()
    }

    /// The engine captured a frame of a display. Keeps it and fills the
    /// buffers of the streams that show that display. Returns when to call
    /// [`Streams::tick`], if a filled frame waits.
    pub fn captured(
        &mut self,
        capture: CaptureId,
        id: u64,
        captured: Result<CapturedFrame, String>,
        mut renderer: Option<&mut GlesRenderer>,
        capturer: &mut (dyn Capturer + 'static),
        now: Instant,
    ) -> Option<Instant> {
        if let Some(at) = self.shooting_browser_window(capture) {
            self.shot_part_drawn(at, capture, captured, renderer, capturer);
            return self.next_due();
        }
        if self.pages.contains_key(&capture) {
            self.page_drawn(capture, id, captured, renderer, capturer, now);
            return self.next_due();
        }
        if let Some(page) = self.page_holding(capture) {
            self.view_drawn(page, capture, id, captured, renderer, capturer, now);
            return self.next_due();
        }
        let Some(display) = self.captures.display_of(capture) else {
            capturer.release(capture, id);
            return self.next_due();
        };
        let kept = captured.map_err(|why| why.to_string()).and_then(|frame| {
            let (snapshot, kept) = captured::snapshot(&frame, renderer.as_deref_mut())
                .map_err(|why| why.to_string())?;
            Ok((frame, snapshot, kept))
        });
        let (frame, snapshot, kept) = match kept {
            Ok(kept) => kept,
            Err(why) => {
                capturer.release(capture, id);
                let engine_display = display;
                tracing::error!(%why, engine_display, "a captured frame could not be kept");
                for stream in self.captures.streams_of(display) {
                    self.end_or_fail(stream, why.clone(), Some(&mut *capturer));
                }
                return self.next_due();
            }
        };
        let content = frame.content;
        let damage = frame.damage.unwrap_or(content);
        self.captures
            .keep(capture, id, Frame { snapshot, content }, kept, capturer);
        self.develop(renderer.as_deref_mut(), capturer);
        let Some(logical) = self
            .screens
            .iter()
            .find(|screen| screen.display == display)
            .map(|screen| (screen.desk.2, screen.desk.3))
        else {
            return self.next_due();
        };
        for stream in self.captures.streams_of(display) {
            let Some(Shows::Desk { layout, .. }) = self.casts.get(&stream).map(|cast| &cast.shows)
            else {
                continue;
            };
            let damage: Vec<Rect> = layout
                .pieces
                .iter()
                .filter(|piece| piece.display == display)
                .filter_map(|piece| damage_in_stream(piece, logical, content, damage))
                .collect();
            if !damage.is_empty() {
                self.offer(stream, damage, renderer.as_deref_mut(), now);
            }
        }
        self.next_due()
    }

    /// The stream that shows browser window capture `capture`, if one does.
    fn page_cast(&self, capture: CaptureId) -> Option<StreamId> {
        self.casts
            .iter()
            .find_map(|(&stream, cast)| match &cast.shows {
                Shows::BrowserWindow(shown) if *shown == capture => Some(stream),
                _ => None,
            })
    }

    /// The page of a stream showing a view `capture` captures.
    fn page_holding(&self, capture: CaptureId) -> Option<CaptureId> {
        self.pages.iter().find_map(|(&page, shown)| {
            shown
                .views
                .iter()
                .any(|view| view.capture == capture)
                .then_some(page)
        })
    }

    /// Keeps frame `id` of `capture`, a view over `page`, gives back the
    /// buffer the engine no longer needs to hold, and fills the page's stream.
    #[allow(clippy::too_many_arguments)] // page_drawn's, and the page.
    fn view_drawn(
        &mut self,
        page: CaptureId,
        capture: CaptureId,
        id: u64,
        captured: Result<CapturedFrame, String>,
        mut renderer: Option<&mut GlesRenderer>,
        capturer: &mut (dyn Capturer + 'static),
        now: Instant,
    ) {
        let stream = self
            .page_cast(page)
            .expect("a page lives as long as its stream");
        let kept = captured.map_err(|why| why.to_string()).and_then(|frame| {
            let (snapshot, kept) = captured::snapshot(&frame, renderer.as_deref_mut())
                .map_err(|why| why.to_string())?;
            Ok((frame, snapshot, kept))
        });
        let (frame, snapshot, kept) = match kept {
            Ok(kept) => kept,
            Err(why) => {
                capturer.release(capture, id);
                tracing::error!(%why, "a browser window view's captured frame could not be kept");
                self.end(stream, Ended::Failed(why), Some(capturer));
                return;
            }
        };
        let shown = self.pages.get_mut(&page).expect("found above");
        let view = shown
            .views
            .iter_mut()
            .find(|view| view.capture == capture)
            .expect("found above");
        view.frame = Some(Frame {
            snapshot,
            content: frame.content,
        });
        let held = match kept {
            Kept::Copied => {
                capturer.release(capture, id);
                None
            }
            Kept::Sampled => Some(id),
        };
        if let Some(before) = std::mem::replace(&mut view.held, held) {
            capturer.release(capture, before);
        }
        let Some(size) = shown.frame.as_ref().map(|frame| page_size(frame.content)) else {
            return;
        };
        self.offer(
            stream,
            vec![(0, 0, size.0 as i32, size.1 as i32)],
            renderer,
            now,
        );
    }

    /// Keeps frame `id` of `capture`, a page a stream shows, gives back the
    /// buffer the engine no longer needs to hold, and fills the stream.
    fn page_drawn(
        &mut self,
        capture: CaptureId,
        id: u64,
        captured: Result<CapturedFrame, String>,
        mut renderer: Option<&mut GlesRenderer>,
        capturer: &mut (dyn Capturer + 'static),
        now: Instant,
    ) {
        let stream = self
            .page_cast(capture)
            .expect("a page lives as long as its stream");
        let page = self.pages.get_mut(&capture).expect("checked by the caller");
        let kept = captured.map_err(|why| why.to_string()).and_then(|frame| {
            let (snapshot, kept) = captured::snapshot(&frame, renderer.as_deref_mut())
                .map_err(|why| why.to_string())?;
            Ok((frame, snapshot, kept))
        });
        let (frame, snapshot, kept) = match kept {
            Ok(kept) => kept,
            Err(why) => {
                capturer.release(capture, id);
                tracing::error!(%why, "a browser window's captured frame could not be kept");
                self.end(stream, Ended::Failed(why), Some(capturer));
                return;
            }
        };
        let content = frame.content;
        let damage = within(frame.damage.unwrap_or(content), content);
        page.frame = Some(Frame { snapshot, content });
        let cast = self.casts.get_mut(&stream).expect("found above");
        if let Some(ToPipewire::Start {
            stream,
            offered,
            cursor,
            heard,
            listener,
            ..
        }) = cast.unstarted.take()
        {
            let size = page_size(content);
            cast.asked = size;
            self.send(ToPipewire::Start {
                stream,
                offered,
                size,
                cursor,
                heard,
                listener,
            });
        }
        let page = self.pages.get_mut(&capture).expect("checked by the caller");
        let held = match kept {
            Kept::Copied => {
                capturer.release(capture, id);
                None
            }
            Kept::Sampled => Some(id),
        };
        if let Some(before) = std::mem::replace(&mut page.held, held) {
            capturer.release(capture, before);
        }
        self.offer(stream, damage.into_iter().collect(), renderer, now);
    }

    /// The engine stopped a capture. Its streams end.
    pub fn capture_ended(
        &mut self,
        capture: CaptureId,
        why: Option<String>,
        mut capturer: Option<&mut (dyn Capturer + 'static)>,
    ) {
        let stopped = |what: &str| match &why {
            Some(why) => format!("the engine stopped capturing the {what}: {why}"),
            None => format!("the engine stopped capturing the {what}"),
        };
        if let Some(at) = self.shooting_browser_window(capture) {
            self.shot_failed(
                at,
                capture,
                stopped("browser window"),
                capturer.as_deref_mut(),
            );
        }
        for stream in self.captures.ended(capture) {
            self.end_or_fail(stream, stopped("monitor"), capturer.as_deref_mut());
        }
        if let Some(stream) = self.page_cast(capture) {
            if let (Some(page), Some(capturer)) =
                (self.pages.remove(&capture), capturer.as_deref_mut())
            {
                for view in page.views {
                    capturer.stop(view.capture);
                }
            }
            self.send(ToPipewire::End {
                stream,
                why: Ended::Failed(stopped("browser window")),
            });
        }
        if let Some(page) = self.page_holding(capture) {
            let shown = self.pages.get_mut(&page).expect("found above");
            shown.views.retain(|view| view.capture != capture);
            // A view closing ends its capture without a cause; it leaves the
            // window. One that failed fails the cast.
            if why.is_some() {
                let stream = self
                    .page_cast(page)
                    .expect("a page lives as long as its stream");
                self.end(
                    stream,
                    Ended::Failed(stopped("browser window's view")),
                    capturer,
                );
            }
        }
    }

    /// The engine was replaced, and its captures with it. Monitor and region
    /// streams end.
    pub fn engine_replaced(&mut self) {
        self.captures = Captures::default();
        self.pages.clear();
        for shooting in self.shooting.drain(..) {
            (shooting.developed)(Err("the engine was replaced".into()));
        }
        for browser_shot in self.browser_shots.drain(..) {
            (browser_shot.developed)(Err("the engine was replaced".into()));
        }
        let captured: Vec<StreamId> = self
            .casts
            .iter()
            .filter(|(_, cast)| matches!(cast.shows, Shows::Desk { .. } | Shows::BrowserWindow(_)))
            .map(|(&stream, _)| stream)
            .collect();
        for stream in captured {
            self.send(ToPipewire::End {
                stream,
                why: Ended::Failed("the engine was replaced".into()),
            });
        }
    }

    /// Fills and sends the frames that are due. Returns when to call again.
    pub fn tick(
        &mut self,
        mut renderer: Option<&mut GlesRenderer>,
        now: Instant,
    ) -> Option<Instant> {
        let due: Vec<StreamId> = self
            .casts
            .iter()
            .filter(|(_, cast)| cast.filling)
            .filter(|(_, cast)| {
                cast.pacing
                    .as_ref()
                    .and_then(Pacing::waiting_until)
                    .is_some_and(|at| at <= now)
            })
            .map(|(&stream, _)| stream)
            .collect();
        for stream in due {
            self.offer(stream, Vec::new(), renderer.as_deref_mut(), now);
        }
        self.next_due()
    }

    /// The pointer moved to `at`, in `app_id`'s box, or left every window.
    /// Window streams that show it are damaged where it was and where it is.
    pub fn pointer_in_window(
        &mut self,
        at: Option<(String, (f64, f64))>,
        renderer: Option<&mut GlesRenderer>,
        now: Instant,
    ) -> Option<Instant> {
        let before = std::mem::replace(&mut self.pointer, at);
        let engine_before = self.engine_pointer.clone();
        self.pointer_moved(before, engine_before, renderer, now)
    }

    /// The pointer moved to `at` on the desktop, or left it, over the pages of
    /// `windows`, as the engine reports it. Desk and browser window streams
    /// that show it are damaged where it was and where it is.
    pub fn pointer_on_desk(
        &mut self,
        at: Option<(f64, f64)>,
        windows: Vec<PointerOverWindow>,
        renderer: Option<&mut GlesRenderer>,
        now: Instant,
    ) -> Option<Instant> {
        let engine_now = EnginePointer {
            desk: at,
            pages: windows
                .into_iter()
                .map(|window| (window.id, window.at))
                .collect(),
        };
        let engine_before = std::mem::replace(&mut self.engine_pointer, engine_now);
        let before = self.pointer.clone();
        self.pointer_moved(before, engine_before, renderer, now)
    }

    /// The engine drew a new pointer, or hid it. Every stream that shows the
    /// pointer is damaged whole: the old image and the new may differ in
    /// size, and a change is rare next to a move.
    pub fn pointer_image(
        &mut self,
        sprite: Sprite,
        mut renderer: Option<&mut GlesRenderer>,
        now: Instant,
    ) -> Option<Instant> {
        if sprite == self.sprite {
            return self.next_due();
        }
        self.sprite = sprite;
        let touched: Vec<(StreamId, Vec<Rect>)> = self
            .casts
            .iter()
            .filter(|(_, cast)| cast.cursor != CursorMode::Hidden)
            .filter_map(|(&stream, cast)| {
                let size = view_size(&cast.shows, &self.shots, &self.pages)?;
                Some((stream, vec![(0, 0, size.0 as i32, size.1 as i32)]))
            })
            .collect();
        for (stream, damage) in touched {
            self.offer(stream, damage, renderer.as_deref_mut(), now);
        }
        self.next_due()
    }

    /// Damages the streams that show the pointer where it was, `before` in a
    /// window and `engine_before` as the engine reported it, and where it is.
    fn pointer_moved(
        &mut self,
        before: Option<(String, (f64, f64))>,
        engine_before: EnginePointer,
        mut renderer: Option<&mut GlesRenderer>,
        now: Instant,
    ) -> Option<Instant> {
        let touched: Vec<(StreamId, Vec<Rect>)> = self
            .casts
            .iter()
            .filter(|(_, cast)| cast.cursor != CursorMode::Hidden)
            .filter_map(|(&stream, cast)| {
                let places = match &cast.shows {
                    Shows::Window(app_id) => {
                        let shot = self.shots.get(app_id)?;
                        [before.as_ref(), self.pointer.as_ref()]
                            .into_iter()
                            .flatten()
                            .filter(|(id, _)| id == app_id)
                            .map(|(_, point)| in_window(*point, shot.pixels_a_point))
                            .collect::<Vec<_>>()
                    }
                    Shows::BrowserWindow(capture) => {
                        let page = self.pages.get(capture)?;
                        let size = page_size(page.frame.as_ref()?.content);
                        [&engine_before, &self.engine_pointer]
                            .into_iter()
                            .filter_map(|engine| on_page(engine, page, size))
                            .collect()
                    }
                    Shows::Desk { target, layout, .. } => {
                        [engine_before.desk, self.engine_pointer.desk]
                            .into_iter()
                            .flatten()
                            .filter_map(|point| on_desk(point, *target, layout))
                            .collect()
                    }
                };
                let size = view_size(&cast.shows, &self.shots, &self.pages)?;
                let sprite = at_density(&self.sprite, density(&cast.shows, &self.shots));
                let damage: Vec<Rect> = places
                    .into_iter()
                    .filter_map(|(x, y)| {
                        let (width, height) = sprite.size;
                        within(
                            (
                                x.round() as i32 - sprite.hotspot.0,
                                y.round() as i32 - sprite.hotspot.1,
                                width as i32,
                                height as i32,
                            ),
                            (0, 0, size.0 as i32, size.1 as i32),
                        )
                    })
                    .collect();
                (!damage.is_empty()).then_some((stream, damage))
            })
            .collect();
        for (stream, damage) in touched {
            self.offer(stream, damage, renderer.as_deref_mut(), now);
        }
        self.next_due()
    }

    /// The windows a stream shows.
    pub fn windows(&self) -> HashSet<String> {
        self.casts
            .values()
            .filter_map(|cast| match &cast.shows {
                Shows::Window(app_id) => Some(app_id.clone()),
                Shows::BrowserWindow(_) | Shows::Desk { .. } => None,
            })
            .collect()
    }

    /// Window `app_id` showed `frame`, which a shot of it alone reads.
    pub fn shown(&mut self, app_id: &str, frame: Shown) {
        self.shown.insert(app_id.to_string(), frame);
    }

    /// A window closed: its streams end.
    pub fn window_gone(&mut self, app_id: &str) {
        self.sizes.remove(app_id);
        self.densities.remove(app_id);
        self.shown.remove(app_id);
        self.shots.remove(app_id);
        let gone: Vec<_> = self
            .casts
            .iter()
            .filter(|(_, cast)| matches!(&cast.shows, Shows::Window(id) if id == app_id))
            .map(|(&stream, _)| stream)
            .collect();
        for stream in gone {
            self.send(ToPipewire::End {
                stream,
                why: Ended::SourceGone,
            });
        }
    }

    /// Where the pointer is over `source`, in its pixels, and its image at
    /// the source's density. `None` off the source, while the pointer is
    /// hidden, and for a browser window or region, which Wayland capture has
    /// no source for.
    pub fn pointer_over(&self, source: &Source) -> Option<Over> {
        if self.sprite.is_hidden() {
            return None;
        }
        let (at, density) = match source {
            Source::Monitor(name) => {
                let screen = self.screens.iter().find(|screen| screen.name == *name)?;
                let (x, y, width, height) = screen.desk;
                let (left, top) = self.engine_pointer.desk?;
                let (left, top) = (left - f64::from(x), top - f64::from(y));
                let inside =
                    left >= 0.0 && top >= 0.0 && left < f64::from(width) && top < f64::from(height);
                inside.then_some(((left * screen.scale, top * screen.scale), screen.scale))?
            }
            Source::Window(app_id) => {
                let (_, point) = self.pointer.as_ref().filter(|(id, _)| id == app_id)?;
                let density = self.densities.get(app_id).copied().unwrap_or((1.0, 1.0));
                (in_window(*point, density), density.0)
            }
            Source::BrowserWindow(_) | Source::Region(_) => return None,
        };
        Some(Over {
            at,
            sprite: at_density(&self.sprite, density),
        })
    }

    /// Damages `stream` by `damage` and fills a buffer from what it shows, if
    /// one is lent.
    fn offer(
        &mut self,
        stream: StreamId,
        damage: Vec<Rect>,
        renderer: Option<&mut GlesRenderer>,
        now: Instant,
    ) {
        let Some(cast) = self.casts.get_mut(&stream) else {
            return;
        };
        let Some(view) = view(
            &cast.shows,
            &self.shots,
            &self.captures,
            &self.pages,
            &self.screens,
            self.pointer.as_ref(),
            &self.engine_pointer,
        ) else {
            return;
        };
        // Damage is in the whole window's pixels, as the view was.
        let (view, damage) = match cast.part {
            Some(part) => {
                let (view, shown) = cut(view, part);
                let damage = damage
                    .into_iter()
                    .filter_map(|rect| within(rect, shown))
                    .collect();
                (view, damage)
            }
            None => (view, damage),
        };
        let sprite = at_density(&self.sprite, density(&cast.shows, &self.shots));
        match step(stream, cast, &view, damage, &sprite, renderer, now) {
            Outcome::Nothing => {}
            Outcome::Send(filled) => self.send(filled),
            Outcome::Starved => self.send(ToPipewire::Starved { stream }),
            Outcome::Resize(size) => {
                debug!(?stream, ?size, "a cast source changed size");
                self.send(ToPipewire::Resize { stream, size });
            }
            Outcome::Failed(why) => self.fail(stream, &why),
        }
    }

    fn fail(&mut self, stream: StreamId, why: &FillError) {
        tracing::error!(?stream, %why, "a cast frame could not be filled");
        self.send(ToPipewire::End {
            stream,
            why: Ended::Failed(why.to_string()),
        });
    }

    /// The earliest instant a filled frame is due.
    fn next_due(&self) -> Option<Instant> {
        self.casts
            .values()
            // A paused stream's frame waits until it fills again.
            .filter(|cast| cast.filling)
            .filter_map(|cast| cast.pacing.as_ref()?.waiting_until())
            .min()
    }

    fn send(&mut self, request: ToPipewire) {
        // A stream that ends before it started starts first, so it ends as
        // every stream does and its consumer hears it.
        if let ToPipewire::End { stream, .. } = &request {
            if let Some(start) = self
                .casts
                .get_mut(stream)
                .and_then(|cast| cast.unstarted.take())
            {
                self.send(start);
            }
        }
        if self.clients.contains(&request.stream()) {
            self.to_clients
                .send(request)
                .unwrap_or_else(|_| panic!("Wayland capture outlives the compositor's casts"));
            return;
        }
        let node = self.gpu.as_ref().map(|gpu| gpu.node.clone());
        let news = self.news.clone();
        self.to_pipewire
            .get_or_insert_with(|| producer::spawn(news, node))
            .send(request)
            .unwrap_or_else(|_| panic!("the PipeWire thread outlives the compositor's casts"));
    }
}

/// A browser window's page, the first of `parts`, with the views after it
/// drawn over it. Every part has its shot.
fn drawn(parts: Vec<ShotPart>) -> domicile_host::screenshot::Shot {
    let mut shots = parts.into_iter().map(|part| {
        (
            part.shot
                .expect("a browser window is shot once every part is"),
            part.place,
        )
    });
    let (page, _) = shots.next().expect("a browser window shot has its page");
    let views: Vec<_> = shots
        .map(|(shot, place)| (shot, place.expect("a view has a place")))
        .collect();
    shots::with_views(page, &views)
}

/// The windows among `open`, as a shot names them, and each monitor's
/// description by name.
fn named(open: Vec<Candidate>) -> (Vec<ShotWindow>, HashMap<String, String>) {
    let mut windows = Vec::new();
    let mut descriptions = HashMap::new();
    for candidate in open {
        match candidate.source {
            Source::Window(id) => windows.push(ShotWindow {
                id,
                title: candidate.title,
                app_id: candidate.app_id,
            }),
            Source::Monitor(name) => {
                descriptions.insert(name, candidate.title);
            }
            Source::BrowserWindow(_) | Source::Region(_) => {}
        }
    }
    (windows, descriptions)
}

/// The size of a browser window's stream: the part of its capture's frame
/// that is the page. Viz letterboxes a page that changed size into the
/// capture's size, so the stream keeps the page's shape.
fn page_size(content: Rect) -> (u32, u32) {
    (content.2 as u32, content.3 as u32)
}

/// The size of a screen's capture: its logical size at its density, upright.
fn capture_size(screen: &Screen) -> (u32, u32) {
    (
        (f64::from(screen.desk.2) * screen.scale).round() as u32,
        (f64::from(screen.desk.3) * screen.scale).round() as u32,
    )
}

/// A point in a window's box, in frame pixels.
fn in_window(point: (f64, f64), pixels_a_point: (f64, f64)) -> (f64, f64) {
    (point.0 * pixels_a_point.0, point.1 * pixels_a_point.1)
}

/// How many stream pixels a logical pixel of what `shows` shows is. A
/// browser window's page is in CSS pixels, which its stream is the size of.
fn density(shows: &Shows, shots: &HashMap<String, Shot>) -> f64 {
    match shows {
        Shows::Window(app_id) => shots.get(app_id).map_or(1.0, |shot| shot.pixels_a_point.0),
        Shows::BrowserWindow(_) => 1.0,
        Shows::Desk { target, layout, .. } => f64::from(layout.size.0) / f64::from(target.2),
    }
}

/// A desktop point in a stream of `target`, in stream pixels, or `None` off
/// it.
fn on_desk(point: (f64, f64), target: Rect, layout: &Layout) -> Option<(f64, f64)> {
    let (x, y) = (point.0 - f64::from(target.0), point.1 - f64::from(target.1));
    let inside = x >= 0.0 && y >= 0.0 && x < f64::from(target.2) && y < f64::from(target.3);
    let scale = f64::from(layout.size.0) / f64::from(target.2);
    inside.then_some((x * scale, y * scale))
}

/// The size a stream's frames are, once its source has drawn.
/// A commit's `damage` in the frame of a window cast showing `sampled`.
///
/// Damage is not mapped through a turn, so a turned window damages its whole
/// frame, as it does in the engine.
fn damage_in_view(damage: Option<Rect>, sampled: Sampled) -> Vec<Rect> {
    if sampled.transform == Transform::Normal {
        damage
            .and_then(|damage| within(damage, sampled.crop))
            .map_or_else(Vec::new, |damage| vec![damage])
    } else {
        let (width, height) = sampled.upright_size();
        vec![(0, 0, width as i32, height as i32)]
    }
}

fn view_size(
    shows: &Shows,
    shots: &HashMap<String, Shot>,
    pages: &HashMap<CaptureId, Page>,
) -> Option<(u32, u32)> {
    match shows {
        Shows::Window(app_id) => shots.get(app_id).map(|shot| shot.sampled.upright_size()),
        Shows::BrowserWindow(capture) => pages
            .get(capture)?
            .frame
            .as_ref()
            .map(|frame| page_size(frame.content)),
        Shows::Desk { layout, .. } => Some(layout.size),
    }
}

/// Where `engine` puts the pointer over `page`, `size` stream pixels, or
/// `None` off it: over one of its views, the topmost, or else the page.
fn on_page(engine: &EnginePointer, page: &Page, size: (u32, u32)) -> Option<(f64, f64)> {
    let over_view = page.views.iter().rev().find_map(|view| {
        let (x, y) = engine.pages.get(&view.id)?;
        let (left, top, width, height) = placed(view.place, view.frame.as_ref()?.content);
        Some((
            f64::from(left) + x * f64::from(width),
            f64::from(top) + y * f64::from(height),
        ))
    });
    over_view.or_else(|| {
        let (x, y) = engine.pages.get(&page.window)?;
        Some((x * f64::from(size.0), y * f64::from(size.1)))
    })
}

/// Where a view `place`d in a window's page, in its CSS pixels, is drawn in
/// the page's stream pixels, from its frame's `content`: at its own density,
/// which its content's width over its place's says.
fn placed(place: Rect, content: Rect) -> Rect {
    let scale = f64::from(content.2) / f64::from(place.2);
    (
        (f64::from(place.0) * scale).round() as i32,
        (f64::from(place.1) * scale).round() as i32,
        content.2,
        content.3,
    )
}

/// What a stream's next frame is made of, or `None` until every source it
/// draws from has drawn.
fn view<'a>(
    shows: &Shows,
    shots: &'a HashMap<String, Shot>,
    captures: &'a Captures,
    pages: &'a HashMap<CaptureId, Page>,
    screens: &[Screen],
    pointer: Option<&(String, (f64, f64))>,
    engine_pointer: &EnginePointer,
) -> Option<View<'a>> {
    match shows {
        Shows::Window(app_id) => {
            let shot = shots.get(app_id)?;
            Some(View {
                size: shot.sampled.upright_size(),
                layers: vec![Layer::upright(&shot.snapshot, shot.sampled)],
                pointer: pointer
                    .filter(|(id, _)| id == app_id)
                    .map(|(_, point)| in_window(*point, shot.pixels_a_point)),
            })
        }
        Shows::BrowserWindow(capture) => {
            let page = pages.get(capture)?;
            let frame = page.frame.as_ref()?;
            let size = page_size(frame.content);
            let views = page
                .views
                .iter()
                .map(|view| {
                    let frame = view.frame.as_ref()?;
                    Some(Layer {
                        snapshot: &frame.snapshot,
                        from: frame.content,
                        to: placed(view.place, frame.content),
                        transform: Transform::Normal,
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            let whole = (0, 0, size.0 as i32, size.1 as i32);
            let view = View {
                size,
                layers: std::iter::once(Layer {
                    snapshot: &frame.snapshot,
                    from: frame.content,
                    to: whole,
                    transform: Transform::Normal,
                })
                .chain(views)
                .collect(),
                pointer: on_page(engine_pointer, page, size),
            };
            // A view the app placed past the page's edge is cut there.
            Some(cut(view, whole).0)
        }
        Shows::Desk { target, layout, .. } => {
            let layers = layout
                .pieces
                .iter()
                .map(|piece| {
                    let frame = captures.frame(piece.display)?;
                    let screen = screens
                        .iter()
                        .find(|screen| screen.display == piece.display)?;
                    Some(Layer {
                        snapshot: &frame.snapshot,
                        from: in_frame(piece.from, (screen.desk.2, screen.desk.3), frame.content),
                        to: piece.to,
                        transform: Transform::Normal,
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            Some(View {
                size: layout.size,
                layers,
                pointer: engine_pointer
                    .desk
                    .and_then(|point| on_desk(point, *target, layout)),
            })
        }
    }
}

/// `view` cut to `part`, in its pixels, and the part shown: `part` kept
/// inside the view, which may have shrunk since it was picked, or all of the
/// view when none of `part` is left.
fn cut(view: View<'_>, part: Rect) -> (View<'_>, Rect) {
    let whole = (0, 0, view.size.0 as i32, view.size.1 as i32);
    let shown = within(part, whole).unwrap_or(whole);
    let layers = view
        .layers
        .into_iter()
        .filter_map(|layer| {
            // Relative to the part.
            let visible = within(layer.to, shown)?;
            let (from_width, from_height) =
                upright_size((layer.from.2 as u32, layer.from.3 as u32), layer.transform);
            let (across, down) = (
                f64::from(from_width) / f64::from(layer.to.2),
                f64::from(from_height) / f64::from(layer.to.3),
            );
            let upright = (
                (f64::from(visible.0 + shown.0 - layer.to.0) * across).round() as i32,
                (f64::from(visible.1 + shown.1 - layer.to.1) * down).round() as i32,
                (f64::from(visible.2) * across).round() as i32,
                (f64::from(visible.3) * down).round() as i32,
            );
            let (x, y, width, height) =
                crop_in_buffer(upright, (from_width, from_height), layer.transform);
            Some(Layer {
                from: (layer.from.0 + x, layer.from.1 + y, width, height),
                to: visible,
                ..layer
            })
        })
        .collect();
    let pointer = view.pointer.and_then(|(x, y)| {
        let (x, y) = (x - f64::from(shown.0), y - f64::from(shown.1));
        let inside = x >= 0.0 && y >= 0.0 && x < f64::from(shown.2) && y < f64::from(shown.3);
        inside.then_some((x, y))
    });
    (
        View {
            size: (shown.2 as u32, shown.3 as u32),
            layers,
            pointer,
        },
        shown,
    )
}

/// Damages `cast`, and fills and sends a buffer from `view` if one is lent and
/// the frame is due. A frame that is not due yet waits for [`Streams::tick`],
/// and is filled once, with the newest view, when it is sent.
fn step(
    stream: StreamId,
    cast: &mut Cast,
    view: &View,
    damage: Vec<Rect>,
    sprite: &Sprite,
    renderer: Option<&mut GlesRenderer>,
    now: Instant,
) -> Outcome {
    let (Some(format), Some(pacing), true) = (cast.format, cast.pacing.as_mut(), cast.filling)
    else {
        return Outcome::Nothing;
    };
    if format.size != view.size {
        if cast.asked == view.size {
            return Outcome::Nothing;
        }
        cast.asked = view.size;
        return Outcome::Resize(view.size);
    }
    if damage.is_empty() && !pacing.owed() && !pacing.waits() {
        return Outcome::Nothing;
    }
    if pacing.damaged(&damage).is_none() {
        return Outcome::Starved;
    }
    let Due::Send { buffer, damage } = pacing.due(now) else {
        return Outcome::Nothing;
    };
    let target = cast
        .targets
        .get(&buffer)
        .expect("PipeWire adds a buffer before lending it");
    // A hidden pointer is off every source, as it is off the screen.
    let cursor = plan(cast.cursor, view.pointer.filter(|_| !sprite.is_hidden()));
    let fence = match fill(target, format, &view.layers, cursor, sprite, renderer) {
        Ok(fence) => fence,
        Err(why) => return Outcome::Failed(why),
    };
    let sprite = matches!(cursor, Plan::Metadata { at: Some(_) }).then(|| Arc::new(sprite.clone()));
    Outcome::Send(ToPipewire::Filled {
        stream,
        buffer,
        damage,
        cursor,
        sprite,
        fence,
    })
}

/// Writes `layers` into `target`. A dmabuf target returns the fence the
/// PipeWire thread waits on before queueing.
fn fill(
    target: &Target,
    format: StreamFormat,
    layers: &[Layer],
    cursor: Plan,
    sprite: &Sprite,
    renderer: Option<&mut GlesRenderer>,
) -> Result<Option<OwnedFd>, FillError> {
    match target {
        Target::Shm(mapping) => {
            let (stride, _) = shm_layout(format.size);
            let stride = stride as usize;
            // SAFETY: the buffer is lent to this thread until it is sent.
            let bytes = unsafe { mapping.bytes() };
            paint(layers, bytes, stride, format.pixel, renderer)?;
            if let Plan::Embed { at } = cursor {
                embed(bytes, stride, format.size, sprite, at);
            }
            Ok(None)
        }
        Target::Dmabuf(dmabuf) => gpu::draw(
            renderer.ok_or(FillError::NoGpu)?,
            layers,
            dmabuf,
            (dmabuf.width(), dmabuf.height()),
            cursor,
            sprite,
        ),
    }
}

/// Whose sound a cast of `shows` carries: a window's client `process`'s, or
/// every app's for the desk. A Wayland capture `client` carries none, and a
/// browser window's page sound is the engine's own.
fn heard(shows: &Shows, process: Option<u32>, client: bool) -> Option<Heard> {
    match shows {
        _ if client => None,
        Shows::Window(id) => process.map(|process| Heard::Window {
            id: id.clone(),
            process,
        }),
        Shows::BrowserWindow(_) => None,
        Shows::Desk { .. } => Some(Heard::Everything),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::io::Write as _;
    use std::os::fd::{FromRawFd as _, OwnedFd};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use smithay::reexports::calloop::channel::{channel, Channel};

    use domicile_protocol::{PointerOverWindow, ShotWindow};

    use smithay::utils::Transform;

    use super::{
        compose, cut, damage_in_view, density, heard, view, Cast, EnginePointer, Shot, Shows,
        Streams,
    };
    use crate::buffer_transform::Sampled;
    use crate::casting::audio::Heard;
    use crate::casting::captures::Capturer;
    use crate::casting::cursor::{CursorMode, Sprite};
    use crate::casting::gpu::Snapshot;
    use crate::casting::lifecycle::Ended;
    use crate::casting::memory::Mapping;
    use crate::casting::negotiation::Pixel;
    use crate::casting::pacing::Rect;
    use crate::casting::producer::{BufferId, StreamFormat, Target, ToPipewire, ToWayland};
    use crate::casting::region;
    use crate::casting::region::Screen;
    use crate::casting::shots::Desk;
    use crate::casting::{Candidate, Consumer, Region, Request, Source, StreamId};
    use crate::engine::{
        BrowserView, BrowserWindow, CaptureId, CapturedFrame, CapturedPixels, SharedFd,
    };

    /// An engine that numbers captures by display, captures browser windows
    /// from 100 up, and records stops and releases.
    #[derive(Default)]
    struct Engine {
        started: Vec<i64>,
        sizes: Vec<(u32, u32)>,
        browser_windows: Vec<String>,
        stopped: Vec<CaptureId>,
        released: Vec<(CaptureId, u64)>,
    }

    /// The capture [`Engine`] starts for the first browser window, then 101
    /// and up.
    const BROWSER_WINDOW: CaptureId = 100;

    impl Capturer for Engine {
        fn start(&mut self, display: i64, size: (u32, u32), _: u32) -> Result<CaptureId, String> {
            self.started.push(display);
            self.sizes.push(size);
            Ok(display as CaptureId)
        }
        fn start_browser_window(&mut self, window: &str, _: u32) -> Result<CaptureId, String> {
            if window == "closed" {
                return Err("no browser window closed".into());
            }
            self.browser_windows.push(window.into());
            Ok(BROWSER_WINDOW + self.browser_windows.len() as CaptureId - 1)
        }
        fn resize(&mut self, _: CaptureId, _: (u32, u32)) {}
        fn stop(&mut self, capture: CaptureId) {
            self.stopped.push(capture);
        }
        fn release(&mut self, capture: CaptureId, frame: u64) {
            self.released.push((capture, frame));
        }
    }

    /// A 1x1 monitor at 1x, and a 1x1 one at 2x to its right.
    fn screens() -> Vec<Screen> {
        vec![
            Screen {
                name: "drm-1".into(),
                display: 1,
                desk: (0, 0, 1, 1),
                scale: 1.0,
            },
            Screen {
                name: "drm-2".into(),
                display: 2,
                desk: (1, 0, 1, 1),
                scale: 2.0,
            },
        ]
    }

    /// A shared memory frame of `size`, every pixel `[blue, 0, 0, 255]`.
    fn frame(size: (u32, u32), blue: u8) -> CapturedFrame {
        painted(size, &vec![blue; (size.0 * size.1) as usize])
    }

    /// A shared memory frame of `size`, each pixel `[blue, 0, 0, 255]` with
    /// its blue byte from `blues`, row by row.
    fn painted(size: (u32, u32), blues: &[u8]) -> CapturedFrame {
        // SAFETY: a fresh memfd, owned here.
        let fd = unsafe { libc::memfd_create(c"frame".as_ptr(), 0) };
        assert!(fd >= 0, "a memfd");
        // SAFETY: `fd` is open and owned by nothing else.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let pixels: Vec<u8> = blues.iter().flat_map(|&blue| [blue, 0, 0, 255]).collect();
        std::fs::File::from(fd.try_clone().expect("a duplicate"))
            .write_all(&pixels)
            .expect("written");
        CapturedFrame {
            pixels: CapturedPixels::Shm {
                fd: SharedFd(Arc::new(fd)),
                stride: size.0 * 4,
            },
            size,
            // DRM_FORMAT_ARGB8888.
            fourcc: 0x3432_5241,
            content: (0, 0, size.0 as i32, size.1 as i32),
            damage: None,
        }
    }

    fn streams() -> Streams {
        let mut streams = Streams::new(channel().0, channel().0, None);
        streams.screens(screens(), None);
        streams
    }

    /// The engine says where the pointer is on the desk; the page says where
    /// it is in a window. Each keeps the other.
    /// A cast draws the pointer at its source's density: a 2x monitor's
    /// stream has two pixels a logical pixel, a 1x one has one.
    #[test]
    fn a_cast_draws_the_pointer_at_its_sources_density() {
        let desk = |target: Rect| Shows::Desk {
            monitor: None,
            target,
            most_pixels: None,
            layout: region::layout(target, &screens(), None).expect("on a monitor"),
        };

        assert_eq!(density(&desk((0, 0, 1, 1)), &HashMap::new()), 1.0);
        assert_eq!(density(&desk((1, 0, 1, 1)), &HashMap::new()), 2.0);
        assert_eq!(density(&Shows::BrowserWindow(1), &HashMap::new()), 1.0);
    }

    /// A fractionally scaled window's buffer has a fractional number of
    /// pixels a point, so the pointer and the arrow scale by it.
    #[test]
    fn a_window_cast_puts_the_pointer_at_its_buffers_pixels_a_point() {
        let mut streams = streams();
        streams.shots.insert(
            "app-1".into(),
            Shot {
                snapshot: Snapshot::Pixels {
                    bytes: vec![0; 175 * 105 * 4],
                    stride: 175 * 4,
                    alpha: false,
                    size: (175, 105),
                },
                sampled: Sampled {
                    crop: (0, 0, 175, 105),
                    transform: Transform::Normal,
                },
                pixels_a_point: (1.75, 1.75),
            },
        );
        let shows = Shows::Window("app-1".into());

        let shown = view(
            &shows,
            &streams.shots,
            &streams.captures,
            &streams.pages,
            &streams.screens,
            Some(&("app-1".into(), (10.0, 20.0))),
            &EnginePointer::default(),
        )
        .expect("a frame to show");
        assert_eq!(shown.pointer, Some((17.5, 35.0)));
        assert_eq!(density(&shows, &streams.shots), 1.75);
    }

    /// A window `size` big, its buffer turned by `transform`.
    fn shot_of(size: (u32, u32), transform: Transform) -> Shot {
        let buffer = crate::buffer_transform::upright_size(size, transform);
        Shot {
            snapshot: Snapshot::Pixels {
                bytes: vec![0; (buffer.0 * buffer.1 * 4) as usize],
                stride: buffer.0 as usize * 4,
                alpha: false,
                size: buffer,
            },
            sampled: Sampled {
                crop: (0, 0, buffer.0 as i32, buffer.1 as i32),
                transform,
            },
            pixels_a_point: (1.0, 1.0),
        }
    }

    /// A part of a hidden window picked over its preview is cast alone: the
    /// stream is the part's size, and the pointer is on it from its corner.
    #[test]
    fn a_window_part_is_cast_alone() {
        let mut streams = streams();
        streams
            .shots
            .insert("app-1".into(), shot_of((100, 50), Transform::Normal));
        let shown = |part, pointer: (f64, f64)| {
            let view = view(
                &Shows::Window("app-1".into()),
                &streams.shots,
                &streams.captures,
                &streams.pages,
                &streams.screens,
                Some(&("app-1".into(), pointer)),
                &EnginePointer::default(),
            )
            .expect("a frame to show");
            let (view, shown) = cut(view, part);
            (
                view.size,
                view.layers[0].from,
                view.layers[0].to,
                view.pointer,
                shown,
            )
        };

        assert_eq!(
            shown((10, 5, 30, 20), (20.0, 10.0)),
            (
                (30, 20),
                (10, 5, 30, 20),
                (0, 0, 30, 20),
                Some((10.0, 5.0)),
                (10, 5, 30, 20)
            )
        );
        assert_eq!(shown((10, 5, 30, 20), (60.0, 10.0)).3, None, "off the part");
        // The window shrank: what is left of the part.
        assert_eq!(shown((90, 40, 30, 20), (0.0, 0.0)).0, (10, 10));
        // None of it is left: all of the window.
        assert_eq!(shown((200, 200, 30, 20), (0.0, 0.0)).0, (100, 50));
    }

    /// A turned window's part is cut from the right pixels of its buffer.
    #[test]
    fn a_part_of_a_turned_window_is_cut_from_its_buffer() {
        let mut streams = streams();
        // Upright 100x50, from a 50x100 buffer turned a quarter.
        streams
            .shots
            .insert("app-1".into(), shot_of((100, 50), Transform::_90));
        let view = view(
            &Shows::Window("app-1".into()),
            &streams.shots,
            &streams.captures,
            &streams.pages,
            &streams.screens,
            None,
            &EnginePointer::default(),
        )
        .expect("a frame to show");

        let (view, _) = cut(view, (10, 5, 30, 20));

        let from = view.layers[0].from;
        assert_eq!((from.2, from.3), (20, 30), "the buffer's sides are swapped");
        assert_eq!(view.layers[0].to, (0, 0, 30, 20));
    }

    #[test]
    fn the_pointer_on_the_desk_and_in_a_window_are_heard_apart() {
        let mut streams = streams();
        let now = Instant::now();

        streams.pointer_in_window(Some(("app-1".into(), (2.0, 3.0))), None, now);
        streams.pointer_on_desk(Some((40.0, 50.0)), Vec::new(), None, now);

        assert_eq!(streams.pointer, Some(("app-1".into(), (2.0, 3.0))));
        assert_eq!(streams.engine_pointer.desk, Some((40.0, 50.0)));
        streams.pointer_in_window(None, None, now);
        assert_eq!(streams.engine_pointer.desk, Some((40.0, 50.0)));
    }

    #[test]
    fn a_shot_waits_for_every_monitor_then_lets_their_captures_go() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let (developed, heard) = mpsc::channel();
        let open = vec![
            Candidate {
                source: Source::Window("app-3".into()),
                title: "~/src".into(),
                app_id: "kitty".into(),
                bounds: None,
                process: None,
                part: None,
            },
            Candidate {
                source: Source::Monitor("drm-1".into()),
                title: "BOE NE135A1M-NY1".into(),
                app_id: String::new(),
                process: None,
                part: None,
                bounds: Some(Region {
                    position: (0, 0),
                    size: (1, 1),
                }),
            },
        ];

        streams.request(
            Request::Shoot {
                stream: StreamId(9),
                developed: Box::new(move |desk| developed.send(desk).expect("heard")),
            },
            || open,
            None,
            Some(&mut engine),
        );
        assert_eq!(engine.started, [1, 2]);
        streams.captured(
            1,
            1,
            Ok(frame((1, 1), 10)),
            None,
            &mut engine,
            Instant::now(),
        );
        assert!(heard.try_recv().is_err(), "drm-2 has no frame yet");
        streams.captured(
            2,
            1,
            Ok(frame((2, 2), 20)),
            None,
            &mut engine,
            Instant::now(),
        );

        let desk: Desk = heard.try_recv().expect("developed").expect("a desk");
        let blue: Vec<u8> = desk.shot.bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!(blue, [10, 10, 20, 20, 10, 10, 20, 20]);
        assert_eq!(
            desk.monitors
                .iter()
                .map(|monitor| (monitor.name.as_str(), monitor.description.as_str()))
                .collect::<Vec<_>>(),
            [("drm-1", "BOE NE135A1M-NY1"), ("drm-2", "")]
        );
        assert_eq!(
            desk.windows,
            [ShotWindow {
                id: "app-3".into(),
                title: "~/src".into(),
                app_id: "kitty".into(),
            }],
            "the windows, not the monitors"
        );
        assert_eq!(desk.place, (0, 0, 2, 1));
        engine.stopped.sort_unstable();
        assert_eq!(engine.stopped, [1, 2]);
    }

    #[test]
    fn a_shot_of_part_of_the_desk_draws_from_its_monitors_capture_alone_at_its_density() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let (developed, heard) = mpsc::channel();

        streams.shoot(
            StreamId(9),
            Ok((1, 0, 1, 1)),
            Vec::new(),
            Box::new(move |desk| developed.send(desk).expect("heard")),
            None,
            Some(&mut engine),
        );
        assert_eq!(engine.started, [2]);
        streams.captured(
            2,
            1,
            Ok(frame((2, 2), 20)),
            None,
            &mut engine,
            Instant::now(),
        );

        let desk: Desk = heard.try_recv().expect("developed").expect("a desk");
        let blue: Vec<u8> = desk.shot.bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!(blue, [20, 20, 20, 20]);
        assert_eq!(desk.place, (1, 0, 1, 1));
        assert_eq!(engine.stopped, [2]);
    }

    #[test]
    fn a_rotated_monitors_shot_is_captured_upright() {
        let mut streams = Streams::new(channel().0, channel().0, None);
        streams.screens(
            vec![Screen {
                name: "drm-1".into(),
                display: 1,
                desk: (0, 0, 1, 2),
                scale: 1.0,
            }],
            None,
        );
        let mut engine = Engine::default();
        let (developed, heard) = mpsc::channel();

        streams.shoot(
            StreamId(9),
            Ok((0, 0, 1, 2)),
            Vec::new(),
            Box::new(move |desk| developed.send(desk).expect("heard")),
            None,
            Some(&mut engine),
        );
        // viz renders a turned window upright and turns it on the way to the
        // panel, so its capture is the upright frame.
        assert_eq!(engine.sizes, [(1, 2)]);
        streams.captured(
            1,
            1,
            Ok(painted((1, 2), &[10, 20])),
            None,
            &mut engine,
            Instant::now(),
        );

        let desk: Desk = heard.try_recv().expect("developed").expect("a desk");
        let blue: Vec<u8> = desk.shot.bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!((desk.shot.width, desk.shot.height), (1, 2));
        assert_eq!(blue, [10, 20]);
    }

    #[test]
    fn a_region_of_a_monitor_is_found_on_the_desktop_clipped_to_it() {
        let streams = streams();
        let region = |x, y, width, height| Region {
            position: (x, y),
            size: (width, height),
        };

        assert_eq!(
            streams.monitor_region("drm-2", region(0, 0, 5, 5)),
            Ok(region(1, 0, 1, 1)),
            "a region past the monitor's edge is cut at it"
        );
        assert!(streams.monitor_region("drm-1", region(1, 0, 1, 1)).is_err());
        assert!(streams.monitor_region("drm-3", region(0, 0, 1, 1)).is_err());
    }

    #[test]
    fn a_window_that_has_shown_nothing_cannot_be_shot_alone() {
        let (developed, heard) = mpsc::channel();

        streams().request(
            Request::ShootWindow {
                app_id: "app-3".into(),
                developed: Box::new(move |shot| developed.send(shot).expect("heard")),
            },
            Vec::new,
            None,
            None,
        );

        assert!(heard.try_recv().expect("developed").is_err());
    }

    #[test]
    fn a_shot_without_an_engine_is_refused() {
        let (developed, heard) = mpsc::channel();

        streams().shoot(
            StreamId(9),
            Ok((0, 0, 2, 1)),
            Vec::new(),
            Box::new(move |desk| developed.send(desk).expect("heard")),
            None,
            None,
        );

        assert!(heard.try_recv().expect("developed").is_err());
    }

    #[test]
    fn a_shot_fails_when_the_engine_stops_a_capture_it_waits_on() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let (developed, heard) = mpsc::channel();
        streams.shoot(
            StreamId(9),
            Ok((0, 0, 2, 1)),
            Vec::new(),
            Box::new(move |desk| developed.send(desk).expect("heard")),
            None,
            Some(&mut engine),
        );

        streams.capture_ended(2, Some("viz ran out".into()), Some(&mut engine));

        assert_eq!(
            heard.try_recv().expect("developed"),
            Err("the engine stopped capturing the monitor: viz ran out".into())
        );
        assert_eq!(engine.stopped, [1]);
    }

    #[test]
    fn a_browser_window_is_shot_alone_from_its_captures_first_frame() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let (developed, heard) = mpsc::channel();
        streams.request(
            Request::ShootBrowserWindow {
                id: "1".into(),
                developed: Box::new(move |shot| developed.send(shot).expect("heard")),
            },
            Vec::new,
            None,
            Some(&mut engine),
        );
        assert_eq!(engine.browser_windows, ["1"]);
        assert!(heard.try_recv().is_err(), "no shot before a frame");

        // Viz letterboxes the page into the frame; only `content` is it.
        let mut letterboxed = painted((3, 2), &[0, 1, 2, 0, 3, 4]);
        letterboxed.content = (1, 0, 2, 2);
        streams.captured(
            BROWSER_WINDOW,
            1,
            Ok(letterboxed),
            None,
            &mut engine,
            Instant::now(),
        );

        let shot = heard.try_recv().expect("developed").expect("shot");
        assert_eq!((shot.width, shot.height), (2, 2));
        let blue: Vec<u8> = shot.bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!(blue, [1, 2, 3, 4]);
        assert_eq!(engine.stopped, [BROWSER_WINDOW]);
    }

    /// Browser window "1", holding `views` by id at `places`, bottom first.
    fn holding(views: &[(&str, Rect)]) -> Vec<BrowserWindow> {
        vec![BrowserWindow {
            id: "1".into(),
            title: "Claude".into(),
            app_id: "claude-desktop".into(),
            url: String::new(),
            private: false,
            views: views
                .iter()
                .map(|&(id, (x, y, width, height))| BrowserView {
                    id: id.into(),
                    x,
                    y,
                    width,
                    height,
                })
                .collect(),
        }]
    }

    /// Asks `streams` for a shot of browser window "1".
    fn shoot_one(
        streams: &mut Streams,
        engine: &mut Engine,
    ) -> mpsc::Receiver<Result<domicile_host::screenshot::Shot, String>> {
        let (developed, heard) = mpsc::channel();
        streams.request(
            Request::ShootBrowserWindow {
                id: "1".into(),
                developed: Box::new(move |shot| developed.send(shot).expect("heard")),
            },
            Vec::new,
            None,
            Some(engine),
        );
        heard
    }

    #[test]
    fn a_browser_window_shot_draws_the_views_it_holds_over_its_page() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        // A title bar page, with the whole chat a view under it.
        streams.browser_windows(&holding(&[("6", (0, 1, 2, 1))]), None);
        let heard = shoot_one(&mut streams, &mut engine);
        assert_eq!(engine.browser_windows, ["1", "6"]);

        streams.captured(
            BROWSER_WINDOW,
            1,
            Ok(painted((2, 2), &[1, 1, 2, 2])),
            None,
            &mut engine,
            Instant::now(),
        );
        assert!(
            heard.try_recv().is_err(),
            "no shot before every view's frame"
        );
        streams.captured(
            BROWSER_WINDOW + 1,
            1,
            Ok(painted((2, 1), &[3, 4])),
            None,
            &mut engine,
            Instant::now(),
        );

        let shot = heard.try_recv().expect("developed").expect("shot");
        let blue: Vec<u8> = shot.bgra.chunks(4).map(|pixel| pixel[0]).collect();
        assert_eq!(blue, [1, 1, 3, 4]);
        assert_eq!(engine.stopped, [BROWSER_WINDOW, BROWSER_WINDOW + 1]);
    }

    #[test]
    fn a_browser_window_shot_fails_when_a_view_cannot_be_captured() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        streams.browser_windows(&holding(&[("closed", (0, 0, 1, 1))]), None);

        let heard = shoot_one(&mut streams, &mut engine);

        assert_eq!(
            heard.try_recv().expect("developed"),
            Err("no browser window closed".into())
        );
        assert_eq!(engine.stopped, [BROWSER_WINDOW], "the page's capture stops");
    }

    #[test]
    fn a_browser_window_shot_fails_when_the_engine_stops_a_views_capture() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        streams.browser_windows(&holding(&[("6", (0, 0, 1, 1))]), None);
        let heard = shoot_one(&mut streams, &mut engine);

        streams.capture_ended(BROWSER_WINDOW + 1, None, Some(&mut engine));

        assert_eq!(
            heard.try_recv().expect("developed"),
            Err("the engine stopped capturing the browser window".into())
        );
        assert_eq!(engine.stopped, [BROWSER_WINDOW], "the page's capture stops");
    }

    #[test]
    fn a_browser_window_shot_fails_when_the_engine_stops_its_capture() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let (developed, heard) = mpsc::channel();
        streams.request(
            Request::ShootBrowserWindow {
                id: "1".into(),
                developed: Box::new(move |shot| developed.send(shot).expect("heard")),
            },
            Vec::new,
            None,
            Some(&mut engine),
        );

        streams.capture_ended(BROWSER_WINDOW, None, Some(&mut engine));

        assert_eq!(
            heard.try_recv().expect("developed"),
            Err("the engine stopped capturing the browser window".into())
        );
    }

    /// The engine's pointer replaces the arrow, as a page changes it; a
    /// hidden one is drawn nowhere.
    #[test]
    fn a_cast_draws_the_pointer_the_engine_draws() {
        let mut streams = streams();
        let hand = Sprite::from_bgra((1, 1), (0, 0), 2.0, vec![1, 2, 3, 255]).expect("a sprite");

        streams.pointer_image(hand.clone(), None, Instant::now());
        assert_eq!(streams.sprite, hand);

        streams.pointer_image(Sprite::hidden(), None, Instant::now());
        assert!(streams.sprite.is_hidden());
    }

    /// The compositor cannot see the pointer over a page; the engine says
    /// where on each window's page it is.
    #[test]
    fn a_browser_window_cast_draws_the_pointer_where_the_engine_puts_it() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let shows = streams
            .shows(
                StreamId(4),
                Source::BrowserWindow("1".into()),
                None,
                |_| false,
                Some(&mut engine),
            )
            .expect("a browser window cast");
        streams.casts.insert(StreamId(4), cast(shows));
        streams.captured(
            BROWSER_WINDOW,
            7,
            Ok(frame((4, 2), 0)),
            None,
            &mut engine,
            Instant::now(),
        );
        let pointer = |streams: &Streams| {
            view(
                &streams.casts[&StreamId(4)].shows,
                &streams.shots,
                &streams.captures,
                &streams.pages,
                &streams.screens,
                None,
                &streams.engine_pointer,
            )
            .expect("a frame to show")
            .pointer
        };

        streams.pointer_on_desk(
            Some((40.0, 50.0)),
            vec![PointerOverWindow {
                id: "1".into(),
                at: (0.5, 0.25),
            }],
            None,
            Instant::now(),
        );
        assert_eq!(pointer(&streams), Some((2.0, 0.5)));

        streams.pointer_on_desk(
            Some((40.0, 50.0)),
            vec![PointerOverWindow {
                id: "2".into(),
                at: (0.5, 0.25),
            }],
            None,
            Instant::now(),
        );
        assert_eq!(pointer(&streams), None, "over another window");
    }

    #[test]
    fn a_browser_window_cast_shows_its_page_alone_from_its_own_capture() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let shows = streams
            .shows(
                StreamId(4),
                Source::BrowserWindow("1".into()),
                None,
                |_| false,
                Some(&mut engine),
            )
            .expect("a browser window cast");
        streams.casts.insert(StreamId(4), cast(shows));
        assert_eq!(engine.browser_windows, ["1"]);

        // Viz letterboxes the page into the frame; only `content` is it.
        let mut letterboxed = painted((3, 2), &[0, 1, 2, 0, 3, 4]);
        letterboxed.content = (1, 0, 2, 2);
        streams.captured(
            BROWSER_WINDOW,
            7,
            Ok(letterboxed),
            None,
            &mut engine,
            Instant::now(),
        );

        let shown = view(
            &streams.casts[&StreamId(4)].shows,
            &streams.shots,
            &streams.captures,
            &streams.pages,
            &streams.screens,
            None,
            &EnginePointer::default(),
        )
        .expect("a frame to show");
        assert_eq!(shown.size, (2, 2));
        assert_eq!(shown.layers.len(), 1);
        assert_eq!(
            (shown.layers[0].from, shown.layers[0].to),
            ((1, 0, 2, 2), (0, 0, 2, 2))
        );
        assert_eq!(
            engine.released,
            [(BROWSER_WINDOW, 7)],
            "a copied frame goes back at once"
        );
    }

    #[test]
    fn a_browser_window_casts_capture_stops_with_it() {
        let (mut streams, mut engine) = (streams(), Engine::default());
        let shows = streams
            .shows(
                StreamId(4),
                Source::BrowserWindow("1".into()),
                None,
                |_| false,
                Some(&mut engine),
            )
            .expect("a browser window cast");
        streams.casts.insert(StreamId(4), cast(shows));

        streams.news(
            ToWayland::Ended {
                stream: StreamId(4),
            },
            None,
            Some(&mut engine),
            Instant::now(),
        );

        assert_eq!(engine.stopped, [BROWSER_WINDOW]);
    }

    #[test]
    fn a_browser_window_cast_without_an_engine_fails() {
        assert!(matches!(
            streams().shows(
                StreamId(4),
                Source::BrowserWindow("1".into()),
                None,
                |_| false,
                None,
            ),
            Err(Ended::Failed(_))
        ));
    }

    #[test]
    fn a_turned_windows_damage_is_its_whole_frame() {
        let upright = Sampled {
            crop: (10, 0, 30, 20),
            transform: Transform::Normal,
        };
        assert_eq!(damage_in_view(Some((15, 5, 2, 2)), upright), [(5, 5, 2, 2)]);
        let turned = Sampled {
            transform: Transform::_90,
            ..upright
        };
        assert_eq!(
            damage_in_view(Some((15, 5, 2, 2)), turned),
            [(0, 0, 20, 30)]
        );
    }

    #[test]
    fn each_window_a_cast_shows_is_named_once() {
        let mut streams = streams();
        for (stream, window) in [(1, "term"), (2, "term"), (3, "editor")] {
            streams
                .casts
                .insert(StreamId(stream), cast(Shows::Window(window.into())));
        }

        assert_eq!(
            streams.windows(),
            HashSet::from(["term".to_string(), "editor".to_string()])
        );
    }

    #[test]
    fn a_window_cast_hears_its_process_and_a_monitor_cast_every_app() {
        let window = Shows::Window("term".into());

        assert_eq!(
            heard(&window, Some(7), false),
            Some(Heard::Window {
                id: "term".into(),
                process: 7
            })
        );
        assert_eq!(heard(&window, None, false), None, "credentials unknown");
        assert_eq!(heard(&window, Some(7), true), None, "a Wayland capture");
        let target = (0, 0, 1, 1);
        let desk = Shows::Desk {
            monitor: None,
            target,
            most_pixels: None,
            layout: region::layout(target, &screens(), None).expect("on a monitor"),
        };
        assert_eq!(heard(&desk, None, false), Some(Heard::Everything));
    }

    /// A Wayland capture client's cast is offered to the client, and one that
    /// cannot start ends there too. Neither reaches PipeWire.
    #[test]
    fn a_clients_cast_is_heard_by_the_client() {
        let (to_clients, heard) = channel();
        let mut streams = Streams::new(channel().0, to_clients, None);
        streams.screens(screens(), None);
        let mut engine = Engine::default();
        let start = |stream, name: &str| Request::Start {
            stream,
            source: Source::Monitor(name.into()),
            part: None,
            most_pixels: None,
            cursor: CursorMode::Hidden,
            consumer: Consumer::Client,
            listener: Box::new(|_| panic!("a client's cast has no listener")),
        };

        streams.request(
            start(StreamId(1), "drm-2"),
            Vec::new,
            None,
            Some(&mut engine),
        );
        streams.request(
            start(StreamId(2), "gone"),
            Vec::new,
            None,
            Some(&mut engine),
        );

        assert!(matches!(
            heard.try_recv(),
            Ok(ToPipewire::Start {
                stream: StreamId(1),
                size: (2, 2),
                ..
            })
        ));
        assert!(matches!(
            heard.try_recv(),
            Ok(ToPipewire::End {
                stream: StreamId(2),
                ..
            })
        ));
    }

    /// A client's lent buffer is filled once there is damage it has not seen,
    /// or at once when it wants a frame regardless.
    #[test]
    fn a_client_gets_a_frame_on_damage_or_when_it_wants_one() {
        let (to_clients, heard) = channel();
        let mut streams = Streams::new(channel().0, to_clients, None);
        streams.screens(screens(), None);
        let mut engine = Engine::default();
        let stream = StreamId(1);
        streams.request(
            Request::Start {
                stream,
                source: Source::Monitor("drm-1".into()),
                part: None,
                most_pixels: None,
                cursor: CursorMode::Hidden,
                consumer: Consumer::Client,
                listener: Box::new(|_| {}),
            },
            Vec::new,
            None,
            Some(&mut engine),
        );
        heard.try_recv().expect("started");
        let mapping = Mapping::new(c"test", 4).expect("a memfd");
        let now = Instant::now();
        for news in [
            ToWayland::Format {
                stream,
                format: StreamFormat {
                    pixel: Pixel::Bgrx,
                    size: (1, 1),
                    modifier: None,
                },
                framerate: 1000,
            },
            ToWayland::Added {
                stream,
                buffer: BufferId(0),
                target: Target::Shm(Arc::new(mapping)),
            },
            ToWayland::Filling { stream, on: true },
        ] {
            streams.news(news, None, Some(&mut engine), now);
        }
        streams.captured(1, 1, Ok(frame((1, 1), 9)), None, &mut engine, now);
        let lent = ToWayland::Lent {
            stream,
            buffer: BufferId(0),
        };
        // Skips `Starved`, which a frame with no buffer lent says.
        let filled = |heard: &Channel<ToPipewire>| loop {
            match heard.try_recv() {
                Ok(ToPipewire::Filled { damage, .. }) => break Some(damage),
                Ok(_) => {}
                Err(_) => break None,
            }
        };

        streams.news(lent, None, Some(&mut engine), now);
        assert!(filled(&heard).is_some(), "the owed frame");

        let later = now + Duration::from_secs(1);
        let lent = ToWayland::Lent {
            stream,
            buffer: BufferId(0),
        };
        streams.news(lent, None, Some(&mut engine), later);
        assert_eq!(filled(&heard), None, "nothing new to show");
        streams.news(ToWayland::Wanted { stream }, None, Some(&mut engine), later);
        assert_eq!(filled(&heard), Some(vec![(0, 0, 1, 1)]), "wanted");
    }

    /// Frames that come inside the interval wait in one buffer, which is
    /// filled once, with the newest of them, when it is due.
    #[test]
    fn a_waiting_frame_is_filled_with_the_newest_view_when_due() {
        let (to_clients, heard) = channel();
        let mut streams = Streams::new(channel().0, to_clients, None);
        streams.screens(screens(), None);
        let mut engine = Engine::default();
        let stream = StreamId(1);
        streams.request(
            Request::Start {
                stream,
                source: Source::Monitor("drm-1".into()),
                part: None,
                most_pixels: None,
                cursor: CursorMode::Hidden,
                consumer: Consumer::Client,
                listener: Box::new(|_| {}),
            },
            Vec::new,
            None,
            Some(&mut engine),
        );
        heard.try_recv().expect("started");
        let mappings = [0, 1].map(|_| Arc::new(Mapping::new(c"test", 4).expect("a memfd")));
        let now = Instant::now();
        streams.news(
            ToWayland::Format {
                stream,
                format: StreamFormat {
                    pixel: Pixel::Bgrx,
                    size: (1, 1),
                    modifier: None,
                },
                framerate: 10,
            },
            None,
            Some(&mut engine),
            now,
        );
        for (id, mapping) in mappings.iter().enumerate() {
            let buffer = BufferId(id as u32);
            let target = Target::Shm(mapping.clone());
            for news in [
                ToWayland::Added {
                    stream,
                    buffer,
                    target,
                },
                ToWayland::Lent { stream, buffer },
            ] {
                streams.news(news, None, Some(&mut engine), now);
            }
        }
        streams.news(
            ToWayland::Filling { stream, on: true },
            None,
            Some(&mut engine),
            now,
        );
        streams.captured(1, 1, Ok(frame((1, 1), 9)), None, &mut engine, now);
        let filled = |heard: &Channel<ToPipewire>| {
            std::iter::from_fn(|| heard.try_recv().ok())
                .filter_map(|request| match request {
                    ToPipewire::Filled { buffer, .. } => Some(buffer),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(filled(&heard), [BufferId(0)], "the first frame");

        let soon = now + Duration::from_millis(10);
        streams.captured(1, 2, Ok(frame((1, 1), 5)), None, &mut engine, soon);
        let due = streams.captured(1, 3, Ok(frame((1, 1), 7)), None, &mut engine, soon);
        assert_eq!(filled(&heard), [], "inside the interval");
        assert_eq!(due, Some(now + Duration::from_millis(100)));
        // SAFETY: nothing else touches the buffer in this test.
        assert_eq!(
            unsafe { mappings[1].bytes() }[0],
            0,
            "not filled before it is due"
        );

        streams.tick(None, now + Duration::from_millis(100));

        assert_eq!(filled(&heard), [BufferId(1)]);
        // SAFETY: as above.
        assert_eq!(unsafe { mappings[1].bytes() }[0], 7, "the newest frame");
    }

    /// Starts a client's cast of browser window "1".
    fn browser_window_cast(streams: &mut Streams, engine: &mut Engine) -> StreamId {
        let stream = StreamId(1);
        streams.request(
            Request::Start {
                stream,
                source: Source::BrowserWindow("1".into()),
                part: None,
                most_pixels: None,
                cursor: CursorMode::Embedded,
                consumer: Consumer::Client,
                listener: Box::new(|_| {}),
            },
            Vec::new,
            None,
            Some(engine),
        );
        stream
    }

    /// A browser window's stream is offered at its page's size, which its
    /// first frame says, not at one pixel then resized: a recording of one
    /// that was resized came out black.
    #[test]
    fn a_browser_window_cast_is_offered_at_its_pages_size() {
        let (to_clients, heard) = channel();
        let mut streams = Streams::new(channel().0, to_clients, None);
        let mut engine = Engine::default();
        browser_window_cast(&mut streams, &mut engine);
        assert!(
            heard.try_recv().is_err(),
            "nothing offered before the page draws"
        );

        let mut letterboxed = painted((3, 2), &[0, 1, 2, 0, 3, 4]);
        letterboxed.content = (1, 0, 2, 2);
        streams.captured(
            BROWSER_WINDOW,
            7,
            Ok(letterboxed),
            None,
            &mut engine,
            Instant::now(),
        );

        match heard.try_recv() {
            Ok(ToPipewire::Start { size, .. }) => assert_eq!(size, (2, 2)),
            _ => panic!("a stream offered once the page drew"),
        }
    }

    /// A cast of an Electron window shows the views it holds over its page,
    /// where the app placed them, once every one has drawn.
    #[test]
    fn a_browser_window_cast_draws_the_views_it_holds_over_its_page() {
        let (to_clients, _heard) = channel();
        let mut streams = Streams::new(channel().0, to_clients, None);
        let mut engine = Engine::default();
        // A view past the page's right edge is cut there.
        streams.browser_windows(&holding(&[("6", (1, 1, 2, 1))]), None);
        browser_window_cast(&mut streams, &mut engine);
        assert_eq!(engine.browser_windows, ["1", "6"]);
        let shows = Shows::BrowserWindow(BROWSER_WINDOW);
        let shown = |streams: &Streams| {
            view(
                &shows,
                &streams.shots,
                &streams.captures,
                &streams.pages,
                &streams.screens,
                None,
                &EnginePointer::default(),
            )
            .map(|view| {
                let shot = compose(view.size, &view.layers, None).expect("on the CPU");
                shot.bgra
                    .chunks(4)
                    .map(|pixel| pixel[0])
                    .collect::<Vec<u8>>()
            })
        };

        streams.captured(
            BROWSER_WINDOW,
            1,
            Ok(painted((2, 2), &[1, 1, 1, 1])),
            None,
            &mut engine,
            Instant::now(),
        );
        assert_eq!(shown(&streams), None, "nothing before the view draws");
        streams.captured(
            BROWSER_WINDOW + 1,
            1,
            Ok(painted((2, 1), &[3, 4])),
            None,
            &mut engine,
            Instant::now(),
        );

        assert_eq!(shown(&streams), Some(vec![1, 1, 1, 3]));
    }

    /// A cast window's views follow the app: one it drops stops being
    /// captured and drawn, and one it adds starts.
    #[test]
    fn a_browser_window_casts_views_follow_the_app() {
        let mut streams = Streams::new(channel().0, channel().0, None);
        let mut engine = Engine::default();
        streams.browser_windows(&holding(&[("6", (0, 0, 1, 1))]), None);
        browser_window_cast(&mut streams, &mut engine);

        streams.browser_windows(&holding(&[("7", (0, 0, 1, 1))]), Some(&mut engine));

        assert_eq!(engine.browser_windows, ["1", "6", "7"]);
        assert_eq!(engine.stopped, [BROWSER_WINDOW + 1]);
        let page = &streams.pages[&BROWSER_WINDOW];
        assert_eq!(
            page.views
                .iter()
                .map(|view| view.capture)
                .collect::<Vec<_>>(),
            [BROWSER_WINDOW + 2]
        );
    }

    /// A view that closes leaves its window's cast; one whose capture failed
    /// fails it.
    #[test]
    fn a_closed_view_leaves_a_cast_and_a_failed_one_ends_it() {
        let (to_clients, heard) = channel();
        let mut streams = Streams::new(channel().0, to_clients, None);
        let mut engine = Engine::default();
        streams.browser_windows(&holding(&[("6", (0, 0, 1, 1)), ("7", (0, 0, 1, 1))]), None);
        browser_window_cast(&mut streams, &mut engine);

        streams.capture_ended(BROWSER_WINDOW + 1, None, Some(&mut engine));
        assert_eq!(streams.pages[&BROWSER_WINDOW].views.len(), 1);
        assert!(heard.try_recv().is_err(), "the cast goes on");

        streams.capture_ended(
            BROWSER_WINDOW + 2,
            Some("viz ran out".into()),
            Some(&mut engine),
        );
        // Its consumer hears it start, then end.
        assert!(matches!(heard.try_recv(), Ok(ToPipewire::Start { .. })));
        assert!(matches!(
            heard.try_recv(),
            Ok(ToPipewire::End {
                why: Ended::Failed(_),
                ..
            })
        ));
    }

    /// A browser window's cast stopped before its page drew still ends
    /// through its stream, so its consumer hears it.
    #[test]
    fn a_browser_window_cast_stopped_before_its_page_draws_ends() {
        let (to_clients, heard) = channel();
        let mut streams = Streams::new(channel().0, to_clients, None);
        let mut engine = Engine::default();
        let stream = browser_window_cast(&mut streams, &mut engine);

        streams.request(Request::Stop { stream }, Vec::new, None, Some(&mut engine));

        assert!(matches!(heard.try_recv(), Ok(ToPipewire::Start { .. })));
        assert!(matches!(
            heard.try_recv(),
            Ok(ToPipewire::End {
                why: Ended::Stopped,
                ..
            })
        ));
    }

    /// The pointer over a monitor or a window is in its pixels, with its
    /// image at its density. Off it, or hidden, there is none.
    #[test]
    fn the_pointer_over_a_source_is_in_its_pixels_at_its_density() {
        let mut streams = streams();
        streams.sprite =
            Sprite::from_bgra((1, 1), (0, 0), 1.0, vec![1, 2, 3, 255]).expect("a sprite");
        streams.engine_pointer.desk = Some((1.5, 0.25));
        streams.pointer = Some(("app-1".into(), (2.0, 3.0)));
        streams.densities.insert("app-1".into(), (1.5, 1.5));

        let over = streams
            .pointer_over(&Source::Monitor("drm-2".into()))
            .expect("over drm-2");
        assert_eq!(over.at, (1.0, 0.5));
        assert_eq!(over.sprite.size, (2, 2));
        assert_eq!(streams.pointer_over(&Source::Monitor("drm-1".into())), None);
        let over = streams
            .pointer_over(&Source::Window("app-1".into()))
            .expect("over the window");
        assert_eq!(over.at, (3.0, 4.5));
        assert_eq!(streams.pointer_over(&Source::Window("app-2".into())), None);

        streams.sprite = Sprite::hidden();
        assert_eq!(streams.pointer_over(&Source::Monitor("drm-2".into())), None);
    }

    /// A stream of `shows` that has not negotiated.
    fn cast(shows: Shows) -> Cast {
        Cast {
            shows,
            cursor: CursorMode::Hidden,
            format: None,
            pacing: None,
            targets: HashMap::new(),
            filling: false,
            asked: (1, 1),
            part: None,
            unstarted: None,
        }
    }
}
